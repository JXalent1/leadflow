"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { InboxThreadRow, ThreadDetail } from "@/lib/inbox-db";
import ConversationList from "./conversation-list";
import ThreadView from "./thread-view";

/**
 * Inbox orchestrator. Holds the conversation list + the selected contact, loads that
 * contact's full thread, and refreshes both after a reply is sent or a lead is updated.
 * All writes go through /api/reply and /api/leads; this only reads /api/inbox.
 *
 * EVERY fetch is scoped to `clientId` (#11): the server resolves it through
 * resolveClientIdForUser, so an operator viewing client 2 keeps seeing client 2's threads (and
 * replies/lead updates land on client 2) instead of silently falling back to client 1. The
 * operator can switch clients with the selector; a client-role user only ever has their own id.
 */
export default function InboxClient({
  clientId,
  clients,
  initialThreads,
  initialContactId,
  offHours,
  windowLabel,
}: {
  clientId: number;
  clients: { id: number; name: string }[];
  initialThreads: InboxThreadRow[];
  initialContactId: number | null;
  offHours: boolean;
  windowLabel: string;
}) {
  const router = useRouter();
  // The query suffix that scopes every inbox read/write to the resolved client.
  const scope = `clientId=${clientId}`;
  const [threads, setThreads] = useState<InboxThreadRow[]>(initialThreads);
  const [selected, setSelected] = useState<number | null>(
    initialContactId ?? initialThreads[0]?.id ?? null
  );
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [listError, setListError] = useState(false);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch(`/api/inbox?${scope}`, { cache: "no-store" });
      if (!res.ok) {
        setListError(true);
        return;
      }
      const data = (await res.json()) as { threads: InboxThreadRow[] };
      setThreads(data.threads);
      setListError(false);
    } catch {
      setListError(true);
    }
  }, [scope]);

  const loadThread = useCallback(
    async (contactId: number) => {
      setLoadingThread(true);
      try {
        const res = await fetch(`/api/inbox?contactId=${contactId}&${scope}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as { thread: ThreadDetail };
          setThread(data.thread);
        }
      } catch {
        /* keep last good thread */
      } finally {
        setLoadingThread(false);
      }
    },
    [scope]
  );

  // Load the selected thread whenever the selection changes.
  useEffect(() => {
    if (selected != null) loadThread(selected);
    else setThread(null);
  }, [selected, loadThread]);

  // Poll the conversation list so new inbound replies surface without a manual refresh.
  useEffect(() => {
    const id = setInterval(refreshThreads, 20000);
    return () => clearInterval(id);
  }, [refreshThreads]);

  // After a reply/status change, re-read the open thread and the list.
  const onChanged = useCallback(async () => {
    if (selected != null) await loadThread(selected);
    await refreshThreads();
  }, [selected, loadThread, refreshThreads]);

  return (
    <div className="flex flex-col gap-4">
      {clients.length > 1 ? (
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="inbox-client" className="text-neutral-500">
            Client
          </label>
          <select
            id="inbox-client"
            value={clientId}
            onChange={(e) => router.push(`/inbox?clientId=${e.target.value}`)}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <ConversationList
          threads={threads}
          selectedId={selected}
          onSelect={setSelected}
          error={listError}
        />
        <ThreadView
          key={selected ?? "none"}
          contactId={selected}
          thread={thread}
          loading={loadingThread}
          offHours={offHours}
          windowLabel={windowLabel}
          scope={scope}
          onChanged={onChanged}
        />
      </div>
    </div>
  );
}
