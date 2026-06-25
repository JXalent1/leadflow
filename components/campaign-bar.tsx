"use client";

import { useState } from "react";
import type { CampaignSummary, ScrubMode } from "@/lib/campaigns";
import Card from "./ui/card";
import Button from "./ui/button";
import Badge from "./ui/badge";
import { Field, Input, Select } from "./ui/field";
import SegmentedToggle from "./ui/toggle";
import { ArrowRightIcon, ShieldIcon } from "./ui/icons";

/**
 * Campaign selector + CSV list uploader (v2 Module V2). Switching campaigns reloads the dashboard
 * scoped to the chosen campaign (?campaignId=). Uploading a CSV POSTs multipart to /api/campaigns,
 * which creates a NEW campaign for the current client and imports the list, then navigates to it.
 *
 * V7 adds the no-scrub toggle: the operator picks the DNC scrub mode at upload time, wired to the
 * EXISTING `scrubMode` field on POST /api/campaigns ('vendor' default | 'none'). No pipeline logic
 * here — it only selects/creates campaigns. Suppression stays client-level and is enforced
 * server-side at send time regardless of scrub mode.
 */

interface Props {
  clientId: number;
  campaigns: CampaignSummary[];
  selectedCampaignId: number | null;
}

function dashboardUrl(clientId: number, campaignId: number): string {
  return `/dashboard?clientId=${clientId}&campaignId=${campaignId}`;
}

function modeBadge(mode: ScrubMode) {
  return mode === "none" ? (
    <Badge tone="warning">No scrub</Badge>
  ) : (
    <Badge tone="neutral">
      <ShieldIcon className="h-3 w-3" />
      Standard
    </Badge>
  );
}

export default function CampaignBar({ clientId, campaigns, selectedCampaignId }: Props) {
  const [showUpload, setShowUpload] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [scrubMode, setScrubMode] = useState<ScrubMode>("vendor");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const selected = campaigns.find((c) => c.id === selectedCampaignId);

  function switchCampaign(id: number) {
    if (id !== selectedCampaignId) window.location.assign(dashboardUrl(clientId, id));
  }

  async function upload() {
    if (!name.trim()) {
      setMsg({ kind: "err", text: "Give the campaign a name." });
      return;
    }
    if (!file) {
      setMsg({ kind: "err", text: "Choose a CSV file." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const form = new FormData();
      form.append("name", name.trim());
      form.append("file", file);
      form.append("scrubMode", scrubMode);
      const res = await fetch(`/api/campaigns?clientId=${clientId}`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data.detail ? `: ${data.detail}` : "";
        setMsg({ kind: "err", text: `Upload failed (${data.error ?? res.status})${detail}.` });
        return;
      }
      setMsg({
        kind: "ok",
        text: `Created "${data.name}" — imported ${data.imported} of ${data.read} (skipped ${data.skipped}). Loading…`,
      });
      window.location.assign(dashboardUrl(clientId, data.campaignId));
    } catch (err) {
      setMsg({ kind: "err", text: `Upload failed: ${err instanceof Error ? err.message : "network error"}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-3 p-4">
        <label className="text-sm font-medium text-slate-700">Campaign</label>
        {campaigns.length > 0 ? (
          <>
            <Select
              value={selectedCampaignId ?? ""}
              onChange={(e) => switchCampaign(Number(e.target.value))}
              className="w-auto"
            >
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.contact_count} contacts · {c.status}
                  {c.scrub_mode === "none" ? " · no scrub" : ""}
                </option>
              ))}
            </Select>
            {selected ? modeBadge(selected.scrub_mode) : null}
          </>
        ) : (
          <span className="text-sm text-slate-400">No campaigns yet.</span>
        )}

        <Button
          variant="secondary"
          size="sm"
          className="ml-auto"
          onClick={() => setShowUpload((v) => !v)}
        >
          {showUpload ? "Close" : "Upload new list"}
          {!showUpload ? <ArrowRightIcon className="h-4 w-4" /> : null}
        </Button>
      </div>

      {showUpload ? (
        <div className="flex flex-col gap-4 border-t border-slate-100 p-4">
          <p className="text-xs text-slate-500">
            CSV columns:{" "}
            <span className="font-mono text-slate-600">FirstName, LastName, Address, City, State, Zip</span>{" "}
            (Address required). Creates a new campaign for this client and imports the list.
          </p>

          <div className="flex flex-wrap items-end gap-4">
            <Field label="Campaign name" htmlFor="campaign-name" className="w-56">
              <Input
                id="campaign-name"
                type="text"
                placeholder="e.g. Tallahassee 2,500"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Contact list (CSV)" htmlFor="campaign-file">
              <input
                id="campaign-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
              />
            </Field>
          </div>

          <Field
            label="DNC scrub"
            help={
              scrubMode === "none"
                ? "No scrub — the whole list is sent without a vendor DNC/litigator check. Skips Tracerfy scrub credits. STOP/opt-out suppression still applies."
                : "Standard — each number is checked against DNC/litigator lists (Tracerfy) and flagged numbers are suppressed before any send."
            }
          >
            <SegmentedToggle<ScrubMode>
              name="DNC scrub mode"
              value={scrubMode}
              onChange={setScrubMode}
              options={[
                { value: "vendor", label: "Standard", activeTone: "indigo" },
                { value: "none", label: "No scrub — send whole list", activeTone: "warning" },
              ]}
            />
          </Field>

          <div>
            <Button onClick={upload} loading={busy}>
              {busy ? "Uploading…" : "Create campaign + import"}
            </Button>
          </div>
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
