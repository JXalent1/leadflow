"use client";

import { useEffect, useState } from "react";
import { LEAD_STATUSES } from "@/lib/lead-status";
import type { ThreadDetail } from "@/lib/inbox-db";

/**
 * Lead status + notes control. Posts { leadId, status, notes } to /api/leads, then asks
 * the parent to refresh (so the dashboard leads table and the conversation list reflect
 * the change too). Only shown when a lead row exists for the contact.
 */
export default function LeadStatus({
  lead,
  scope,
  onChanged,
}: {
  lead: NonNullable<ThreadDetail["lead"]>;
  /** Query suffix scoping the lead update to the resolved client (e.g. "clientId=2"). (#11) */
  scope: string;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<string>(lead.status);
  const [notes, setNotes] = useState<string>(lead.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-sync when the parent swaps in a freshly-loaded lead (e.g. after refresh).
  useEffect(() => {
    setStatus(lead.status);
    setNotes(lead.notes ?? "");
  }, [lead.id, lead.status, lead.notes]);

  const dirty = status !== lead.status || notes !== (lead.notes ?? "");

  async function save() {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/leads?${scope}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: lead.id, status, notes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(`Update failed${data?.error ? ` (${data.error})` : ""}.`);
        return;
      }
      setSaved(true);
      onChanged();
    } catch {
      setError("Network error — not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border bg-surface-muted p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs font-medium text-ink-subtle">
          Lead status
        </label>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setSaved(false);
          }}
          className="rounded-lg border border-hairline-strong bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-brand"
        >
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <textarea
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
          setSaved(false);
        }}
        placeholder="Notes (e.g. quoted $X, follow up Friday)…"
        rows={2}
        className="mt-2 w-full resize-y rounded-lg border border-hairline-strong bg-surface px-2 py-1 text-sm text-ink placeholder:text-ink-subtle outline-none focus:border-brand"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-lg bg-brand px-3 py-1 text-xs font-medium text-brand-fg hover:bg-brand-strong disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && !dirty ? <span className="text-xs text-emerald-600">✓ saved</span> : null}
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
      </div>
    </div>
  );
}
