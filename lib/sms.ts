/**
 * lib/sms.ts — SMS message rendering + segment/name utilities.
 * Pure, synchronous, no side effects, no network/DB/SDK imports.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Variant = "A" | "B" | "C";

export interface Contact {
  firstName?: string | null;
  zip?: string | null;
  /** Situs street address (county data is ALL CAPS — title-cased before sending). */
  address?: string | null;
}

export interface SegmentInfo {
  length: number;
  segments: number;
  encoding: "GSM-7" | "UCS-2";
}

// ---------------------------------------------------------------------------
// isNonHumanName
// ---------------------------------------------------------------------------

/**
 * Returns true when `name` is absent or looks like a non-human entity.
 *
 * Detection rules (case-insensitive):
 *  1. Null, undefined, or blank/whitespace → true.
 *  2. Contains digits (e.g. "Unit 2B") → true.
 *  3. Exact-word match against a set of known entity suffixes/keywords:
 *     LLC, LLP, INC, CORP, CO, LP, LTD, TRUST, ESTATE, FOUNDATION,
 *     PARTNERS, HOLDINGS, ASSOC, ASSOCIATION, GROUP → true.
 *  4. All-uppercase multi-word string (two or more words, every letter caps)
 *     looks like an entity name typed by a title company → true.
 *  5. Single-character "words" alone (one character total) → not a real first name → true.
 *     (Two-char names like "Li" or "Jo" are valid; do not flag them.)
 */
export function isNonHumanName(name?: string | null): boolean {
  // Rule 1: missing / blank
  if (!name || !name.trim()) return true;

  const trimmed = name.trim();

  // Rule 2: contains any digit
  if (/\d/.test(trimmed)) return true;

  // Rule 3: word-boundary match against entity keyword set
  const entityKeywords = [
    "LLC", "LLP", "INC", "CORP", "CO", "LP", "LTD",
    "TRUST", "ESTATE", "FOUNDATION", "PARTNERS", "HOLDINGS",
    "ASSOC", "ASSOCIATION", "GROUP",
  ];
  const upperTrimmed = trimmed.toUpperCase();
  for (const keyword of entityKeywords) {
    // Match as a whole word so "Scott" doesn't trip on "CO" inside "Scott"
    const wordBoundary = new RegExp(`\\b${keyword}\\b`);
    if (wordBoundary.test(upperTrimmed)) return true;
  }

  // Rule 4: all-uppercase, multi-word string (entity typed in caps)
  const words = trimmed.split(/\s+/);
  if (
    words.length >= 2 &&
    trimmed === trimmed.toUpperCase() &&
    /[A-Z]/.test(trimmed) // make sure it has letters, not just symbols
  ) {
    return true;
  }

  // Rule 5: single-character single "word" — not a real first name
  if (words.length === 1 && words[0].length === 1) return true;

  return false;
}

// ---------------------------------------------------------------------------
// renderMessage
// ---------------------------------------------------------------------------

// The default opt-out suffix that MUST appear at the end of every message when a client has not
// configured its own. Talan (client 1) keeps this verbatim. Per-client clients can advertise a
// different visible instruction (e.g. Reply "2" to opt out) via optOutInstructionFor — but STOP
// always keeps working at the classifier + carrier level regardless of the visible copy.
const OPT_OUT_PHRASE = "Reply STOP to opt out.";

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Derive a client's visible opt-out instruction line from its config. Pure (no DB) so the operator
 * UI preview can call it client-side too.
 *  - an explicit `instruction` wins verbatim (operator typed the exact line);
 *  - else a configured `keyword` yields `Reply "<keyword>" to opt out`;
 *  - else the default `Reply STOP to opt out` (Talan / any STOP-only client).
 * NOTE (operator choice, documented): advertising a non-STOP keyword does NOT disable STOP — carriers
 * honor STOP at the carrier level no matter the visible copy, and 10DLC traffic that omits standard
 * STOP language can see more carrier filtering. STOP stays authoritative in the classifier (isOptOut)
 * regardless of what this line says.
 */
export function optOutInstructionFor(
  keyword?: string | null,
  instruction?: string | null
): string {
  if (instruction && instruction.trim()) return instruction.trim();
  const kw = keyword?.trim();
  if (kw) return `Reply "${kw}" to opt out`;
  return "Reply STOP to opt out";
}

/**
 * The approved Talan (client 1) message template — kept here as the TS-side source of truth for
 * tests and as documentation. The SEEDED client row in db/schema.sql MUST match this exact string
 * (the migration carries the same copy). In v2 the live template is read from the client record
 * (clients.message_template), NOT this constant — but client 1's record equals this verbatim, so
 * rendering is byte-identical to the v1 pilot.
 *
 * Convention: [NAME]/[ADDRESS]/[BIZ]/[ZIP] are merge placeholders. A {...} span is an OPTIONAL
 * clause dropped only when keeping it would push the message past one GSM-7 segment (or when a
 * placeholder inside it resolves empty). Talan's "{ at [ADDRESS]}" reproduces the v1 single-segment
 * auto-fallback exactly: kept when it fits, dropped (with its leading " at ") when it doesn't.
 */
export const TALAN_MESSAGE_TEMPLATE =
  "Hey [NAME] busy season is here, we are working close by if you were interested in window cleaning services{ at [ADDRESS]}. Reply STOP to opt out";

/**
 * Title-cases a string: each whitespace-delimited token gets a leading capital and
 * the rest lower-cased. County roll data arrives ALL CAPS (e.g. "7445 BUCK LAKE RD",
 * "ROBERT") — we never send caps. Returns "" for null/blank input.
 */
function titleCase(value?: string | null): string {
  if (!value || !value.trim()) return "";
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * Renders an outbound SMS from a per-client TEMPLATE (clients.message_template) — v2 Module V1.
 *
 * The template is plain copy with merge placeholders and an optional droppable clause:
 *  - [NAME]    → firstName, title-cased; falls back to "there" for blank/entity names, so
 *               "Hey [NAME]" becomes "Hey there" (preserves the v1 fallback exactly).
 *  - [ADDRESS] → contact.address, title-cased (county data is ALL CAPS → never sent caps).
 *  - [BIZ]     → bizName (for branded clients; Talan's copy has no [BIZ]).
 *  - [ZIP]     → contact.zip, or "your area" when missing.
 *  - {...}     → an OPTIONAL clause. Kept when it fits one GSM-7 segment AND every placeholder
 *               inside it resolved non-empty; otherwise the whole span (incl. its leading text,
 *               e.g. " at ") is dropped. This reproduces Talan's single-segment auto-fallback:
 *               the address clause stays when it fits and is dropped when it would overflow.
 *
 * Hard requirement: every returned string MUST carry an opt-out line. By default that line is
 * "Reply STOP to opt out" (OPT_OUT_PHRASE); a per-client client passes its configured instruction
 * (e.g. `Reply "2" to opt out`) as `optOutInstruction`. The safety guard below checks for THAT
 * client's line at the end and appends it only if missing — so a "2"-opt-out client never gets a
 * second/contradictory STOP line, and Talan (default instruction) stays byte-identical to v1.
 */
export function renderMessage(
  template: string,
  contact: Contact,
  bizName = "",
  optOutInstruction: string = OPT_OUT_PHRASE
): string {
  const useName =
    contact.firstName && !isNonHumanName(contact.firstName)
      ? titleCase(contact.firstName)
      : "there";
  const vals: Record<string, string> = {
    "[NAME]": useName,
    "[ADDRESS]": titleCase(contact.address),
    "[BIZ]": bizName,
    "[ZIP]": contact.zip?.trim() || "your area",
  };

  const subst = (s: string): string =>
    s.replace(/\[NAME\]|\[ADDRESS\]|\[BIZ\]|\[ZIP\]/g, (m) => vals[m] ?? m);

  // Split the optional {...} clause (at most one is supported, which covers every current template).
  const clauseMatch = template.match(/\{([^}]*)\}/);
  let message: string;
  if (!clauseMatch) {
    message = subst(template);
  } else {
    const rawClause = clauseMatch[1];
    const full = subst(template.replace(/\{([^}]*)\}/, "$1"));
    const dropped = subst(template.replace(/\{[^}]*\}/, ""));
    // Drop the clause if a placeholder inside it resolved empty, or keeping it overflows a segment.
    const clauseHasEmpty = Object.entries(vals).some(
      ([k, v]) => v === "" && rawClause.includes(k)
    );
    message = clauseHasEmpty || !withinSingleSegment(full) ? dropped : full;
  }

  // Collapse any double space left by a dropped placeholder, and tidy a stray space before
  // punctuation, so output stays clean regardless of where a clause was removed.
  message = message.replace(/ {2,}/g, " ").replace(/ +([.,!?])/g, "$1").trim();

  // Safety guard: every message must carry THIS client's opt-out line, and never a second/contradictory
  // one. We match the configured instruction at the end (trailing period optional, so Talan's verbatim
  // period-less "Reply STOP to opt out" passes unchanged), and append the instruction only when missing.
  const line = optOutInstruction.trim() || OPT_OUT_PHRASE;
  const lineBase = line.replace(/\.\s*$/, ""); // strip a trailing period for the end-of-message check
  const endRe = new RegExp(`${escapeRegExp(lineBase)}\\.?$`);
  if (!endRe.test(message)) {
    message = `${message.trimEnd()} ${line}`;
  }

  return message;
}

// ---------------------------------------------------------------------------
// segmentInfo / withinSingleSegment
// ---------------------------------------------------------------------------

/**
 * The GSM 03.38 basic character set (excluding the extension table — extended
 * chars like { } [ ] \ ^ ~ | € count as 2 GSM units each, but for segment
 * counting purposes we include them in the "GSM-7" encoding bucket and account
 * for the double-unit cost).
 *
 * We use a Set of the printable characters for fast lookup.
 */
const GSM7_BASIC_CHARS = new Set<string>(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);

/**
 * GSM 03.38 extension table characters — each counts as 2 units when encoding.
 */
const GSM7_EXTENSION_CHARS = new Set<string>(
  "{}[]\\^~|€\f"  // \f = form feed (0x0A in extension table)
);

/**
 * Counts the number of GSM-7 units a message occupies.
 * Extension characters count as 2 units each.
 * Returns null if the message contains non-GSM characters.
 */
function gsm7Units(message: string): number | null {
  let units = 0;
  for (const ch of message) {
    if (GSM7_BASIC_CHARS.has(ch)) {
      units += 1;
    } else if (GSM7_EXTENSION_CHARS.has(ch)) {
      units += 2;
    } else {
      return null; // not GSM-7 encodable
    }
  }
  return units;
}

/**
 * Returns segment count and encoding details for a given message string.
 *
 * GSM-7 rules:
 *   Single message:    160 units max → 1 segment
 *   Multipart:         153 units per segment (7 used for UDH header)
 *
 * UCS-2 rules:
 *   Single message:    70 chars max → 1 segment
 *   Multipart:         67 chars per segment
 */
export function segmentInfo(message: string): SegmentInfo {
  const units = gsm7Units(message);

  if (units !== null) {
    // GSM-7 encoding
    const length = message.length; // character count (display length)
    let segments: number;
    if (units <= 160) {
      segments = 1;
    } else {
      segments = Math.ceil(units / 153);
    }
    return { length, segments, encoding: "GSM-7" };
  }

  // UCS-2 encoding (Unicode)
  const length = message.length;
  let segments: number;
  if (length <= 70) {
    segments = 1;
  } else {
    segments = Math.ceil(length / 67);
  }
  return { length, segments, encoding: "UCS-2" };
}

/**
 * Returns true if the message fits within a single SMS segment.
 */
export function withinSingleSegment(message: string): boolean {
  return segmentInfo(message).segments === 1;
}
