/**
 * components/client-form-defaults.ts — the client-form value type + defaults.
 *
 * Split out of components/client-form.tsx to keep that component under the 500-line cap. Pure data
 * + types only (no JSX, no hooks) so it can be imported by the form and by the cockpit (which maps a
 * loaded Client into ClientFormValues for the Edit modal).
 */

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
  // Conversational-AI responder config. ai_enabled flips the auto-reply on for this client; the
  // ai_* text fields shape the system prompt (lib/ai-responder.ts buildSystemPrompt).
  ai_enabled: boolean;
  ai_services: string | null;
  ai_offer: string | null;
  ai_persona: string | null;
  ai_location: string | null;
}

export const POWERWASH_TEMPLATE =
  'Hey [NAME], this is your local crew. We\'re working near [ADDRESS] this week — want a free quote on pressure washing, paver sealing, or exterior house cleaning? Reply "2" to opt out';

/** Defaults for a NEW client. Auto-pause OFF (lead_target = 0 → the send route treats target <= 0
 *  as "never pause"), so a new client never inherits a stray small target (#16); the operator turns
 *  auto-pause on explicitly via the form toggle. */
export const EMPTY: ClientFormValues = {
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
  lead_target: 0,
  target_period: "month",
  // Conversational AI ships OFF — the operator turns it on per client in the form.
  ai_enabled: false,
  ai_services: null,
  ai_offer: null,
  ai_persona: null,
  ai_location: null,
};

export const SAMPLE_CONTACT = { firstName: "Chris", zip: "32801", address: "1424 EDGEWATER DR" };
