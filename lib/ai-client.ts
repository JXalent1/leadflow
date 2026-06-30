/**
 * lib/ai-client.ts — the real Claude call behind the conversational responder. (Build: ai-responder)
 *
 * Isolated here so lib/ai-responder.ts (the pure orchestrator) and its unit tests never import the
 * Anthropic SDK or need ANTHROPIC_API_KEY — they inject a fake `classify`. The wire module injects
 * THIS implementation in production.
 *
 * Model: claude-sonnet-4-6 (strong enough for the short SMS-qualification intent read, far cheaper +
 * faster than Opus for high inbound volume), overridable via AI_RESPONDER_MODEL.
 * (For even lower cost, claude-haiku-4-5-20251001 is a cheaper option — set AI_RESPONDER_MODEL to it.)
 * The intent read is a short, well-scoped classification, so we run at low effort with a tight
 * max_tokens and a JSON-schema structured output — no streaming needed. The API key is read from
 * env and never logged. A missing key (or any API error) THROWS, which lib/inbound catches to fall
 * back to the keyword path — the responder fails safe, never crashing the webhook.
 */

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { AiSignal, AiTurn } from "@/lib/ai-responder";

let cached: Anthropic | null = null;

function getClient(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set — AI responder unavailable.");
  cached = new Anthropic({ apiKey });
  return cached;
}

function model(): string {
  // Cheaper + faster than Opus, ample for SMS qualification. claude-haiku-4-5-20251001 is cheaper still.
  return process.env.AI_RESPONDER_MODEL?.trim() || "claude-sonnet-4-6";
}

// Structured-output schema. Strings (not nullables) for service/summary keep the schema simple and
// avoid null-type edge cases; "" stands in for "none". additionalProperties:false + all-required is
// what JSON-schema structured outputs require.
const SIGNAL_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    service: { type: "string" },
    wants_call: { type: "boolean" },
    qualified: { type: "boolean" },
    serious: { type: "boolean" },
    summary: { type: "string" },
  },
  required: ["reply", "service", "wants_call", "qualified", "serious", "summary"],
  additionalProperties: false,
} as const;

/**
 * Call Claude for the intent read + next reply. Returns the validated AiSignal. Throws on a missing
 * key, an API/network error, or an unparseable response — the caller (lib/inbound) treats any throw
 * as "fall back to the keyword path", so this never needs to swallow errors itself.
 */
export async function callClaude(system: string, turns: AiTurn[]): Promise<AiSignal> {
  // Cast the params: output_config is GA on the wire but may lag the installed SDK's static types.
  const params = {
    model: model(),
    max_tokens: 1024,
    system,
    output_config: { effort: "low", format: { type: "json_schema", schema: SIGNAL_SCHEMA } },
    messages: turns.map((t) => ({ role: t.role, content: t.text })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const resp = await getClient().messages.create(params);

  const text = (resp.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
  if (!text) throw new Error("AI responder: empty model response");

  const parsed = JSON.parse(text) as Partial<AiSignal>;
  return {
    reply: typeof parsed.reply === "string" ? parsed.reply : "",
    service: typeof parsed.service === "string" ? parsed.service : "",
    wants_call: parsed.wants_call === true,
    qualified: parsed.qualified === true,
    // Default to serious=true so a malformed/missing flag never wrongly strikes a real prospect.
    serious: parsed.serious !== false,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}
