# v2 Session 5 — Client dashboard + login (closes the access-control gate)

Module V5 in `modules-v2.md`. **The security-critical module.** Single focused session, then a
required agent-team security review.

## Goal
Two things: (1) replace the single shared admin password with **real per-user login** (operator vs.
client roles), which **CLOSES the long-carried `?clientId=` access-control gate** — the hard
prerequisite before a real client #2; and (2) a clean, branded, **read-mostly client dashboard**
where a client logs in and watches their own leads land + progress to their 50/month guarantee.

## Scope — do this
1. **Auth / users:**
   - `users` table: `id`, `email`, `password_hash`, `role` ('operator'|'client'), `client_id` (NULL
     for operator, set for client users), `created_at`. Seed an operator user + a client user for
     Talan (client 1).
   - Real login: email + password (hashed with a vetted KDF — bcrypt/scrypt/argon2), an **httpOnly,
     secure** session cookie carrying user id + role + client_id. Replace the shared `ADMIN_PASSWORD`
     gate. Keep it minimal — NO OAuth/SSO/password-reset; the operator creates client users with a
     password. Basic login throttling is fine.
   - **Access control (the load-bearing fix):** the resolved client for EVERY request comes from the
     LOGGED-IN USER's session, NOT a `?clientId=` param. An **operator** may act on any client (the
     cockpit click-through selects one); a **client** user is HARD-LOCKED to their own `client_id` —
     any `?clientId=` (or campaign id, or API body client) that isn't theirs is rejected, and they can
     never reach another client's data by any route/param/API. **This closes the V1 gate.**
2. **Client-facing dashboard (read-mostly, branded):**
   - A clean per-client view branded with the client's name/branding: their **leads feed** (name,
     address, reply text, time), **progress to the guarantee** (X / 50 this cycle), lead detail.
   - Clients do NOT see: pipeline controls (trace/scrub/send), the operator cockpit, other clients,
     or config. Operators keep all of it.
3. **Routing by role:** operator → cockpit + full per-client dashboards + controls; client → their
   scoped dashboard only.

## Do NOT
- Build billing (V6) or the full visual redesign (V7 — make the client view clean + basic-branded;
  comprehensive polish is later).
- Touch the send / suppression / eligibility logic. No source file over 500 lines. Don't break
  client-1 (Talan).

## Acceptance — security is the bar
- Login works: operator login → cockpit + full access; client login → ONLY their scoped dashboard.
- **The access-control gate is CLOSED — prove it with a fixture/test:** a client-2 user cannot read or
  reach client-1's data by ANY vector — `?clientId=1`, `/dashboard?clientId=1`, an API route with
  another client's id, the inbox/reply/leads endpoints. Resolution is server-side from the session,
  never a request param, for client users.
- Operator can still reach all clients (cockpit + drill-in).
- The client dashboard shows leads + guarantee progress, read-mostly + scoped; no operator controls
  leak to the client role.
- Talan works; `npm run build` + `npm test` + `npm run test:isolation` green.
- Update `status.md`, `overview.md` (decisions), `modules-v2.md` (V5 → done; mark the V1 access gate
  CLOSED), rewrite `handoff.md` for V6.

## After it passes → agent-team SECURITY review (REQUIRED)
3 reviewers:
- **access-control:** can a client user reach ANY other client's data by any param/route/API? Is the
  resolved client ALWAYS from the session (never a request param) for client users? Is the operator's
  legitimate cross-client access still correct? Is the V1 `?clientId=` gate truly closed?
- **auth:** password hashing (vetted KDF, salted), session cookie httpOnly+secure+sane expiry, no
  session fixation, login throttling, no credential/hash leakage in responses or logs.
- **correctness:** role routing, client dashboard read-mostly + scoped, no controls exposed to
  clients, Talan unchanged, no regressions.
Any cross-client access by a client user, or an auth weakness, is Critical — fix before done.
