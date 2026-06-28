"use client";

import { useFormStatus } from "react-dom";
import Card from "@/components/ui/card";
import Button from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

/**
 * The login card (V7). Wraps the V5 server action in a branded product form: labeled email +
 * password fields, a full-width primary button that shows a loading state on submit, and a
 * non-jarring inline error for ?error=1. No auth logic here — it just posts to `action`.
 */
export default function LoginForm({
  action,
  hasError,
}: {
  action: (formData: FormData) => void | Promise<void>;
  hasError: boolean;
}) {
  return (
    <Card className="p-6">
      <form action={action} className="space-y-4">
        <div>
          <h1 className="text-lg font-medium text-stone-900">Sign in</h1>
          <p className="mt-0.5 text-sm text-stone-500">
            Use the credentials for your account.
          </p>
        </div>

        {hasError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Incorrect email or password.
          </p>
        ) : null}

        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            name="email"
            placeholder="you@company.com"
            autoComplete="username"
            autoFocus
            required
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            name="password"
            placeholder="••••••••"
            autoComplete="current-password"
            required
          />
        </Field>

        <SubmitButton />
      </form>
    </Card>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" fullWidth loading={pending} className="mt-1">
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}
