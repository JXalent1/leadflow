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

export default function PipelineRunner({
  scope,
  ratePerHour,
  windowLabel,
  withinWindow,
  activeRunId,
  onChanged,
}: Props) {
  const [running, setRunning] = useState(false);
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

  /** Drive trace → scrub → send to completion. Returns when a stage halts/pauses or all is done. */
  async function runPipeline() {
    setModalOpen(false);
    setRunning(true);
    setMsg(null);
    const acc: Tally = { ...ZERO };
    setTally(acc);

    try {
      // ---- STAGE 1: SKIP TRACE (idempotent; loops until nothing pending) -------------------
      setStage("Skip-tracing");
      for (let i = 0; i < MAX_STAGE_ITERATIONS; i++) {
        const { status, ok, data } = await post("/api/skiptrace", { limit: TRACE_BATCH });
        if (status === 401) return setMsg({ kind: "err", text: "Session expired — reload and log in." });
        if (data.error === "insufficient_credits")
          return setMsg({
            kind: "info",
            text: `Paused — trace needs ${data.needed} Tracerfy credits (have ${data.credits}). Top up, then click Run again — it resumes.`,
          });
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
    <Card className="ring-1 ring-indigo-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardHeader
          title="Run pipeline"
          subtitle="One click drives skip-trace → scrub → paced send to completion. Resumable."
        />

        <div className="flex items-end gap-2">
          {/* Live send-rate control — change takes effect on the next batch, no redeploy. */}
          <div className="flex flex-col gap-1">
            <label htmlFor="rate-input" className="text-xs font-medium text-slate-500">
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

          <Button
            onClick={() => {
              setConfirmText("");
              setModalOpen(true);
            }}
            disabled={running}
            className="h-9"
          >
            {running ? "Running…" : "Run pipeline"}
          </Button>
        </div>
      </div>

      {running || stage ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-indigo-50 px-3 py-2 text-sm">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
          <span className="font-medium text-indigo-900">{stage ? `${stage}…` : "Working…"}</span>
          <span className="text-indigo-700/70">
            traced {tally.traced} · clean {tally.clean} · sent {tally.sent} · failed {tally.failed}
          </span>
        </div>
      ) : null}

      {!withinWindow ? (
        <p className="mt-2 text-xs text-slate-400">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-2xl">
        <h3 className="text-lg font-semibold text-slate-900">Run the full pipeline?</h3>
        <p className="mt-2 text-sm text-slate-600">
          This will skip-trace, DNC/litigator-scrub, then send{" "}
          <span className="font-semibold text-slate-900">real SMS</span> to every eligible contact in
          this campaign (paced, within {windowLabel}). It spends Tracerfy credits and sends real
          messages, and cannot be undone. It runs to completion on its own and is resumable.
        </p>
        <p className="mt-3 text-sm text-slate-600">
          Type <span className="font-mono font-semibold text-slate-900">CONFIRM</span> to proceed:
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
