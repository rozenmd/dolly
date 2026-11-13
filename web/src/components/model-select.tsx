import type { ComponentProps } from "react";
import { Select } from "./ui";

export function ModelSelect(props: ComponentProps<"select">) {
  return <Select {...props}>
    <option value="">Server default</option>
    <optgroup label="ChatGPT subscription">
      <option value="gpt-6-sol">GPT-6 Sol</option>
      <option value="gpt-6-luna">GPT-6 Luna</option>
      <option value="gpt-6.1-terra">GPT-6.1 Terra</option>
    </optgroup>
    <optgroup label="Claude subscription (experimental)">
      <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
      <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
      <option value="claude-opus-4-6">Claude Opus 4.6</option>
    </optgroup>
  </Select>;
}
