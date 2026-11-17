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
