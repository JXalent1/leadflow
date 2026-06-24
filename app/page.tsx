import { isAuthed, login, logout } from "./actions";
import { getContactCounts } from "@/lib/db";
import { DEFAULT_CLIENT_ID } from "@/lib/clients";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  if (!(await isAuthed())) {
    return <LoginGate error={searchParams.error === "1"} />;
  }

  let counts = { total: 0, withPhone: 0, suppressed: 0 };
  let dbError: string | null = null;
  try {
    counts = await getContactCounts(DEFAULT_CLIENT_ID);
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Unknown database error";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-6 py-16">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">LeadFlow</h1>
        <div className="flex items-center gap-4">
          <a
            href="/dashboard"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Open dashboard →
          </a>
          <form action={logout}>
            <button className="text-sm text-neutral-500 hover:text-neutral-900">
              Log out
            </button>
          </form>
        </div>
      </header>

      {dbError ? (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          Database error: {dbError}
        </p>
      ) : (
        <section className="grid grid-cols-3 gap-4">
          <Stat label="Contacts loaded" value={counts.total} />
          <Stat label="With phones" value={counts.withPhone} />
          <Stat label="Suppressed" value={counts.suppressed} />
        </section>
      )}

      <p className="text-sm text-neutral-500">
        LeadFlow — {counts.total} contacts loaded, {counts.withPhone} with
        phones, {counts.suppressed} suppressed.
      </p>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-3xl font-semibold">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
    </div>
  );
}

function LoginGate({ error }: { error: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <form
        action={login}
        className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-200 bg-white p-6"
      >
        <h1 className="text-xl font-semibold">LeadFlow</h1>
        <p className="text-sm text-neutral-500">Admin access.</p>
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
        />
        {error ? (
          <p className="text-sm text-red-600">Incorrect password.</p>
        ) : null}
        <button className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700">
          Enter
        </button>
      </form>
    </main>
  );
}
