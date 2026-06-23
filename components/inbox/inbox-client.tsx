"use client";

import { useCallback, useEffect, useState } from "react";
import type { InboxThreadRow, ThreadDetail } from "@/lib/inbox-db";
import ConversationList from "./conversation-list";
import ThreadView from "./thread-view";

/**
 * Inbox orchestrator. Holds the conversation list + the selected contact, loads that
 * contact's full thread, and refreshes both after a reply is sent or a lead is updated.
 * All writes go through /api/reply and /api/leads; this only reads /api/inbox.
 */
export default function InboxClient({
  initialThreads,
  initialContactId,
  offHours,
  windowLabel,
}: {
  initialThreads: InboxThreadRow[];
  initialContactId: number | null;
  offHours: boolean;
  windowLabel: string;
}) {
  const [threads, setThreads] = useState<InboxThreadRow[]>(initialThreads);
  const [selected, setSelected] = useState<number | null>(
    initialContactId ?? initialThreads[0]?.id ?? null
  );
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [listError, setListError] = useState(false);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox", { cache: "no-store" });
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
  }, []);

  const loadThread = useCallback(async (contactId: number) => {
    setLoadingThread(true);
    try {
      const res = await fetch(`/api/inbox?contactId=${contactId}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { thread: ThreadDetail };
        setThread(data.thread);
      }
    } catch {
      /* keep last good thread */
    } finally {
      setLoadingThread(false);
    }
  }, []);

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
        onChanged={onChanged}
      />
    </div>
  );
}
