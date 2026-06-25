"use client";

import { useState } from "react";

/**
 * Manual stage controls (overrides). These ONLY call the existing read/idempotent endpoints
 * (/api/skiptrace, /api/scrub, and a SEND-NOTHING dry run on /api/campaign). The actual paced
 * send + the one-click trace→scrub→send drive live in PipelineRunner; nothing here sends SMS.
 * Handy for running a single stage (e.g. trace a capped slice) without driving the whole pipeline.
 */

interface Props {
  /** Query string scoping every action to the selected client + campaign (clientId=..&campaignId=..). */
  scope: string;
  windowLabel: string;
  /** Re-pull the dashboard snapshot after an action changes state. */
  onChanged: () => void;
}

type MsgKind = "ok" | "err" | "info";

export default function CampaignControls({ scope, windowLabel, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: MsgKind; text: string } | null>(null);
  const [traceLimit, setTraceLimit] = useState("");

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
      const sep = url.includes("?") ? "&" : "?";
      const res = await fetch(`${url}${sep}${scope}`, {
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
    if (data.error === "insufficient_credits") {
      show("err", `Insufficient Tracerfy credits: have ${data.credits}, need ${data.needed}.`);
      return;
    }
    if (data.error) {
      show("err", `${label} error: ${String(data.error)}`);
      return;
    }

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
        `Dry run — ${data.eligible} eligible. Split ${split}. Rate ${data.ratePerHour}/hr. Window ${win ? "OPEN" : "CLOSED"} (${windowLabel}).`,
      );
    } else {
      show("ok", `${label} complete.`);
    }
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-1 text-sm font-semibold">Manual stage controls</h2>
      <p className="mb-3 text-xs text-neutral-500">
        Run a single stage by hand. The send-nothing dry run previews eligibility. None of these
        send SMS — use “Run pipeline” above for the real, paced send.
      </p>

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
      </div>

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
    </section>
  );
}
