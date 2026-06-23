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

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { scrubBatch, type ScrubReason } from "@/lib/scrub";

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

  const batch = Math.max(1, Number(arg("batch") ?? 100));
  const max = arg("max") ? Math.max(1, Number(arg("max"))) : Infinity;
  const delay = Math.max(0, Number(arg("delay") ?? 0));

  console.log(`[scrub] starting — batch=${batch} max=${max === Infinity ? "ALL" : max} delay=${delay}ms`);

  let scrubbed = 0;
  let clean = 0;
  let suppressed = 0;
  const totals: Record<ScrubReason, number> = { litigator: 0, dnc: 0, scrub_error: 0 };
  let chunk = 0;

  while (scrubbed < max) {
    const limit = Math.min(batch, max - scrubbed);
    const res = await scrubBatch({ limit });

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
