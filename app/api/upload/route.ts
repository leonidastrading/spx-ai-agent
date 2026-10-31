import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { upsertOutcomes } from "@/lib/db";
import { parseTradeLog } from "@/lib/optionomega";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Checked here too, not only in the proxy.
  if (!checkBasicAuth(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no file" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "file too large (20MB max)" }, { status: 413 });
  const report = parseTradeLog(await file.text());
  const written = report.outcomes.length ? await upsertOutcomes(report.outcomes) : 0;
  return NextResponse.json({
    rows: report.rows,
    outcomes: report.outcomes.length,
    written,
    dates: report.outcomes.length ? [report.outcomes[0].date, report.outcomes[report.outcomes.length - 1].date] : null,
    unmapped: report.unmapped,
    badRows: report.badRows.slice(0, 50),
  });
}
