import { useRef, type ClipboardEvent, type DragEvent } from "react";
import { MAX_IMAGES, readAttachments, type Attachment } from "../lib/images";

/** Paste, drop and file-picker handlers that append screenshots to a composer. */
export function useAttachmentInput(
  attachments: readonly Attachment[],
  onChange: (next: Attachment[]) => void,
  onError: (message: string) => void,
) {
  async function add(files: Iterable<File>) {
    const { attachments: added, error } = await readAttachments(files, attachments.length);
    onError(error);
    if (added.length) onChange([...attachments, ...added]);
  }

  return {
    add,
    onPaste(event: ClipboardEvent) {
      const files = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (!files.length) return;
      event.preventDefault();
      void add(files);
    },
    onDragOver(event: DragEvent) {
      if (event.dataTransfer.types.includes("Files")) event.preventDefault();
    },
    onDrop(event: DragEvent) {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      void add(Array.from(event.dataTransfer.files));
    },
  };
}

export function AttachButton({
  disabled,
  count,
  onFiles,
}: {
  disabled?: boolean;
  count: number;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="attach-button"
        aria-label="Attach screenshot"
        title="Attach screenshot (or paste / drop an image)"
        disabled={disabled || count >= MAX_IMAGES}
        onClick={() => input.current?.click()}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m21 12-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"
          />
        </svg>
      </button>
    </>
  );
}

export function AttachmentTray({
  attachments,
  disabled,
  onRemove,
}: {
  attachments: readonly Attachment[];
  disabled?: boolean;
  onRemove: (id: string) => void;
}) {
  if (!attachments.length) return null;

  return (
    <ul className="attachment-tray" aria-label="Attached screenshots">
      {attachments.map((item) => (
        <li key={item.id} className="attachment">
          <img src={item.preview} alt={item.name} />
          <button
            type="button"
            aria-label={`Remove ${item.name}`}
            disabled={disabled}
            onClick={() => onRemove(item.id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
