// scripts/run-skiptrace.ts — batched, resumable skip trace from the CLI.
//
// Runs the SAME fail-closed logic as POST /api/skiptrace (both call lib/skiptrace's
// traceBatch), but loops over the pending list in small chunks from your machine so
// it never hits a serverless function timeout. Idempotent: each chunk only traces
// skiptrace_status='pending' rows and commits before the next, so a re-run resumes.
//
// Usage:
//   npm run trace                 # default 50/chunk, traces ALL pending
//   npm run trace -- --batch=25   # 25 per chunk
//   npm run trace -- --max=25     # trace only 25 total (a small first batch)
//   npm run trace -- --advanced   # advanced trace (2 credits/lead)
//   npm run trace -- --delay=2000 # ms to pause between chunks (default 0)
//
// Run a small --max first, eyeball the dashboard, then run the rest.

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { traceBatch, InsufficientCreditsError } from "@/lib/skiptrace";
import type { TraceType } from "@/lib/tracerfy";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (add it to .env.local).");
  if (!process.env.TRACERFY_API_KEY) throw new Error("TRACERFY_API_KEY is not set.");

  const batch = Math.max(1, Number(arg("batch") ?? 50));
  const max = arg("max") ? Math.max(1, Number(arg("max"))) : Infinity;
  const delay = Math.max(0, Number(arg("delay") ?? 0));
  const traceType: TraceType = flag("advanced") ? "advanced" : "normal";

  console.log(
    `[trace] starting — batch=${batch} max=${max === Infinity ? "ALL" : max} type=${traceType} delay=${delay}ms`
  );

  let traced = 0;
  let matched = 0;
  let noMatch = 0;
  let chunk = 0;

  while (traced < max) {
    const limit = Math.min(batch, max - traced);
    let res;
    try {
      res = await traceBatch({ limit, traceType });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        console.error(
          `[trace] STOPPED — insufficient credits: have ${err.credits}, need ${err.needed} for ${err.pending}. ` +
            `Load credits and re-run; already-traced rows are committed.`
        );
        process.exit(2);
      }
      throw err;
    }

    if (res.traced === 0) {
      console.log("[trace] no more pending contacts — done.");
      break;
    }

    chunk++;
    traced += res.traced;
    matched += res.matched;
    noMatch += res.noMatch;
    console.log(
      `[trace] chunk ${chunk}: traced=${res.traced} matched=${res.matched} noMatch=${res.noMatch} ` +
        `(running: traced=${traced} matched=${matched} noMatch=${noMatch})`
    );

    if (traced < max && delay > 0) await sleep(delay);
  }

  console.log(`\n[trace] DONE — traced=${traced} matched=${matched} noMatch(suppressed)=${noMatch}`);
}

main().catch((err) => {
  console.error("\n[trace] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
