import { Buffer } from "node:buffer";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;

export const ScreenshotReference = Schema.String.check(
  Schema.isPattern(/^r2:\/\/screenshots\/(png|jpeg|gif|webp)\/[a-f0-9]{64}$/),
);

const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

/** Allow four maximum-sized images plus text and JSON overhead, only on the prompt route. */
export const MAX_PROMPT_BYTES = MAX_IMAGES * MAX_BASE64_LENGTH + 256 * 1024;

export const PromptImage = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: Schema.String.check(
    Schema.isMaxLength(MAX_BASE64_LENGTH),
    Schema.makeFilter((data) => {
      if (!data.length || data.length > MAX_BASE64_LENGTH || data.length % 4 !== 0) return false;

      const bytes = Buffer.from(data, "base64");

      return (
        bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES && bytes.toString("base64") === data
      );
    }),
  ),
});

export type PromptImage = typeof PromptImage.Type;

/** Content-addressed keys make retries immutable and deduplicate identical uploads. */
export async function storeImages(bucket: R2Bucket, images: readonly PromptImage[]) {
  const blocks: ImageContent[] = [];

  for (const image of images) {
    const bytes = Buffer.from(image.data, "base64");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Buffer.from(digest).toString("hex");
    const key = `screenshots/${image.mimeType.slice(6)}/${hash}`;

    await bucket.put(key, bytes, { httpMetadata: { contentType: image.mimeType } });
    blocks.push({ type: "image", mimeType: image.mimeType, data: `r2://${key}` });
  }

  return blocks;
}

/** Request-only hydration: never write base64 back into Pi entries, submissions or task state. */
export async function resolveImages(
  bucket: R2Bucket,
  messages: readonly Message[],
): Promise<Message[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (
        (message.role !== "user" && message.role !== "toolResult") ||
        Schema.is(Schema.String)(message.content)
      )
        return message;

      const content = await Promise.all(
        message.content.map(async (block) => {
          if (block.type !== "image" || !block.data.startsWith("r2://")) return block;

          if (!Schema.is(ScreenshotReference)(block.data))
            throw new Error("Invalid screenshot reference");

          const object = await bucket.get(block.data.slice(5));

          if (!object) throw new Error("Screenshot is missing from R2");

          return { ...block, data: Buffer.from(await object.arrayBuffer()).toString("base64") };
        }),
      );

      return { ...message, content };
    }),
  );
}
