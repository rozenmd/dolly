import { BoltIcon } from "@heroicons/react/16/solid";
import { Picker, type PickerOption } from "./picker";

const CHATGPT = "ChatGPT subscription";
const CLAUDE = "Claude subscription";

export const MODELS: PickerOption[] = [
  { value: "", label: "Server default" },
  { value: "gpt-6-sol", label: "GPT-6 Sol", group: CHATGPT },
  { value: "gpt-6-luna", label: "GPT-6 Luna", group: CHATGPT },
  { value: "gpt-6.1-terra", label: "GPT-6.1 Terra", group: CHATGPT },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", group: CLAUDE },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", group: CLAUDE },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", group: CLAUDE },
  { value: "claude-fable-5-2", label: "Claude Fable 5.2", group: CLAUDE },
];

export function ModelPicker({
  id,
  value,
  disabled,
  onChange,
}: {
  id?: string;
  value: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  const current = MODELS.find((model) => model.value === value);

  return (
    <Picker
      id={id}
      label="Model"
      className="model-picker"
      align="end"
      value={value}
      options={MODELS}
      disabled={disabled}
      onChange={onChange}
      trigger={
        <>
          <BoltIcon className="model-picker-bolt" aria-hidden="true" />
          <span>{current?.label ?? value}</span>
        </>
      }
    />
  );
}
