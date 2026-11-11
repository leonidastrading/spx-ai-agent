import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { callPacket } from "@/lib/entry/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The exact packet (and raw reply) a logged call was made on. */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ error: "database not connected" }, { status: 503 });
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const row = await callPacket(id);
  return row ? new Response(JSON.stringify(row, null, 2), { headers: { "content-type": "application/json" } }) : NextResponse.json({ error: "not found" }, { status: 404 });
}
