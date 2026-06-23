# SMS Copy — campaign variants

## ✅ APPROVED PILOT MESSAGE (2026-06-22) — supersedes the A/B variants below
The pilot runs a **single message** (no A/B), Jordan's exact wording, with only "Reply STOP to opt out" appended:

> **Hey [NAME] busy season is here, we are working close by if you were interested in window cleaning services at [ADDRESS]. Reply STOP to opt out**

Overflow fallback (drops only the address clause when the full version exceeds one segment):

> **Hey [NAME] busy season is here, we are working close by if you were interested in window cleaning services. Reply STOP to opt out**

Implementation requirements (wire into `lib/sms.ts`, Session 6 Task 0) — **do not alter Jordan's wording**:
- Use the message **verbatim**; the ONLY addition is "Reply STOP to opt out" at the end (Jordan approved). No business name, nothing else added.
- **Opt-out = `Reply STOP`** (the system only honors STOP-family keywords; carriers/CTIA require it).
- **`[ADDRESS]` = the situs street only** (`contacts.address`), passed into `renderMessage`, **title-cased** (county data is ALL CAPS — do not send caps).
- **`[NAME]`** = first name as-is; only if it's blank/entity, greet with "Hey there" (entities were already stripped, so rare).
- **Single-segment auto-fallback:** if the full (with-address) version exceeds one GSM-7 segment, render the no-address fallback above so no eligible contact is dropped for length.
- Single variant (`AB_VARIANTS=A`, variant A = this message).
- **Still owed:** Talan's blessing on the final wording (goes out in his name). Address-in-message raises complaint risk — watch the first batch's reply tone.

### ✅ Implemented (Session 6, Task 0 — `lib/sms.ts` variant A)
Wired in verbatim. Verified against the real list (`npm test`): **all 500 rows render single GSM-7 segment** and end with `Reply STOP to opt out` (no trailing period — Jordan's exact wording). Name + address title-cased (county data is ALL CAPS). The single-segment auto-fallback drops ONLY the `at [address]` clause; on the real 500 it fires for just **2** rows (the 28-char `CHARRINGTON FOREST BLVD` paired with longer first names) — the other **498 keep the address**. Variant A carries **no business name**. Variants B/C are untouched (kept as future-A/B reference; not used while `AB_VARIANTS=A`). Sample (typical):
> Hey Robert busy season is here, we are working close by if you were interested in window cleaning services at 7445 Buck Lake Rd. Reply STOP to opt out

---

## Original creative variants (reference / future A/B)
Cold home-service SMS. Goal: identify the sender, make a soft low-friction offer, sound like a person, fit roughly one segment, and carry opt-out language. Replace `[BIZ]` with Talan's business name and `[NAME]` with first name (merge field from the contacts table).

A good cold text is short, specific to the neighborhood, and asks a low-commitment question. Opt-out language is required — keep "Reply STOP to opt out" on every message.

## Variant A — neighbor / soft question
> Hi [NAME], this is [BIZ] — we clean windows for homes around [ZIP/neighborhood]. Would a free quote to get your windows done be useful? Reply STOP to opt out.

## Variant B — direct offer
> Hey [NAME], it's [BIZ], a local window cleaning crew working in your area this week. Want a quick free quote? No obligation. Reply STOP to opt out.

## Variant C — seasonal / reason-to-act
> Hi [NAME], [BIZ] here — we're doing window cleaning in [neighborhood] and have a couple openings this week. Want me to send a free quote? Reply STOP to opt out.

## As-implemented in `lib/sms.ts` (single-segment, GSM-7) — NEEDS TALAN SIGN-OFF
The creative variants above are the source intent. Module P's `renderMessage` adapts them slightly so every message stays **GSM-7 and one segment** (the em dash `—` is not in GSM-7 and forced costly UCS-2 encoding; a couple lines also ran long). The em dashes were swapped for ASCII hyphens (` -`) and the copy was trimmed. The wording below is what actually sends — review and approve (or tweak) before the Session 3 send:

- **A:** `Hi [NAME], this is [BIZ] - we clean windows for homes in [ZIP]. Would a free quote be useful? Reply STOP to opt out.`
- **B:** `Hey [NAME], it's [BIZ], a local window cleaning crew in your area this week. Want a free quote? No obligation. Reply STOP to opt out.`
- **C:** `Hi [NAME], [BIZ] here - we're doing window cleaning in [ZIP] this week and have openings. Want a free quote? Reply STOP to opt out.`

Fallbacks: missing/entity name → "Hi there,"/"Hey there,"; missing zip → "your area". Verified: all 3 variants fit one GSM-7 segment for typical first-name + zip inputs (largest observed 154 chars with a long first name + the full "Talan Window Cleaning" biz name).

## A/B plan
Split the eligible list into 2–3 equal cells, one variant each. Compare positive-reply rate per variant. Keep everything else identical (send time, pacing). The winner becomes the default for the scaled campaign.

## Rules baked into sending (enforced in code, restated here)
- Never send to a contact where `suppressed = true` (DNC, litigator, or prior opt-out).
- Send during reasonable local hours only (e.g., 10am–7pm CT for Tallahassee). No early-morning / late-night sends.
- One message per contact for the initial test. Do not auto-drip multiple times in the pilot — measure the single-touch response first.
- Honor STOP instantly and permanently; send the one confirmation Twilio/CTIA requires, then never message again.
- Keep it one segment where possible (~160 chars). Going slightly over is fine but watch cost/segmentation.

## Note on personalization
`[NAME]` uses the owner first name parsed from the county roll. Some rows may have odd/entity-looking names that slipped the filter — if first name looks non-human, fall back to a generic greeting ("Hi there") rather than texting "Hi LLC".
