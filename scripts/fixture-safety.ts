// scripts/fixture-safety.ts — guardrail for destructive live-DB fixtures.
//
// CONTEXT (2026-06-27 incident): the isolation/access/cockpit/auto-pause/passthrough fixtures used a
// HARDCODED client id (2) as a disposable test tenant and, in cleanup, ran `DELETE ... WHERE
// client_id = 2` UNCONDITIONALLY. Once a real client #2 was onboarded, running a fixture deleted that
// real client's data. Fix: (a) fixtures now use a high throwaway id well above any real client id, and
// (b) they call this guard BEFORE any insert/cleanup — it REFUSES to run if the target id is occupied
// by a client the fixture didn't create (i.e. a real client). The guard MUST be called before the
// fixture's try/finally so a guard failure can never reach the cleanup deletes.

type TaggedSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/**
 * Refuse to run a destructive fixture unless `id` is a safe, disposable client id:
 *   - it must be a high id (>= 100000) so it can't collide with a real, sequentially-allocated client;
 *   - if a client row already exists at `id`, its name MUST equal `markerName` (i.e. it is THIS
 *     fixture's own leftover from a prior run) — otherwise we abort rather than delete a real client.
 * Throws (aborting the fixture) on any violation. Call this BEFORE the fixture's try/finally.
 */
export async function assertDisposableClientId(
  sql: TaggedSql,
  id: number,
  markerName: string
): Promise<void> {
  if (!Number.isInteger(id) || id < 100000) {
    throw new Error(
      `[fixture-safety] fixture client id ${id} must be a high throwaway id (>= 100000) to avoid ` +
        `colliding with real clients. Refusing to run.`
    );
  }
  const rows = (await sql`SELECT name FROM clients WHERE id = ${id}`) as { name: unknown }[];
  if (rows.length) {
    const name = String(rows[0].name);
    if (name !== markerName) {
      throw new Error(
        `[fixture-safety] REFUSING TO RUN: client id ${id} exists and is "${name}", not the fixture ` +
          `marker "${markerName}". This fixture DELETEs all data for client_id=${id} in cleanup; ` +
          `running it would destroy real client data.`
      );
    }
  }
}
