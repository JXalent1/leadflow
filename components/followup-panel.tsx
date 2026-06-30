"use client";

import { useState } from "react";
import Card from "./ui/card";
import Button from "./ui/button";
import Badge from "./ui/badge";
import { Field, inputClasses } from "./ui/field";
import { renderMessage, segmentInfo, MAX_MESSAGE_SEGMENTS } from "@/lib/sms";

/**
 * Follow-up / re-engagement launcher (Build: followup-campaigns). Lets the operator re-text a prior
 * campaign's NON-RESPONDERS with a new short message, reusing the already-traced + already-clean
 * phones (no re-trace, no re-scrub). On open it fetches the audience COUNT (GET /api/followups) and
 * the per-client opt-out line + biz name so the live preview matches the real send. "Create follow-up"
 * POSTs to seed the new campaign, then navigates to it where the operator runs the EXISTING send
 * pipeline (suppression/claim/window/segment cap unchanged).
 */

interface Props {
  clientId: number;
  sourceCampaignId: number;
  sourceName: string;
}

interface AudienceMeta {
  count: number;
  defaultTemplate: string;
  bizName: string;
  optOutInstruction: string;
  maxFollowups: number;
}

// A representative contact for the live preview (real renderMessage + segment count).
const PREVIEW_CONTACT = { firstName: "Chris", address: "123 Main St", zip: "32301" };

export default function FollowupPanel({ clientId, sourceCampaignId, sourceName }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<AudienceMeta | null>(null);
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !meta) await loadAudience();
  }

  async function loadAudience() {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/followups?clientId=${clientId}&sourceCampaignId=${sourceCampaignId}`,
        { cache: "no-store" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: "err", text: `Could not load audience (${data.error ?? res.status}).` });
        return;
      }
      setMeta(data as AudienceMeta);
      setTemplate((data.defaultTemplate as string) ?? "");
    } catch (err) {
      setMsg({ kind: "err", text: `Load failed: ${err instanceof Error ? err.message : "network error"}` });
    } finally {
      setLoading(false);
    }
  }

  async function create() {
    if (!meta) return;
    if (meta.count === 0) {
      setMsg({ kind: "err", text: "No non-responders to follow up." });
      return;
    }
    if (!template.trim()) {
      setMsg({ kind: "err", text: "Write a follow-up message." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/followups?clientId=${clientId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceCampaignId, messageTemplate: template.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: "err", text: `Create failed (${data.error ?? res.status}).` });
        return;
      }
      setMsg({
        kind: "ok",
        text: `Created follow-up — seeded ${data.seeded} contacts. Opening… Run the pipeline to send.`,
      });
      window.location.assign(`/dashboard?clientId=${clientId}&campaignId=${data.campaignId}`);
    } catch (err) {
      setMsg({ kind: "err", text: `Create failed: ${err instanceof Error ? err.message : "network error"}` });
    } finally {
      setBusy(false);
    }
  }

  // Live preview: the exact rendered body (incl. the client's opt-out line) + segment count.
  const preview = meta
    ? renderMessage(template, PREVIEW_CONTACT, meta.bizName, meta.optOutInstruction)
    : "";
  const seg = preview ? segmentInfo(preview) : null;
  const overCap = seg ? seg.segments > MAX_MESSAGE_SEGMENTS : false;

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-ink">Follow up</span>
          <span className="text-xs text-ink-subtle">
            Re-text non-responders of “{sourceName}” — reuses traced phones, no new scrub.
          </span>
        </div>
        <Button variant="secondary" size="sm" className="ml-auto" onClick={toggle}>
          {open ? "Close" : "Follow up"}
        </Button>
      </div>

      {open ? (
        <div className="flex flex-col gap-4 border-t p-4">
          {loading ? (
            <p className="text-sm text-ink-subtle">Counting non-responders…</p>
          ) : meta ? (
            <>
              <div className="flex items-center gap-2 text-sm">
                <Badge tone={meta.count > 0 ? "brand" : "neutral"}>
                  {meta.count.toLocaleString()} non-responder{meta.count === 1 ? "" : "s"}
                </Badge>
                <span className="text-ink-subtle">
                  were sent, never replied, aren’t a lead, and haven’t opted out or been followed up.
                </span>
              </div>

              <Field
                label="Follow-up message"
                htmlFor="followup-template"
                help='Placeholders: [NAME], [ADDRESS], [ZIP]. The opt-out line is added automatically.'
              >
                <textarea
                  id="followup-template"
                  rows={3}
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  className={inputClasses}
                />
              </Field>

              {seg ? (
                <div className="rounded-lg border bg-surface-sunken p-3">
                  <p className="text-xs font-medium text-ink-muted">Preview</p>
                  <p className="mt-1 text-sm text-ink">{preview}</p>
                  <p className={`mt-2 text-xs ${overCap ? "text-red-600" : "text-ink-subtle"}`}>
                    {seg.length} chars · {seg.segments} segment{seg.segments === 1 ? "" : "s"} ·{" "}
                    {seg.encoding}
                    {overCap
                      ? ` · over the ${MAX_MESSAGE_SEGMENTS}-segment cap — shorten it or it will be skipped`
                      : ""}
                  </p>
                </div>
              ) : null}

              <div>
                <Button onClick={create} loading={busy} disabled={meta.count === 0 || overCap}>
                  {busy ? "Creating…" : `Create follow-up to ${meta.count.toLocaleString()}`}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {msg ? (
        <div className="px-4 pb-4">
          <p
            className={`rounded-lg px-3 py-2 text-sm ${
              msg.kind === "ok"
                ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {msg.text}
          </p>
        </div>
      ) : null}
    </Card>
  );
}
