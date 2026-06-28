"use client";

import { useState } from "react";
import Card from "./ui/card";
import Button from "./ui/button";
import { Input } from "./ui/field";
import { ChevronDownIcon } from "./ui/icons";

/**
 * Manual stage controls (overrides). These ONLY call the existing read/idempotent endpoints
 * (/api/skiptrace, /api/scrub, and a SEND-NOTHING dry run on /api/campaign). The actual paced
 * send + the one-click trace→scrub→send drive live in PipelineRunner; nothing here sends SMS.
 * Handy for running a single stage (e.g. trace a capped slice) without driving the whole pipeline.
 * V7: tucked into a collapsed-by-default secondary area so the primary launch flow stays prominent.
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
  const [open, setOpen] = useState(false);

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
    <Card padded={false}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-stone-50"
        aria-expanded={open}
      >
        <div>
          <h2 className="text-sm font-medium text-stone-900">Manual stage controls</h2>
          <p className="text-xs text-stone-500">
            Advanced — run a single stage by hand. None of these send SMS.
          </p>
        </div>
        <ChevronDownIcon
          className={`h-5 w-5 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="border-t border-stone-100 p-4">
          <p className="mb-3 text-xs text-stone-500">
            The send-nothing dry run previews eligibility. None of these send SMS — use “Run
            pipeline” above for the real, paced send.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={1}
                placeholder="limit"
                value={traceLimit}
                onChange={(e) => setTraceLimit(e.target.value)}
                className="h-9 w-24"
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  const n = parseInt(traceLimit, 10);
                  call("Skip trace", "/api/skiptrace", n > 0 ? { limit: n } : {});
                }}
                className="h-9"
              >
                {busy === "Skip trace" ? "Tracing…" : "Run skip trace"}
              </Button>
            </div>

            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => call("Scrub", "/api/scrub", {})}
              className="h-9"
            >
              {busy === "Scrub" ? "Scrubbing…" : "Run scrub"}
            </Button>

            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => call("Dry run", "/api/campaign", { dryRun: true })}
              className="h-9 border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100"
            >
              {busy === "Dry run" ? "Checking…" : "Dry-run send"}
            </Button>
          </div>

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
        </div>
      ) : null}
    </Card>
  );
}
