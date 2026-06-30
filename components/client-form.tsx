"use client";

/**
 * components/client-form.tsx — operator "Add / edit client" form. (2nd-client onboarding, 2026-06-27)
 *
 * A launcher button (`ClientFormLauncher`) opens a modal with the full per-client config form:
 * number, forward phone, message copy, opt-out keyword, send window/timezone/rate, lead
 * guarantee/target. The message template has a LIVE preview rendered with the real renderMessage +
 * segmentInfo against a sample contact, INCLUDING the per-client opt-out line derived from the
 * keyword — so the operator sees the exact first text + segment count and the advertised opt-out
 * line can't drift from the keyword the system honors.
 *
 * On CREATE it also creates the client's login user (email + password → role='client'). It POSTs to
 * /api/clients (create) / PATCHes /api/clients (edit), then refreshes the server-rendered cockpit.
 *
 * Pure rendering helpers (renderMessage/segmentInfo/optOutInstructionFor) come from lib/sms.ts,
 * which is DB-free, so the preview runs client-side.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { renderMessage, segmentInfo, optOutInstructionFor } from "@/lib/sms";
import { parseForwardPhones, isProbablyPhone } from "@/lib/forward-phones";
import Button from "./ui/button";
import { Field, Input, Select } from "./ui/field";

/** The editable client config the form reads/writes (a serializable subset of lib/clients Client). */
export interface ClientFormValues {
  id?: number;
  name: string;
  biz_name: string | null;
  from_number: string | null;
  messaging_service_sid: string | null;
  message_template: string | null;
  forward_phone: string | null;
  optout_keyword: string | null;
  optout_instruction: string | null;
  send_window_start_hour: number;
  send_window_end_hour: number;
  send_timezone: string;
  send_rate_per_hour: number;
  lead_guarantee: number;
  lead_target: number | null;
  target_period: string; // 'week' | 'month'
}

const POWERWASH_TEMPLATE =
  'Hey [NAME], this is your local crew. We\'re working near [ADDRESS] this week — want a free quote on pressure washing, paver sealing, or exterior house cleaning? Reply "2" to opt out';

const EMPTY: ClientFormValues = {
  name: "",
  biz_name: null,
  from_number: null,
  messaging_service_sid: null,
  message_template: POWERWASH_TEMPLATE,
  forward_phone: null,
  optout_keyword: "2",
  optout_instruction: null,
  send_window_start_hour: 10,
  send_window_end_hour: 19,
  send_timezone: "America/New_York",
  send_rate_per_hour: 300,
  lead_guarantee: 50,
  lead_target: null,
  target_period: "month",
};

const SAMPLE_CONTACT = { firstName: "Chris", zip: "32801", address: "1424 EDGEWATER DR" };

export function ClientFormLauncher({
  mode,
  client,
  triggerLabel,
  triggerVariant = "primary",
  triggerSize = "md",
  stopPropagation = false,
}: {
  mode: "create" | "edit";
  client?: ClientFormValues;
  triggerLabel?: string;
  triggerVariant?: "primary" | "secondary" | "ghost" | "danger";
  triggerSize?: "sm" | "md";
  stopPropagation?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = triggerLabel ?? (mode === "create" ? "+ New client" : "Edit");

  return (
    <>
      <Button
        variant={triggerVariant}
        size={triggerSize}
        onClick={(e) => {
          // On a card that is itself a link, don't trigger the drill-through (mirrors CockpitBilling).
          if (stopPropagation) {
            e.preventDefault();
            e.stopPropagation();
          }
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {open ? (
        <ClientFormModal mode={mode} initial={client ?? EMPTY} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function ClientFormModal({
  mode,
  initial,
  onClose,
}: {
  mode: "create" | "edit";
  initial: ClientFormValues;
  onClose: () => void;
}) {
  const router = useRouter();
  const [v, setV] = useState<ClientFormValues>(initial);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set<K extends keyof ClientFormValues>(key: K, val: ClientFormValues[K]) {
    setV((prev) => ({ ...prev, [key]: val }));
  }

  // Live preview: render the exact first text the homeowner would get, WITH the per-client opt-out
  // line derived from the keyword (so the advertised line matches what inbound honors).
  const preview = useMemo(() => {
    const optLine = optOutInstructionFor(v.optout_keyword, v.optout_instruction);
    const body = renderMessage(
      v.message_template ?? "",
      SAMPLE_CONTACT,
      v.biz_name ?? "",
      optLine
    );
    return { body, seg: segmentInfo(body), optLine };
  }, [v.message_template, v.biz_name, v.optout_keyword, v.optout_instruction]);

  // Forward recipients: parse the free-text field + flag clearly-invalid entries (non-blocking).
  const forward = useMemo(() => {
    const list = parseForwardPhones(v.forward_phone);
    const invalid = list.filter((p) => !isProbablyPhone(p));
    return { count: list.length, invalid };
  }, [v.forward_phone]);

  async function submit() {
    setErr(null);
    if (!v.name.trim()) {
      setErr("Business / client name is required.");
      return;
    }
    if (mode === "create" && (loginEmail.trim() || loginPassword)) {
      if (!loginEmail.trim() || !loginPassword) {
        setErr("Provide both a login email and password, or leave both blank.");
        return;
      }
      if (loginPassword.length < 8) {
        setErr("Login password must be at least 8 characters.");
        return;
      }
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: v.name.trim(),
        biz_name: v.biz_name,
        from_number: v.from_number,
        messaging_service_sid: v.messaging_service_sid,
        message_template: v.message_template,
        forward_phone: v.forward_phone,
        optout_keyword: v.optout_keyword,
        optout_instruction: v.optout_instruction,
        send_window_start_hour: v.send_window_start_hour,
        send_window_end_hour: v.send_window_end_hour,
        send_timezone: v.send_timezone,
        send_rate_per_hour: v.send_rate_per_hour,
        lead_guarantee: v.lead_guarantee,
        lead_target: v.lead_target,
        target_period: v.target_period,
      };
      let res: Response;
      if (mode === "create") {
        if (loginEmail.trim() && loginPassword) {
          payload.loginEmail = loginEmail.trim();
          payload.loginPassword = loginPassword;
        }
        res = await fetch("/api/clients", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        payload.clientId = v.id;
        res = await fetch("/api/clients", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setErr(data.message ?? data.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
      onClose();
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-6 w-full max-w-2xl rounded-2xl border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="text-base font-medium text-ink">
            {mode === "create" ? "Add a new client" : `Edit ${initial.name}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-ink-subtle hover:text-ink"
          >
            Close
          </button>
        </div>

        <div className="max-h-[75vh] space-y-5 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business / client name" htmlFor="cf-name">
              <Input
                id="cf-name"
                value={v.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Jeremy's Powerwashing"
              />
            </Field>
            <Field label="Brand name in copy ([BIZ])" htmlFor="cf-biz" help="Optional; used where the template has [BIZ].">
              <Input
                id="cf-biz"
                value={v.biz_name ?? ""}
                onChange={(e) => set("biz_name", e.target.value || null)}
                placeholder="Optional"
              />
            </Field>
            <Field label="Twilio from number" htmlFor="cf-from" help="E.164, e.g. +14075551234. Inbound STOP/replies route by this.">
              <Input
                id="cf-from"
                value={v.from_number ?? ""}
                onChange={(e) => set("from_number", e.target.value || null)}
                placeholder="+1..."
              />
            </Field>
            <Field
              label="Forward phone(s) (lead pings)"
              htmlFor="cf-fwd"
              help={
                forward.invalid.length > 0
                  ? undefined
                  : `Where hot leads are texted. Comma-separate multiple numbers to ping more than one person${
                      forward.count > 1 ? ` (${forward.count} recipients)` : ""
                    }.`
              }
              error={
                forward.invalid.length > 0
                  ? `Check these entries (saved anyway): ${forward.invalid.join(", ")}`
                  : undefined
              }
            >
              <textarea
                id="cf-fwd"
                value={v.forward_phone ?? ""}
                onChange={(e) => set("forward_phone", e.target.value || null)}
                rows={2}
                placeholder="+14075551234, +14075556789"
                className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
              />
            </Field>
          </div>

          <Field
            label="Message template"
            htmlFor="cf-tmpl"
            help="Placeholders: [NAME] [ADDRESS] [BIZ] [ZIP]. Wrap a droppable clause in {…}. The opt-out line is added automatically from the keyword below."
          >
            <textarea
              id="cf-tmpl"
              value={v.message_template ?? ""}
              onChange={(e) => set("message_template", e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
            />
          </Field>

          {/* Live preview — exact first text + segment count, with the per-client opt-out line. */}
          <div className="rounded-lg border bg-surface-muted p-3">
            <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-ink-subtle">
              <span>Preview (sample contact)</span>
              <span className={preview.seg.segments > 1 ? "text-amber-700" : "text-ink-subtle"}>
                {preview.seg.length} chars · {preview.seg.segments} segment
                {preview.seg.segments === 1 ? "" : "s"} · {preview.seg.encoding}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-ink">{preview.body}</p>
            <p className="mt-2 text-[11px] text-ink-subtle">
              Opt-out line shown: <span className="font-medium text-ink-muted">{preview.optLine}</span>
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Opt-out keyword"
              htmlFor="cf-kw"
              help='e.g. 2 — advertised AND honored as an exact reply. Blank = STOP only. STOP always works regardless.'
            >
              <Input
                id="cf-kw"
                value={v.optout_keyword ?? ""}
                onChange={(e) => set("optout_keyword", e.target.value.trim() || null)}
                placeholder="blank = STOP only"
              />
            </Field>
            <Field label="Send rate (per hour)" htmlFor="cf-rate">
              <Input
                id="cf-rate"
                type="number"
                min={1}
                max={20000}
                value={v.send_rate_per_hour}
                onChange={(e) => set("send_rate_per_hour", Number(e.target.value))}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Window start hour" htmlFor="cf-ws">
              <Input
                id="cf-ws"
                type="number"
                min={0}
                max={23}
                value={v.send_window_start_hour}
                onChange={(e) => set("send_window_start_hour", Number(e.target.value))}
              />
            </Field>
            <Field label="Window end hour" htmlFor="cf-we">
              <Input
                id="cf-we"
                type="number"
                min={1}
                max={24}
                value={v.send_window_end_hour}
                onChange={(e) => set("send_window_end_hour", Number(e.target.value))}
              />
            </Field>
            <Field label="Timezone" htmlFor="cf-tz" help="Florida is Eastern.">
              <Input
                id="cf-tz"
                value={v.send_timezone}
                onChange={(e) => set("send_timezone", e.target.value)}
                placeholder="America/New_York"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Lead guarantee" htmlFor="cf-guar">
              <Input
                id="cf-guar"
                type="number"
                min={0}
                value={v.lead_guarantee}
                onChange={(e) => set("lead_guarantee", Number(e.target.value))}
              />
            </Field>
            <Field label="Lead target" htmlFor="cf-target" help="Blank = use the guarantee.">
              <Input
                id="cf-target"
                type="number"
                min={0}
                value={v.lead_target ?? ""}
                onChange={(e) =>
                  set("lead_target", e.target.value === "" ? null : Number(e.target.value))
                }
                placeholder="= guarantee"
              />
            </Field>
            <Field label="Target period" htmlFor="cf-period">
              <Select
                id="cf-period"
                value={v.target_period}
                onChange={(e) => set("target_period", e.target.value)}
              >
                <option value="month">month</option>
                <option value="week">week</option>
              </Select>
            </Field>
          </div>

          {mode === "create" ? (
            <div className="rounded-lg border bg-surface-muted p-4">
              <p className="mb-3 text-xs font-medium text-ink">
                Client login (optional) — creates the client&apos;s portal account
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Login email" htmlFor="cf-le">
                  <Input
                    id="cf-le"
                    type="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="client@example.com"
                  />
                </Field>
                <Field label="Login password" htmlFor="cf-lp" help="≥ 8 characters.">
                  <Input
                    id="cf-lp"
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                  />
                </Field>
              </div>
            </div>
          ) : null}

          {err ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {err}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            {mode === "create" ? "Create client" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
