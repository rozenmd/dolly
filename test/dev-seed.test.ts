import api from "../src/index";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vite-plus/test";
import { resetStorage } from "./storage";
import * as Schema from "effect/Schema";
import { DEV_SESSION_TITLE } from "../src/dev-seed";
import { Snapshot } from "../src/transcript";

const dev = { ...env, DEV_SIGNED_IN: "true" };

beforeEach(async () => {
  await resetStorage();
});

it("signs in without a cookie and serves a seeded transcript only with both dev bindings", async () => {
  // Without DEV_SIGNED_IN, or without the local Access bypass, nothing is seeded or signed in.
  expect((await api.request("https://worker/api/sessions", {}, env)).status).toBe(401);
  expect(
    (await api.request("https://worker/api/sessions", {}, { ...dev, ACCESS_LOCAL_DEV: "false" }))
      .status,
  ).toBe(503);

  const auth = await api.request("https://worker/api/auth", {}, dev);
  expect(await auth.json()).toMatchObject({ user: { login: "octocat" } });

  const list = await api.request("https://worker/api/sessions", {}, dev);
  expect(list.status).toBe(200);
  const sessions = await list.json<{ id: string; title: string }[]>();
  expect(sessions).toEqual([expect.objectContaining({ title: DEV_SESSION_TITLE })]);

  // Seeding happens once: later requests reuse the same session.
  const again = await (await api.request("https://worker/api/sessions", {}, dev)).json();
  expect(again).toEqual(sessions);

  // The transcript streams over the real session WebSocket.
  const upgrade = await api.request(
    `https://worker/api/sessions/${sessions[0]!.id}/events`,
    { headers: { Upgrade: "websocket" } },
    dev,
  );

  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket!;

  const first = new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
  );

  socket.accept();
  const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(await first);
  socket.close();

  expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
    "pi.user",
    "pi.assistant",
    "pi.tool-result",
    "pi.assistant",
  ]);
});
