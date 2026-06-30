"use client";

import type { InboxThreadRow } from "@/lib/inbox-db";
import { displayName, formatTime } from "@/components/dashboard-utils";
import StatusDot from "@/components/ui/status-dot";

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
    <section className="rounded-2xl border bg-surface">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-medium text-ink">Conversations ({threads.length})</h2>
        {error ? <span className="text-xs text-amber-600">⚠ stale</span> : null}
      </div>

      {threads.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-subtle">
          No conversations yet. Inbound replies and leads appear here.
        </p>
      ) : (
        <ul className="max-h-[70vh] divide-y overflow-y-auto">
          {threads.map((t) => {
            const active = t.id === selectedId;
            const preview = t.last_body
              ? (t.last_direction === "outbound" ? "You: " : "") + t.last_body
              : "—";
            return (
              <li key={t.id}>
                <button
                  onClick={() => onSelect(t.id)}
                  className={`w-full px-4 py-3 text-left hover:bg-surface-muted ${
                    active ? "bg-surface-muted" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {displayName(t.first_name, t.last_name, t.phone)}
                    </span>
                    <span className="whitespace-nowrap text-xs text-ink-subtle">
                      {formatTime(t.last_at)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-subtle">{preview}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-3">
                    {t.suppressed ? (
                      <StatusDot tone="danger">opted out</StatusDot>
                    ) : t.needs_reply ? (
                      <StatusDot tone="warning">needs reply</StatusDot>
                    ) : null}
                    {t.lead_status ? (
                      <StatusDot tone="success">{t.lead_status}</StatusDot>
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
