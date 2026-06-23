import type { InboundFeedRow, InboundDisposition } from "@/lib/dashboard";
import { displayName, formatTime } from "./dashboard-utils";

const DISPOSITION_STYLE: Record<InboundDisposition, { label: string; cls: string }> = {
  opt_out: { label: "opt-out", cls: "bg-red-100 text-red-700" },
  interested: { label: "interested", cls: "bg-emerald-100 text-emerald-700" },
  not_interested: { label: "not interested", cls: "bg-neutral-200 text-neutral-600" },
  neutral: { label: "neutral", cls: "bg-amber-100 text-amber-700" },
};

/** Reply feed — most-recent inbound messages with a derived disposition tag. */
export default function ReplyFeed({ replies }: { replies: InboundFeedRow[] }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-4 py-3">
        <h2 className="text-sm font-semibold">Reply feed ({replies.length})</h2>
      </div>

      {replies.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-neutral-500">
          No inbound replies yet.
        </p>
      ) : (
        <ul className="max-h-96 divide-y divide-neutral-100 overflow-y-auto">
          {replies.map((r) => {
            const tag = DISPOSITION_STYLE[r.disposition];
            return (
              <li key={r.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {displayName(r.first_name, r.last_name, r.phone)}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${tag.cls}`}>
                      {tag.label}
                    </span>
                    <span className="whitespace-nowrap text-xs text-neutral-400">
                      {formatTime(r.created_at)}
                    </span>
                  </div>
                </div>
                <p className="mt-1 text-sm text-neutral-700">{r.body}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
