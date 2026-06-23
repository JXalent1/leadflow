"use client";

import { useState } from "react";
import { segmentInfo } from "@/lib/sms";

/**
 * Reply box at the bottom of a thread. Posts { contactId, body } to /api/reply, then
 * asks the parent to refresh. If the contact is suppressed the box is DISABLED entirely
 * (the server refuses too — this is the UI half of the same guarantee). Manual replies
 * may be multi-segment; we show the segment count but never block on it.
 *
 * The send-window hint is computed server-side and passed in (the window depends on env
 * vars not available client-side, and importing lib/twilio here would bundle the SDK).
 */
export default function ReplyBox({
  contactId,
  suppressed,
  offHours,
  windowLabel,
  onSent,
}: {
  contactId: number;
  suppressed: boolean;
  offHours: boolean;
  windowLabel: string;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (suppressed) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        This contact opted out — replies are disabled. We never message a suppressed number.
      </div>
    );
  }

  const seg = text.trim() ? segmentInfo(text) : null;

  async function send() {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, body: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setError(
          data?.error === "recipient_suppressed"
            ? "Refused — this contact is suppressed/opted out."
            : `Send failed${data?.error ? ` (${data.error})` : ""}.`
        );
        return;
      }
      setText("");
      onSent();
    } catch {
      setError("Network error — reply not sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {offHours ? (
        <p className="text-xs text-amber-600">
          Heads up: outside normal hours ({windowLabel}). A 1:1 reply is still allowed.
        </p>
      ) : null}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a reply…"
        rows={3}
        className="w-full resize-y rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-neutral-400">
          {seg ? `${seg.length} chars · ${seg.segments} segment${seg.segments === 1 ? "" : "s"}` : " "}
        </span>
        <button
          onClick={send}
          disabled={sending || !text.trim()}
          className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? "Sending…" : "Send reply"}
        </button>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
