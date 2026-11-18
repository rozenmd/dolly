// Adapted from Open Session's pi-context.ts. Copyright (c) 2026 Tella.
// https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/server/pi-context.ts
// MIT license: third_party/opensession/LICENSE.
import type { Model, Api } from "@earendil-works/pi-ai";
import type { CompactionSettings } from "@earendil-works/pi-durable";

const COMPACT_AT_TOKENS = 440_000;
const PI_RESERVE_TOKENS = 16_384;

/** Cap large model windows without making smaller windows compact earlier than Pi's default. */
export function compactionSettings(models: readonly Model<Api>[]): CompactionSettings {
  const modelOverrides: Record<string, { reserveTokens: number }> = {};

  for (const { provider, id, contextWindow } of models) {
    if (!Number.isFinite(contextWindow)) continue;

    const reserveTokens = Math.floor(contextWindow) - COMPACT_AT_TOKENS;

    if (reserveTokens > PI_RESERVE_TOKENS) modelOverrides[`${provider}/${id}`] = { reserveTokens };
  }

  return { modelOverrides };
}
