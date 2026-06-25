/**
 * lib/csv-import.ts — pure CSV → contact-rows parser for the operator's list uploader. (v2 V2)
 *
 * No DB, no I/O: it parses a raw CSV string into validated, deduped NewContact rows plus an
 * import summary, so it unit-tests without a database. The /api/campaigns route does the actual
 * inserts (one per returned row, under a freshly-created campaign).
 *
 * Expected columns (header row, case-insensitive): FirstName, LastName, Address, City, State, Zip.
 * Address is REQUIRED (a contact with no address can't be skip-traced); the rest are optional.
 * Rows are deduped WITHIN the upload by address+zip (uppercased), matching the importer's key.
 */

import { parse } from "csv-parse/sync";
import type { NewContact } from "@/lib/db";

export interface ParsedCsv {
  /** Valid, deduped rows ready to insert. */
  rows: NewContact[];
  /** Data rows seen in the file (excludes the header). */
  read: number;
  /** Rows dropped: missing address OR a within-upload duplicate. */
  skipped: number;
  /** Set when the file can't be used at all (unparseable or no Address column). rows is empty. */
  error?: string;
}

/** Trim a possibly-undefined cell. */
function norm(value: unknown): string {
  return (value == null ? "" : String(value)).trim();
}

/** Pick a column case-insensitively from a parsed row object. */
function pick(row: Record<string, unknown>, lowerKeyMap: Map<string, string>, name: string): string {
  const actual = lowerKeyMap.get(name.toLowerCase());
  return actual ? norm(row[actual]) : "";
}

export function parseContactsCsv(raw: string): ParsedCsv {
  let records: Record<string, unknown>[];
  try {
    records = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as Record<
      string,
      unknown
    >[];
  } catch (err) {
    return { rows: [], read: 0, skipped: 0, error: `Could not parse CSV: ${err instanceof Error ? err.message : "invalid file"}` };
  }

  if (records.length === 0) {
    return { rows: [], read: 0, skipped: 0, error: "The CSV has no data rows." };
  }

  // Build a case-insensitive header lookup from the first record's keys.
  const lowerKeyMap = new Map<string, string>();
  for (const key of Object.keys(records[0])) lowerKeyMap.set(key.toLowerCase(), key);
  if (!lowerKeyMap.has("address")) {
    return { rows: [], read: records.length, skipped: 0, error: "The CSV must have an 'Address' column." };
  }

  const seen = new Set<string>();
  const rows: NewContact[] = [];
  let skipped = 0;

  for (const rec of records) {
    const address = pick(rec, lowerKeyMap, "Address");
    const zip = pick(rec, lowerKeyMap, "Zip");
    if (!address) {
      skipped++;
      continue;
    }
    const key = `${address.toUpperCase()}|${zip}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    rows.push({
      first_name: pick(rec, lowerKeyMap, "FirstName") || null,
      last_name: pick(rec, lowerKeyMap, "LastName") || null,
      address,
      city: pick(rec, lowerKeyMap, "City") || null,
      state: pick(rec, lowerKeyMap, "State") || null,
      zip: zip || null,
    });
  }

  return { rows, read: records.length, skipped };
}
