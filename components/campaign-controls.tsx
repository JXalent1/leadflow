"use client";

import { useState } from "react";

/**
 * Control buttons — they ONLY call the existing endpoints (/api/skiptrace,
 * /api/scrub, /api/campaign). No send logic lives here. The real send is gated twice:
 * the campaign endpoint enforces { confirm:true } + the send window, and this UI adds
 * an explicit in-UI confirmation (type CONFIRM) before it ever sends { confirm:true }.
 */

interface Props {
  eligible: number;
  withinWindow: boolean;
  windowLabel: string;
  activeRun: boolean;
  /** Re-pull the dashboard snapshot after an action changes state. */
  onChanged: () => void;
}

type MsgKind = "ok" | "err" | "info";

export default function CampaignControls({
  eligible,
  withinWindow,
  windowLabel,
  activeRun,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: MsgKind; text: string } | null>(null);
  const [traceLimit, setTraceLimit] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  function show(kind: MsgKind, text: string) {
    setMsg({ kind, text });
  }

  async function call(
    label: string,
    url: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    setBusy(label);
    setMsg(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      handleResponse(label, res.status, data);
    } catch (err) {
      show("err", `${label} failed: ${err instanceof Error ? err.message : "network error"}`);
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  function handleResponse(label: string, status: number, data: Record<string, unknown>) {
    if (status === 401) {
      show("err", "Session expired — reload and log in again.");
      return;
    }
    // Surface the campaign endpoint's specific guard responses verbatim-ish.
    if (data.error === "confirmation_required") {
      show("err", "Endpoint refused: confirmation required (confirm:true was not sent).");
      return;
    }
    if (data.error === "outside_send_window") {
      show("err", `Outside the send window (${data.window ?? windowLabel}). Send blocked.`);
      return;
    }
    if (data.error === "campaign_already_running") {
      show("err", "Another campaign run is in flight — wait for it to finish, then continue.");
      return;
    }
    if (data.error === "insufficient_credits") {
      show("err", `Insufficient Tracerfy credits: have ${data.credits}, need ${data.needed}.`);
      return;
    }
    if (data.error) {
      show("err", `${label} error: ${String(data.error)}`);
      return;
    }

    // Success shapes per endpoint.
    if (label === "Skip trace") {
      show("ok", `Skip trace: traced ${data.traced}, matched ${data.matched}, no-match ${data.noMatch}.`);
    } else if (label === "Scrub") {
      show("ok", `Scrub: ${data.scrubbed} scrubbed, ${data.clean} clean, ${data.suppressed} suppressed.`);
    } else if (label === "Dry run") {
      const split = data.perVariant
        ? Object.entries(data.perVariant as Record<string, number>)
            .map(([k, v]) => `${k}:${v}`)
            .join("  ")
        : "—";
      const win = (data.sendWindow as { within?: boolean } | undefined)?.within;
      show(
        "info",
        `Dry run — ${data.eligible} eligible. Split ${split}. Rate ${data.ratePerHour}/hr. Window ${win ? "OPEN" : "CLOSED"}.`,
      );
    } else if (label === "Start send") {
      show(
        "ok",
        `Send batch ran: ${data.sent} sent, ${data.failed} failed${
          data.stoppedForWindow ? " (stopped at window close)" : ""
        }. Run again to continue any remaining eligible.`,
      );
    } else {
      show("ok", `${label} complete.`);
    }
  }

  function openSendModal() {
    setConfirmText("");
    setModalOpen(true);
  }

  async function confirmSend() {
    setModalOpen(false);
    await call("Start send", "/api/campaign", { confirm: true });
  }

  const sendDisabled = busy !== null || activeRun || !withinWindow || eligible === 0;
  const sendDisabledReason = activeRun
    ? "A run is already active."
    : !withinWindow
      ? `Outside the send window (${windowLabel}).`
      : eligible === 0
        ? "Nothing eligible to send."
        : "";

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold">Controls</h2>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            placeholder="limit"
            value={traceLimit}
            onChange={(e) => setTraceLimit(e.target.value)}
            className="w-20 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          />
          <button
            disabled={busy !== null}
            onClick={() => {
              const n = parseInt(traceLimit, 10);
              call("Skip trace", "/api/skiptrace", n > 0 ? { limit: n } : {});
            }}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-40"
          >
            {busy === "Skip trace" ? "Tracing…" : "Run skip trace"}
          </button>
        </div>

        <button
          disabled={busy !== null}
          onClick={() => call("Scrub", "/api/scrub", {})}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-40"
        >
          {busy === "Scrub" ? "Scrubbing…" : "Run scrub"}
        </button>

        <button
          disabled={busy !== null}
          onClick={() => call("Dry run", "/api/campaign", { dryRun: true })}
          className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-sm text-sky-800 hover:bg-sky-100 disabled:opacity-40"
        >
          {busy === "Dry run" ? "Checking…" : "Dry-run send"}
        </button>

        <button
          disabled={sendDisabled}
          title={sendDisabledReason}
          onClick={openSendModal}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === "Start send" ? "Sending…" : "Start send"}
        </button>
      </div>

      {sendDisabled && sendDisabledReason ? (
        <p className="mt-2 text-xs text-neutral-400">Send disabled: {sendDisabledReason}</p>
      ) : null}

      {msg ? (
        <p
          className={`mt-3 rounded-md px-3 py-2 text-sm ${
            msg.kind === "ok"
              ? "bg-emerald-50 text-emerald-700"
              : msg.kind === "err"
                ? "bg-red-50 text-red-700"
                : "bg-sky-50 text-sky-800"
          }`}
        >
          {msg.text}
        </p>
      ) : null}

      {modalOpen ? (
        <ConfirmModal
          eligible={eligible}
          windowLabel={windowLabel}
          confirmText={confirmText}
          setConfirmText={setConfirmText}
          onCancel={() => setModalOpen(false)}
          onConfirm={confirmSend}
        />
      ) : null}
    </section>
  );
}

function ConfirmModal({
  eligible,
  windowLabel,
  confirmText,
  setConfirmText,
  onCancel,
  onConfirm,
}: {
  eligible: number;
  windowLabel: string;
  confirmText: string;
  setConfirmText: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const armed = confirmText.trim().toUpperCase() === "CONFIRM";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Start the send?</h3>
        <p className="mt-2 text-sm text-neutral-700">
          This will text <span className="font-semibold">{eligible}</span> eligible{" "}
          {eligible === 1 ? "person" : "people"} (real SMS, paced, within {windowLabel}). This
          spends money and cannot be undone. The send is resumable — it runs one batch; run it
          again to continue.
        </p>
        <p className="mt-3 text-sm text-neutral-600">
          Type <span className="font-mono font-semibold">CONFIRM</span> to proceed:
        </p>
        <input
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            disabled={!armed}
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-40"
          >
            Send to {eligible}
          </button>
        </div>
      </div>
    </div>
  );
}
