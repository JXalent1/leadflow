"use client";

import type { ThreadDetail } from "@/lib/inbox-db";
import { displayName, formatTime } from "@/components/dashboard-utils";
import ReplyBox from "./reply-box";
import LeadStatus from "./lead-status";

/**
 * Right-hand thread view: the contact header, the lead status/notes control (if a lead
 * exists), the full message history (inbound vs outbound visually distinct), and the
 * reply box. The reply box is disabled for suppressed contacts.
 */
export default function ThreadView({
  contactId,
  thread,
  loading,
  offHours,
  windowLabel,
  scope,
  onChanged,
}: {
  contactId: number | null;
  thread: ThreadDetail | null;
  loading: boolean;
  offHours: boolean;
  windowLabel: string;
  /** Query suffix scoping reply/lead writes to the resolved client (e.g. "clientId=2"). (#11) */
  scope: string;
  onChanged: () => void;
}) {
  if (contactId == null) {
    return (
      <section className="flex min-h-[60vh] items-center justify-center rounded-lg border border-neutral-200 bg-white">
        <p className="text-sm text-neutral-500">Select a conversation to view it.</p>
      </section>
    );
  }

  if (!thread) {
    return (
      <section className="flex min-h-[60vh] items-center justify-center rounded-lg border border-neutral-200 bg-white">
        <p className="text-sm text-neutral-500">{loading ? "Loading…" : "Thread not found."}</p>
      </section>
    );
  }

  const { contact, lead, messages } = thread;

  return (
    <section className="flex min-h-[60vh] flex-col rounded-lg border border-neutral-200 bg-white">
      {/* Header */}
      <div className="border-b border-neutral-200 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">
            {displayName(contact.first_name, contact.last_name, contact.phone)}
          </h2>
          {contact.suppressed ? (
            <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
              opted out
            </span>
          ) : null}
        </div>
        <p className="text-xs text-neutral-500">
          {contact.phone ?? "no phone"}
          {contact.address ? ` · ${contact.address}` : ""}
        </p>
      </div>

      {/* Lead status / notes */}
      <div className="border-b border-neutral-200 px-4 py-3">
        {lead ? (
          <LeadStatus lead={lead} scope={scope} onChanged={onChanged} />
        ) : (
          <p className="text-xs text-neutral-400">
            No lead record for this contact yet (created automatically from an interested reply).
          </p>
        )}
      </div>

      {/* Message history */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <p className="text-center text-sm text-neutral-400">No messages yet.</p>
        ) : (
          messages.map((m) => {
            const outbound = m.direction === "outbound";
            return (
              <div key={m.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                    outbound
                      ? "bg-neutral-900 text-white"
                      : "border border-neutral-200 bg-neutral-50 text-neutral-800"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <div
                    className={`mt-1 text-[11px] ${
                      outbound ? "text-neutral-400" : "text-neutral-400"
                    }`}
                  >
                    {formatTime(m.created_at)}
                    {outbound && m.status === "failed" ? " · failed" : ""}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Reply box */}
      <div className="border-t border-neutral-200 px-4 py-3">
        <ReplyBox
          contactId={contact.id}
          suppressed={contact.suppressed}
          offHours={offHours}
          windowLabel={windowLabel}
          scope={scope}
          onSent={onChanged}
        />
      </div>
    </section>
  );
}
