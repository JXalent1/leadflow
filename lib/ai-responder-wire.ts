/**
 * lib/ai-responder-wire.ts — wires the real DB / Twilio / Claude implementations into the pure
 * AI responder for the webhook route. (Build: ai-responder)
 *
 * The route calls buildRunAiResponder(client) and passes the returned closure as
 * InboundDeps.runAiResponder — but ONLY when aiResponderGloballyEnabled() AND client.ai_enabled.
 * Every send here goes through the SAME suppression-checked reply gate as /api/reply
 * (replyRefusalReason → sendOne → log) and targets ONLY the stored contact phone.
 */

import "server-only";
import type { InboundContactLite, InboundOutcome } from "@/lib/inbound";
import {
  runAiResponder as runAiCore,
  type AiConfig,
  type AiResponderDeps,
  type AiResponderOptions,
} from "@/lib/ai-responder";
import { callClaude } from "@/lib/ai-client";
import {
  getAiState,
  setAiStatus,
  bumpAiStrike,
  getAiHistory,
  countAiReplies,
} from "@/lib/ai-db";
import { recordMessage, createLead } from "@/lib/db";
import { getContactById, isPhoneOptedOut } from "@/lib/inbox-db";
import { replyRefusalReason } from "@/lib/reply";
import { forwardLead } from "@/lib/forward";
import { sendOne } from "@/lib/twilio";
import { clientSender, clientWindow, clientBizName, type Client } from "@/lib/clients";
import { withinSendWindow } from "@/lib/twilio";

/** Global kill switch: AI_RESPONDER_ENABLED must be truthy for ANY client's responder to run. */
export function aiResponderGloballyEnabled(): boolean {
  return process.env.AI_RESPONDER_ENABLED?.trim().toLowerCase() === "true";
}

/** Per-conversation reply cap, env-overridable; defaults to 5. */
function maxTurns(): number {
  const n = Number(process.env.AI_RESPONDER_MAX_TURNS);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

/**
 * Build the InboundDeps.runAiResponder closure for one client. The route only wires this when the
 * global switch + client.ai_enabled are both on, so this function assumes the client is AI-enabled;
 * the deterministic STOP/keyword/suppression gate still ran upstream in lib/inbound.
 */
export function buildRunAiResponder(
  client: Client,
): (contact: InboundContactLite, body: string) => Promise<InboundOutcome | null> {
  const clientId = client.id;
  const config: AiConfig = {
    bizName: clientBizName(client),
    services: client.ai_services,
    offer: client.ai_offer,
    persona: client.ai_persona,
    location: client.ai_location,
  };
  const forwardCfg = {
    clientId,
    forwardPhone: client.forward_phone,
    sender: clientSender(client),
  };

  return async (contact, body) => {
    const contactId = contact.id;

    const deps: AiResponderDeps = {
      classify: (system, turns) => callClaude(system, turns),

      // Guarded send — the SAME gate as /api/reply. Re-load the contact for the freshest
      // suppression state, refuse via replyRefusalReason, and send ONLY to the stored phone.
      sendReply: async (text) => {
        const fresh = await getContactById(clientId, contactId);
        const optedOut = fresh?.phone ? await isPhoneOptedOut(clientId, fresh.phone) : true;
        const refusal = replyRefusalReason(
          fresh ? { phone: fresh.phone, suppressed: fresh.suppressed } : null,
          optedOut,
        );
        if (refusal) {
          console.warn(`[ai] reply refused for contact ${contactId}: ${refusal}`);
          return false;
        }
        const phone = fresh!.phone as string;
        const res = await sendOne(phone, text, clientSender(client));
        await recordMessage({
          clientId,
          contactId,
          direction: "outbound",
          body: text,
          twilioSid: res.ok ? res.sid : null,
          status: res.ok ? "ai_reply" : "failed",
        });
        if (!res.ok) console.error(`[ai] reply send failed contact=${contactId} code=${res.code ?? "?"}`);
        return res.ok;
      },

      createHotLead: () => createLead({ clientId, contactId, replyText: body }),

      forwardHotLead: (leadId, summary) =>
        forwardLead({ contact, leadId, replyText: summary }, forwardCfg),

      markHandedOff: () => setAiStatus(clientId, contactId, "handed_off"),
      markDismissed: () => setAiStatus(clientId, contactId, "dismissed"),
      bumpStrike: () => bumpAiStrike(clientId, contactId),
    };

    const [fresh, state, turns, aiReplyCount] = await Promise.all([
      getContactById(clientId, contactId),
      getAiState(clientId, contactId),
      getAiHistory(clientId, contactId),
      countAiReplies(clientId, contactId),
    ]);

    // Suppression short-circuit: if the contact is already suppressed / opted out (or has no usable
    // phone), the model is never called and no AI lead is created — runAiCore returns null and the
    // webhook defers to the keyword path. The sendReply gate above is still the fail-closed backstop.
    const optedOut = fresh?.phone ? await isPhoneOptedOut(clientId, fresh.phone) : true;
    const suppressed = !fresh || !fresh.phone || fresh.suppressed || optedOut;

    const opts: AiResponderOptions = {
      withinWindow: withinSendWindow(new Date(), clientWindow(client)),
      maxTurns: maxTurns(),
      maxStrikes: 3,
    };

    return runAiCore(
      { config, turns, suppressed, aiStatus: state.status, aiStrikes: state.strikes, aiReplyCount },
      deps,
      opts,
    );
  };
}
