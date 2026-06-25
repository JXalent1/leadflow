/**
 * components/cockpit-view.tsx — the operator cockpit (read-only, server-rendered). (v2 Module V4;
 * V7 redesign.)
 *
 * Renders every client at a glance, centered on leads-this-cycle vs. their lead guarantee, with the
 * behind/on-track/met pace flag and a quick campaign-health read. Clicking a client opens their
 * scoped dashboard (?clientId=). No writes, no client-facing data — operator surface only. The
 * behind-pace-first ordering comes from getCockpitData (unchanged).
 */

import type { CockpitData, CockpitRow } from "@/lib/cockpit";
import type { Pace } from "@/lib/billing-cycle";
import type { Tone } from "./ui/badge";
import Card from "./ui/card";
import Badge from "./ui/badge";
import ProgressBar from "./ui/progress-bar";
import StatTile from "./ui/stat-tile";
import { CheckIcon, PauseIcon } from "./ui/icons";
import CockpitBilling from "./cockpit-billing";

const PACE: Record<Pace, { text: string; tone: Tone; bar: "success" | "warning" | "danger" }> = {
  behind: { text: "Behind pace", tone: "warning", bar: "warning" },
  on_track: { text: "On track", tone: "success", bar: "success" },
  met: { text: "Met", tone: "success", bar: "success" },
};

export default function CockpitView({ data }: { data: CockpitData }) {
  if (data.rows.length === 0) {
    return (
      <Card className="bg-amber-50/60 text-sm text-amber-800">No clients yet.</Card>
    );
  }

  const onPace = data.totalClients - data.behindCount;

  return (
    <section className="flex flex-col gap-6">
      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Clients" value={data.totalClients} />
        <StatTile
          label="Behind pace"
          value={data.behindCount}
          tone={data.behindCount > 0 ? "warn" : "default"}
        />
        <StatTile label="On pace" value={onPace} tone={onPace > 0 ? "lead" : "default"} />
      </div>

      <div className="grid gap-4">
        {data.rows.map((row) => (
          <ClientCard key={row.clientId} row={row} />
        ))}
      </div>
    </section>
  );
}

function ClientCard({ row }: { row: CockpitRow }) {
  const pace = PACE[row.pace];
  const pct = row.guarantee > 0 ? Math.min(100, Math.round((row.leads / row.guarantee) * 100)) : 0;

  return (
    <Card href={`/dashboard?clientId=${row.clientId}`} interactive>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-slate-900">{row.name}</h2>
            {row.status !== "active" ? (
              <Badge tone="neutral" className="uppercase tracking-wide">
                {row.status}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {row.daysLeft} day{row.daysLeft === 1 ? "" : "s"} left in cycle
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone={pace.tone}>
            {row.pace === "met" ? <CheckIcon className="h-3 w-3" /> : null}
            {pace.text}
          </Badge>
          {row.autoPaused ? (
            <Badge tone="indigo">
              <PauseIcon className="h-3 w-3" />
              Auto-paused · {row.leadsThisPeriod}/{row.target} this {row.targetPeriod}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-slate-900">{row.leads}</span>
        <span className="text-lg text-slate-400">/ {row.guarantee} leads</span>
        {row.pace === "behind" ? (
          <span className="ml-auto text-xs font-medium text-amber-700">
            ~{row.expected} expected by now
          </span>
        ) : null}
      </div>

      <ProgressBar value={pct} tone={pace.bar} className="mt-2.5" />

      <div className="mt-4 grid grid-cols-3 gap-3">
        <Health label="Sent this cycle" value={row.sent.toLocaleString()} />
        <Health label="Reply rate" value={`${row.replyRatePct}%`} />
        <Health label="Opt-out rate" value={`${row.optOutRatePct}%`} />
      </div>

      <CockpitBilling
        clientId={row.clientId}
        status={row.invoiceStatus}
        amountCents={row.planAmountCents}
        nextBillDate={row.nextBillDate}
      />
    </Card>
  );
}

function Health({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-base font-semibold tabular-nums text-slate-900">{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}
