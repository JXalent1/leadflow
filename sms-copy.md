# SMS Copy — campaign variants

Cold home-service SMS. Goal: identify the sender, make a soft low-friction offer, sound like a person, fit roughly one segment, and carry opt-out language. Replace `[BIZ]` with Talan's business name and `[NAME]` with first name (merge field from the contacts table).

A good cold text is short, specific to the neighborhood, and asks a low-commitment question. Opt-out language is required — keep "Reply STOP to opt out" on every message.

## Variant A — neighbor / soft question
> Hi [NAME], this is [BIZ] — we clean windows for homes around [ZIP/neighborhood]. Would a free quote to get your windows done be useful? Reply STOP to opt out.

## Variant B — direct offer
> Hey [NAME], it's [BIZ], a local window cleaning crew working in your area this week. Want a quick free quote? No obligation. Reply STOP to opt out.

## Variant C — seasonal / reason-to-act
> Hi [NAME], [BIZ] here — we're doing window cleaning in [neighborhood] and have a couple openings this week. Want me to send a free quote? Reply STOP to opt out.

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
