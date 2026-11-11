import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { addEcon, deleteEcon } from "@/lib/trader/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time_et: z.string().regex(/^\d{2}:\d{2}$/),
  event: z.string().trim().min(2).max(120),
});

const guard = (request: Request) =>
  !checkBasicAuth(request.headers.get("authorization"))
    ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
    : !hasDatabase()
      ? NextResponse.json({ error: "database not connected" }, { status: 503 })
      : null;

/** Scheduled economic releases shown to the trader model. */
export async function POST(request: Request) {
  const g = guard(request);
  if (g) return g;
  const r = schema.safeParse(await request.json().catch(() => null));
  if (!r.success) return NextResponse.json({ error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 422 });
  await addEcon(r.data.date, r.data.time_et, r.data.event);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const g = guard(request);
  if (g) return g;
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "bad id" }, { status: 400 });
  await deleteEcon(id);
  return NextResponse.json({ ok: true });
}
