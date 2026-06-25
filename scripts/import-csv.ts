// Imports data/tallahassee_test_500.csv into the contacts table FOR ONE CLIENT (default 1).
// Phone is left null and skiptrace_status defaults to 'pending' (Session 2 fills phones).
// Idempotent: skips rows whose (address, zip) already exist FOR THAT CLIENT. Pass --fresh to
// TRUNCATE first (clears ALL clients' contacts — use with care). Run:
//   npx tsx scripts/import-csv.ts [--fresh] [--client=N]
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { neon } from "@neondatabase/serverless";

// Load .env.local first (Vercel/Neon convention), then fall back to .env.
config({ path: ".env.local" });
config();

interface CsvRow {
  FirstName: string;
  LastName: string;
  Address: string;
  City: string;
  State: string;
  Zip: string;
}

function norm(value: string | undefined): string {
  return (value ?? "").trim();
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Add it to .env.local.");
  const sql = neon(url);

  const fresh = process.argv.includes("--fresh");
  const clientArg = process.argv.find((a) => a.startsWith("--client="));
  const clientId = clientArg ? Math.max(1, Number(clientArg.split("=")[1])) : 1;
  // v2: contacts now carry a campaign_id (NOT NULL). The Talan pilot list belongs to campaign 1.
  // (The product path for new lists is the in-app CSV uploader, which creates a fresh campaign.)
  const campaignArg = process.argv.find((a) => a.startsWith("--campaign="));
  const campaignId = campaignArg ? Math.max(1, Number(campaignArg.split("=")[1])) : 1;
  const csvPath = join(process.cwd(), "data", "tallahassee_test_500.csv");
  const raw = readFileSync(csvPath, "utf8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as CsvRow[];

  if (fresh) {
    // Client-scoped reset (review fix): delete ONLY this client's rows, in FK order, so a --fresh
    // re-import can never wipe another client's data. (The old global TRUNCATE was a multi-tenant
    // data-loss hazard.) FKs have no ON DELETE CASCADE, so children go first.
    await sql`DELETE FROM leads WHERE client_id = ${clientId}`;
    await sql`DELETE FROM opt_outs WHERE client_id = ${clientId}`;
    await sql`DELETE FROM messages WHERE client_id = ${clientId}`;
    await sql`DELETE FROM contacts WHERE client_id = ${clientId}`;
    console.log(`--fresh: cleared client ${clientId}'s contacts (+ its messages/opt_outs/leads).`);
  }

  // Build a set of existing (address|zip) keys (for THIS client) so re-runs don't duplicate.
  const existing = new Set<string>();
  const existingRows = await sql`SELECT address, zip FROM contacts WHERE client_id = ${clientId}`;
  for (const r of existingRows as { address: string; zip: string | null }[]) {
    existing.add(`${(r.address ?? "").toUpperCase()}|${r.zip ?? ""}`);
  }

  let read = 0;
  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    read++;
    const address = norm(row.Address);
    const zip = norm(row.Zip);

    if (!address) {
      skipped++;
      continue;
    }

    const key = `${address.toUpperCase()}|${zip}`;
    if (existing.has(key)) {
      skipped++;
      continue;
    }

    await sql`
      INSERT INTO contacts (client_id, campaign_id, first_name, last_name, address, city, state, zip)
      VALUES (${clientId}, ${campaignId}, ${norm(row.FirstName) || null}, ${norm(row.LastName) || null},
              ${address}, ${norm(row.City) || null},
              ${norm(row.State) || null}, ${zip || null})
    `;
    existing.add(key);
    inserted++;
  }

  console.log(`Import summary — read: ${read}, inserted: ${inserted}, skipped: ${skipped}`);

  const [{ count }] = (await sql`SELECT COUNT(*)::int AS count FROM contacts WHERE client_id = ${clientId}`) as { count: number }[];
  console.log(`client ${clientId} now holds ${count} contacts.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
