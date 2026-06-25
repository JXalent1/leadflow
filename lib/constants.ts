/**
 * lib/constants.ts — small shared constants with NO heavy imports (no DB driver).
 *
 * Kept dependency-free so pure modules (e.g. lib/access.ts) and their unit tests can import these
 * without pulling in lib/db.ts (which requires DATABASE_URL at import time).
 */

/** The default/first client (Talan). Operator surfaces fall back here when no client is selected. */
export const DEFAULT_CLIENT_ID = 1;
