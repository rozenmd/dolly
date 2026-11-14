import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import type { Message } from "@earendil-works/pi-ai";
import { MAX_IMAGE_BYTES, PromptImage, resolveImages, storeImages } from "../src/images";

beforeEach(reset);

it("stores binary screenshots in private R2 and resolves references without mutating history", async () => {
  const image = { mimeType: "image/png", data: btoa("screenshot bytes") } as const;
  const blocks = await storeImages(env.SCREENSHOTS, [image]);
  const messages = [{ role: "user", timestamp: 1, content: blocks }] as const;
  const [block] = blocks;

  expect(block.data).toMatch(/^r2:\/\/screenshots\/png\/[a-f0-9]{64}$/);
  expect(JSON.stringify(messages)).not.toContain(image.data);
  const object = await env.SCREENSHOTS.get(block.data.slice(5));

  expect(await object?.text()).toBe("screenshot bytes");
  expect(object?.httpMetadata?.contentType).toBe("image/png");
  expect(await resolveImages(env.SCREENSHOTS, messages)).toEqual([
    { role: "user", timestamp: 1, content: [{ type: "image", ...image }] },
  ]);
  expect(messages[0].content[0].data).toBe(block.data);
  expect(await storeImages(env.SCREENSHOTS, [image])).toEqual(blocks);
  expect((await env.SCREENSHOTS.list()).objects).toHaveLength(1);
});

it("leaves text-only and legacy inline-image prompts unchanged", async () => {
  const messages: Message[] = [
    { role: "user", content: "hello", timestamp: 1 },
    {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "eA==" }],
      timestamp: 2,
    },
  ];

  expect(await resolveImages(env.SCREENSHOTS, messages)).toEqual(messages);
});

it("fails closed for invalid or missing R2 references", async () => {
  for (const data of ["r2://other/key", `r2://screenshots/png/${"a".repeat(64)}`]) {
    await expect(
      resolveImages(env.SCREENSHOTS, [
        {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data }],
          timestamp: 1,
        },
      ]),
    ).rejects.toThrow(/screenshot|Screenshot/);
  }
});

it("accepts the exact decoded size limit but rejects the next byte", () => {
  const image = { mimeType: "image/png", data: btoa("x".repeat(MAX_IMAGE_BYTES)) };

  expect(Schema.is(PromptImage)(image)).toBe(true);
  expect(Schema.is(PromptImage)({ ...image, data: btoa("x".repeat(MAX_IMAGE_BYTES + 1)) })).toBe(
    false,
  );
});
