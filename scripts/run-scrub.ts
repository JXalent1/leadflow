// scripts/run-scrub.ts — batched, resumable DNC + litigator scrub from the CLI.
//
// Runs the SAME fail-closed logic as POST /api/scrub (both call lib/scrub's
// scrubBatch), but loops over the matched-but-unscrubbed list in small chunks from
// your machine so it never hits a serverless function timeout. Idempotent: each chunk
// only processes contacts that still need scrubbing and commits before the next, so a
// re-run resumes. Fail closed: anything not explicitly clean is suppressed.
//
// Usage:
//   npm run scrub                 # default 100/chunk, scrubs ALL matched-unscrubbed
//   npm run scrub -- --batch=50   # 50 per chunk
//   npm run scrub -- --max=25     # scrub only 25 total
//   npm run scrub -- --delay=2000 # ms to pause between chunks (default 0)
//
// Run AFTER tracing. The dashboard's suppressed count climbing is the protection working.

// dotenv must run before @/lib/* loads: lib/db throws at module load if DATABASE_URL is
// unset, and a static import would be hoisted above config() (ESM order). Load env, then
// dynamic-import the lib inside main(). (Bootstrap only — scrub's fail-closed logic is unchanged.)
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import type { ScrubReason } from "@/lib/scrub"; // type-only — erased, never triggers lib/db load

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : undefined;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (add it to .env.local).");
  if (!process.env.TRACERFY_API_KEY) throw new Error("TRACERFY_API_KEY is not set.");

  const { scrubBatch, InsufficientCreditsError, SCRUB_CREDITS_PER_PHONE, creditsCoverScrub } =
    await import("@/lib/scrub");
  const { getPendingScrubCount } = await import("@/lib/scrub-jobs");
  const { getCredits } = await import("@/lib/tracerfy");
  const { DEFAULT_CLIENT_ID } = await import("@/lib/clients");

  const clientId = arg("client") ? Math.max(1, Number(arg("client"))) : DEFAULT_CLIENT_ID;
  // Optional campaign scope; omit to scrub ALL the client's matched-unscrubbed across campaigns.
  const campaignId = arg("campaign") ? Math.max(1, Number(arg("campaign"))) : undefined;
  const batch = Math.max(1, Number(arg("batch") ?? 100));
  const max = arg("max") ? Math.max(1, Number(arg("max"))) : Infinity;
  const delay = Math.max(0, Number(arg("delay") ?? 0));

  console.log(`[scrub] starting — client=${clientId} campaign=${campaignId ?? "ALL"} batch=${batch} max=${max === Infinity ? "ALL" : max} delay=${delay}ms`);

  // UPFRONT credit pre-flight: report need-vs-have BEFORE submitting anything. The amount we
  // intend to scrub this run is min(pending, max); refuse cleanly if the balance can't cover it.
  const credits = await getCredits();
  const pending = await getPendingScrubCount(clientId, campaignId);
  const intend = Math.min(pending, max);
  const need = intend * SCRUB_CREDITS_PER_PHONE;
  console.log(
    `[scrub] credits: have ${credits}, pending-with-phone ${pending}, will scrub ${intend} this run ` +
      `(need ≈${need} credit${need === 1 ? "" : "s"})`
  );
  if (pending === 0) {
    console.log("[scrub] nothing pending to scrub — done.");
    return;
  }
  if (!creditsCoverScrub(credits, intend)) {
    console.error(
      `[scrub] STOPPED before submitting — insufficient credits: need ${need}, have ${credits}. ` +
        `Top up ~${need - credits} and re-run; nothing was scrubbed (no credits spent).`
    );
    process.exit(2);
  }

  let scrubbed = 0;
  let clean = 0;
  let suppressed = 0;
  const totals: Record<ScrubReason, number> = { litigator: 0, dnc: 0, scrub_error: 0 };
  let chunk = 0;

  while (scrubbed < max) {
    const limit = Math.min(batch, max - scrubbed);
    let res;
    try {
      res = await scrubBatch(clientId, { campaignId, limit });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        console.error(
          `[scrub] STOPPED — insufficient credits: have ${err.credits}, need ${err.needed} for ${err.pending}. ` +
            `Top up and re-run; already-scrubbed rows are committed and will NOT re-bill.`
        );
        process.exit(2);
      }
      throw err;
    }

    if (res.scrubbed === 0) {
      console.log("[scrub] nothing left to scrub — done.");
      break;
    }

    chunk++;
    scrubbed += res.scrubbed;
    clean += res.clean;
    suppressed += res.suppressed;
    totals.litigator += res.byReason.litigator;
    totals.dnc += res.byReason.dnc;
    totals.scrub_error += res.byReason.scrub_error;
    console.log(
      `[scrub] chunk ${chunk}: scrubbed=${res.scrubbed} clean=${res.clean} suppressed=${res.suppressed} ` +
        `(dnc=${res.byReason.dnc} litigator=${res.byReason.litigator} scrub_error=${res.byReason.scrub_error})`
    );

    if (scrubbed < max && delay > 0) await sleep(delay);
  }

  console.log(
    `\n[scrub] DONE — scrubbed=${scrubbed} clean=${clean} suppressed=${suppressed} ` +
      `(dnc=${totals.dnc} litigator=${totals.litigator} scrub_error=${totals.scrub_error})`
  );
}

main().catch((err) => {
  console.error("\n[scrub] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
