/**
 * lib/forward-phones.ts — parse a free-text forward_phone field into a list of recipients.
 *
 * Pure + dependency-free (no DB, no SDK) so BOTH the server lead-forward path (lib/forward.ts) and
 * the operator form (components/client-form.tsx, a client component) can use it. A client's
 * forward_phone may hold ONE number (today's behavior, unchanged) or SEVERAL numbers so a lead pings
 * more than one person (e.g. the operator + the client owner).
 */

/**
 * Split forward_phone into a deduped list of recipient numbers.
 *  - separators: comma, semicolon, any whitespace, newlines;
 *  - blanks are dropped;
 *  - deduped by last-10 digits (the same canonical key used everywhere for phone identity), so
 *    "+18508213720" and "850-821-3720" collapse to one recipient (first form kept);
 *  - a single number → a one-element list (byte-for-byte the same recipient as before);
 *  - empty / null / undefined → [].
 */
export function parseForwardPhones(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    // Canonical identity = last 10 digits. Fall back to the raw token if it has no digits, so a
    // clearly-bad entry still de-dupes against itself rather than collapsing every bad entry to "".
    const digits = p.replace(/[^0-9]/g, "");
    const key = digits ? digits.slice(-10) : p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Loose "looks like a phone number" check for non-blocking UI validation. True when the entry has
 * 10–15 digits (NANP through full E.164), optionally prefixed with '+'. Intentionally permissive —
 * it only flags clearly-wrong entries (e.g. "call me"), never blocks saving.
 */
export function isProbablyPhone(entry: string): boolean {
  const t = entry.trim();
  if (!t) return false;
  const digits = t.replace(/[^0-9]/g, "");
  return digits.length >= 10 && digits.length <= 15;
}
