// scripts/ingest-trace-queue.ts — recover an ALREADY-COMPLETE Tracerfy trace queue
// into contacts WITHOUT re-tracing (no new charge).
//
// Why this exists: a trace ran on Tracerfy and was paid for, but a crash/reload killed
// the function before results were written back, and the queue id was never persisted —
// the paid results were orphaned and the contacts are stuck skiptrace_status='pending'.
// Re-reading a completed queue does NOT re-charge, so this recovers them for free.
//
// It reuses the SAME field-mapping + matching logic the live trace uses (lib/skiptrace's
// ingestTraceQueue → getTraceResults parse → matchKey UPPER(address)|UPPER(city)|UPPER(state)
// → best-mobile pick): every pending contact that maps to a result gets phone/phone_type +
// skiptrace_status='matched'; any still-pending contact with no usable mobile is set
// skiptrace_status='no_match' + suppressed=true/suppress_reason='no_match' (fail closed).
// Idempotent: only rows still 'pending' are touched.
//
// Usage:
//   npm run ingest -- 103802         # ingest queue 103802
//   npm run ingest -- --queue=103802
//
// IMPORTANT: this never calls submitTrace / starts a new trace. It proves it spent 0 credits
// by reading the balance before and after.
//
// NOTE: dynamic import() of @/lib/* AFTER dotenv runs — lib/db throws at module load if
// DATABASE_URL is unset, and a static import would be hoisted above config() (ESM order),
// so the env must be loaded first.

import { config } from "dotenv";
config({ path: ".env.local" });
config();

function parseQueueId(): number {
  const flag = process.argv.find((a) => a.startsWith("--queue="));
  const raw = flag ? flag.split("=")[1] : process.argv.find((a) => /^\d+$/.test(a));
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) {
    throw new Error("Provide a Tracerfy queue id, e.g. `npm run ingest -- 103802`");
  }
  return id;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (add it to .env.local).");
  if (!process.env.TRACERFY_API_KEY) throw new Error("TRACERFY_API_KEY is not set.");

  const queueId = parseQueueId();

  const { getCredits } = await import("@/lib/tracerfy");
  const { ingestTraceQueue } = await import("@/lib/skiptrace");
  const { recordIngestedTraceJob } = await import("@/lib/trace-jobs");
  const { DEFAULT_CLIENT_ID } = await import("@/lib/clients");
  const { sql } = await import("@/lib/db");

  const clientArg = process.argv.find((a) => a.startsWith("--client="));
  const clientId = clientArg ? Math.max(1, Number(clientArg.split("=")[1])) : DEFAULT_CLIENT_ID;

  console.log(`[ingest] recovering Tracerfy queue ${queueId} for client ${clientId} (NO new trace — re-read only)\n`);

  // PROOF the recovery is free: read the balance before and after; the delta MUST be 0.
  const creditsBefore = await getCredits();
  console.log(`[ingest] credits BEFORE: ${creditsBefore}`);

  const res = await ingestTraceQueue(clientId, queueId);

  const creditsAfter = await getCredits();
  console.log(`[ingest] credits AFTER:  ${creditsAfter}`);
  const delta = creditsAfter - creditsBefore;
  console.log(
    `[ingest] credits delta:  ${delta} — ${
      delta === 0 ? "OK (recovery re-read a paid queue, re-charged 0)" : "⚠ UNEXPECTED non-zero delta"
    }\n`
  );

  console.log(
    `[ingest] queue ${queueId}: ingested=${res.ingested} matched=${res.matched} noMatch(suppressed)=${res.noMatch}` +
      (res.note ? ` (${res.note})` : "")
  );

  // Provenance: record the recovered job as 'ingested' so the durability table reflects it.
  // Best-effort — the recovery (phones written) already succeeded above; a failure here
  // (e.g. schema not yet applied) must not fail the run.
  try {
    await recordIngestedTraceJob({ clientId, queueId, matched: res.matched, noMatch: res.noMatch });
    console.log(`[ingest] recorded queue ${queueId} in trace_jobs (status='ingested')`);
  } catch (err) {
    console.warn(
      `[ingest] (provenance) could not record trace_jobs row — run \`npm run schema\` then re-run is safe: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }

  const counts = await sql`
    SELECT
      COUNT(*) FILTER (WHERE skiptrace_status='matched')::int  AS matched,
      COUNT(*) FILTER (WHERE skiptrace_status='no_match')::int AS no_match,
      COUNT(*) FILTER (WHERE skiptrace_status='pending')::int  AS pending,
      COUNT(*) FILTER (WHERE phone IS NOT NULL)::int           AS with_phone,
      COUNT(*)::int                                            AS total
    FROM contacts
    WHERE client_id = ${clientId}
  `;
  const c = counts[0] as Record<string, number>;
  console.log(
    `\n[ingest] DB now: matched=${c.matched} no_match=${c.no_match} pending=${c.pending} ` +
      `with_phone=${c.with_phone} (total=${c.total})`
  );
  console.log(`[ingest] credits unchanged by recovery: ${creditsBefore} → ${creditsAfter}`);
}

main().catch((err) => {
  console.error("\n[ingest] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
