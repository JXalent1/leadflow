"use server";

import { redirect } from "next/navigation";
import { getUserWithHashByEmail } from "@/lib/users";
import { verifyPassword, hashPassword } from "@/lib/auth";
import { createSession, destroySession } from "@/lib/session";
import { isLockedOut, recordFailure, clearAttempts } from "@/lib/login-throttle";

// A precomputed scrypt hash to verify against when the email has no account. Running scrypt on the
// no-such-user path equalizes response time with the wrong-password path, so login timing can't
// reveal whether an account exists (no enumeration). This value never matches a real password.
const DUMMY_HASH = hashPassword("login-timing-dummy-not-a-real-password");

// Real per-user login (v2 Module V5) — replaces the single shared ADMIN_PASSWORD gate. Email +
// password (scrypt-verified); on success we mint a signed httpOnly session cookie and route by
// role. All failure modes (unknown email, bad password, lockout) return the SAME generic error so
// the form can't be used to enumerate accounts.

export async function login(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  let role: string | null = null;
  if (email && password && !isLockedOut(email)) {
    try {
      const user = await getUserWithHashByEmail(email);
      if (user && verifyPassword(password, user.password_hash)) {
        clearAttempts(email);
        createSession(user);
        role = user.role;
      } else {
        // No such user → still run scrypt against the dummy so the response time can't distinguish
        // "unknown email" from "wrong password".
        if (!user) verifyPassword(password, DUMMY_HASH);
        recordFailure(email);
      }
    } catch (err) {
      // Never echo auth internals; log server-side only.
      console.error("[login] error:", err instanceof Error ? err.message : String(err));
    }
  }

  // redirect() throws control flow, so it must run OUTSIDE the try/catch above.
  if (!role) redirect("/login?error=1");
  redirect(role === "operator" ? "/" : "/client");
}

export async function logout(): Promise<void> {
  destroySession();
  redirect("/login");
}
