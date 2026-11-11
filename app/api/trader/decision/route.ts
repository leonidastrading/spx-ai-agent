import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { decisionInputs } from "@/lib/trader/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Full logged inputs and raw reply of one decision (read-only). */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ error: "database not connected" }, { status: 503 });
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const row = await decisionInputs(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new Response(JSON.stringify(row, null, 2), { headers: { "content-type": "application/json" } });
}
