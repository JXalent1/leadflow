/**
 * classify.ts — pure, synchronous reply classification
 *
 * No imports, no side effects, no network/DB access.
 * Called by the Twilio inbound webhook to decide:
 *   1. Did this person opt out?  → isOptOut()
 *   2. Are they interested?       → classifyInterest()
 */

// ---------------------------------------------------------------------------
// isOptOut
// ---------------------------------------------------------------------------
//
// Compliance rule: CTIA opt-out keyword set. Per TCPA and CTIA guidelines,
// carriers are required to honour the following keywords unconditionally:
//   STOP, STOPALL, STOP ALL, UNSUBSCRIBE, CANCEL, END, QUIT
// We extend with common consumer variants that express the same intent:
//   OPTOUT, OPT OUT, REMOVE
//
// Tokenisation decision (documented for compliance audit trail):
//   We normalise the message by stripping leading/trailing whitespace,
//   lower-casing, and collapsing all internal whitespace runs to a single
//   space. We then check whether any CTIA keyword (or variant) appears as a
//   complete token sequence anywhere in the normalised string.
//
//   "Token sequence" means the keyword is bounded on each side by either:
//     • the start/end of the string, OR
//     • a non-alphanumeric character (space, punctuation, etc.)
//   This prevents "stopping" from matching "stop" incorrectly.
//
// FAIL-SAFE RULE (documented): When intent is genuinely ambiguous (e.g.
//   the message contains a keyword alongside other words like "please stop"
//   or "stop texting me"), we STILL treat it as an opt-out. The word-boundary
//   check is therefore intentionally generous — if ANY opt-out keyword appears
//   as a recognisable token anywhere in the message, we return true.
//   A false positive (suppressing a non-opt-out) is far safer than a false
//   negative that continues texting someone who said stop.

const OPT_OUT_KEYWORDS: string[] = [
  // CTIA mandatory set
  "stop",
  "stopall",
  "stop all",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  // Extended common variants
  "optout",
  "opt out",
  "remove",
];

/**
 * Build a regex that matches any opt-out keyword as a whole token anywhere
 * in the string. We sort longest-first so multi-word phrases ("stop all",
 * "opt out") match before their constituent words when the regex engine tests.
 */
const OPT_OUT_PATTERN: RegExp = new RegExp(
  "(?:^|[^a-z0-9])(" +
    OPT_OUT_KEYWORDS.slice()
      .sort((a, b) => b.length - a.length) // longest first
      .map((kw) => kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) // escape regex chars
      .join("|") +
    ")(?:[^a-z0-9]|$)",
  "i",
);

/**
 * Normalise a message body: trim whitespace, collapse internal whitespace
 * runs to a single space, lower-case.
 */
function normalise(body: string): string {
  return body.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Returns true if the message contains any CTIA opt-out keyword as a token.
 *
 * Fail-safe: errs toward over-matching. Any message that contains an opt-out
 * keyword — even surrounded by other words — is treated as an opt-out.
 */
export function isOptOut(body: string): boolean {
  if (!body) return false;
  const norm = normalise(body);
  return OPT_OUT_PATTERN.test(norm);
}

// ---------------------------------------------------------------------------
// isConfiguredOptOut — per-client ADDITIONAL opt-out keyword (exact-match only)
// ---------------------------------------------------------------------------
//
// A client may advertise an extra opt-out trigger on top of STOP, e.g. Reply "2" to opt out. Unlike
// isOptOut (the CTIA STOP family, which matches a keyword as a token ANYWHERE in the message and is
// always authoritative), the configured keyword is matched EXACTLY against the whole normalized
// body — so for keyword "2" ONLY a message whose entire body is "2" (or "2." / quoted "2" / " 2 ")
// opts out, NEVER a "2" that appears inside other text ("2 services", "call me at 2pm", "$200?").
//
// This is deliberately strict: a non-STOP keyword like a bare digit is far too common inside normal
// replies to safely treat as opt-out anywhere, so we require the keyword to BE the whole message.
// isOptOut stays the fail-safe over-matcher; this is an additive exact trigger.

/**
 * Normalize a body/keyword for exact configured-keyword comparison: trim, lowercase, then strip any
 * surrounding quotes and punctuation/whitespace (so `"2"`, `2.`, ` 2 ` all reduce to `2`). Interior
 * characters are left intact, so `2 services` stays multi-token and never reduces to `2`.
 */
function normalizeConfiguredKeyword(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^[\s"'“”‘’.,!?;:]+/, "")
    .replace(/[\s"'“”‘’.,!?;:]+$/, "");
}

/**
 * Returns true iff the whole message body EXACTLY matches the client's configured opt-out keyword
 * (after normalization). A null/blank keyword (the default) always returns false — STOP-only.
 * Pure; never throws. STOP-family handling stays in isOptOut and is unaffected by this.
 */
export function isConfiguredOptOut(body: string, keyword: string | null | undefined): boolean {
  if (!body || !keyword || !keyword.trim()) return false;
  const k = normalizeConfiguredKeyword(keyword);
  if (!k) return false; // keyword was only punctuation/quotes — nothing to match
  return normalizeConfiguredKeyword(body) === k;
}

// ---------------------------------------------------------------------------
// classifyInterest
// ---------------------------------------------------------------------------
//
// Heuristic rules for MVP (keyword matching only; no ML):
//
// INTERESTED signals — explicit affirmative words or service-intent phrases.
//   The bar is high: we only return "interested" when there's a clear positive
//   signal, because a false "interested" wastes the client's time and erodes
//   trust.
//
// NOT_INTERESTED signals — explicit negative words or phrases meaning the
//   person wants no contact. Note: "remove me" also triggers isOptOut above
//   (handled separately in the webhook layer), but we classify it as
//   not_interested here for completeness.
//
// NEUTRAL — everything else. Ambiguous messages go here; a human (Talan)
//   decides whether to follow up. We NEVER guess "interested" when the signal
//   is weak — the cost of spamming the client with a false lead is higher than
//   missing a borderline case.
//
// Precedence: not_interested checked before interested, so "no thanks but
// how much" correctly resolves to not_interested (explicit rejection wins).
// Opt-out messages (STOP, etc.) are handled by isOptOut before this function
// is reached, but "not interested" / "remove me" stay here so the webhook
// can store the intent for reporting.

const INTERESTED_PATTERNS: RegExp[] = [
  /\byes\b/i,
  /\byep\b/i,
  /\byeah\b/i,
  /\bsure\b/i,
  /\binterested\b/i,
  /\bhow much\b/i,
  /\bwhat.?s the cost\b/i,
  /\bwhat does it cost\b/i,
  /\bquote\b/i,
  /\bpricing\b/i,
  /\bprice\b/i,
  /\bwhen can you\b/i,
  /\bschedul/i, // "schedule", "scheduling", "scheduled"
  /\bavailab/i, // "available", "availability"
  /\bbook\b/i,
  /\bcome out\b/i,
  /\bset (it|something|an appointment) up\b/i,
  /\btell me more\b/i,
  /\bmore info\b/i,
  /\bsend info\b/i,
  /\bsounds good\b/i,
  /\bsounds great\b/i,
  /\bsounds interesting\b/i,
  /\bi.?m interested\b/i,
  /\bplease (call|contact|reach|text)\b/i,
  /\bcan you (call|come|send)\b/i,
];

const NOT_INTERESTED_PATTERNS: RegExp[] = [
  /\bno\b/i,
  /\bnope\b/i,
  /\bnah\b/i,
  /\bno thanks\b/i,
  /\bno thank you\b/i,
  /\bnot interested\b/i,
  /\bdon.?t (contact|text|call|reach|bother)\b/i,
  /\bdo not (contact|text|call|reach|bother)\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bleave me alone\b/i,
  /\bstop (contact|text|calling|reaching)\b/i,
  /\bnot looking\b/i,
  /\bnot in the market\b/i,
  /\bwrong number\b/i,
];

/**
 * Classify inbound reply intent.
 *
 * Bias: ambiguous → "neutral". Only return "interested" on a clear positive
 * signal, never on a weak or mixed signal.
 */
export function classifyInterest(
  body: string,
): "interested" | "not_interested" | "neutral" {
  if (!body) return "neutral";

  // not_interested is checked first — an explicit rejection wins even if the
  // message also contains an interested-sounding word.
  for (const pattern of NOT_INTERESTED_PATTERNS) {
    if (pattern.test(body)) return "not_interested";
  }

  for (const pattern of INTERESTED_PATTERNS) {
    if (pattern.test(body)) return "interested";
  }

  return "neutral";
}
