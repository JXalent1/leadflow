import { redirect } from "next/navigation";
import { login } from "@/app/actions";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/access";

export const dynamic = "force-dynamic";

// The single login page (v2 Module V5) — email + password, real per-user accounts. An already
// logged-in user is bounced to their home (operator → cockpit, client → their dashboard).
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const user = await getSessionUser();
  if (user) redirect(isOperator(user) ? "/" : "/client");

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <form
        action={login}
        className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-200 bg-white p-6"
      >
        <h1 className="text-xl font-semibold">LeadFlow</h1>
        <p className="text-sm text-neutral-500">Sign in to your account.</p>
        <input
          type="email"
          name="email"
          placeholder="Email"
          autoComplete="username"
          autoFocus
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
        />
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoComplete="current-password"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
        />
        {searchParams.error === "1" ? (
          <p className="text-sm text-red-600">Incorrect email or password.</p>
        ) : null}
        <button className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700">
          Sign in
        </button>
      </form>
    </main>
  );
}
