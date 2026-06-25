# Raise the send-rate cap (allow high-throughput sending)

> Self-contained prompt. You are **Claude Code** in the LeadFlow repo. The operator runs `/clear` before
> each prompt, so assume NO prior context. Small, surgical change. **Do NOT weaken no-double-send, the send
> window, or opt-out/suppression** — only the rate/pacing ceilings change. Keep every test green, then deploy.

---

## 0. Orientation — read these first
1. `CLAUDE.md` + `overview.md` top decisions + `handoff.md`.
2. The send-rate + pacing code:
   - `setClientSendRate` (the PATCH `/api/client` setter) — currently **clamps the rate to [1, 1000]**.
   - `lib/pipeline.ts` (or wherever `sendBatchSize` / `clientPacingDelayMs` live) — the pacing math that
     turns `send_rate_per_hour` into a batch size + inter-batch delay. `sendBatchSize` is currently
     **clamped to [1, 50]**.
   - `components/pipeline-runner.tsx` (and any rate `<input max=...>`) — the UI rate control.
   - `app/api/campaign/route.ts` — the send loop that reads `client.send_rate_per_hour` fresh each batch.

**Read those first.** The operator is an experienced, A2P-compliant Twilio sender and wants to send much
faster than 1,000/hr; the 1,000 cap is an early-build artifact.

---

## 1. Goal
Let the operator set a much higher `send_rate_per_hour` and have the pipeline actually achieve it, without
touching any safety guarantee.

## 2. Changes
1. **Raise the rate clamp.** In `setClientSendRate`, change the max from `1000` to **`20000`** (keep min 1,
   integer-coerce). This is the new ceiling.
2. **Scale the pacing so high rates materialize.** Today `sendBatchSize ≈ rate/20` clamped `[1, 50]`, so
   above ~1,000/hr the 50-cap throttles throughput. Raise the batch-size cap so high rates are reachable —
   e.g. clamp `[1, 250]` — and keep the inter-batch delay formula so the realized rate ≈ the target. **Each
   batch sends sequentially inside one serverless invocation (300s limit), so keep the per-batch send count
   bounded** (≤250) so a batch always finishes comfortably under the function timeout. Pick the batch
   size + delay so e.g. 2,500 sends at 10,000/hr complete in ~15 min and the function never approaches 300s.
3. **UI:** raise any client-side `max` on the rate input to match (20000) so the field accepts the value;
   keep the input integer-only.

## 3. Do NOT (load-bearing — unchanged)
- Do NOT change `claimForSend` / the atomic `not_sent → sending` claim — **no-double-send must still hold**
  at any rate (it's the per-contact DB claim, independent of batch size).
- Do NOT change the send-window gate (still re-checked each batch) or opt-out/suppression/eligibility.
- Do NOT remove the send-confirmation guard. No file >500 lines.

## 4. Acceptance
- `npx tsc --noEmit` clean; `npm run build` green; `npm test` = 208 (update any pacing unit test that
  asserted the old 50/1000 bounds — keep them meaningful: assert the new clamps + that
  `realized rate ≈ target` and `batchSize ≤ 250`); `test:isolation` 28/28, `test:access`, `test:cockpit`,
  `test:auto-pause`, `test:passthrough` all pass.
- A unit assertion that at a high target (e.g. 10,000/hr) `sendBatchSize` is ≤250 and the computed
  inter-batch delay yields ~the target rate (no off-by-orders-of-magnitude), and that the rate clamp now
  accepts up to 20,000 and still rejects ≤0 / non-integers.
- Commit + push + `vercel --prod`. Report the deployed URL.
- Update `status.md`, `overview.md` (a one-line decision: rate cap 1000→20000 + batch cap 50→250, safety
  unchanged), `handoff.md`.

## 5. After it deploys
Tell the operator the new max (20,000/hr) and that they can now set the rate field to whatever their Twilio
10DLC throughput supports, **Save rate**, then **Run pipeline**. Note the realized speed is still bounded by
how fast Twilio accepts the sends, but the app will no longer throttle below their number.
