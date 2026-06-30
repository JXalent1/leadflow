import type { InboundFeedRow, InboundDisposition } from "@/lib/dashboard";
import { displayName, formatTime } from "./dashboard-utils";

const DISPOSITION_STYLE: Record<InboundDisposition, { label: string; cls: string }> = {
  opt_out: { label: "opt-out", cls: "border-red-200 bg-red-50 text-red-700" },
  interested: { label: "interested", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  not_interested: { label: "not interested", cls: "bg-surface-muted text-ink-muted" },
  neutral: { label: "neutral", cls: "border-amber-200 bg-amber-50 text-amber-700" },
};

/** Reply feed — most-recent inbound messages with a derived disposition tag. */
export default function ReplyFeed({ replies }: { replies: InboundFeedRow[] }) {
  return (
    <section className="overflow-hidden rounded-2xl border bg-surface">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium tracking-tight text-ink">Reply feed ({replies.length})</h2>
      </div>

      {replies.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-subtle">
          No inbound replies yet.
        </p>
      ) : (
        <ul className="max-h-96 divide-y overflow-y-auto">
          {replies.map((r) => {
            const tag = DISPOSITION_STYLE[r.disposition];
            return (
              <li key={r.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {displayName(r.first_name, r.last_name, r.phone)}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-md border px-1.5 py-0.5 text-[11px] ${tag.cls}`}>
                      {tag.label}
                    </span>
                    <span className="whitespace-nowrap text-xs text-ink-subtle">
                      {formatTime(r.created_at)}
                    </span>
                  </div>
                </div>
                <p className="mt-1 text-sm text-ink-muted">{r.body}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
