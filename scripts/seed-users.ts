// scripts/seed-users.ts — seed the initial operator + Talan client user. (v2 Module V5)
//
// Reads passwords from the ENVIRONMENT (never hardcoded / committed), hashes them with scrypt, and
// upserts the users idempotently. Run AFTER `npm run schema` (which creates the users table).
//
//   OPERATOR_EMAIL, OPERATOR_PASSWORD   → the operator account (role='operator', client_id NULL)
//   CLIENT1_EMAIL,  CLIENT1_PASSWORD    → Talan's client login (role='client', client_id=1)
//
// Example:
//   OPERATOR_EMAIL=you@dr.x OPERATOR_PASSWORD='...' \
//   CLIENT1_EMAIL=talan@example.com CLIENT1_PASSWORD='...' npm run seed:users
//
// Re-running updates the password/role/client_id for the same email (idempotent on lower(email)).

import { config } from "dotenv";
config({ path: ".env.local" });
config();

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const opEmail = process.env.OPERATOR_EMAIL?.trim();
  const opPass = process.env.OPERATOR_PASSWORD;
  const c1Email = process.env.CLIENT1_EMAIL?.trim();
  const c1Pass = process.env.CLIENT1_PASSWORD;

  const missing: string[] = [];
  if (!opEmail) missing.push("OPERATOR_EMAIL");
  if (!opPass) missing.push("OPERATOR_PASSWORD");
  if (!c1Email) missing.push("CLIENT1_EMAIL");
  if (!c1Pass) missing.push("CLIENT1_PASSWORD");
  if (missing.length) {
    console.error(
      `[seed-users] missing env: ${missing.join(", ")}\n` +
        "Set them (operator + Talan client credentials) and re-run. No credentials are hardcoded."
    );
    process.exit(2);
  }

  const { hashPassword } = await import("@/lib/auth");
  const { upsertUser } = await import("@/lib/users");
  const { getClientById } = await import("@/lib/clients");

  const c1 = await getClientById(1);
  if (!c1) throw new Error("client 1 (Talan) missing — run `npm run schema` first.");

  const op = await upsertUser({
    email: opEmail!,
    passwordHash: hashPassword(opPass!),
    role: "operator",
    clientId: null,
  });
  const cu = await upsertUser({
    email: c1Email!,
    passwordHash: hashPassword(c1Pass!),
    role: "client",
    clientId: 1,
  });

  console.log(`[seed-users] operator: #${op.id} <${op.email}> (role=${op.role})`);
  console.log(`[seed-users] client:   #${cu.id} <${cu.email}> (role=${cu.role}, client_id=${cu.client_id})`);
  console.log("[seed-users] done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-users] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
