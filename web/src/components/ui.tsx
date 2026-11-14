import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { CheckIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { DocumentDuplicateIcon } from "@heroicons/react/24/outline";

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function Modal({
  title,
  children,
  onClose,
  className = "",
  bare = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  /** Hide the visible header; the title stays available to assistive tech. */
  bare?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();

    return () => {
      ref.current?.close();

      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-labelledby="modal-title"
      onCancel={onClose}
      onClick={(event) => {
        // Clicks on the backdrop target the dialog element itself.
        if (bare && event.target === event.currentTarget) onClose();
      }}
    >
      {bare ? (
        <h2 id="modal-title" className="sr-only">
          {title}
        </h2>
      ) : (
        <header>
          <h2 id="modal-title">{title}</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <XMarkIcon />
          </IconButton>
        </header>
      )}
      {children}
    </dialog>
  );
}

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={`input ${props.className ?? ""}`} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea {...props} className={`input ${props.className ?? ""}`} />;
}

export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={`input ${props.className ?? ""}`} />;
}

const BADGE_COLOURS = [
  "#3b82f6",
  "#e0663a",
  "#c04fd6",
  "#8b5cf6",
  "#5d9b2f",
  "#4f6ef7",
  "#d4a017",
  "#14a3a3",
  "#e0457b",
];

export function RepoBadge({ repository }: { repository: string }) {
  const name = repository.split("/").at(-1) ?? "";

  // Stable per-repository colour so repos are recognisable at a glance.
  let hash = 0;

  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const background = BADGE_COLOURS[Math.abs(hash) % BADGE_COLOURS.length];

  return (
    <span className="repo-badge" aria-hidden="true" style={{ background }}>
      {name.charAt(0).toUpperCase() || "·"}
    </span>
  );
}

/** A one-time device code to enter on another site, copied with one click. */
export function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="device-code"
      aria-label={copied ? `Copied code ${code}` : `Copy code ${code}`}
      title={copied ? "Copied" : "Copy code"}
      onClick={() =>
        void navigator.clipboard.writeText(code).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      <span>{code}</span>
      {copied ? <CheckIcon /> : <DocumentDuplicateIcon />}
    </button>
  );
}
