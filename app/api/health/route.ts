import { NextResponse } from "next/server";
import { lastSuccessfulRun } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const run = await lastSuccessfulRun();
    return NextResponse.json({
      ok: true,
      mode: "shadow (never trades)",
      last_successful_run: run?.finished_at ?? null,
      last_minute_et: run?.minute_et ?? null,
      last_action: run?.action ?? null,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
