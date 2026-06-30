"use client";

import { useState } from "react";
import {
  TRACE_BATCH,
  SCRUB_BATCH,
  MAX_STAGE_ITERATIONS,
  MAX_SEND_RATE_PER_HOUR,
  sendBatchSize,
  clientPacingDelayMs,
} from "@/lib/pipeline";
import Card, { CardHeader } from "./ui/card";
import Button from "./ui/button";
import { Input } from "./ui/field";

/**
 * The guided pipeline driver (v2 Module V3). The operator hits **Run** ONCE; this drives
 * trace → scrub → send to completion by re-invoking the EXISTING batch endpoints
 * (/api/skiptrace, /api/scrub, /api/campaign) one batch at a time and looping until each stage
 * drains — so no single request hits the function timeout and there's no manual re-clicking.
 *
 * Compliance is unchanged: every send batch goes through the campaign endpoint's
 * getEligibleContacts + atomic claimForSend (with the V2 opt-out re-check). This component only
 * DRIVES those endpoints — it has no eligibility/suppression logic of its own. It's resumable:
 * all state lives in the DB, so closing the tab and clicking Run again picks up where it left off
 * (and adopts an already-open run via `activeRunId`).
 */

interface Props {
  /** Query string scoping every call to the selected client + campaign (clientId=..&campaignId=..). */
  scope: string;
  /** Live sends/hour from the snapshot — seeds the rate control + the first send batch size. */
  ratePerHour: number;
  windowLabel: string;
  withinWindow: boolean;
  /** The in-flight run id (if any), so a resumed drive continues its OWN run instead of being blocked. */
  activeRunId: number | null;
  /** Re-pull the dashboard snapshot so progress is live between batches. */
  onChanged: () => void;
}

type MsgKind = "ok" | "err" | "info";

interface Tally {
  traced: number;
  matched: number;
  noMatch: number;
  clean: number;
  flagged: number;
  sent: number;
  failed: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ZERO: Tally = { traced: 0, matched: 0, noMatch: 0, clean: 0, flagged: 0, sent: 0, failed: 0 };

/** How many times to auto-retry a transient skip-trace batch failure before pausing. */
const MAX_BATCH_RETRIES = 4;

/** Backoff between client-side batch retries: 1s, 2s, 4s, 8s (capped). Rides a brief rate-limit. */
const batchRetryDelayMs = (attempt: number) => Math.min(8000, 1000 * 2 ** (attempt - 1));

/** A transient HTTP failure the driver should ride through (rate-limit / gateway / network blip)
 *  rather than treat as a dead error. The skip-trace route tags its 502s with an explicit
 *  `retryable` flag (transient upstream vs. a genuine fault) — honor it first; otherwise a raw
 *  network/gateway status with no body is transient. The trace endpoint is fully resumable
 *  (trace_jobs persisted, re-ingest is free, no double-charge), so re-POSTing is safe. */
function isTransientHttp(status: number, data: Record<string, unknown>): boolean {
  if (data?.retryable === true) return true;
  if (data?.retryable === false) return false;
  return status === 0 || status === 429 || status === 503 || status === 504;
}

export default function PipelineRunner({
  scope,
  ratePerHour,
  windowLabel,
  withinWindow,
  activeRunId,
  onChanged,
}: Props) {
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [tally, setTally] = useState<Tally>(ZERO);
  const [msg, setMsg] = useState<{ kind: MsgKind; text: string } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [rateInput, setRateInput] = useState(String(ratePerHour));
  const [savingRate, setSavingRate] = useState(false);

  async function post(url: string, body: Record<string, unknown>) {
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${sep}${scope}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, ok: res.ok, data };
  }

  /**
   * POST a skip-trace batch, riding through TRANSIENT failures (rate-limit / gateway / network
   * blip) with backoff instead of failing on the first one. Returns the final result plus a
   * `transient` flag set when retries were exhausted on a still-transient error — the caller
   * then pauses gracefully into a resumable state. Safe to re-POST: the trace endpoint persists
   * its queue ids and re-ingests for free, so a retry never double-charges or double-traces.
   */
  async function postTraceBatch(
    body: Record<string, unknown>
  ): Promise<{ status: number; ok: boolean; data: Record<string, unknown>; transient: boolean }> {
    let last: { status: number; ok: boolean; data: Record<string, unknown> } = {
      status: 0,
      ok: false,
      data: {},
    };
    for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
      try {
        last = await post("/api/skiptrace", body);
        if (last.ok && !last.data.error) return { ...last, transient: false };
        if (!isTransientHttp(last.status, last.data)) return { ...last, transient: false };
      } catch {
        // Network throw (fetch rejected) — treat as transient (status 0).
        last = { status: 0, ok: false, data: {} };
      }
      if (attempt < MAX_BATCH_RETRIES) await sleep(batchRetryDelayMs(attempt));
    }
    return { ...last, transient: true };
  }

  /** Drive trace → scrub → send to completion. Returns when a stage halts/pauses or all is done. */
  async function runPipeline() {
    setModalOpen(false);
    setRunning(true);
    setPaused(false);
    setMsg(null);
    const acc: Tally = { ...ZERO };
    setTally(acc);

    try {
      // ---- STAGE 1: SKIP TRACE (idempotent; loops until nothing pending) -------------------
      setStage("Skip-tracing");
      for (let i = 0; i < MAX_STAGE_ITERATIONS; i++) {
        const { status, ok, data, transient } = await postTraceBatch({ limit: TRACE_BATCH });
        if (status === 401) return setMsg({ kind: "err", text: "Session expired — reload and log in." });
        if (data.error === "insufficient_credits")
          return setMsg({
            kind: "info",
            text: `Paused — trace needs ${data.needed} Tracerfy credits (have ${data.credits}). Top up, then click Run again — it resumes.`,
          });
        // Transient Tracerfy trouble (rate-limit / outage) survived the auto-retries: pause into a
        // clearly resumable state instead of dead-ending. Nothing was double-charged or lost.
        if (transient) {
          setPaused(true);
          return setMsg({
            kind: "info",
            text: `Skip-trace paused — Tracerfy was temporarily unavailable (rate-limit or outage) and didn't clear after several auto-retries. Traced ${acc.traced} so far. Your progress is saved and nothing was double-charged — click Resume to continue.`,
          });
        }
        if (!ok || data.error)
          return setMsg({ kind: "err", text: `Skip trace error: ${String(data.error ?? status)}.` });
        acc.traced += Number(data.traced ?? 0);
        acc.matched += Number(data.matched ?? 0);
        acc.noMatch += Number(data.noMatch ?? 0);
        setTally({ ...acc });
        onChanged();
        if (Number(data.traced ?? 0) === 0) break;
      }

      // ---- STAGE 2: DNC / LITIGATOR SCRUB (loops until nothing left to scrub) ---------------
      setStage("Scrubbing");
      for (let i = 0; i < MAX_STAGE_ITERATIONS; i++) {
        const { status, ok, data } = await post("/api/scrub", { limit: SCRUB_BATCH });
        if (status === 401) return setMsg({ kind: "err", text: "Session expired — reload and log in." });
        if (data.error === "insufficient_credits")
          return setMsg({
            kind: "info",
            text: `Paused — scrub needs ${data.needed} Tracerfy credits (have ${data.credits}). Top up, then click Run again — it resumes.`,
          });
        if (!ok || data.error)
          return setMsg({ kind: "err", text: `Scrub error: ${String(data.error ?? status)}.` });
        acc.clean += Number(data.clean ?? 0);
        acc.flagged += Number(data.suppressed ?? 0);
        setTally({ ...acc });
        onChanged();
        if (Number(data.scrubbed ?? 0) === 0) break;
      }

      // ---- STAGE 3: PACED SEND (one driven run, batch by batch, until drained) --------------
      setStage("Sending");
      let runId: number | undefined = activeRunId ?? undefined;
      let rate = ratePerHour;
      for (let i = 0; i < MAX_STAGE_ITERATIONS; i++) {
        const { status, ok, data } = await post("/api/campaign", {
          confirm: true,
          limit: sendBatchSize(rate),
          runId,
        });
        if (status === 401) return setMsg({ kind: "err", text: "Session expired — reload and log in." });
        // Deliver-then-stop (V6): the send route refuses once the lead target is met for the period.
        if (data.paused || data.reason === "target_met")
          return setMsg({
            kind: "info",
            text:
              typeof data.message === "string"
                ? data.message
                : `Target met — paused until ${String(data.nextPeriod ?? "the next period")}.`,
          });
        if (data.error === "outside_send_window")
          return setMsg({
            kind: "info",
            text: `Paused — outside the send window (${String(data.window ?? windowLabel)}). Sent ${acc.sent} so far. Click Run during the window to finish.`,
          });
        if (data.error === "campaign_already_running")
          return setMsg({
            kind: "info",
            text: "Paused — another send run is active for this campaign. Reload the page to resume it.",
          });
        if (!ok || data.error)
          return setMsg({ kind: "err", text: `Send error: ${String(data.error ?? status)}.` });

        acc.sent += Number(data.sent ?? 0);
        acc.failed += Number(data.failed ?? 0);
        setTally({ ...acc });
        runId = typeof data.runId === "number" ? data.runId : runId;
        if (typeof data.ratePerHour === "number") rate = data.ratePerHour;
        onChanged();

        if (data.stoppedForWindow)
          return setMsg({
            kind: "info",
            text: `Paused — the send window closed mid-run. Sent ${acc.sent} so far. Click Run during the window to finish.`,
          });
        if (data.done) break;

        // Pace the gap BETWEEN batches so the realized rate matches the configured one (the server
        // paces within a batch; this restores the boundary delay it omits after the last send).
        await sleep(clientPacingDelayMs(rate));
      }

      setMsg({
        kind: "ok",
        text: `Pipeline complete — traced ${acc.traced}, scrubbed clean ${acc.clean}, sent ${acc.sent}, failed ${acc.failed}.`,
      });
    } catch (err) {
      setMsg({
        kind: "err",
        text: `Pipeline stopped: ${err instanceof Error ? err.message : "network error"}. State is saved — click Run to resume.`,
      });
    } finally {
      setRunning(false);
      setStage(null);
      onChanged();
    }
  }

  async function saveRate() {
    const n = parseInt(rateInput, 10);
    if (!(n >= 1)) {
      setMsg({ kind: "err", text: "Enter a send rate of at least 1 per hour." });
      return;
    }
    setSavingRate(true);
    try {
      const res = await fetch(`/api/client?${scope}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sendRatePerHour: n }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setMsg({ kind: "err", text: `Rate update failed (${String(data.error ?? res.status)}).` });
        return;
      }
      setRateInput(String(data.sendRatePerHour));
      setMsg({ kind: "ok", text: `Send rate set to ${String(data.sendRatePerHour)}/hr — takes effect on the next batch.` });
      onChanged();
    } catch (err) {
      setMsg({ kind: "err", text: `Rate update failed: ${err instanceof Error ? err.message : "network error"}` });
    } finally {
      setSavingRate(false);
    }
  }

  return (
    <Card className="ring-1 ring-brand-tint">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardHeader
          title="Run pipeline"
          subtitle="One click drives skip-trace → scrub → paced send to completion. Resumable."
        />

        <div className="flex items-end gap-2">
          {/* Live send-rate control — change takes effect on the next batch, no redeploy. */}
          <div className="flex flex-col gap-1">
            <label htmlFor="rate-input" className="text-xs font-medium text-stone-500">
              Rate/hr
            </label>
            <Input
              id="rate-input"
              type="number"
              min={1}
              max={MAX_SEND_RATE_PER_HOUR}
              step={1}
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
              disabled={savingRate}
              className="h-9 w-24"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={saveRate} loading={savingRate} className="h-9">
            {savingRate ? "Saving…" : "Save rate"}
          </Button>

          {paused && !running ? (
            <Button onClick={runPipeline} className="h-9">
              Resume
            </Button>
          ) : null}

          <Button
            onClick={() => {
              setConfirmText("");
              setModalOpen(true);
            }}
            disabled={running}
            variant={paused ? "secondary" : "primary"}
            className="h-9"
          >
            {running ? "Running…" : paused ? "Restart" : "Run pipeline"}
          </Button>
        </div>
      </div>

      {running || stage ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-brand-tint px-3 py-2 text-sm">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
          <span className="font-medium text-brand-strong">{stage ? `${stage}…` : "Working…"}</span>
          <span className="text-brand-strong">
            traced {tally.traced} · clean {tally.clean} · sent {tally.sent} · failed {tally.failed}
          </span>
        </div>
      ) : null}

      {!withinWindow ? (
        <p className="mt-2 text-xs text-stone-400">
          Note: the send window ({windowLabel}) is closed — trace + scrub will run now; the send
          stage will pause until the window opens.
        </p>
      ) : null}

      {msg ? (
        <p
          className={`mt-3 rounded-lg px-3 py-2 text-sm ${
            msg.kind === "ok"
              ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
              : msg.kind === "err"
                ? "border border-red-200 bg-red-50 text-red-700"
                : "border border-sky-200 bg-sky-50 text-sky-800"
          }`}
        >
          {msg.text}
        </p>
      ) : null}

      {modalOpen ? (
        <ConfirmModal
          windowLabel={windowLabel}
          confirmText={confirmText}
          setConfirmText={setConfirmText}
          onCancel={() => setModalOpen(false)}
          onConfirm={runPipeline}
        />
      ) : null}
    </Card>
  );
}

function ConfirmModal({
  windowLabel,
  confirmText,
  setConfirmText,
  onCancel,
  onConfirm,
}: {
  windowLabel: string;
  confirmText: string;
  setConfirmText: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const armed = confirmText.trim().toUpperCase() === "CONFIRM";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-2xl">
        <h3 className="text-lg font-medium text-stone-900">Run the full pipeline?</h3>
        <p className="mt-2 text-sm text-stone-600">
          This will skip-trace, DNC/litigator-scrub, then send{" "}
          <span className="font-medium text-stone-900">real SMS</span> to every eligible contact in
          this campaign (paced, within {windowLabel}). It spends Tracerfy credits and sends real
          messages, and cannot be undone. It runs to completion on its own and is resumable.
        </p>
        <p className="mt-3 text-sm text-stone-600">
          Type <span className="font-mono font-medium text-stone-900">CONFIRM</span> to proceed:
        </p>
        <Input
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          className="mt-1"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!armed} onClick={onConfirm}>
            Run pipeline
          </Button>
        </div>
      </div>
    </div>
  );
}
