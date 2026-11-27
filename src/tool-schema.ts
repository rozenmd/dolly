import type { ToolCall } from "@earendil-works/pi-ai";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * JSON Schema parameters for a native Pi tool.
 *
 * Only a `Schema.Struct` is accepted, so a root `Schema.Union` fails to compile. Pi's Anthropic
 * adapter keeps only a tool schema's root `properties`/`required` (Anthropic rejects a root
 * anyOf/oneOf), so a root union reached Claude as `{"properties": {}}`: the model saw no arguments
 * and its first call always failed validation. Expose a flat struct to the model and decode the
 * stricter action-specific union inside `execute` instead.
 */
export function toolParameters<const Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
) {
  const parameters = Schema.toJsonSchemaDocument(schema).schema;

  if (!Predicate.isObject(parameters)) throw new Error("Tool parameters must be an object schema");

  return parameters;
}

/**
 * A tool's `prepareArguments` that drops top-level fields its schema does not name.
 *
 * GPT models on the ChatGPT backend (where tools are not strict) regularly append a stray field
 * to an otherwise complete call: `"x": 0`, `"}": "x"`, `"unused": ""`, `"limit": null`, even a
 * duplicate `"parameters": {...}`. The schema rejects unknown fields, so the whole call failed
 * validation and the model had to repeat it. Use this only where ignoring an unknown field can't
 * change what the call does: the named fields are still validated as before.
 */
export function dropUnknownFields<Args extends object>(known: readonly (keyof Args & string)[]) {
  // Pi prepares a tool call's arguments once it has parsed them as a JSON object.
  return (args: ToolCall["arguments"]) =>
    // SAFETY: not validated yet, like the model's own arguments: Pi validates this against the
    // tool's parameters before execute() sees it.
    Object.fromEntries(
      Object.entries(args).filter(([key]) => known.some((name) => name === key)),
    ) as Args;
}
