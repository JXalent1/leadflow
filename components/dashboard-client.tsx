"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardData } from "@/lib/dashboard";
import CountCards from "./count-cards";
import SendProgress from "./send-progress";
import CampaignControls from "./campaign-controls";
import LeadsTable from "./leads-table";
import ReplyFeed from "./reply-feed";
import OptOutList from "./opt-out-list";
import { formatTime } from "./dashboard-utils";

/**
 * Client orchestrator. Holds the dashboard snapshot, re-fetches the READ-ONLY
 * /api/dashboard on an interval (faster while a run is active so progress is live),
 * and after any control action. No write logic here — controls hit the existing
 * endpoints; this just refreshes the view.
 */
export default function DashboardClient({ initial }: { initial: DashboardData }) {
  const [data, setData] = useState<DashboardData>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [staleError, setStaleError] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
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
  }, []);

  // Poll: 7s while a run is active (live progress), else 20s.
  useEffect(() => {
    const intervalMs = data.activeRun ? 7000 : 20000;
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [data.activeRun, refresh]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>
          {staleError
            ? "⚠ Could not refresh — showing last good data."
            : `Last updated ${formatTime(data.fetchedAt)}`}
          {refreshing ? " · refreshing…" : ""}
        </span>
        <button onClick={refresh} className="hover:text-neutral-900">
          Refresh now
        </button>
      </div>

      <CountCards counts={data.counts} />

      <SendProgress
        counts={data.counts}
        sendWindow={data.sendWindow}
        activeRun={data.activeRun}
      />

      <CampaignControls
        eligible={data.counts.eligible}
        withinWindow={data.sendWindow.within}
        windowLabel={data.sendWindow.label}
        activeRun={data.activeRun}
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
