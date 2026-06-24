/**
 * lib/request-client.ts — resolve the "current client" for an OPERATOR request. (v2 Module V1)
 *
 * Operator routes/pages (dashboard, inbox, campaign, scrub, skiptrace, reply, leads) act on one
 * client at a time. Until a client switcher ships (later module), this defaults to client 1
 * (Talan) and accepts a `?clientId=` override (used by tests / the eventual switcher). The admin
 * gate is unchanged and still required by every route — this only selects WHICH client's data.
 *
 * The inbound webhook does NOT use this — it resolves the client by the Twilio To number
 * (getClientByInboundNumber), since there is no operator session on an inbound SMS.
 */

import { getClientById, DEFAULT_CLIENT_ID, type Client } from "@/lib/clients";

/** The selected client id for an operator request: `?clientId=` if valid, else client 1. */
export function clientIdFromRequest(req: Request): number {
  const raw = new URL(req.url).searchParams.get("clientId");
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CLIENT_ID;
}

/** Load the selected client record (or null if it doesn't exist). */
export async function resolveClient(req: Request): Promise<Client | null> {
  return getClientById(clientIdFromRequest(req));
}

/** Same selection logic for server-component pages that only have searchParams. */
export function clientIdFromSearchParams(searchParams: { clientId?: string }): number {
  const n = Number(searchParams.clientId);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CLIENT_ID;
}
