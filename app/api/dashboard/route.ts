// GET /api/dashboard — READ-ONLY snapshot for the dashboard's client-side polling.
//
// AUTH: requires the admin cookie (isAuthed) — never expose contact data to an
// unauthenticated request. This route only reads (getDashboardData); it adds NO
// write/mutation logic. The dashboard's action buttons call the existing
// /api/{skiptrace,scrub,campaign} endpoints for anything that changes state.

import { NextResponse } from "next/server";
import { isAuthed } from "@/app/actions";
import { getDashboardData } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!(await isAuthed())) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const data = await getDashboardData();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[dashboard] read failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "dashboard_read_failed" }, { status: 500 });
  }
}
