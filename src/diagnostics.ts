/** Preserve exception details while removing OAuth credentials from provider response errors. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let safe = text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted JWT]")
    .replace(/((?:access_token|refresh_token|id_token|code_verifier|device_auth_id|user_code|authorization_code)["'\\\s]*[:=]["'\\\s]*)([^"'\\\s,}]+)/gi, "$1[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[redacted]");
  }
  return safe;
}

export function exceptionDetails(error: unknown, secrets: readonly string[] = []) {
  return error instanceof Error
    ? {
        name: error.name,
        message: redact(typeof error.message === "string" ? error.message : String(error), secrets),
        stack: redact(typeof error.stack === "string" ? error.stack : "", secrets),
      }
    : { message: redact(String(error), secrets) };
}
