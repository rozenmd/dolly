import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "@heroicons/react/16/solid";

export type PickerOption = {
  value: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  group?: string;
};

/**
 * A button that opens a popover listbox. Used instead of native selects where the
 * menu needs icons, groups and footers. The trigger exposes the current value as
 * `data-value` so tests and forms can read it.
 */
export function Picker({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  align = "start",
  className = "",
  trigger,
  footer,
}: {
  id?: string;
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  align?: "start" | "end";
  className?: string;
  trigger: ReactNode;
  footer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false);
    };

    document.addEventListener("pointerdown", onPointer);
    list.current?.focus();

    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function show() {
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  }

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  function choose(option: PickerOption) {
    onChange(option.value);
    close();
  }

  function onKeyDown(event: KeyboardEvent) {
    const last = options.length - 1;

    const moves = new Map([
      ["ArrowDown", active >= last ? 0 : active + 1],
      ["ArrowUp", active <= 0 ? last : active - 1],
      ["Home", 0],
      ["End", last],
    ]);

    const next = moves.get(event.key);

    if (next !== undefined) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();

      if (options[active]) choose(options[active]);
    } else if (event.key === "Escape") {
      // Don't let the surrounding dialog close too.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  let previousGroup: string | undefined;

  return (
    <div ref={root} className={`picker ${className}`}>
      <button
        ref={button}
        id={id}
        type="button"
        className="picker-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
          }
        }}
      >
        {trigger}
        <ChevronDownIcon className="picker-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className={`picker-menu align-${align}`}>
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            aria-activedescendant={`${listId}-${active}`}
            onKeyDown={onKeyDown}
          >
            {options.map((option, index) => {
              const heading =
                option.group && option.group !== previousGroup ? option.group : undefined;

              previousGroup = option.group;

              return (
                <div key={option.value || "__none__"} role="presentation">
                  {heading && (
                    <div className="picker-group" role="presentation">
                      {heading}
                    </div>
                  )}
                  <div
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={option.value === value}
                    className={`picker-option${index === active ? " active" : ""}`}
                    onPointerMove={() => setActive(index)}
                    onClick={() => choose(option)}
                  >
                    {option.icon}
                    <span className="picker-label">{option.label}</span>
                    {option.hint && <span className="picker-hint">{option.hint}</span>}
                    <CheckIcon className="picker-check" aria-hidden="true" />
                  </div>
                </div>
              );
            })}
          </div>
          {footer && <div className="picker-footer">{footer(() => setOpen(false))}</div>}
        </div>
      )}
    </div>
  );
}
