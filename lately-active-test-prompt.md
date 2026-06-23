# Lately.la — Authorized Non-Destructive Security Test (Claude Code prompt)

> Paste everything below into Claude Code, running in a project folder with the
> **Chrome DevTools MCP** connected in its default **isolated** browser instance.
> It is written so the agent confirms reachability of vulnerabilities **without**
> harvesting data, writing to production, creating accounts, or operating any
> admin functionality.

---

## ROLE & AUTHORIZATION

You are performing an **authorized, internal security assessment** of `https://www.lately.la/`
and its Supabase backend. The operator is an **equity owner** of Lately Technologies, Inc.
and is conducting this at the request of a co-owner. Scope is the company's own production
web application and the Supabase project it calls directly from the browser.

This is a **black-box** test (website only — no backend credentials, no source).

## NON-NEGOTIABLE RULES (read before every action)

The standard is **"prove and stop, don't harvest."** Demonstrate that a gap is *reachable*,
capture minimal evidence, and move on. Do not exploit it for data or control.

1. **Read-only against production.** Never send `INSERT`/`UPDATE`/`UPSERT`/`DELETE`,
   never call a write/mutating RPC, never submit a form that persists data.
2. **No accounts.** Do not register, log in, or create any user. Test as an
   **anonymous / logged-out** client only.
3. **No money, no bookings.** Never start a checkout, enter card data, or place a booking.
4. **No data exfiltration.** To prove a table/endpoint is reachable, request a **row count**
   (`Prefer: count=exact` + `limit=0`) or **at most one** sample row. Never download,
   page through, or store full tables. **Redact any real PII** you happen to see
   (names, emails, phones, addresses) in your notes — keep only field names and a count.
5. **Never operate the admin panel.** If an admin route or admin function is reachable
   without proper authorization, that **is** the finding — record it and stop. Do not
   perform any admin action.
6. **No availability/DoS impact.** Rate-limit checks use a **small capped burst (≤20 reqs)**
   against a **public read** endpoint only. Do **not** test OTP/SMS-send or login endpoints
   (cost, toll-fraud, account lockout) — document those as "needs controlled test."
7. **Scope:** `lately.la` and its Supabase project (`*.supabase.co`) only.
   **Out of scope:** Stripe, Vercel infra, Mapbox, PostHog, Google, and any third party.
8. **If a test would require a write, an account, a charge, OTP/SMS, or touching real PII
   to confirm → STOP and log it as `DEFER — needs staging/controlled test`.** Do not execute it.

If you are ever unsure whether an action is destructive or in-scope, **don't do it** —
note it for the operator instead.

## KNOWN CONTEXT (from prior passive recon — don't re-derive)

- **Frontend:** Vite + React, pure client-side rendering, hosted on Vercel.
- **Backend:** Supabase project `hoealuscfuqrmpzyambj.supabase.co` — PostgREST REST API,
  RPCs, Storage, Auth, all called **directly from the browser** with the **public anon key**
  embedded in the JS bundle. **CORS is `*`.** RLS is therefore the *only* authorization
  boundary — this is the #1 thing to verify.
- Already-known gaps: missing security headers (only HSTS), soft-404s (HTTP 200 on unknown
  paths), no consent banner, missing SPF / triple DMARC. (Don't spend time re-confirming
  these unless trivial.)

---

## TASKS

For each, capture: endpoint/route, request, response status, evidence (count / header /
code snippet — **redacted**), confirmed vs. deferred, severity, and remediation.

### 1. Extract the live anon key (read-only)
Load the homepage, read the JS bundle / network requests, and extract the **public anon key**
and Supabase URL actually in use (don't assume — confirm the current values). The anon key is
public by design; you'll use it as the auth header for the reachability checks below.

### 2. Supabase table reachability under the anon role (the critical test)
For each **candidate sensitive table**, send a `GET` to
`/rest/v1/<table>?select=*&limit=0` with headers `apikey: <anon>`, `Authorization: Bearer <anon>`,
and `Prefer: count=exact`. Record the `Content-Range` **count** and status — **do not fetch rows**.
A `200` with a count on a sensitive table = **RLS gap confirmed**. A `401`/empty = protected.

Candidate tables to probe (extend with any names you find referenced in the bundle):
`users`, `profiles`, `bookings`, `appointments`, `orders`, `payments`, `payment_methods`,
`transactions`, `payouts`, `messages`, `conversations`, `reviews`, `notifications`,
`provider_payouts`, `customers`, `service_providers`, `time_slots`.

### 3. RPC enumeration (read-only)
From the bundle, list every `/rest/v1/rpc/<fn>` the app calls. For **read-only** RPCs,
call with minimal/expected params and note whether anon gets data it shouldn't.
For any RPC that **writes or mutates** (create/update/cancel/book/charge/set-role/verify):
**do not invoke** — document its name/params and mark `DEFER — write test needs staging`.
(Note the already-spotted `get_services_with_timeslots_test` as a prod test artifact.)

### 4. Admin / privileged endpoint authorization (don't operate — just probe access control)
Identify admin surfaces: try routes like `/admin`, `/dashboard`, `/provider`, and look for
admin-only RPCs/endpoints referenced in the bundle. Call each **as anon / no token** and record
whether it returns `401/403` (good) or **executes/returns data** (broken function-level auth = finding).
**Do not perform any admin action even if it's reachable** — log it and stop.

### 5. Authenticated IDOR / BOLA — DEFER
True IDOR (one logged-in user reading another's record by changing an ID) needs two test
accounts. Since accounts are out of scope, **do not attempt** — document the object-by-ID
endpoints reachable by anon (covered in #2) and mark authenticated IDOR
`DEFER — needs controlled test with seeded accounts`.

### 6. Mass assignment — static only, DEFER the write
By reading the bundle, identify create/update RPCs or table writes whose payloads include
sensitive fields (`role`, `is_admin`, `verified`, `price`, `discount`, `status`). **Do not
send any write to test this.** Document which fields *appear* client-settable and mark
`DEFER — write test needs staging`.

### 7. Client-side price/discount integrity — static analysis (read-only)
Inspect the booking/checkout code in the bundle: is the charged **amount computed or passed
from the client** before it reaches Stripe, or is it derived server-side? Flag if price/discount
is client-trusted (tampering risk). **Do not submit a payment** to test it.

### 8. XSS surfaces — DOM/reflected, benign & non-persistent only
Map where user-controlled content is rendered (reviews, salon names, bios, search, URL params)
and whether via `innerHTML`/`dangerouslySetInnerHTML`. You may test **reflected/DOM** handling
in your own isolated session with a **benign, unique, non-persistent marker** in a URL param
(e.g. a random string; observe if it's reflected unescaped). **Never store a payload**
(no submitting into reviews/bios — that's a write + defacement) — mark stored-XSS `DEFER`.

### 9. Rate limiting — capped, public read only
Send a **single capped burst (≤20 requests)** to a **public read** endpoint (e.g. the services
listing) and note whether any `429`/throttling appears. **Do not** test login or OTP/SMS-send.
Mark OTP/SMS and login rate-limiting `DEFER — needs controlled test (cost/lockout risk)`.

### 10. Headers / CORS / clickjacking / storage (read-only)
- Confirm missing security headers and that a **forged `Origin`** still gets
  `Access-Control-Allow-Origin: *`.
- Test framing locally (load the booking page in an `<iframe>` in your own page) to confirm
  clickjacking exposure (no `X-Frame-Options`/`frame-ancestors`).
- Check whether Supabase **Storage** buckets are publicly **listable** via the storage API
  (read-only `list`); flag any world-readable/writable bucket config.

---

## DELIVERABLE

Write a findings report to `lately-active-findings.md` with:

1. A one-line scope/authorization + "non-destructive, read-only" statement.
2. A findings table: **Area · Reachable? · Evidence (redacted) · Severity (CVSS-ish) ·
   Confirmed/Deferred · Remediation.**
3. A clearly separated **"DEFER — needs controlled/staging test"** list (writes, accounts,
   charges, OTP/SMS, authenticated IDOR, stored XSS) for a future authorized window.
4. Prioritized remediations (the RLS policy fix first).

Keep all evidence **redacted** of real PII. Prove reachability with counts and status codes,
not data dumps.

---

## FASTEST SAFE PATH (recommended in parallel)
As an owner you can request **read access to the Supabase dashboard**. A white-box pass —
**Authentication → Policies**, checking that **RLS is enabled on every table** and each policy
is scoped to `auth.uid()` (not `true`/public) — confirms the critical finding in minutes,
touches **zero** customer data, and is more complete than any black-box probe. Do this too if
you can get access.
