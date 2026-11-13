/** Screenshots attached to a prompt, sent as base64 alongside its text. */
export type Attachment = {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
  readonly preview: string;
};

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function base64(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

/** Reads image files, returning accepted attachments and a message for any rejected ones. */
export async function readAttachments(
  files: Iterable<File>,
  existing: number,
): Promise<{ attachments: Attachment[]; error: string }> {
  const attachments: Attachment[] = [];
  let error = "";

  for (const file of files) {
    if (!TYPES.has(file.type)) {
      error = "Only PNG, JPEG, GIF and WebP images can be attached.";
      continue;
    }

    if (!file.size || file.size > MAX_IMAGE_BYTES) {
      error = `${file.name || "Image"} must be non-empty and no larger than 5 MB.`;
      continue;
    }

    if (existing + attachments.length >= MAX_IMAGES) {
      error = `You can attach up to ${MAX_IMAGES} images.`;
      break;
    }

    const data = await base64(file);
    attachments.push({
      id: crypto.randomUUID(),
      name: file.name || "screenshot",
      mimeType: file.type,
      data,
      preview: `data:${file.type};base64,${data}`,
    });
  }

  return { attachments, error };
}

export function imagesBody(attachments: readonly Attachment[]) {
  return attachments.length
    ? { images: attachments.map(({ mimeType, data }) => ({ mimeType, data })) }
    : {};
}
