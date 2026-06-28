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
import type { Client } from "@/lib/clients";
import type { Tone } from "./ui/badge";
import Card from "./ui/card";
import Badge from "./ui/badge";
import ProgressBar from "./ui/progress-bar";
import StatTile from "./ui/stat-tile";
import { CheckIcon, PauseIcon, SparkleIcon } from "./ui/icons";
import CockpitBilling from "./cockpit-billing";
import { ClientFormLauncher, type ClientFormValues } from "./client-form";

const PACE: Record<Pace, { text: string; tone: Tone; bar: "success" | "warning" | "danger" }> = {
  behind: { text: "Behind pace", tone: "warning", bar: "warning" },
  on_track: { text: "On track", tone: "success", bar: "success" },
  met: { text: "Met", tone: "success", bar: "success" },
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

      <div className="flex justify-end">
        <ClientFormLauncher mode="create" />
      </div>

      <div className="grid gap-4">
        {data.rows.map((row) => (
          <ClientCard key={row.clientId} row={row} config={configById.get(row.clientId)} />
        ))}
      </div>
    </section>
  );
}

function ClientCard({ row, config }: { row: CockpitRow; config?: ClientFormValues }) {
  const pace = PACE[row.pace];
  const pct = row.guarantee > 0 ? Math.min(100, Math.round((row.leads / row.guarantee) * 100)) : 0;

  return (
    <Card href={`/dashboard?clientId=${row.clientId}`} interactive>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand-tint-fg">
            <SparkleIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-medium text-stone-900">{row.name}</h2>
              {row.status !== "active" ? (
                <Badge tone="neutral" className="capitalize">
                  {row.status}
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-stone-500">
              {row.daysLeft} day{row.daysLeft === 1 ? "" : "s"} left in cycle
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
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
            <Badge tone={pace.tone}>
              {row.pace === "met" ? <CheckIcon className="h-3 w-3" /> : null}
              {pace.text}
            </Badge>
          </div>
          {row.autoPaused ? (
            <Badge tone="brand">
              <PauseIcon className="h-3 w-3" />
              Auto-paused · {row.leadsThisPeriod}/{row.target} this {row.targetPeriod}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-3xl font-medium tabular-nums text-stone-900">{row.leads}</span>
        <span className="text-lg text-stone-400">/ {row.guarantee} leads</span>
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
    <div className="rounded-xl bg-stone-50 px-3 py-2">
      <div className="text-base font-medium tabular-nums text-stone-900">{value}</div>
      <div className="mt-0.5 text-[11px] text-stone-500">{label}</div>
    </div>
  );
}
