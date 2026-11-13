import { NextResponse } from "next/server";
import { runTick } from "@/lib/agent";
import { checkCronSecret } from "@/lib/auth";
import { cronResponse } from "@/lib/cron-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The 10:50 ET run includes the LLM call; give it room.
export const maxDuration = 300;

/** Morning book advisor. Answers at once; the tick runs after (its result is in the dashboard's "Recent cron runs"). */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return cronResponse(request, "cron tick", () => runTick());
}
