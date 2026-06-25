/**
 * lib/request-client.ts — PARSE request params (v2 Module V5 rewrite).
 *
 * SECURITY: these helpers now ONLY parse the raw `?clientId=` / `?campaignId=` values — they do
 * NOT decide which client a request may act on. That decision moved to lib/access.ts
 * (resolveClientIdForUser), which takes the LOGGED-IN USER and the parsed request value and locks a
 * client user to their own client_id. This is the chokepoint that closes the V1 access gate: a
 * request param can no longer select a client on its own.
 *
 * (The old clientIdFromRequest/resolveClient helpers — which defaulted straight to client 1 from a
 * request param with no user check — were removed.)
 */

function parsePositiveInt(raw: string | null | undefined): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The raw requested client id (or undefined). Pass to resolveClientIdForUser with the session user. */
export function requestedClientId(req: Request): number | undefined {
  return parsePositiveInt(new URL(req.url).searchParams.get("clientId"));
}

/** Same for server-component pages that only have searchParams. */
export function requestedClientIdFromSearchParams(searchParams: { clientId?: string }): number | undefined {
  return parsePositiveInt(searchParams.clientId);
}

/**
 * The requested campaign id for an operator request, or undefined if none/invalid. (v2 Module V2)
 * The actual campaign is resolved per (resolved) client via resolveCampaignForClient, which
 * validates ownership + falls back to the client's default campaign. This only parses the param.
 */
export function campaignIdFromRequest(req: Request): number | undefined {
  return parsePositiveInt(new URL(req.url).searchParams.get("campaignId"));
}

/** Same for server-component pages that only have searchParams. */
export function campaignIdFromSearchParams(searchParams: { campaignId?: string }): number | undefined {
  return parsePositiveInt(searchParams.campaignId);
}
