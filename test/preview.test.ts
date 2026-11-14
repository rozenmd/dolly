import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { previewRequest, PreviewRequest } from "../src/preview";

it("pins browser routing to one hostname and strips application credentials", async () => {
  for (const url of ["https://scoped.test/", "http://other.test/", "http://scoped.test:3000/"])
    expect(previewRequest(new Request(url), "scoped.test")).toBeNull();

  const forwarded = previewRequest(
    new Request("http://scoped.test/page", {
      headers: {
        Cookie: "app-cookie",
        Authorization: "Bearer app-secret",
        "CF-Access-Client-Secret": "access-secret",
        Accept: "text/html",
      },
    }),
    "scoped.test",
  );

  expect(forwarded?.url).toBe("http://scoped.test/page");

  for (const header of ["cookie", "authorization", "cf-access-client-secret"])
    expect(forwarded?.headers.get(header)).toBeNull();
  expect(forwarded?.headers.get("accept")).toBe("text/html");
});

it("validates action-specific preview inputs and rejects absolute/network paths", () => {
  const valid = Schema.is(PreviewRequest);
  expect(valid({ action: "start", command: "pnpm dev --host 0.0.0.0", port: 3000 })).toBe(true);

  for (const input of [
    { action: "start", port: 3000 },
    { action: "start", command: "server", port: 80 },
    { action: "start", command: "server", port: 65536 },
    { action: "screenshot", width: 10000 },
    ...["https://example.com", "//other.test", "/\\other.test", "/\nother.test"].map((path) => ({
      action: "screenshot",
      path,
    })),
  ])
    expect(valid(input)).toBe(false);
  expect(valid({ action: "screenshot", path: "/settings?tab=one", waitFor: "main" })).toBe(true);
});

it("does not initialize a sandbox for preview status or unauthorised browser requests", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    Object.assign(instance, {
      container: () => {
        throw new Error("Must not start a container");
      },
    });
    expect(await instance.previewStatus()).toMatchObject({ running: false });
    expect(
      (await instance.previewFetch(new Request("http://preview.test/"), "forged")).status,
    ).toBe(404);
    expect(() => instance.previewCapability()).toThrow("No active preview");
    expect(await instance.previewStop()).toEqual({ stopped: true });
  });
});

it("revokes preview capability before stopping its process without replacing workspace state", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    await state.storage.put("snapshot:checkpoint", { id: "preserve-me" });
    let killed = 0;
    Object.assign(instance, {
      preview: {
        token: "private",
        port: 3000,
        expiresAt: Date.now() + 1000,
        exited: false,
        process: {
          kill: (signal: number) => {
            killed = signal;
            expect(() => instance.previewCapability()).toThrow("No active preview");
          },
          exitCode: Promise.resolve(0),
        },
      },
    });
    await instance.previewStop();
    expect(killed).toBe(15);
    expect(await state.storage.get("snapshot:checkpoint")).toEqual({ id: "preserve-me" });
    expect(
      (await instance.previewFetch(new Request("http://preview.test/"), "private")).status,
    ).toBe(404);
  });
});
