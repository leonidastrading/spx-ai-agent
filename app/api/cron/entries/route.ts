import { NextResponse } from "next/server";
import { AlpacaClient, credsFromEnv, referenceHostFromEnv } from "@/lib/alpaca";
import { checkCronSecret } from "@/lib/auth";
import { exportConfigFromEnv, makeExportClient } from "@/lib/entry/client";
import { runEntryTick } from "@/lib/entry/engine";
import { callEntryModel } from "@/lib/entry/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Entry advisor (shadow mode): call every minute 09:00–16:59 ET on weekdays. */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = exportConfigFromEnv();
  if (!cfg) return NextResponse.json({ status: "skipped", notes: ["OO_EXPORT_URL / OO_EXPORT_TOKEN not set: oo-trading's export isn't connected yet"] });
  try {
    const r = await runEntryTick({
      fetchExport: makeExportClient(cfg),
      data: new AlpacaClient({ creds: credsFromEnv(), referenceHost: referenceHostFromEnv(), maxRetries: 2 }),
      callModel: callEntryModel,
      clock: () => new Date(),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    });
    return NextResponse.json(r, { status: r.status === "error" ? 500 : 200 });
  } catch (err) {
    return NextResponse.json({ status: "error", error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
