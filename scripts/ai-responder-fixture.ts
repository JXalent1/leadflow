// scripts/ai-responder-fixture.ts — live-DB acceptance for the conversational AI responder.
// (Build: ai-responder, 2026-06-29)
//
// Exercises the REAL pure responder core (lib/ai-responder.runAiResponder) wired to the REAL Neon DB
// helpers (ai-db state/history/turns, createLead, forwardLead, the suppression-checked reply gate),
// with the Claude call (classify) and Twilio sendOne MOCKED — so there is NO Anthropic spend and NO
// real SMS. This mirrors lib/ai-responder-wire.buildRunAiResponder exactly, swapping only classify +
// sendOne for fakes. Proves against the live DB:
//   - suppressed contact → the guarded send REFUSES → no SMS, no 'ai_reply' logged;
//   - qualified → EXACTLY one hot lead + one forward (with summary) + ai_status='handed_off' + 1 reply;
//   - turn cap → 5 prior ai_reply messages → skipped, no classify, no send;
//   - 3rd non-serious strike → ai_status='dismissed', strike incremented, no reply;
//   - handed_off contact → skipped, no classify.
// Everything created is deleted at the end → the live DB is left pristine.
//
// Run: npm run test:ai   (requires DATABASE_URL + the schema applied; needs NO ANTHROPIC_API_KEY).

import { config } from "dotenv";
import type { InboundContactLite } from "@/lib/inbound";
import type { AiResponderDeps, AiResponderOptions, AiSignal, AiTurn } from "@/lib/ai-responder";
config({ path: ".env.local" });
config();

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`✓  ${label}`);
  } else {
    fail++;
    console.error(`✗  ${label}`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql, createLead, recordMessage, markLeadForwarded } = await import("@/lib/db");
  const { createClient, clientSender } = await import("@/lib/clients");
  const { runAiResponder } = await import("@/lib/ai-responder");
  const { getAiState, setAiStatus, bumpAiStrike, getAiHistory, countAiReplies } = await import("@/lib/ai-db");
  const { getContactById, isPhoneOptedOut } = await import("@/lib/inbox-db");
  const { replyRefusalReason } = await import("@/lib/reply");
  const { forwardLead } = await import("@/lib/forward");

  const OK_SEND = { ok: true as const, sid: "SM_FAKE", status: "queued" };

  let clientId: number | null = null;
  try {
    const client = await createClient({
      name: "AI-RESPONDER-FIXTURE TEST CLIENT",
      from_number: "+13215550199",
      forward_phone: "+14075559999",
      send_rate_per_hour: 60,
      ai_enabled: true,
      ai_services: "window cleaning",
      ai_persona: "Lance, friendly and brief",
      ai_location: "Tallahassee, FL",
    });
    clientId = client.id;
    const sender = clientSender(client);
    const forwardCfg = { clientId, forwardPhone: client.forward_phone, sender };

    const campaignId = (
      (await sql`INSERT INTO campaigns (client_id, name) VALUES (${clientId}, 'ai fixture') RETURNING id`)[0] as { id: number }
    ).id;

    // Helper: make a fresh contact (one conversation per scenario) and return its lite shape.
    async function freshContact(suppressed = false): Promise<InboundContactLite> {
      const id = (
        (await sql`
          INSERT INTO contacts (client_id, campaign_id, first_name, last_name, address, city, state, zip,
                                phone, phone_type, skiptrace_status, scrub_status, send_status, suppressed)
          VALUES (${clientId}, ${campaignId}, 'Pat', 'Lead', '1 Test St', 'Tallahassee', 'FL', '32301',
                  '+14075550000', 'mobile', 'matched', 'clean', 'sent', ${suppressed})
          RETURNING id`)[0] as { id: number }
      ).id;
      return {
        id,
        first_name: "Pat",
        last_name: "Lead",
        address: "1 Test St",
        city: "Tallahassee",
        state: "FL",
        zip: "32301",
        phone: "+14075550000",
      };
    }

    // Build the SAME deps the wire builds, but with classify + sendOne mocked (no spend, no SMS).
    function makeDeps(contact: InboundContactLite, signal: AiSignal, sends: string[]): AiResponderDeps {
      const contactId = contact.id;
      const body = "yes, when can you come out?";
      return {
        classify: async (_system: string, _turns: AiTurn[]) => signal,
        sendReply: async (text) => {
          const fresh = await getContactById(clientId!, contactId);
          const optedOut = fresh?.phone ? await isPhoneOptedOut(clientId!, fresh.phone) : true;
          const refusal = replyRefusalReason(
            fresh ? { phone: fresh.phone, suppressed: fresh.suppressed } : null,
            optedOut,
          );
          if (refusal) return false;
          // Mocked send (no Twilio). Log it as the wire would so the turn-cap counter persists.
          const res = OK_SEND;
          sends.push(text);
          await recordMessage({
            clientId: clientId!,
            contactId,
            direction: "outbound",
            body: text,
            twilioSid: res.sid,
            status: "ai_reply",
          });
          return true;
        },
        createHotLead: () => createLead({ clientId: clientId!, contactId, replyText: body }),
        forwardHotLead: (leadId, summary) =>
          forwardLead(
            { contact, leadId, replyText: summary },
            forwardCfg,
            { send: async () => OK_SEND, markForwarded: markLeadForwarded },
          ),
        markHandedOff: () => setAiStatus(clientId!, contactId, "handed_off"),
        markDismissed: () => setAiStatus(clientId!, contactId, "dismissed"),
        bumpStrike: () => bumpAiStrike(clientId!, contactId),
      };
    }

    const OPTS: AiResponderOptions = { withinWindow: true, maxTurns: 5, maxStrikes: 3 };
    function signal(over: Partial<AiSignal>): AiSignal {
      return { reply: "", service: "", wants_call: false, qualified: false, serious: true, summary: "", ...over };
    }

    async function loadInput(contact: InboundContactLite) {
      const [state, turns, aiReplyCount] = await Promise.all([
        getAiState(clientId!, contact.id),
        getAiHistory(clientId!, contact.id),
        countAiReplies(clientId!, contact.id),
      ]);
      return {
        config: { bizName: "AI-RESPONDER-FIXTURE TEST CLIENT", services: "window cleaning", offer: null, persona: "Lance", location: "Tallahassee, FL" },
        turns,
        aiStatus: state.status,
        aiStrikes: state.strikes,
        aiReplyCount,
      };
    }
    async function countLeads(contactId: number): Promise<number> {
      return (
        (await sql`SELECT count(*)::int n FROM leads WHERE client_id = ${clientId} AND contact_id = ${contactId}`)[0] as { n: number }
      ).n;
    }

    // 1. Suppressed contact → guarded send refuses → no SMS, no ai_reply logged.
    {
      const contact = await freshContact(true);
      await recordMessage({ clientId, contactId: contact.id, direction: "inbound", body: "hi", status: null });
      const sends: string[] = [];
      const out = await runAiResponder(await loadInput(contact), makeDeps(contact, signal({ reply: "What windows." }), sends), OPTS);
      check("suppressed: outcome is ai_reply (engaged), but the send was refused", out?.kind === "ai_reply");
      check("suppressed: NO SMS sent to a suppressed contact", sends.length === 0);
      check("suppressed: no 'ai_reply' logged in DB", (await countAiReplies(clientId!, contact.id)) === 0);
    }

    // 2. Qualified → exactly one hot lead + one forward + handed_off + one reply.
    {
      const contact = await freshContact();
      await recordMessage({ clientId, contactId: contact.id, direction: "inbound", body: "yes when can you come out?", status: null });
      const sends: string[] = [];
      const sig = signal({
        reply: "Perfect. Someone from the team will reach out shortly.",
        service: "window cleaning",
        wants_call: true,
        qualified: true,
        summary: "Wants window cleaning, late August, asked about price.",
      });
      const out = await runAiResponder(await loadInput(contact), makeDeps(contact, sig, sends), OPTS);
      check("qualified: outcome is ai_lead", out?.kind === "ai_lead");
      check("qualified: exactly one hot lead created in DB", (await countLeads(contact.id)) === 1);
      check("qualified: lead forwarded=true in DB", out?.kind === "ai_lead" && out.forwarded === true);
      const st = await getAiState(clientId!, contact.id);
      check("qualified: ai_status='handed_off'", st.status === "handed_off");
      check("qualified: exactly one expectation-setting reply sent", sends.length === 1);
    }

    // 3. Turn cap → 5 prior ai_reply messages → skipped before classify/send.
    {
      const contact = await freshContact();
      for (let i = 0; i < 5; i++) {
        await recordMessage({ clientId, contactId: contact.id, direction: "outbound", body: `r${i}`, status: "ai_reply" });
      }
      const sends: string[] = [];
      let classified = false;
      const deps = makeDeps(contact, signal({ reply: "more" }), sends);
      deps.classify = async () => {
        classified = true;
        return signal({ reply: "more" });
      };
      const out = await runAiResponder(await loadInput(contact), deps, OPTS);
      check("turn cap: outcome is ai_skipped(turn_cap)", out?.kind === "ai_skipped" && out.reason === "turn_cap");
      check("turn cap: classify NOT called", classified === false);
      check("turn cap: no new reply sent", sends.length === 0);
    }

    // 4. 3rd non-serious strike → dismissed, strike incremented.
    {
      const contact = await freshContact();
      await bumpAiStrike(clientId!, contact.id);
      await bumpAiStrike(clientId!, contact.id); // strikes now 2
      await recordMessage({ clientId, contactId: contact.id, direction: "inbound", body: "lol spam", status: null });
      const sends: string[] = [];
      const out = await runAiResponder(await loadInput(contact), makeDeps(contact, signal({ serious: false }), sends), OPTS);
      check("3rd strike: outcome is ai_skipped(dismissed)", out?.kind === "ai_skipped" && out.reason === "dismissed");
      const st = await getAiState(clientId!, contact.id);
      check("3rd strike: ai_status='dismissed'", st.status === "dismissed");
      check("3rd strike: strikes incremented to 3", st.strikes === 3);
      check("3rd strike: no reply sent", sends.length === 0);
    }

    // 5. handed_off contact → skipped, no classify.
    {
      const contact = await freshContact();
      await setAiStatus(clientId!, contact.id, "handed_off");
      const sends: string[] = [];
      let classified = false;
      const deps = makeDeps(contact, signal({ reply: "hi again" }), sends);
      deps.classify = async () => {
        classified = true;
        return signal({});
      };
      const out = await runAiResponder(await loadInput(contact), deps, OPTS);
      check("handed_off: outcome is ai_skipped(handed_off)", out?.kind === "ai_skipped" && out.reason === "handed_off");
      check("handed_off: classify NOT called", classified === false);
      check("handed_off: no reply sent", sends.length === 0);
    }
  } finally {
    if (clientId !== null) {
      await sql`DELETE FROM leads WHERE client_id = ${clientId}`;
      await sql`DELETE FROM messages WHERE client_id = ${clientId}`;
      await sql`DELETE FROM contacts WHERE client_id = ${clientId}`;
      await sql`DELETE FROM campaigns WHERE client_id = ${clientId}`;
      await sql`DELETE FROM clients WHERE id = ${clientId}`;
    }
    const strays = (await sql`SELECT count(*)::int n FROM clients WHERE name = 'AI-RESPONDER-FIXTURE TEST CLIENT'`)[0] as { n: number };
    check("throwaway client cleaned up (DB pristine)", strays.n === 0);
  }

  console.log(`\n${fail === 0 ? "AI-RESPONDER OK" : "AI-RESPONDER FAILED"} — ${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[ai-responder-fixture] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
