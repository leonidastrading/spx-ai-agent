import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { saveEntrySettings } from "@/lib/entry/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ enabled: z.boolean(), model: z.string().trim().max(100).regex(/^[a-z0-9.\-]*$/i), effort: z.enum(["low", "medium", "high", "xhigh", "max"]) });

/** Changing model or effort starts a new version. */
export async function PUT(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ error: "database not connected" }, { status: 503 });
  const r = schema.safeParse(await request.json().catch(() => null));
  if (!r.success) return NextResponse.json({ error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 422 });
  await saveEntrySettings(r.data);
  return NextResponse.json({ ok: true });
}
