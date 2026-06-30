import { redirect } from "next/navigation";
import { login } from "@/app/actions";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/access";
import LoginForm from "@/components/login-form";
import { Wordmark } from "@/components/ui/wordmark";

export const dynamic = "force-dynamic";

// The single login page (v2 Module V5) — email + password, real per-user accounts. An already
// logged-in user is bounced to their home (operator → cockpit, client → their dashboard). V7: the
// raw form is replaced by a branded product login card (LoginForm handles the submit/loading state).
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const user = await getSessionUser();
  if (user) redirect(isOperator(user) ? "/" : "/client");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-sunken px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Wordmark size="lg" />
          <p className="mt-3 text-sm text-ink-subtle">
            SMS lead generation for home-service businesses.
          </p>
        </div>

        <LoginForm action={login} hasError={searchParams.error === "1"} />

        <p className="mt-6 text-center text-xs text-ink-subtle">
          Authorized operators &amp; clients only.
        </p>
      </div>
    </main>
  );
}
