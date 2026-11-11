import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Preserve exception details while removing OAuth credentials from provider response errors. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let safe = text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted JWT]")
    .replace(
      /((?:access_token|refresh_token|id_token|code_verifier|device_auth_id|user_code|authorization_code)["'\\\s]*[:=]["'\\\s]*)([^"'\\\s,}]+)/gi,
      "$1[redacted]",
    )
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");

  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[redacted]");
  }

  return safe;
}

export function exceptionDetails(cause: unknown, secrets: readonly string[] = []) {
  return cause instanceof Error
    ? {
        name: cause.name,
        message: redact(
          Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(cause.message), () =>
            String(cause),
          ),
          secrets,
        ),
        stack: redact(
          Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(cause.stack), () => ""),
          secrets,
        ),
      }
    : { message: redact(String(cause), secrets) };
}
