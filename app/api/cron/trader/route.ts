import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { cronResponse } from "@/lib/cron-response";
import { runTraderTick } from "@/lib/trader/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** AI day-trader paper test: call every minute 09:00–16:00 ET on weekdays. Answers at once; the tick runs after. */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return cronResponse(request, "trader tick", () => runTraderTick());
}
