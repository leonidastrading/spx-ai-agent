import { NextResponse } from "next/server";
import { runTick } from "@/lib/agent";
import { checkCronSecret } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The 10:50 ET run includes the LLM call; give it room.
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runTick();
    return NextResponse.json(result, { status: result.status === "error" ? 500 : 200 });
  } catch (err) {
    // Failures before a run row exists (e.g. calendar fetch or DB down).
    const message = err instanceof Error ? err.message : String(err);
    console.error(`cron tick failed: ${message}`);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
