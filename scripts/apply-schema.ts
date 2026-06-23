// Applies db/schema.sql against DATABASE_URL. Idempotent (schema uses IF NOT EXISTS).
// Run: npx tsx scripts/apply-schema.ts
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

// Load .env.local first (Vercel/Neon convention), then fall back to .env.
config({ path: ".env.local" });
config();

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Add it to .env.local.");

  const sql = neon(url);
  const schema = readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8");

  // Split on statement boundaries; the neon HTTP driver runs one statement per call.
  const statements = schema
    .split(";")
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter((s) => s.length > 0);

  // The 0.10.x HTTP function only executes as a tagged template. Build a no-value
  // template-strings array for each (trusted, file-sourced) statement.
  for (const stmt of statements) {
    const tpl = [stmt] as unknown as TemplateStringsArray;
    (tpl as unknown as { raw: string[] }).raw = [stmt];
    await sql(tpl);
  }

  console.log(`Applied ${statements.length} statements from db/schema.sql.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
