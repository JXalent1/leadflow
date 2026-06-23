/**
 * lib/lead-status.ts — the lead funnel values. (Session 7)
 *
 * Pure module (no DB / SDK imports) so both the server (lib/db, /api/leads) and client
 * components (the inbox lead-status dropdown) can share one source of truth without
 * pulling the Neon driver into the browser bundle.
 */
export const LEAD_STATUSES = [
  "new",
  "contacted",
  "quoted",
  "scheduled",
  "won",
  "lost",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
