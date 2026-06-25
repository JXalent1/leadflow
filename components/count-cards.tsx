import type { DashboardCounts } from "@/lib/dashboard";
import StatTile from "./ui/stat-tile";

type Tone = "default" | "good" | "warn" | "lead" | "danger";

/** The status count tiles. Eligible / Sent / Leads are emphasized; in-flight/failed warn. */
export default function CountCards({ counts }: { counts: DashboardCounts }) {
  const cards: { label: string; value: number; tone?: Tone }[] = [
    { label: "Total contacts", value: counts.total },
    { label: "With phone", value: counts.withPhone },
    { label: "Scrubbed clean", value: counts.scrubbedClean },
    { label: "Eligible", value: counts.eligible, tone: "good" },
    { label: "Sent", value: counts.sent, tone: "good" },
    { label: "Pending", value: counts.pending },
    { label: "In flight", value: counts.inFlight, tone: counts.inFlight > 0 ? "warn" : "default" },
    { label: "Failed", value: counts.failed, tone: counts.failed > 0 ? "danger" : "default" },
    { label: "Suppressed", value: counts.suppressed },
    { label: "Opted out", value: counts.optedOut },
    { label: "Leads", value: counts.leads, tone: "lead" },
  ];

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => (
        <StatTile key={c.label} label={c.label} value={c.value.toLocaleString()} tone={c.tone} />
      ))}
    </section>
  );
}
