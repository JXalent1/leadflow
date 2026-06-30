/**
 * lib/skiptrace.test.ts — traceBatch resilience + durability, with the Tracerfy client AND the
 * DB writers fully MOCKED via injected deps. No DB, no network, no API spend. Proves:
 *   - a TRANSIENT submit error (429) is retried then succeeds — one queue, no double-charge;
 *   - a transient credit-read error recovers on retry;
 *   - a TERMINAL credit shortfall stops cleanly (InsufficientCreditsError, nothing submitted/billed);
 *   - a POISON record (no usable address) is skipped + suppressed fail-closed, the run continues;
 *   - RESUME re-ingests an orphaned 'submitted' job with NO re-charge (idempotent);
 *   - a terminal (non-credit) submit 4xx is NOT retried.
 *
 * db.ts needs a well-formed DATABASE_URL to load (neon() validates the string but does NOT connect
 * until a query runs — and we never run a real query because every DB fn is mocked).
 * Runner: `tsx --test lib/*.test.ts` → runs under `npm test`.
 */

process.env.DATABASE_URL ||= "postgresql://user:pass@host.tld/db";

import { test } from "node:test";
import assert from "node:assert/strict";
import { TracerfyError, type TraceResultRow } from "./tracerfy";

// skiptrace.ts (transitively) imports db.ts, which validates DATABASE_URL at load. Pull it in via
// require (runs in source order, AFTER the dummy URL above) rather than a hoisted static import.
// Tests run under the CJS output format, so top-level await isn't available.
const { traceBatch, isTraceable, InsufficientCreditsError } =
  require("./skiptrace") as typeof import("./skiptrace");
type TraceDeps = NonNullable<Parameters<typeof traceBatch>[2]>;

const CLIENT = 1;
const noRetry = { sleep: async () => {}, onRetry: () => {} };

let idSeq = 1;
interface FakeContact {
  id: number;
  client_id: number;
  campaign_id: number;
  first_name: string | null;
  last_name: string | null;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  skiptrace_status: string;
  suppressed: boolean;
  suppress_reason: string | null;
  phone: string | null;
  phone_type: string | null;
}

function mkContact(address: string, over: Partial<FakeContact> = {}): FakeContact {
  return {
    id: idSeq++,
    client_id: CLIENT,
    campaign_id: 1,
    first_name: "F",
    last_name: "L",
    address,
    city: "Tallahassee",
    state: "FL",
    zip: "32301",
    skiptrace_status: "pending",
    suppressed: false,
    suppress_reason: null,
    phone: null,
    phone_type: null,
    ...over,
  };
}

interface FakeJob {
  id: number;
  client_id: number;
  queue_id: number;
  status: "submitted" | "ingested";
  contact_ids: number[];
  matched: number | null;
  no_match: number | null;
}

interface Calls {
  getCredits: number;
  submitTrace: number;
  getTraceResults: number;
  createTraceJob: number;
  markTraceJobIngested: number;
}

function makeDeps(opts: {
  contacts?: FakeContact[];
  jobs?: FakeJob[];
  credits?: number;
  submitErrors?: unknown[]; // thrown (shifted) per submit call before a success
  creditErrors?: unknown[];
} = {}) {
  const state = {
    contacts: opts.contacts ?? [],
    jobs: opts.jobs ?? [],
    calls: {
      getCredits: 0,
      submitTrace: 0,
      getTraceResults: 0,
      createTraceJob: 0,
      markTraceJobIngested: 0,
    } as Calls,
    nextQueueId: 5000,
    nextJobId: 9000,
  };
  const credits = opts.credits ?? 1000;
  const submitErrors = [...(opts.submitErrors ?? [])];
  const creditErrors = [...(opts.creditErrors ?? [])];

  const byId = (id: number) => state.contacts.find((c) => c.id === id);

  const deps = {
    async getContactsForSkiptrace(
      clientId: number,
      scope: { campaignId?: number; limit?: number } = {}
    ) {
      let rows = state.contacts.filter(
        (c) => c.client_id === clientId && c.skiptrace_status === "pending"
      );
      if (scope.campaignId != null) rows = rows.filter((c) => c.campaign_id === scope.campaignId);
      rows.sort((a, b) => a.id - b.id);
      if (scope.limit != null) rows = rows.slice(0, scope.limit);
      return rows as unknown as Awaited<ReturnType<TraceDeps["getContactsForSkiptrace"]>>;
    },
    async setTraceResult(
      clientId: number,
      id: number,
      result: { phone: string | null; phoneType: string | null; status: "matched" | "no_match" }
    ) {
      const c = byId(id);
      if (c && c.client_id === clientId) {
        c.phone = result.phone;
        c.phone_type = result.phoneType;
        c.skiptrace_status = result.status;
      }
    },
    async markSuppressed(clientId: number, id: number, reason: string) {
      const c = byId(id);
      if (c && c.client_id === clientId) {
        c.suppressed = true;
        c.suppress_reason = reason;
      }
    },
    async createTraceJob(args: {
      clientId: number;
      queueId: number;
      contactIds: number[];
      traceType: string;
      rowsUploaded: number;
    }) {
      state.calls.createTraceJob++;
      const id = state.nextJobId++;
      state.jobs.push({
        id,
        client_id: args.clientId,
        queue_id: args.queueId,
        status: "submitted",
        contact_ids: args.contactIds,
        matched: null,
        no_match: null,
      });
      return id;
    },
    async getOutstandingTraceJobs(clientId: number) {
      return state.jobs
        .filter((j) => j.client_id === clientId && j.status === "submitted")
        .sort((a, b) => a.id - b.id) as unknown as Awaited<
        ReturnType<TraceDeps["getOutstandingTraceJobs"]>
      >;
    },
    async markTraceJobIngested(clientId: number, id: number, matched: number, noMatch: number) {
      state.calls.markTraceJobIngested++;
      const j = state.jobs.find((x) => x.id === id && x.client_id === clientId);
      if (j) {
        j.status = "ingested";
        j.matched = matched;
        j.no_match = noMatch;
      }
    },
    async getCredits() {
      state.calls.getCredits++;
      if (creditErrors.length) throw creditErrors.shift();
      return credits;
    },
    async submitTrace() {
      state.calls.submitTrace++;
      if (submitErrors.length) throw submitErrors.shift();
      return { queueId: state.nextQueueId++, rowsUploaded: 1 };
    },
    async getTraceResults() {
      state.calls.getTraceResults++;
      // Echo EVERY contact as a matched row with a usable mobile; applyTraceRows maps by
      // address+city+state and only touches the in-scope contacts, ignoring the extras.
      const rows: TraceResultRow[] = state.contacts.map((c) => ({
        address: c.address,
        city: c.city,
        state: c.state,
        firstName: c.first_name,
        lastName: c.last_name,
        phone: "8501234567",
        phoneType: "Mobile",
        matched: true,
      }));
      return { rows, raw: null };
    },
  } as unknown as TraceDeps;

  return { deps, state };
}

// --- isTraceable ------------------------------------------------------------

test("isTraceable: blank / whitespace address → poison (false); real address → true", () => {
  assert.equal(isTraceable({ address: "" }), false);
  assert.equal(isTraceable({ address: "   " }), false);
  assert.equal(isTraceable({ address: null }), false);
  assert.equal(isTraceable({ address: "123 Main St" }), true);
});

// --- transient retry --------------------------------------------------------

test("traceBatch: a transient submit 429 is retried then succeeds — ONE queue, no double-charge", async () => {
  idSeq = 1;
  const contacts = [mkContact("1 A St"), mkContact("2 B St")];
  const { deps, state } = makeDeps({
    contacts,
    submitErrors: [new TracerfyError("rate limited", { status: 429 })], // fail once, then succeed
  });

  const res = await traceBatch(CLIENT, { campaignId: 1 }, deps, noRetry);

  assert.equal(state.calls.submitTrace, 2, "submit retried exactly once");
  assert.equal(state.calls.createTraceJob, 1, "only ONE paid job created (no double-charge)");
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, "ingested");
  assert.equal(res.matched, 2);
  assert.equal(res.traced, 2);
  assert.ok(contacts.every((c) => c.skiptrace_status === "matched" && c.phone === "8501234567"));
});

test("traceBatch: a transient credit-read error recovers on retry, then proceeds", async () => {
  idSeq = 1;
  const contacts = [mkContact("1 A St")];
  const { deps, state } = makeDeps({
    contacts,
    creditErrors: [new TracerfyError("502", { status: 502 })], // first getCredits throws, retry ok
  });

  const res = await traceBatch(CLIENT, { campaignId: 1 }, deps, noRetry);

  assert.equal(state.calls.getCredits, 2, "credit read retried once");
  assert.equal(state.calls.submitTrace, 1);
  assert.equal(res.matched, 1);
});

// --- terminal credit shortfall ---------------------------------------------

test("traceBatch: a credit shortfall stops cleanly — InsufficientCreditsError, nothing submitted/billed", async () => {
  idSeq = 1;
  const contacts = [mkContact("1 A St"), mkContact("2 B St"), mkContact("3 C St")];
  const { deps, state } = makeDeps({ contacts, credits: 2 }); // need 3, have 2

  await assert.rejects(
    () => traceBatch(CLIENT, { campaignId: 1 }, deps, noRetry),
    (err: unknown) => {
      assert.ok(err instanceof InsufficientCreditsError);
      assert.equal((err as InstanceType<typeof InsufficientCreditsError>).needed, 3);
      assert.equal((err as InstanceType<typeof InsufficientCreditsError>).credits, 2);
      return true;
    }
  );

  assert.equal(state.calls.submitTrace, 0, "nothing submitted");
  assert.equal(state.calls.createTraceJob, 0, "nothing billed");
  assert.ok(contacts.every((c) => c.skiptrace_status === "pending"), "all contacts untouched");
});

// --- poison record ----------------------------------------------------------

test("traceBatch: a poison record (no address) is skipped + suppressed fail-closed; the run continues", async () => {
  idSeq = 1;
  const good1 = mkContact("1 A St");
  const poison = mkContact("   "); // whitespace-only address
  const good2 = mkContact("2 B St");
  const { deps, state } = makeDeps({ contacts: [good1, poison, good2] });

  const res = await traceBatch(CLIENT, { campaignId: 1 }, deps, noRetry);

  // The poison record was suppressed fail-closed and NEVER submitted.
  assert.equal(poison.skiptrace_status, "no_match");
  assert.equal(poison.suppressed, true);
  assert.equal(poison.suppress_reason, "no_match");
  // The good records were traced normally.
  assert.equal(good1.skiptrace_status, "matched");
  assert.equal(good2.skiptrace_status, "matched");
  assert.equal(state.calls.submitTrace, 1, "one submit for the traceable records");
  assert.equal(res.skipped, 1);
  assert.equal(res.matched, 2);
  assert.equal(res.noMatch, 1, "the poison record counts as a no-match");
  // Credit pre-flight only counted the 2 traceable records, not the poison one.
});

test("traceBatch: an all-poison batch never spends a credit and suppresses everything", async () => {
  idSeq = 1;
  const contacts = [mkContact(""), mkContact("  ")];
  const { deps, state } = makeDeps({ contacts });

  const res = await traceBatch(CLIENT, { campaignId: 1 }, deps, noRetry);

  assert.equal(state.calls.getCredits, 0, "no credit read when nothing is traceable");
  assert.equal(state.calls.submitTrace, 0);
  assert.equal(res.skipped, 2);
  assert.ok(contacts.every((c) => c.skiptrace_status === "no_match" && c.suppressed));
});

// --- resume / orphaned-job recovery (no re-charge) --------------------------

test("traceBatch: RESUME re-ingests an orphaned 'submitted' job with NO re-charge", async () => {
  idSeq = 1;
  const c1 = mkContact("1 A St");
  const c2 = mkContact("2 B St");
  const orphan: FakeJob = {
    id: 42,
    client_id: CLIENT,
    queue_id: 777,
    status: "submitted",
    contact_ids: [c1.id, c2.id],
    matched: null,
    no_match: null,
  };
  const { deps, state } = makeDeps({ contacts: [c1, c2], jobs: [orphan] });

  const res = await traceBatch(CLIENT, { campaignId: 1 }, deps, noRetry);

  // Recovery is a FREE re-read: no new submit, no credit spend.
  assert.equal(state.calls.getCredits, 0, "no credit read on a pure recovery");
  assert.equal(state.calls.submitTrace, 0, "no re-submit → no re-charge");
  assert.equal(state.calls.getTraceResults, 1, "re-read the orphaned queue once");
  assert.equal(orphan.status, "ingested", "orphan marked ingested");
  assert.equal(res.recovered, 2);
  assert.equal(res.matched, 2);
  assert.ok([c1, c2].every((c) => c.skiptrace_status === "matched"));
});

test("traceBatch: idempotent — a second run after everything is matched does nothing + spends nothing", async () => {
  idSeq = 1;
  const contacts = [mkContact("1 A St"), mkContact("2 B St")];
  const { deps, state } = makeDeps({ contacts });

  await traceBatch(CLIENT, { campaignId: 1 }, deps, noRetry); // first run traces both
  const before = { ...state.calls };
  const res2 = await traceBatch(CLIENT, { campaignId: 1 }, deps, noRetry); // second run

  assert.equal(state.calls.submitTrace, before.submitTrace, "no new submit on the 2nd run");
  assert.equal(state.calls.getCredits, before.getCredits, "no new credit read on the 2nd run");
  assert.equal(res2.traced, 0);
  assert.equal(state.jobs.length, 1, "no second job created");
});

// --- terminal (non-credit) submit error -------------------------------------

test("traceBatch: a terminal submit 4xx is NOT retried — it surfaces after one attempt", async () => {
  idSeq = 1;
  const contacts = [mkContact("1 A St")];
  const { deps, state } = makeDeps({
    contacts,
    submitErrors: [new TracerfyError("malformed request", { status: 400 })],
  });

  await assert.rejects(() => traceBatch(CLIENT, { campaignId: 1 }, deps, noRetry), /malformed request/);
  assert.equal(state.calls.submitTrace, 1, "terminal 4xx not retried");
  assert.equal(state.calls.createTraceJob, 0, "no job persisted on a failed submit");
});
