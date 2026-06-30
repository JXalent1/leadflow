"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PortalData } from "@/lib/portal";
import type { Pace } from "@/lib/billing-cycle";
import { formatTime } from "../dashboard-utils";

/**
 * The client portal view (read-only). Shows progress to the monthly lead guarantee + the client's
 * own leads feed, and re-polls the scoped /api/portal so new leads appear without a refresh. There
 * are NO controls here — a client can only watch their leads land.
 */

const PACE_BADGE: Record<Pace, { text: string; cls: string }> = {
  behind: { text: "Working on it", cls: "bg-amber-50 text-amber-700" },
  on_track: { text: "On track", cls: "bg-emerald-50 text-emerald-700" },
  met: { text: "Guarantee met ✓", cls: "bg-brand-tint text-brand-tint-fg" },
};

export default function PortalClient({ initial }: { initial: PortalData }) {
  const [data, setData] = useState<PortalData>(initial);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/portal", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as PortalData);
    } catch {
      // transient — keep the last good snapshot
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  const badge = PACE_BADGE[data.pace];
  const pct =
    data.guarantee > 0 ? Math.min(100, Math.round((data.leadsThisCycle / data.guarantee) * 100)) : 0;

  return (
    <div className="flex flex-col gap-8">
      {/* Progress to the guarantee */}
      <section className="rounded-2xl border bg-surface p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-ink-subtle">Leads this month</p>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-4xl font-medium tabular-nums text-ink">{data.leadsThisCycle}</span>
              <span className="text-lg text-ink-subtle">/ {data.guarantee} guaranteed</span>
            </div>
          </div>
          <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${badge.cls}`}>
            {badge.text}
          </span>
        </div>
        <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full bg-brand" style={{ width: `${pct}%` }} aria-hidden />
        </div>
        <p className="mt-2 text-xs text-ink-subtle">
          {data.daysLeft} day{data.daysLeft === 1 ? "" : "s"} left in this cycle
        </p>
        {data.targetMet ? (
          <p className="mt-3 rounded-lg border border-brand-tint bg-brand-tint px-3 py-2 text-xs text-brand-tint-fg">
            ✓ You&apos;ve hit this period&apos;s lead target — new outreach is paused and resumes{" "}
            {data.targetResetsOn}.
          </p>
        ) : null}
      </section>

      {/* Leads feed */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium tracking-tight text-ink">Your leads</h2>
        {data.recentLeads.length === 0 ? (
          <p className="rounded-xl border bg-surface-muted px-4 py-6 text-center text-sm text-ink-subtle">
            No leads yet — they&apos;ll show up here as they come in.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.recentLeads.map((lead) => (
              <li
                key={lead.id}
                className="rounded-xl border bg-surface p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{lead.name}</p>
                    {lead.address ? (
                      <p className="text-sm text-ink-subtle">{lead.address}</p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    {lead.phone ? (
                      <a href={`tel:${lead.phone}`} className="text-sm font-medium text-brand-strong">
                        {lead.phone}
                      </a>
                    ) : null}
                    <p className="text-xs text-ink-subtle">{formatTime(lead.createdAt)}</p>
                  </div>
                </div>
                {lead.replyText ? (
                  <p className="mt-2 rounded bg-surface-muted px-3 py-2 text-sm text-ink-muted">
                    “{lead.replyText}”
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
