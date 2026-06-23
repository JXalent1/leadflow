import type { DashboardCounts } from "@/lib/dashboard";

/**
 * Send-progress bar. Denominator = sent + remaining sendable work (eligible) +
 * in-flight, so the bar reflects how much of the known backlog has gone out.
 */
export default function SendProgress({
  counts,
  sendWindow,
  activeRun,
}: {
  counts: DashboardCounts;
  sendWindow: { within: boolean; label: string };
  activeRun: boolean;
}) {
  const denom = counts.sent + counts.eligible + counts.inFlight;
  const pct = denom > 0 ? Math.round((counts.sent / denom) * 100) : 0;

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Send progress</h2>
        <span className="text-xs text-neutral-500">
          {counts.sent} sent · {counts.eligible} eligible · {counts.inFlight} in flight ·{" "}
          {counts.failed} failed
        </span>
      </div>

      <div className="h-3 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className="h-full rounded-full bg-sky-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-neutral-500">{pct}% of known backlog sent</span>
        <span
          className={
            sendWindow.within ? "text-emerald-600" : "text-neutral-400"
          }
        >
          Send window {sendWindow.within ? "OPEN" : "CLOSED"} · {sendWindow.label}
          {activeRun ? " · run active" : ""}
        </span>
      </div>
    </section>
  );
}
