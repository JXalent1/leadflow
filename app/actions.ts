"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// Single shared-password admin gate. NOT real auth — just keeps the dashboard
// from being world-open for the MVP pilot. One httpOnly cookie flag.
const COOKIE_NAME = "lf_admin";
const COOKIE_VALUE = "ok";

export async function isAuthed(): Promise<boolean> {
  return cookies().get(COOKIE_NAME)?.value === COOKIE_VALUE;
}

export async function login(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected || password !== expected) {
    redirect("/?error=1");
  }

  cookies().set(COOKIE_NAME, COOKIE_VALUE, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8, // 8 hours
  });
  redirect("/");
}

export async function logout(): Promise<void> {
  cookies().delete(COOKIE_NAME);
  redirect("/");
}
