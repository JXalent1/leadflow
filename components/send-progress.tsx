import type { DashboardCounts } from "@/lib/dashboard";
import Card, { CardHeader } from "./ui/card";
import Badge from "./ui/badge";
import ProgressBar from "./ui/progress-bar";

/**
 * Send-progress card. Denominator = sent + remaining sendable work (eligible) + in-flight, so the
 * bar reflects how much of the known backlog has gone out. (V7 restyle — same math.)
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
    <Card>
      <CardHeader
        title="Send progress"
        right={
          <Badge tone={sendWindow.within ? "success" : "neutral"}>
            Window {sendWindow.within ? "open" : "closed"}
            {activeRun ? " · run active" : ""}
          </Badge>
        }
      />

      <ProgressBar value={pct} tone="brand" height="h-3" />

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-stone-600">{pct}% of known backlog sent</span>
        <span className="text-stone-500">
          {counts.sent.toLocaleString()} sent · {counts.eligible.toLocaleString()} eligible ·{" "}
          {counts.inFlight} in flight · {counts.failed} failed
        </span>
      </div>
      <p className="mt-1 text-[11px] text-stone-400">Send window {sendWindow.label}</p>
    </Card>
  );
}
