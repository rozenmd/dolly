import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowUturnLeftIcon,
  BoltIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@heroicons/react/16/solid";
import { Picker, type PickerOption } from "./picker";

const CHATGPT = "ChatGPT subscription";
const CLAUDE = "Claude subscription";

const word = (part: string) =>
  /^(gpt|o\d)$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);

/**
 * Human name for an API model ID: "gpt-6.1-sol" → "GPT-6.1 Sol",
 * "claude-opus-5-5" → "Claude Opus 5.5". Unknown IDs are prettified, never hidden.
 */
export function modelName(id: string) {
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/i.exec(id);

  if (gpt) return [`GPT-${gpt[1]}`, ...(gpt[2]?.split("-").map(word) ?? [])].join(" ");

  const claude = /^claude-([a-z]+)-(\d+)-(\d+)$/i.exec(id);

  if (claude) return `Claude ${word(claude[1])} ${claude[2]}.${claude[3]}`;

  return /^[a-z0-9.-]+$/i.test(id) && id.includes("-") ? id.split("-").map(word).join(" ") : id;
}

/** The compact name a pill has room for: "Claude Opus 5.5" → "Opus 5.5". */
export const shortModelName = (id: string) => modelName(id).replace(/^Claude /, "");

export const MODELS: PickerOption[] = [
  { value: "", label: "Default" },
  ...["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna"].map((value) => ({
    value,
    label: modelName(value),
    group: CHATGPT,
  })),
  ...["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"].map(
    (value) => ({ value, label: modelName(value), group: CLAUDE }),
  ),
];

/** Pi thinking levels. Providers clamp levels a model doesn't support to the nearest one. */
export const EFFORTS: PickerOption[] = [
  { value: "off", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

export const DEFAULT_EFFORT = "medium";

export const effortName = (level: string) =>
  EFFORTS.find((option) => option.value === level)?.label ?? level;

/** A single-choice model picker, for settings where only the model is chosen. */
export function ModelPicker({
  id,
  value,
  disabled,
  defaultLabel = "Default",
  onChange,
}: {
  id?: string;
  value: string;
  disabled?: boolean;
  /** Label for the empty value, e.g. "Default (GPT-6 Luna)". */
  defaultLabel?: string;
  onChange: (model: string) => void;
}) {
  const options = MODELS.map((model) =>
    model.value === "" ? { ...model, label: defaultLabel } : model,
  );

  const current = options.find((model) => model.value === value);

  return (
    <Picker
      id={id}
      label="Model"
      className="model-picker"
      align="end"
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
      trigger={
        <>
          <BoltIcon className="model-picker-bolt" aria-hidden="true" />
          <span>{current?.label ?? modelName(value)}</span>
        </>
      }
    />
  );
}

export const SPEEDS = ["standard", "fast"] as const;

export type Speed = (typeof SPEEDS)[number];

/** Fast asks OpenAI for priority processing; Claude subscriptions have no faster tier. */
export const fastSupported = (model: string) => !model.startsWith("claude-");

export const speedName = (speed: Speed) => (speed === "fast" ? "Fast" : "Standard");

type List = "model" | "effort" | "speed";

type View = "root" | List;

type Row =
  | { key: List; kind: "list"; label: string; value: string }
  | { key: "fallback"; kind: "toggle"; label: string; hint: string; checked: boolean }
  | { key: "set-default" | "reset"; kind: "action"; label: string; disabled: boolean };

/**
 * One control for everything about the model a session runs on. The pill reads
 * "Opus 5.5 Medium"; its menu lists Model, Effort and Speed with their current
 * values, each opening its choices in place (a back row returns), an
 * Auto-fallback switch, and Set as default / Reset to default. It works the same
 * with a pointer, a keyboard or a thumb.
 *
 * `model` may be "" when `defaultModel` names what the empty choice resolves to,
 * as in the new-session composer. Speed, auto-fallback and the default actions
 * appear only when their handlers are given.
 */
export function ModelControl({
  id,
  model,
  effort,
  speed = "standard",
  autoFallback = true,
  defaultModel,
  disabled,
  placement = "below",
  isDefault = false,
  atDefault = false,
  onModel,
  onEffort,
  onSpeed,
  onAutoFallback,
  onSetDefault,
  onReset,
}: {
  id?: string;
  model: string;
  effort: string;
  speed?: Speed;
  autoFallback?: boolean;
  /** What "" resolves to; offering it adds a "Default" choice. Omit to hide that choice. */
  defaultModel?: string | null;
  disabled?: boolean;
  placement?: "above" | "below";
  /** The current choices are already the defaults for new sessions. */
  isDefault?: boolean;
  /** Every setting already matches the defaults, so there is nothing to reset. */
  atDefault?: boolean;
  onModel: (model: string) => void;
  onEffort: (level: string) => void;
  onSpeed?: (speed: Speed) => void;
  onAutoFallback?: (enabled: boolean) => void;
  onSetDefault?: () => void;
  onReset?: () => void;
}) {
  const [view, setView] = useState<View | null>(null);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const open = view !== null;
  const offersDefault = defaultModel !== undefined;
  const resolved = model || defaultModel || "";
  const modelLabel = resolved ? shortModelName(resolved) : "Default";
  const canFast = !resolved || fastSupported(resolved);
  const effectiveSpeed: Speed = speed === "fast" && canFast ? "fast" : "standard";

  const models = offersDefault
    ? MODELS.map((option) =>
        option.value === ""
          ? {
              ...option,
              label: "Default",
              hint: defaultModel ? modelName(defaultModel) : undefined,
            }
          : option,
      )
    : MODELS.filter((option) => option.value !== "");

  const speeds: (PickerOption & { disabled?: boolean })[] = SPEEDS.map((value) =>
    value === "fast"
      ? {
          value,
          label: speedName(value),
          hint: canFast ? "Priority, uses more of your limit" : "ChatGPT models only",
          disabled: !canFast,
        }
      : { value, label: speedName(value) },
  );

  const rows: Row[] = [
    {
      key: "model",
      kind: "list",
      label: "Model",
      value: model
        ? modelName(model)
        : defaultModel
          ? `Default · ${modelName(defaultModel)}`
          : "Default",
    },
    { key: "effort", kind: "list", label: "Effort", value: effortName(effort) },
    ...(onSpeed
      ? [{ key: "speed", kind: "list", label: "Speed", value: speedName(effectiveSpeed) } as const]
      : []),
    ...(onAutoFallback
      ? [
          {
            key: "fallback",
            kind: "toggle",
            label: "Auto-fallback",
            hint: "Switch subscriptions when usage runs out",
            checked: autoFallback,
          } as const,
        ]
      : []),
    ...(onSetDefault
      ? [
          {
            key: "set-default",
            kind: "action",
            label: "Set as default",
            disabled: isDefault,
          } as const,
        ]
      : []),
    ...(onReset
      ? [{ key: "reset", kind: "action", label: "Reset to default", disabled: atDefault } as const]
      : []),
  ];

  const lists: Record<List, (PickerOption & { disabled?: boolean })[]> = {
    model: models,
    effort: EFFORTS,
    speed: speeds,
  };

  const choices = (list: List) => lists[list];
  const selectedIn = (list: List) => ({ model, effort, speed: effectiveSpeed })[list];

  const options = view && view !== "root" ? choices(view) : [];
  const selected = view && view !== "root" ? selectedIn(view) : "";
  // In a list, index 0 is the back row and choices follow.
  const count = view === "root" ? rows.length : options.length + 1;
  const listLabel = { model: "Model", effort: "Effort", speed: "Speed" } as const;

  useEffect(() => {
    if (!open) return;

    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setView(null);
    };

    document.addEventListener("pointerdown", onPointer);

    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open, view]);

  function show(next: View, from?: List) {
    if (next === "root") setActive(from ? rows.findIndex((row) => row.key === from) : 0);
    else {
      const index = choices(next).findIndex((option) => option.value === selectedIn(next));

      setActive(Math.max(0, index) + 1);
    }

    setView(next);
  }

  function close() {
    setView(null);
    button.current?.focus();
  }

  function choose(option: PickerOption & { disabled?: boolean }) {
    if (option.disabled) return;

    if (view === "model") onModel(option.value);
    else if (view === "effort") onEffort(option.value);
    else if (view === "speed" && (option.value === "standard" || option.value === "fast"))
      onSpeed?.(option.value);
    close();
  }

  function activateRow(row: Row) {
    if (row.kind === "list") show(row.key);
    else if (row.kind === "toggle") onAutoFallback?.(!row.checked);
    else if (!row.disabled) {
      if (row.key === "set-default") onSetDefault?.();
      else onReset?.();
      close();
    }
  }

  function activate(index: number) {
    if (view === "root") activateRow(rows[index]);
    else if (view && index === 0) show("root", view);
    else choose(options[index - 1]);
  }

  function onKeyDown(event: KeyboardEvent) {
    const last = count - 1;

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
      activate(active);
    } else if (event.key === "ArrowRight" && view === "root" && rows[active]?.kind === "list") {
      event.preventDefault();
      activate(active);
    } else if ((event.key === "ArrowLeft" || event.key === "Escape") && view && view !== "root") {
      event.preventDefault();
      event.stopPropagation();
      show("root", view);
    } else if (event.key === "Escape") {
      // Don't let the surrounding dialog close too.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      setView(null);
    }
  }

  let previousGroup: string | undefined;

  return (
    <div ref={root} className={`picker model-control${placement === "above" ? " opens-up" : ""}`}>
      <button
        ref={button}
        id={id}
        type="button"
        className="picker-trigger"
        aria-label={`Model: ${modelName(resolved || "Default")}, effort: ${effortName(effort)}${
          effectiveSpeed === "fast" ? ", fast" : ""
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-model={model}
        data-effort={effort}
        data-speed={effectiveSpeed}
        disabled={disabled}
        onClick={() => (open ? setView(null) : show("root"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show("root");
          }
        }}
      >
        {effectiveSpeed === "fast" && (
          <BoltIcon className="model-control-fast" aria-hidden="true" />
        )}
        <span className="model-control-model">{modelLabel}</span>
        <span className="model-control-effort">{effortName(effort)}</span>
        <ChevronDownIcon className="picker-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="picker-menu align-end model-control-menu">
          {view === "root" ? (
            <div
              ref={panel}
              id={menuId}
              role="menu"
              aria-label="Model settings"
              tabIndex={-1}
              aria-activedescendant={`${menuId}-${active}`}
              onKeyDown={onKeyDown}
            >
              {rows.map((row, index) => {
                const className = `picker-option model-control-row${index === active ? " active" : ""}`;

                const startsGroup =
                  row.kind === "action" && rows[index - 1]?.kind !== "action" && index > 0;

                return (
                  <div key={row.key} role="presentation">
                    {startsGroup && <div className="model-control-separator" role="separator" />}
                    {row.kind === "list" && (
                      <div
                        id={`${menuId}-${index}`}
                        role="menuitem"
                        aria-haspopup="listbox"
                        className={className}
                        onPointerMove={() => setActive(index)}
                        onClick={() => activateRow(row)}
                      >
                        <span className="picker-label">{row.label}</span>
                        <span className="model-control-value">{row.value}</span>
                        <ChevronRightIcon className="model-control-arrow" aria-hidden="true" />
                      </div>
                    )}
                    {row.kind === "toggle" && (
                      <div
                        id={`${menuId}-${index}`}
                        role="menuitemcheckbox"
                        aria-checked={row.checked}
                        className={`${className} model-control-toggle`}
                        onPointerMove={() => setActive(index)}
                        onClick={() => activateRow(row)}
                      >
                        <span className="model-control-text">
                          <span className="picker-label">{row.label}</span>
                          <span className="model-control-hint">{row.hint}</span>
                        </span>
                        <CheckIcon className="model-control-check" aria-hidden="true" />
                      </div>
                    )}
                    {row.kind === "action" && (
                      <div
                        id={`${menuId}-${index}`}
                        role="menuitem"
                        aria-disabled={row.disabled}
                        className={`${className} model-control-action`}
                        onPointerMove={() => setActive(index)}
                        onClick={() => activateRow(row)}
                      >
                        <span className="picker-label">{row.label}</span>
                        {row.key === "set-default" ? (
                          row.disabled && (
                            <CheckIcon className="model-control-arrow" aria-hidden="true" />
                          )
                        ) : (
                          <ArrowUturnLeftIcon className="model-control-arrow" aria-hidden="true" />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              ref={panel}
              id={menuId}
              role="listbox"
              aria-label={view === "effort" ? "Thinking effort" : listLabel[view]}
              tabIndex={-1}
              aria-activedescendant={`${menuId}-${active}`}
              onKeyDown={onKeyDown}
            >
              <div
                id={`${menuId}-0`}
                role="option"
                aria-selected={false}
                className={`picker-option model-control-back${active === 0 ? " active" : ""}`}
                onPointerMove={() => setActive(0)}
                onClick={() => activate(0)}
              >
                <ChevronLeftIcon className="model-control-arrow" aria-hidden="true" />
                <span className="picker-label">{listLabel[view]}</span>
              </div>
              {options.map((option, offset) => {
                const index = offset + 1;

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
                      id={`${menuId}-${index}`}
                      role="option"
                      aria-selected={option.value === selected}
                      aria-disabled={option.disabled || undefined}
                      className={`picker-option${index === active ? " active" : ""}`}
                      onPointerMove={() => setActive(index)}
                      onClick={() => choose(option)}
                    >
                      <span className="picker-label">{option.label}</span>
                      {option.hint && <span className="picker-hint">{option.hint}</span>}
                      <CheckIcon className="picker-check" aria-hidden="true" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
