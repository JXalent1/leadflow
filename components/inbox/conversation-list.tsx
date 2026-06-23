"use client";

import type { InboxThreadRow } from "@/lib/inbox-db";
import { displayName, formatTime } from "@/components/dashboard-utils";

/**
 * Left-hand conversation list. Each thread shows the homeowner name, a preview of the
 * last message, the time, a clear "needs reply" badge (the newest message was inbound),
 * the lead status if any, and a visible "opted out" mark for suppressed contacts.
 */
export default function ConversationList({
  threads,
  selectedId,
  onSelect,
  error,
}: {
  threads: InboxThreadRow[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  error: boolean;
}) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <h2 className="text-sm font-semibold">Conversations ({threads.length})</h2>
        {error ? <span className="text-xs text-amber-600">⚠ stale</span> : null}
      </div>

      {threads.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-neutral-500">
          No conversations yet. Inbound replies and leads appear here.
        </p>
      ) : (
        <ul className="max-h-[70vh] divide-y divide-neutral-100 overflow-y-auto">
          {threads.map((t) => {
            const active = t.id === selectedId;
            const preview = t.last_body
              ? (t.last_direction === "outbound" ? "You: " : "") + t.last_body
              : "—";
            return (
              <li key={t.id}>
                <button
                  onClick={() => onSelect(t.id)}
                  className={`w-full px-4 py-3 text-left hover:bg-neutral-50 ${
                    active ? "bg-neutral-100" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {displayName(t.first_name, t.last_name, t.phone)}
                    </span>
                    <span className="whitespace-nowrap text-xs text-neutral-400">
                      {formatTime(t.last_at)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-neutral-500">{preview}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {t.suppressed ? (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] text-red-700">
                        opted out
                      </span>
                    ) : t.needs_reply ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                        needs reply
                      </span>
                    ) : null}
                    {t.lead_status ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700">
                        {t.lead_status}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
