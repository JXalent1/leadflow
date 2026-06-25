# Fix prod login — seed users into the DB prod actually reads + verify

> Self-contained prompt. You are **Claude Code** in the LeadFlow repo. The operator runs `/clear` before
> each prompt, so assume NO prior context. Cowork writes prompts; you execute. Diagnose + fix; verify with
> a real password check (don't just assume). Do NOT print secret values; do NOT invent passwords.

---

## 0. Orientation — read these first
1. `CLAUDE.md` — stack/conventions; `overview.md` (top decisions) + `handoff.md` for the V5 auth design.
2. The auth + seed code: the `seed:users` script (find via `package.json` `scripts`), `lib/users.ts`
   (user lookup + `verifyPassword`), `lib/session.ts`, `app/login` (the server action that returns
   `?error=1` on a failed sign-in), and `lib/db.ts` (the `users` table + `DATABASE_URL` client).

---

## 1. The symptom (what the operator sees)
Prod `https://leadflow1-seven.vercel.app/login` returns **"Incorrect email or password"** (`/login?error=1`)
for the seeded operator `jordan@xalent.ai`. The page renders (no 500), so `SESSION_SECRET` IS set in prod
and the auth path runs — the login simply can't find a matching user. **Most likely root cause:** `npm run
seed:users` wrote to the DB that **local `.env.local` `DATABASE_URL`** points to, but **prod reads a
different `DATABASE_URL`** (Neon's Vercel integration can hand prod a different branch/database). So the
user landed in the wrong DB. Second possibility: the seed errored locally (e.g. a missing env var) and no
user was created. Confirm which, then fix.

---

## 2. Diagnose (report findings, never print full secret values)
1. **Compare the two DATABASE_URLs.** Pull the prod env: `vercel env pull .env.vercel-prod` (production).
   Compare the **host + database name + branch** of `DATABASE_URL` in `.env.vercel-prod` vs `.env.local`.
   Report whether they are the **same DB** or **different**. (Show only host/db enough to compare — not the
   password in the URL.)
2. **Look where the user actually is.** Query the `users` table (`SELECT id, email, role FROM users`) on
   BOTH the local-`.env.local` DB and the prod DB. Report which DB has `jordan@xalent.ai` (if any) and the
   row's `role`. This pinpoints the mismatch.
3. **Check email handling.** Confirm how login looks users up — is `email` compared lowercased/trimmed? If
   the form sends `jordan@xalent.ai` but the row stored a different case, that alone fails the match. Note
   it.

---

## 3. Fix
- **Seed the users into the PROD database.** Run the seed with `DATABASE_URL` set to the **prod** value
  (from `.env.vercel-prod`) so the rows land where prod reads. Credentials come from env vars the operator
  sets — `OPERATOR_EMAIL` / `OPERATOR_PASSWORD` / `CLIENT1_EMAIL` / `CLIENT1_PASSWORD` (the operator is
  `jordan@xalent.ai`, client is `Texexteriors@gmail.com`). **Do NOT hardcode passwords in any file.** If a
  required var is unset, STOP and tell the operator exactly which to `export` (single-quote any password
  containing `!`).
- If `seed:users` **skips** an already-existing email (won't reset the password), and a stale row exists in
  the prod DB with a wrong/old hash, make the seed **upsert/update** the password hash for that email (or
  add a one-off reset path) so the operator's current password takes effect. Keep it idempotent.
- Store `email` consistently with how login looks it up (lowercase+trim on both sides if that's the
  convention).
- **Delete `.env.vercel-prod`** when done (don't leave a pulled-secrets file in the tree; it must be
  git-ignored regardless).

---

## 4. Verify (prove it, don't assume)
1. Re-query the **prod** DB: `jordan@xalent.ai` exists with role `operator` and a non-empty `password_hash`.
2. **Programmatic password check (the real proof):** load that row from the prod DB and call the app's
   `verifyPassword(<operator password from env>, storedHash)` — assert it returns **true**. Do the same for
   the client user. This confirms the exact password the operator types will authenticate, without needing
   a browser.
3. Report: which DB the users are now in, that prod's `DATABASE_URL` points at that same DB, and that
   `verifyPassword` returned true. End with a one-line **"login fixed — operator can sign in"** or the
   remaining blocker.

## 5. Do NOT
- Do NOT print secret values (DB passwords, user passwords, hashes, `SESSION_SECRET`).
- Do NOT invent or hardcode user passwords. Do NOT commit any pulled `.env*` file.
- Do NOT change auth/eligibility/send logic — this is a data/config fix only.
- Leave the DB otherwise pristine (don't create stray rows beyond the two users).
