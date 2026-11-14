import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { dependencyCache } from "../src/dependency-cache";
import { workspaceConfig } from "../src/workspace";

it("streams immutable cache objects through R2 with repository and network-policy isolation", async () => {
  const key = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const url = `http://dependencies.workspace/v1/${key}`;
  const token = crypto.randomUUID();
  const workspace = workspaceConfig({ repository: `fixture/${crypto.randomUUID()}` }, "cache");
  const headers = { "X-Dolly-Dependency-Cache": token };
  const bucket = env.DEPENDENCY_CACHE;

  expect((await dependencyCache(new Request(url), bucket, workspace, token)).status).toBe(403);
  expect((await dependencyCache(new Request(url, { headers }), bucket, workspace)).status).toBe(
    403,
  );
  expect(
    (await dependencyCache(new Request(url, { headers }), bucket, workspace, token)).status,
  ).toBe(404);
  const content = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]);

  const upload = () =>
    new Request(url, {
      method: "PUT",
      headers: { ...headers, "Content-Length": String(content.length) },
      body: content,
    });

  expect((await dependencyCache(upload(), bucket, workspace, token)).status).toBe(201);
  expect((await dependencyCache(upload(), bucket, workspace, token)).status).toBe(412);
  const restored = await dependencyCache(new Request(url, { headers }), bucket, workspace, token);
  expect(new Uint8Array(await restored.arrayBuffer())).toEqual(content);

  for (const other of [
    { ...workspace, repository: "another/repo" },
    { ...workspace, ref: "refs/pull/42/head" },
    { ...workspace, networkHosts: ["private-registry.example"] },
  ])
    expect(
      (await dependencyCache(new Request(url, { headers }), bucket, other, token)).status,
    ).toBe(404);

  for (const invalid of [
    "http://dependencies.workspace/v1/not-a-digest",
    `${url}?repository=another/repo`,
    url.replace("http:", "https:"),
  ])
    expect(
      (await dependencyCache(new Request(invalid, { headers }), bucket, workspace, token)).status,
    ).toBe(400);
  expect(
    (
      await dependencyCache(
        new Request(url, { method: "DELETE", headers }),
        bucket,
        workspace,
        token,
      )
    ).status,
  ).toBe(405);
  expect(
    (
      await dependencyCache(
        new Request(url, {
          method: "PUT",
          headers: { ...headers, "Content-Length": String(513 * 1024 * 1024) },
          body: content,
        }),
        bucket,
        workspace,
        token,
      )
    ).status,
  ).toBe(413);
});
