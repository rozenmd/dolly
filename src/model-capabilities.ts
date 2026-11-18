/**
 * What each catalog model accepts: its reasoning efforts, speeds and fallback tier. Ported
 * from opensession (`models.ts` `modelEfforts`/`FALLBACK_TIER`/`nextFallbackModel` and
 * `openai-service-tier.ts`) so Dolly offers and routes the same way. Dependency-free, so the
 * web app shares it with the Worker.
 */

/** Pi's thinking levels. opensession's "none" is Pi's "off"; no catalog model offers "minimal". */
export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const OPENAI_EFFORTS: readonly Effort[] = ["off", "low", "medium", "high", "xhigh"];

/** GPT-6.2 rejects reasoning effort none. */
const OPENAI_REASONING_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const ALL_EFFORTS: readonly Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The efforts a model accepts, in order. Unknown models accept every Pi level. */
export function modelEfforts(model: string): readonly Effort[] {
  if (/^gpt-6\.2-(?:astra|sol)$/.test(model)) return OPENAI_REASONING_EFFORTS;

  if (/^(?:gpt-6\.1-sol|gpt-6\.1-terra|gpt-6-sol|gpt-6-luna)$/.test(model))
    return [...OPENAI_EFFORTS, "max"];

  if (model.startsWith("gpt-5.") || model === "gpt-6-astra") return OPENAI_EFFORTS;

  if (/^claude-(?:fable|opus|sonnet|haiku)-/.test(model)) return CLAUDE_EFFORTS;

  return ALL_EFFORTS;
}

/** Keep a supported effort; otherwise High, opensession's default, or the model's first. */
export function normalizeEffort(model: string, effort?: string | null): Effort {
  const supported = modelEfforts(model);
  const kept = supported.find((level) => level === effort);

  if (kept) return kept;

  return supported.includes("high") ? "high" : (supported[0] ?? "high");
}

/**
 * Session speeds. Fast sends ChatGPT's `priority` service tier; Ultrafast sends `ultrafast`,
 * which only Astra and Sol serve, and only to a ChatGPT Pro login ($200 or $500). Claude
 * subscriptions have no faster tier.
 */
export const SPEEDS = ["standard", "fast", "ultrafast"] as const;

export type Speed = (typeof SPEEDS)[number];

const FAST_MODELS = new Set([
  "gpt-6.2-astra",
  "gpt-6.2-sol",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

const ULTRAFAST_MODELS = new Set(["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-astra", "gpt-6.1-sol"]);

/**
 * ChatGPT plans that get Ultrafast: Pro $200 ("pro") and Pro $500 ("promax"). opensession allows
 * only "promax", but Ultrafast is confirmed working on a $200 Pro login. Pro Lite ("prolite",
 * $100) and lower plans run Ultrafast sessions at Fast.
 */
const ULTRAFAST_PLANS = new Set(["pro", "promax"]);

/** Whether a ChatGPT plan (`chatgpt_plan_type`) gets the ultrafast service tier. */
export const ultrafastPlan = (plan: string | undefined) => !!plan && ULTRAFAST_PLANS.has(plan);

/** ChatGPT models whose backend accepts the priority service tier. */
export const fastSupported = (model: string) => FAST_MODELS.has(model);

/** Models the ChatGPT backend serves on the ultrafast service tier. */
export const ultrafastSupported = (model: string) => ULTRAFAST_MODELS.has(model);

/** The speed a session actually gets on `model`; `ultrafast` says the login's plan has it. */
export function effectiveSpeed(speed: Speed | undefined, model: string, ultrafast = false): Speed {
  if (!speed || speed === "standard" || !fastSupported(model)) return "standard";

  return speed === "ultrafast" && ultrafastSupported(model) && ultrafast ? "ultrafast" : "fast";
}

const SERVICE_TIERS = {
  standard: undefined,
  fast: "priority",
  ultrafast: "ultrafast",
} as const satisfies Record<Speed, string | undefined>;

/** The `service_tier` a request carries at that speed, if any. */
export function serviceTier(speed: Speed | undefined, model: string, plan?: string) {
  return SERVICE_TIERS[effectiveSpeed(speed, model, ultrafastPlan(plan))];
}

/**
 * Fallback routing tiers (higher = smarter). A session moves on automatically only to an
 * equal-or-smarter model; opensession asks a human before a downgrade, so Dolly doesn't take one.
 */
const FALLBACK_TIER = new Map<string, number>(
  Object.entries({
    "claude-fable-5-2": 3,
    "gpt-6.2-astra": 3,
    "gpt-6.2-sol": 3,
    "gpt-6-astra": 3,
    "gpt-6.1-sol": 3,
    "gpt-6-sol": 3,
    "claude-opus-5-5": 3,
    "gpt-6.1-terra": 3,
    "gpt-5.6-terra": 3,
    "gpt-6-luna": 3,
    "gpt-5.5": 2,
    "claude-sonnet-5-5": 1,
    "claude-haiku-5-5": 0,
  }),
);

export const fallbackTier = (model: string) => FALLBACK_TIER.get(model) ?? 1;

/**
 * Fallback destinations, most desirable first. Fable is never one: its weekly credit pool is
 * the scarce thing sessions usually fall off of.
 */
const FALLBACK_DESTINATIONS = [
  "gpt-6.2-astra",
  "gpt-6.2-sol",
  "claude-opus-5-5",
  "gpt-6.1-terra",
  "gpt-6-luna",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

/**
 * The model to continue on after `current` ran out, or undefined. Candidates are the destination
 * list minus models `usable` rejects (an exhausted or unconnected subscription), ordered by tier
 * and then destination order, as opensession orders them. opensession's configured fallback
 * (Opus, or Luna from Haiku) is itself a destination, and its ordering already ranks it.
 * Opensession asks a person before a downgrade; Dolly never takes one automatically.
 */
export function nextFallbackModel(current: string, usable: (model: string) => boolean) {
  const tier = fallbackTier(current);

  const candidates = FALLBACK_DESTINATIONS.filter((model) => model !== current && usable(model));

  const rank = (model: string) => FALLBACK_DESTINATIONS.indexOf(model);

  const [next] = candidates
    .filter((model) => fallbackTier(model) >= tier)
    .sort((a, b) => fallbackTier(b) - fallbackTier(a) || rank(a) - rank(b));

  return next;
}

/**
 * Whether a failed response means the subscription ran out, with opensession's classifiers
 * (`runner-shared.ts` `isClaudeUsageLimitError`, `isClaudeSubscriptionError`,
 * `isCodexUsageLimitError`). Claude also reports credit-metered models (Fable) running out of
 * usage credits, and a lapsed or disabled subscription, which no retry fixes.
 */
export function usageExhausted(provider: "openai" | "anthropic", errorMessage: string) {
  const s = errorMessage.toLowerCase();

  if (provider === "openai")
    return (
      s.includes("rate limit") ||
      s.includes("rate_limit") ||
      s.includes("429") ||
      s.includes("usage limit") ||
      (s.includes("limit") && s.includes("reached")) ||
      s.includes("too many requests")
    );

  return claudeUsageLimit(s) || claudeSubscriptionError(s);
}

function claudeUsageLimit(s: string) {
  // "You've hit your session limit · resets 12:50pm (UTC)"
  if (/you've (?:hit|reached) your .{0,30}limit/.test(s)) return true;

  // "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 …"
  if (/out of (usage )?credits/.test(s) || s.includes("/usage-credits")) return true;

  if (/claude (ai )?usage limit reached/.test(s)) return true;

  if (/limit (reached|hit).{0,60}resets/.test(s)) return true;

  if (s.length < 200 && /\blimit\b/.test(s) && /\bresets\b/.test(s)) return true;

  if (s.includes("rate_limit_error") || s.includes("429") || s.includes("too many requests"))
    return true;

  return (
    (s.includes("usage") || s.includes("rate") || s.includes("limit")) &&
    (s.includes("exceeded") || s.includes("reached"))
  );
}

function claudeSubscriptionError(s: string) {
  return (
    s.includes("subscription issue") ||
    s.includes("check your subscription") ||
    (s.includes("claude max") && s.includes("subscription")) ||
    (s.includes("organization has disabled") && s.includes("subscription access"))
  );
}
