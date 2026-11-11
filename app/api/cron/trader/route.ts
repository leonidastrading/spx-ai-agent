import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { runTraderTick } from "@/lib/trader/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** AI day-trader paper test: call every minute 09:00–16:00 ET on weekdays. */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const r = await runTraderTick();
    return NextResponse.json(r, { status: r.status === "error" ? 500 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`trader tick failed: ${message}`);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
