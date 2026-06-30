"use client";

/**
 * components/client-ai-settings.tsx — the "Conversational AI" section of the client edit form.
 * (Build: ai-settings-ui, 2026-06-30)
 *
 * Extracted from components/client-form.tsx to keep that file under the 500-line cap. Pure
 * presentation: it reads/writes the ai_* fields of ClientFormValues through the parent's setter, so
 * they persist via the existing PATCH /api/clients → updateClientConfig path (no new wiring).
 *
 * This is the CONFIG SURFACE only. It never touches the responder logic, the deterministic
 * STOP/"2"/suppression gate, or the send path — those ship + are reviewed elsewhere. ai_enabled
 * stays false unless the operator turns it on here.
 */

import { Field, Input } from "./ui/field";
import type { ClientFormValues } from "./client-form-defaults";

export default function ClientAiSettings({
  v,
  set,
}: {
  v: ClientFormValues;
  set: <K extends keyof ClientFormValues>(key: K, val: ClientFormValues[K]) => void;
}) {
  return (
    <div className="rounded-lg border bg-surface-muted p-4">
      <label
        htmlFor="cf-ai-enabled"
        className="flex cursor-pointer items-start justify-between gap-3"
      >
        <span>
          <span className="text-sm font-medium text-ink">Conversational AI auto-reply</span>
          <span className="mt-0.5 block text-xs font-normal text-ink-subtle">
            When on, the AI reads each inbound reply&apos;s intent, answers like a real rep,
            qualifies interest, and forwards hot leads. STOP and your opt-out keyword are always
            honored first — the AI never texts an opted-out contact.
          </span>
        </span>
        <input
          id="cf-ai-enabled"
          type="checkbox"
          checked={v.ai_enabled}
          onChange={(e) => set("ai_enabled", e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-brand"
        />
      </label>

      {v.ai_enabled ? (
        <div className="mt-4 space-y-4">
          <Field
            label="Services offered"
            htmlFor="cf-ai-services"
            help="What the AI can offer — it never invents services beyond this."
          >
            <textarea
              id="cf-ai-services"
              value={v.ai_services ?? ""}
              onChange={(e) => set("ai_services", e.target.value || null)}
              rows={2}
              placeholder="Pressure washing, paver sealing, window cleaning, whole-house exterior wash"
              className="w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Offer / hook"
              htmlFor="cf-ai-offer"
              help="What the AI can mention — never a price."
            >
              <Input
                id="cf-ai-offer"
                value={v.ai_offer ?? ""}
                onChange={(e) => set("ai_offer", e.target.value || null)}
                placeholder="Free quote; running deals this week"
              />
            </Field>
            <Field
              label="Service area"
              htmlFor="cf-ai-location"
              help='For the "where are you located" answer.'
            >
              <Input
                id="cf-ai-location"
                value={v.ai_location ?? ""}
                onChange={(e) => set("ai_location", e.target.value || null)}
                placeholder="Tallahassee, FL"
              />
            </Field>
          </div>

          <Field
            label="Rep name + tone"
            htmlFor="cf-ai-persona"
            help="The name + voice the AI texts as."
          >
            <Input
              id="cf-ai-persona"
              value={v.ai_persona ?? ""}
              onChange={(e) => set("ai_persona", e.target.value || null)}
              placeholder="Lance — friendly, casual, never robotic"
            />
          </Field>

          <p className="text-[11px] text-ink-subtle">
            The AI also requires <span className="font-medium text-ink-muted">ANTHROPIC_API_KEY</span>{" "}
            and <span className="font-medium text-ink-muted">AI_RESPONDER_ENABLED</span> set on the
            server.
          </p>
        </div>
      ) : null}
    </div>
  );
}
