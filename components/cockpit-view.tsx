/**
 * components/cockpit-view.tsx — the operator cockpit (read-only, server-rendered). (v2 Module V4)
 *
 * Renders every client at a glance, centered on leads-this-cycle vs. their lead guarantee, with the
 * behind/on-track/met pace flag and a quick campaign-health read. Clicking a client opens their
 * scoped dashboard (?clientId=). No writes, no client-facing data — operator surface only.
 */

import type { CockpitData, CockpitRow } from "@/lib/cockpit";
import type { Pace } from "@/lib/billing-cycle";
import CockpitBilling from "./cockpit-billing";

const PACE_BADGE: Record<Pace, { text: string; cls: string }> = {
  behind: { text: "Behind pace", cls: "bg-red-100 text-red-800" },
  on_track: { text: "On track", cls: "bg-green-100 text-green-800" },
  met: { text: "Met ✓", cls: "bg-blue-100 text-blue-800" },
};

const BAR_FILL: Record<Pace, string> = {
  behind: "bg-red-500",
  on_track: "bg-green-500",
  met: "bg-blue-500",
};

export default function CockpitView({ data }: { data: CockpitData }) {
  if (data.rows.length === 0) {
    return (
      <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
        No clients yet.
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-4 text-sm">
        <span className="text-neutral-500">
          {data.totalClients} client{data.totalClients === 1 ? "" : "s"}
        </span>
        {data.behindCount > 0 ? (
          <span className="font-medium text-red-700">
            {data.behindCount} behind pace — push more campaigns
          </span>
        ) : (
          <span className="font-medium text-green-700">All clients on pace</span>
        )}
      </div>

      <div className="grid gap-3">
        {data.rows.map((row) => (
          <ClientCard key={row.clientId} row={row} />
        ))}
      </div>
    </section>
  );
}

function ClientCard({ row }: { row: CockpitRow }) {
  const badge = PACE_BADGE[row.pace];
  const pct = row.guarantee > 0 ? Math.min(100, Math.round((row.leads / row.guarantee) * 100)) : 0;

  return (
    <a
      href={`/dashboard?clientId=${row.clientId}`}
      className="block rounded-lg border border-neutral-200 bg-white p-5 transition hover:border-neutral-400 hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{row.name}</h2>
            {row.status !== "active" ? (
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs uppercase tracking-wide text-neutral-600">
                {row.status}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-neutral-500">
            {row.daysLeft} day{row.daysLeft === 1 ? "" : "s"} left in cycle
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${badge.cls}`}>
            {badge.text}
          </span>
          {row.autoPaused ? (
            <span className="rounded-full bg-purple-100 px-3 py-1 text-xs font-medium text-purple-800">
              ⏸ Auto-paused · target met ({row.leadsThisPeriod}/{row.target} this {row.targetPeriod})
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums">{row.leads}</span>
        <span className="text-lg text-neutral-400">/ {row.guarantee} leads</span>
        {row.pace === "behind" ? (
          <span className="ml-auto text-xs text-red-700">
            ~{row.expected} expected by now
          </span>
        ) : null}
      </div>

      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className={`h-full ${BAR_FILL[row.pace]}`}
          style={{ width: `${pct}%` }}
          aria-hidden
        />
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <Health label="Sent this cycle" value={row.sent.toLocaleString()} />
        <Health label="Reply rate" value={`${row.replyRatePct}%`} />
        <Health label="Opt-out rate" value={`${row.optOutRatePct}%`} />
      </dl>

      <CockpitBilling
        clientId={row.clientId}
        status={row.invoiceStatus}
        amountCents={row.planAmountCents}
        nextBillDate={row.nextBillDate}
      />
    </a>
  );
}

function Health({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
    </div>
  );
}
