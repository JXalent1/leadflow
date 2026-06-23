import type { DashboardCounts } from "@/lib/dashboard";

/** The status count cards. Eligible / Sent / Leads are emphasized. */
export default function CountCards({ counts }: { counts: DashboardCounts }) {
  const cards: { label: string; value: number; accent?: "good" | "warn" | "lead" }[] = [
    { label: "Total contacts", value: counts.total },
    { label: "With phone", value: counts.withPhone },
    { label: "Scrubbed clean", value: counts.scrubbedClean },
    { label: "Eligible", value: counts.eligible, accent: "good" },
    { label: "Sent", value: counts.sent, accent: "good" },
    { label: "Pending", value: counts.pending },
    { label: "In flight", value: counts.inFlight, accent: counts.inFlight > 0 ? "warn" : undefined },
    { label: "Failed", value: counts.failed, accent: counts.failed > 0 ? "warn" : undefined },
    { label: "Suppressed", value: counts.suppressed },
    { label: "Opted out", value: counts.optedOut },
    { label: "Leads", value: counts.leads, accent: "lead" },
  ];

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => (
        <Card key={c.label} label={c.label} value={c.value} accent={c.accent} />
      ))}
    </section>
  );
}

function Card({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "good" | "warn" | "lead";
}) {
  const accentClass =
    accent === "lead"
      ? "border-emerald-300 bg-emerald-50"
      : accent === "good"
        ? "border-sky-200 bg-sky-50"
        : accent === "warn"
          ? "border-amber-300 bg-amber-50"
          : "border-neutral-200 bg-white";
  return (
    <div className={`rounded-lg border p-3 ${accentClass}`}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-neutral-500">
        {label}
      </div>
    </div>
  );
}
