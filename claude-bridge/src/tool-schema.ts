import { z } from "zod";
import { JsonSchema, type Tool } from "./messages.ts";

/** A tool's argument fields, as the SDK registers them. */
export type ToolFields = Record<string, z.ZodType>;

/**
 * The SDK registers a tool from a zod object shape and shows the model the JSON Schema it derives
 * from it. zod's own JSON Schema import keeps what the client sent (unions, enums, bounds), which
 * matters for Dolly's tools: an `operation` that is a union of actions would otherwise reach the
 * model as `any`. Schemas it can't import fall back to Open Session's minimal conversion.
 */
export function toolInputSchema(schema: Tool["input_schema"]): ToolFields {
  if (!schema) return {};

  try {
    const imported = z.fromJSONSchema(schema);

    if (imported instanceof z.ZodObject) return imported.shape;
  } catch {
    // Fall through to the minimal conversion below.
  }

  const parsed = JsonSchema.safeParse(schema);

  return parsed.success ? minimalFields(parsed.data) : {};
}

/**
 * Minimal JSON Schema to zod conversion, after Open Session's bridge. The schema only shapes what
 * the model emits: the client validates the arguments again, so constructs this does not know
 * degrade to `z.any()`.
 */
function minimalFields(schema: JsonSchema) {
  const fields: ToolFields = {};

  if (!schema.properties) return fields;
  const required = new Set(schema.required ?? []);

  for (const [key, property] of Object.entries(schema.properties)) {
    let field = toZod(property);

    if (property.description) field = field.describe(property.description);
    fields[key] = required.has(key) ? field : field.optional();
  }

  return fields;
}

function toZod(schema: JsonSchema): z.ZodType {
  switch (schema.type) {
    case "string":
      return schema.enum?.length ? z.enum(schema.enum) : z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(schema.items ? toZod(schema.items) : z.any());
    case "object":
      return schema.properties ? z.object(minimalFields(schema)) : z.record(z.string(), z.any());
    default:
      return z.any();
  }
}
