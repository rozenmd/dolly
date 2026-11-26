/**
 * Recognising Claude Code's account notices, ported from Open Session's runner-shared.ts (MIT, see
 * third_party/opensession/LICENSE). Claude Code reports some usage limits as an ordinary
 * successful answer ("5-hour limit reached ∙ resets 3am"); the bridge turns those into errors so
 * Dolly's auto-fallback sees a limit instead of a reply.
 */

/** SDK assistant-message error kinds that mean the account is out of capacity. */
export function isLimitErrorKind(kind: string | undefined) {
  return kind === "rate_limit" || kind === "billing_error";
}

/** The failure to report for a message tagged with such a kind, worded as a usage limit. */
export function limitErrorMessage(kind: string, text: string) {
  return `Usage limit reached (${kind})${text ? `: ${text}` : ""}`;
}

const SEPARATOR = "[·∙•|-]";

// The reset stamp Claude Code prints, and nothing after it: "3am", "12:50pm (UTC)",
// "Aug 20, 9am (UTC)". Prose after a stamp makes the text an answer, not a notice.
const RESET_STAMP =
  "(?:[a-z]{3,9}\\.? \\d{1,2},? )?\\d{1,2}(?::\\d{2})? ?(?:am|pm)(?: \\([\\w/+:-]{1,40}\\))?";

const ACCOUNT_NOTICES = [
  // "You've hit your session limit · resets 12:50pm (UTC)"
  new RegExp(
    `^you['’]ve (?:hit|reached) your [\\w -]{0,30}limit(?: ${SEPARATOR} resets ${RESET_STAMP})?\\.?$`,
  ),
  // "5-hour limit reached ∙ resets 3am"
  new RegExp(`^[\\w -]{0,30}limit (?:reached|hit) ${SEPARATOR} resets ${RESET_STAMP}\\.?$`),
  // "Claude AI usage limit reached|1767225600"
  /^claude (?:ai )?usage limit reached(?:\|\d+)?\.?$/,
  // "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models."
  /^you(?:['’]re| are) out of (?:usage )?credits\.(?: run \/usage-credits to keep using [\w .-]{1,30} or \/model to switch models\.)?$/,
  // "Claude Max subscription issue. Check your subscription status."
  /^claude (?:max|pro) subscription issue\.(?: check your subscription status\.)?$/,
  // "Your organization has disabled Claude subscription access for Claude Code · …"
  new RegExp(
    `^your organization has disabled claude subscription access for claude code(?: ${SEPARATOR} use an anthropic api key instead, or ask your admin to enable access)?\\.?$`,
  ),
];

/** Whether a successful result's whole text is an account notice rather than a model answer. */
export function isAccountNotice(text: string) {
  const s = text.trim().toLowerCase();

  return s.length <= 300 && ACCOUNT_NOTICES.some((notice) => notice.test(s));
}
