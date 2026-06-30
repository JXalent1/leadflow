/**
 * components/cockpit-view.tsx — the operator cockpit (read-only, server-rendered). (v2 Module V4;
 * minimal-premium overhaul.)
 *
 * A KPI row of bordered stat cells + a dense clients table: Client / Pace (dot + muted label) /
 * Leads·cycle (thin progress + N/T) / Sent / Opt-out. Behind-pace-first ordering comes from
 * getCockpitData (unchanged); clicking a row opens that client's scoped dashboard (?clientId=). Each
 * row also carries the per-client Edit launcher + track-only billing (stop-propagating so they don't
 * trigger the row's drill-through). No writes, no client-facing data — operator surface only.
 */

import type { CockpitData, CockpitRow } from "@/lib/cockpit";
import type { Pace } from "@/lib/billing-cycle";
import type { Client } from "@/lib/clients";
import type { DotTone } from "./ui/status-dot";
import Card from "./ui/card";
import Badge from "./ui/badge";
import ProgressBar from "./ui/progress-bar";
import StatTile from "./ui/stat-tile";
import StatusDot from "./ui/status-dot";
import { PauseIcon } from "./ui/icons";
import CockpitBilling from "./cockpit-billing";
import { ClientFormLauncher, type ClientFormValues } from "./client-form";

const PACE: Record<Pace, { text: string; dot: DotTone; bar: "success" | "warning" | "danger" }> = {
  behind: { text: "Behind pace", dot: "warning", bar: "warning" },
  on_track: { text: "On track", dot: "success", bar: "success" },
  met: { text: "Met", dot: "success", bar: "success" },
};

/** Map a full Client record to the serializable subset the Add/Edit form reads/writes. */
function toFormValues(c: Client): ClientFormValues {
  return {
    id: c.id,
    name: c.name,
    biz_name: c.biz_name,
    from_number: c.from_number,
    messaging_service_sid: c.messaging_service_sid,
    message_template: c.message_template,
    forward_phone: c.forward_phone,
    optout_keyword: c.optout_keyword,
    optout_instruction: c.optout_instruction,
    send_window_start_hour: c.send_window_start_hour,
    send_window_end_hour: c.send_window_end_hour,
    send_timezone: c.send_timezone,
    send_rate_per_hour: c.send_rate_per_hour,
    lead_guarantee: c.lead_guarantee,
    lead_target: c.lead_target,
    target_period: c.target_period,
    ai_enabled: c.ai_enabled,
    ai_services: c.ai_services,
    ai_offer: c.ai_offer,
    ai_persona: c.ai_persona,
    ai_location: c.ai_location,
  };
}

export default function CockpitView({
  data,
  clients,
}: {
  data: CockpitData;
  clients: Client[];
}) {
  const configById = new Map(clients.map((c) => [c.id, toFormValues(c)]));

  if (data.rows.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <ClientFormLauncher mode="create" />
        </div>
        <Card className="bg-amber-50/60 text-sm text-amber-800">
          No clients yet. Use “New client” to onboard one.
        </Card>
      </div>
    );
  }

  const onPace = data.totalClients - data.behindCount;

  return (
    <section className="flex flex-col gap-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Clients" value={data.totalClients} />
        <StatTile
          label="Behind pace"
          value={data.behindCount}
          tone={data.behindCount > 0 ? "warn" : "default"}
        />
        <StatTile label="On pace" value={onPace} tone={onPace > 0 ? "lead" : "default"} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">Clients</h2>
        <ClientFormLauncher mode="create" />
      </div>

      {/* Dense clients table */}
      <Card padded={false}>
        {/* Column header (sm+) */}
        <div className="hidden border-b px-4 py-2.5 text-xs text-ink-subtle sm:grid sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.8fr)_minmax(0,0.7fr)_minmax(0,0.7fr)] sm:gap-4">
          <span>Client</span>
          <span>Pace</span>
          <span>Leads · cycle</span>
          <span className="text-right">Sent</span>
          <span className="text-right">Opt-out</span>
        </div>

        <div className="divide-y">
          {data.rows.map((row) => (
            <ClientRow key={row.clientId} row={row} config={configById.get(row.clientId)} />
          ))}
        </div>
      </Card>
    </section>
  );
}

function ClientRow({ row, config }: { row: CockpitRow; config?: ClientFormValues }) {
  const pace = PACE[row.pace];
  const pct = row.guarantee > 0 ? Math.min(100, Math.round((row.leads / row.guarantee) * 100)) : 0;
  const initial = row.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <a
      href={`/dashboard?clientId=${row.clientId}`}
      className="block px-4 py-3.5 transition-colors hover:bg-surface-muted"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.8fr)_minmax(0,0.7fr)_minmax(0,0.7fr)] sm:items-center sm:gap-4">
        {/* Client */}
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-xs font-medium text-ink-muted">
            {initial}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-ink">{row.name}</span>
              {row.status !== "active" ? (
                <Badge tone="neutral" className="capitalize">
                  {row.status}
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-ink-subtle">
              {row.daysLeft} day{row.daysLeft === 1 ? "" : "s"} left
            </p>
          </div>
        </div>

        {/* Pace */}
        <div className="flex items-center">
          <StatusDot tone={pace.dot}>{pace.text}</StatusDot>
        </div>

        {/* Leads · cycle */}
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="tabular-nums text-ink">
              <span className="font-medium">{row.leads}</span>
              <span className="text-ink-subtle"> / {row.guarantee}</span>
            </span>
            {row.pace === "behind" ? (
              <span className="text-xs tabular-nums text-amber-700">~{row.expected} expected</span>
            ) : null}
          </div>
          <ProgressBar value={pct} tone={pace.bar} className="mt-1.5" />
        </div>

        {/* Sent */}
        <div className="text-sm tabular-nums text-ink-muted sm:text-right">
          <span className="text-ink-subtle sm:hidden">Sent: </span>
          {row.sent.toLocaleString()}
        </div>

        {/* Opt-out */}
        <div className="text-sm tabular-nums text-ink-muted sm:text-right">
          <span className="text-ink-subtle sm:hidden">Opt-out: </span>
          {row.optOutRatePct}%
        </div>
      </div>

      {/* Secondary line: reply rate · auto-pause · billing + edit (kept for behavior parity) */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-xs text-ink-subtle">
        <span className="tabular-nums">Reply rate {row.replyRatePct}%</span>
        {row.autoPaused ? (
          <Badge tone="brand">
            <PauseIcon className="h-3 w-3" />
            Auto-paused · {row.leadsThisPeriod}/{row.target} this {row.targetPeriod}
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {config ? (
            <ClientFormLauncher
              mode="edit"
              client={config}
              triggerLabel="Edit"
              triggerVariant="secondary"
              triggerSize="sm"
              stopPropagation
            />
          ) : null}
        </div>

        <div className="w-full">
          <CockpitBilling
            clientId={row.clientId}
            status={row.invoiceStatus}
            amountCents={row.planAmountCents}
            nextBillDate={row.nextBillDate}
          />
        </div>
      </div>
    </a>
  );
}
