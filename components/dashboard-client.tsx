"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardData } from "@/lib/dashboard";
import CountCards from "./count-cards";
import SendProgress from "./send-progress";
import PipelineRunner from "./pipeline-runner";
import CampaignControls from "./campaign-controls";
import LeadsTable from "./leads-table";
import ReplyFeed from "./reply-feed";
import OptOutList from "./opt-out-list";
import Badge from "./ui/badge";
import { PauseIcon } from "./ui/icons";
import { formatTime } from "./dashboard-utils";

/**
 * Client orchestrator. Holds the dashboard snapshot, re-fetches the READ-ONLY
 * /api/dashboard on an interval (faster while a run is active so progress is live),
 * and after any control action. No write logic here — controls hit the existing
 * endpoints; this just refreshes the view.
 */
export default function DashboardClient({
  initial,
  clientId,
  campaignId,
}: {
  initial: DashboardData;
  clientId: number;
  campaignId: number;
}) {
  const [data, setData] = useState<DashboardData>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [staleError, setStaleError] = useState(false);
  const inFlight = useRef(false);
  // Every read/action is scoped to the selected client + campaign.
  const scope = `clientId=${clientId}&campaignId=${campaignId}`;

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/dashboard?${scope}`, { cache: "no-store" });
      if (!res.ok) {
        setStaleError(true);
        return;
      }
      const next = (await res.json()) as DashboardData;
      setData(next);
      setStaleError(false);
    } catch {
      setStaleError(true);
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [scope]);

  // Poll: 7s while a run is active (live progress), else 20s.
  useEffect(() => {
    const intervalMs = data.activeRun ? 7000 : 20000;
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [data.activeRun, refresh]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between text-xs text-stone-400">
        <span>
          {staleError
            ? "⚠ Could not refresh — showing last good data."
            : `Last updated ${formatTime(data.fetchedAt)}`}
          {refreshing ? " · refreshing…" : ""}
        </span>
        <button onClick={refresh} className="font-medium hover:text-stone-900">
          Refresh now
        </button>
      </div>

      <CountCards counts={data.counts} />

      <SendProgress
        counts={data.counts}
        sendWindow={data.sendWindow}
        activeRun={data.activeRun}
      />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-stone-500">
          Leads this {data.autoPause.period}:{" "}
          <span className="font-medium tabular-nums text-stone-900">
            {data.autoPause.leadsThisPeriod}/{data.autoPause.target}
          </span>{" "}
          target
        </span>
        {data.autoPause.met ? (
          <Badge tone="brand">
            <PauseIcon className="h-3 w-3" />
            Auto-paused — target met, resumes {data.autoPause.nextPeriod}
          </Badge>
        ) : null}
      </div>

      <PipelineRunner
        scope={scope}
        ratePerHour={data.ratePerHour}
        windowLabel={data.sendWindow.label}
        withinWindow={data.sendWindow.within}
        activeRunId={data.activeRunId}
        onChanged={refresh}
      />

      <CampaignControls
        scope={scope}
        windowLabel={data.sendWindow.label}
        onChanged={refresh}
      />

      <LeadsTable leads={data.recentLeads} />

      <div className="grid gap-6 lg:grid-cols-2">
        <ReplyFeed replies={data.recentInbound} />
        <OptOutList optOuts={data.recentOptOuts} total={data.counts.optedOut} />
      </div>
    </div>
  );
}
