// Small presentational helpers shared across the dashboard components.

/** Build a display name from first/last, falling back to a phone or "Unknown". */
export function displayName(
  firstName: string | null,
  lastName: string | null,
  phone?: string | null,
): string {
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (phone) return phone;
  return "Unknown";
}

/** Format an ISO/Postgres timestamp for the operator's locale; "" if absent. */
export function formatTime(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
