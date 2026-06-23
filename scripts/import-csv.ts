// Imports data/tallahassee_test_500.csv into the contacts table.
// Phone is left null and skiptrace_status defaults to 'pending' (Session 2 fills phones).
// Idempotent: skips rows whose (address, zip) already exist. Pass --fresh to TRUNCATE first.
// Run: npx tsx scripts/import-csv.ts [--fresh]
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
  const csvPath = join(process.cwd(), "data", "tallahassee_test_500.csv");
  const raw = readFileSync(csvPath, "utf8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as CsvRow[];

  if (fresh) {
    await sql`TRUNCATE contacts RESTART IDENTITY CASCADE`;
    console.log("--fresh: truncated contacts.");
  }

  // Build a set of existing (address|zip) keys so re-runs don't duplicate.
  const existing = new Set<string>();
  const existingRows = await sql`SELECT address, zip FROM contacts`;
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
      INSERT INTO contacts (first_name, last_name, address, city, state, zip)
      VALUES (${norm(row.FirstName) || null}, ${norm(row.LastName) || null},
              ${address}, ${norm(row.City) || null},
              ${norm(row.State) || null}, ${zip || null})
    `;
    existing.add(key);
    inserted++;
  }

  console.log(`Import summary — read: ${read}, inserted: ${inserted}, skipped: ${skipped}`);

  const [{ count }] = (await sql`SELECT COUNT(*)::int AS count FROM contacts`) as { count: number }[];
  console.log(`contacts table now holds ${count} rows.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
