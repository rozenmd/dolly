import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { artifactTransport } from "../src/git-transport";

it("brokers only the session Artifact repository with scoped, short-lived credentials and rejects redirects", async () => {
  const name = `session-${crypto.randomUUID()}`;
  await env.WORKSPACES.create(name);
  using repo = await env.WORKSPACES.get(name);
  const info = await repo.info();
  let seenToken = "";
  let response: "ok" | "redirect" | "failure" = "ok";

  const mocked = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe(`${info.remote}/info/refs?service=git-upload-pack`);
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    seenToken = headers.get("Authorization")?.slice("Bearer ".length) ?? "";
    expect(seenToken).not.toBe("");
    expect(headers.get("Cookie")).toBeNull();
    const tokens = await repo.listTokens();
    expect(tokens.tokens.some((token) => token.scope === "read")).toBe(true);

    if (response === "failure") throw new Error(`upstream failure with ${seenToken}`);

    if (response === "redirect")
      return new Response(null, { status: 302, headers: { Location: "https://example.com" } });

    return new Response("Git advertisement");
  });

  const request = () =>
    new Request(`http://artifacts.workspace/${name}.git/info/refs?service=git-upload-pack`, {
      headers: { Authorization: "Bearer container-value", Cookie: "secret=container" },
    });

  const initialTokens = (await repo.listTokens()).tokens.length;

  try {
    expect(await (await artifactTransport(request(), env, name)).text()).toBe("Git advertisement");
    expect((await repo.listTokens()).tokens).toHaveLength(initialTokens);
    response = "redirect";
    expect((await artifactTransport(request(), env, name)).status).toBe(502);
    response = "failure";

    try {
      await artifactTransport(request(), env, name);
      throw new Error("Expected broker failure");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(seenToken);
      expect(JSON.stringify(error)).toContain("upstream failure");
    }

    expect(
      (
        await artifactTransport(
          new Request(
            `http://artifacts.workspace/another-session.git/info/refs?service=git-upload-pack`,
          ),
          env,
          name,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await artifactTransport(
          new Request(`https://artifacts.workspace/${name}.git/info/refs?service=git-upload-pack`),
          env,
          name,
        )
      ).status,
    ).toBe(403);
    expect(mocked).toHaveBeenCalledTimes(3);
  } finally {
    mocked.mockRestore();
    await env.WORKSPACES.delete(name);
  }
});
