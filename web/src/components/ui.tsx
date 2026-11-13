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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
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
    >
      <header>
        <h2 id="modal-title">{title}</h2>
        <IconButton label="Close dialog" onClick={onClose}>
          <XMarkIcon />
        </IconButton>
      </header>
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

export function RepoBadge({ repository }: { repository: string }) {
  const name = repository.split("/").at(-1) ?? "";

  return (
    <span className="repo-badge" aria-hidden="true">
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
