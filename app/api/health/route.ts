import { NextResponse } from "next/server";
import { lastSuccessfulRun } from "@/lib/db";
import { lastHeartbeat } from "@/lib/trader/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [run, hb] = await Promise.all([lastSuccessfulRun(), lastHeartbeat()]);
    return NextResponse.json({
      ok: true,
      mode: "advisor: shadow (never trades); trader & swing: Alpaca paper only",
      last_successful_run: run?.finished_at ?? null,
      last_minute_et: run?.minute_et ?? null,
      last_action: run?.action ?? null,
      trader_last_heartbeat: hb?.ts ?? null,
      trader_last_heartbeat_status: hb?.status ?? null,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
