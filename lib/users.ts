/**
 * lib/users.ts — the users table data layer. (v2 Module V5)
 *
 * A user is either an OPERATOR (role='operator', client_id NULL — may act on any client) or a
 * CLIENT user (role='client', client_id set — hard-locked to that client). Passwords are stored
 * ONLY as a scrypt hash (see lib/auth.ts); this module never returns or logs a plaintext password.
 * Email is matched case-insensitively (unique on lower(email)).
 */

import "server-only";
import { sql } from "@/lib/db";

export type UserRole = "operator" | "client";

export interface User {
  id: number;
  email: string;
  role: string; // 'operator' | 'client'
  client_id: number | null;
  created_at: string;
}

/** A user row including the password hash — used ONLY by the login path to verify, never returned to a client. */
export interface UserWithHash extends User {
  password_hash: string;
}

function toUser(r: Record<string, unknown>): User {
  return {
    id: Number(r.id),
    email: String(r.email),
    role: String(r.role),
    client_id: r.client_id === null || r.client_id === undefined ? null : Number(r.client_id),
    created_at: String(r.created_at),
  };
}

/** Load a user (with hash) by email, case-insensitive. Null if no such user. Login path only. */
export async function getUserWithHashByEmail(email: string): Promise<UserWithHash | null> {
  if (!email || !email.trim()) return null;
  const rows = await sql`
    SELECT id, email, password_hash, role, client_id, created_at
    FROM users WHERE lower(email) = lower(${email.trim()})
    LIMIT 1
  `;
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return { ...toUser(r), password_hash: String(r.password_hash) };
}

/** Load a user by id (NO hash). Null if no such user. Used to re-load the session's user each request. */
export async function getUserById(id: number): Promise<User | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await sql`
    SELECT id, email, role, client_id, created_at FROM users WHERE id = ${id} LIMIT 1
  `;
  return rows.length ? toUser(rows[0] as Record<string, unknown>) : null;
}

/**
 * Create or update a user by email (idempotent on lower(email)). The operator uses this to
 * provision client users; the seed script uses it for the initial operator + Talan client user.
 * `clientId` must be set for a client user and NULL for an operator (enforced by the caller / seed).
 */
export async function upsertUser(params: {
  email: string;
  passwordHash: string;
  role: UserRole;
  clientId: number | null;
}): Promise<User> {
  const { email, passwordHash, role, clientId } = params;
  const rows = await sql`
    INSERT INTO users (email, password_hash, role, client_id)
    VALUES (${email.trim()}, ${passwordHash}, ${role}, ${clientId})
    ON CONFLICT (lower(email)) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          role = EXCLUDED.role,
          client_id = EXCLUDED.client_id
    RETURNING id, email, role, client_id, created_at
  `;
  return toUser(rows[0] as Record<string, unknown>);
}
