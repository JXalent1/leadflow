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

// The required opt-out suffix that MUST appear at the end of every message.
const OPT_OUT_PHRASE = "Reply STOP to opt out.";

// The APPROVED pilot opt-out line — Jordan's verbatim copy ends with NO trailing
// period (the only text appended to his wording). Used by variant A. Carriers/CTIA
// require a STOP keyword; the system only suppresses on STOP-family keywords.
const PILOT_OPT_OUT = "Reply STOP to opt out";

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
 * Renders an outbound SMS message.
 *
 * Variant A is the APPROVED PILOT MESSAGE (session-6.md Task 0 / sms-copy.md) —
 * Jordan's exact wording, verbatim, with ONLY "Reply STOP to opt out" appended.
 * No business name, nothing else changed. The pilot runs single-variant (AB_VARIANTS=A),
 * so variant A is what actually sends:
 *   A: "Hey [NAME] busy season is here, we are working close by if you were interested in window cleaning services at [ADDRESS]. Reply STOP to opt out"
 *      → single-segment auto-fallback drops ONLY the "at [address]" clause when the
 *        with-address version would exceed one GSM-7 segment:
 *        "Hey [NAME] busy season is here, we are working close by if you were interested in window cleaning services. Reply STOP to opt out"
 *
 * Variants B and C are the original creative templates (sms-copy.md), kept for a
 * possible future A/B test. They are NOT used in the pilot.
 *   B: "Hey [NAME], it's [BIZ], a local window cleaning crew working in your area this week. Want a quick free quote? No obligation. Reply STOP to opt out."
 *   C: "Hi [NAME], [BIZ] here — we're doing window cleaning in [neighborhood] and have a couple openings this week. Want me to send a free quote? Reply STOP to opt out."
 *
 * Merge rules:
 *  - [NAME]              → firstName, title-cased (or fallback greeting — see below).
 *  - [ADDRESS]          → contact.address, title-cased (variant A only).
 *  - [BIZ]               → bizName (variants B/C only — the pilot copy has no biz name).
 *  - [ZIP/neighborhood]  → zip value (or "your area" if zip missing) (variants B/C).
 *
 * Non-human-name fallback:
 *  Variant A opens with "Hey [NAME]" — fallback becomes "Hey there".
 *  Variant C opens with "Hi [NAME]," — fallback becomes "Hi there,".
 *  Variant B opens with "Hey [NAME]," — fallback becomes "Hey there,".
 *
 * Hard requirement: every returned string MUST carry the "Reply STOP to opt out"
 * opt-out line (variant A omits the trailing period to stay verbatim to Jordan's copy).
 */
export function renderMessage(
  variant: Variant,
  contact: Contact,
  bizName: string
): string {
  const zip = contact.zip?.trim() || "your area";
  const useName =
    contact.firstName && !isNonHumanName(contact.firstName)
      ? contact.firstName.trim()
      : null;

  let message: string;

  switch (variant) {
    case "A": {
      // APPROVED PILOT COPY — Jordan's exact wording, verbatim. The ONLY addition is
      // the "Reply STOP to opt out" line (no trailing period). Do NOT add a business
      // name or change any other words. (session-6.md Task 0 / sms-copy.md.)
      const greeting = useName ? `Hey ${titleCase(useName)}` : "Hey there";
      const addr = titleCase(contact.address);
      const withAddress = `${greeting} busy season is here, we are working close by if you were interested in window cleaning services at ${addr}. ${PILOT_OPT_OUT}`;
      // Single-segment auto-fallback: drop ONLY the "at [address]" clause if the
      // with-address version exceeds one GSM-7 segment (or no address is present),
      // so no eligible contact is skipped for length.
      if (addr && withinSingleSegment(withAddress)) {
        message = withAddress;
      } else {
        message = `${greeting} busy season is here, we are working close by if you were interested in window cleaning services. ${PILOT_OPT_OUT}`;
      }
      break;
    }
    case "B": {
      // Adapted from: "Hey [NAME], it's [BIZ], a local window cleaning crew working in your area this week. Want a quick free quote? No obligation. Reply STOP to opt out."
      // Trimmed slightly to stay under 160 GSM-7 chars with a typical name+biz.
      const greeting = useName ? `Hey ${useName},` : "Hey there,";
      message = `${greeting} it's ${bizName}, a local window cleaning crew in your area this week. Want a free quote? No obligation. ${OPT_OUT_PHRASE}`;
      break;
    }
    case "C": {
      // Adapted from: "Hi [NAME], [BIZ] here — we're doing window cleaning in [neighborhood] and have a couple openings this week. Want me to send a free quote? Reply STOP to opt out."
      // Em dash replaced with " -" (ASCII); copy trimmed to fit one segment.
      const greeting = useName ? `Hi ${useName},` : "Hi there,";
      message = `${greeting} ${bizName} here - we're doing window cleaning in ${zip} this week and have openings. Want a free quote? ${OPT_OUT_PHRASE}`;
      break;
    }
  }

  // Safety assertion: if the opt-out phrase is somehow missing, append it. This
  // should never trigger given the templates above, but is a hard guardrail. The
  // trailing period is optional so variant A's verbatim (period-less) line passes.
  if (!/Reply STOP to opt out\.?$/.test(message)) {
    message = `${message.trimEnd()} ${OPT_OUT_PHRASE}`;
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
