import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { submitIdea } from "@/lib/swing/engine";
import { defaultDeps } from "@/lib/trader/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Save a swing idea (locked once saved) and send its paper entry order. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ errors: ["database not connected"] }, { status: 503 });
  try {
    const deps = defaultDeps();
    const feed = await deps.data.resolveFeed({ forced: process.env.ALPACA_FEED });
    const r = await submitIdea(await request.json().catch(() => null), { ...deps, feed });
    return NextResponse.json(r, { status: r.ok ? 200 : 422 });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}
