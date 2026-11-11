import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { saveHumanCall } from "@/lib/entry/store";
import { toEt } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ call: z.enum(["normal", "half", "skip_afternoon"]), reason: z.string().trim().min(3).max(200) });

/** Vadim's pre-open call for today: accepted only before 09:30 ET, locked once saved. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ error: "database not connected" }, { status: 503 });
  const et = toEt(new Date());
  if (et.minutes >= 9 * 60 + 30) return NextResponse.json({ error: "Locked: the market has opened (calls are accepted before 09:30 ET)." }, { status: 423 });
  const r = schema.safeParse(await request.json().catch(() => null));
  if (!r.success) return NextResponse.json({ error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 422 });
  const saved = await saveHumanCall(et.date, r.data.call, r.data.reason);
  return saved ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Today's call is already saved and locked." }, { status: 409 });
}
