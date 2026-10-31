import { checkBasicAuth } from "@/lib/auth";
import * as store from "@/lib/db";
import { buildCallsCsv, buildFeaturesCsv } from "@/lib/export";
import { toEt } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/export?type=calls&from=YYYY-MM-DD&to=YYYY-MM-DD  (default: all history)
 * GET /api/export?type=features&date=YYYY-MM-DD             (every stored minute of one day)
 */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return new Response("unauthorized", { status: 401 });
  if (!store.hasDatabase()) return new Response("Database not connected: add DATABASE_URL (Vercel → Storage → Neon) and redeploy.", { status: 503 });
  const url = new URL(request.url);
  const type = url.searchParams.get("type") ?? "calls";
  const today = toEt(new Date()).date;

  let csv: string;
  let name: string;
  if (type === "features") {
    const date = url.searchParams.get("date") ?? today;
    if (!DATE.test(date)) return new Response("bad date", { status: 400 });
    csv = buildFeaturesCsv(await store.featuresForDate(date));
    name = `features_${date}.csv`;
  } else if (type === "calls") {
    const from = url.searchParams.get("from") || "2000-01-01";
    const to = url.searchParams.get("to") || today;
    if (!DATE.test(from) || !DATE.test(to)) return new Response("bad from/to", { status: 400 });
    const [rows, cfg] = await Promise.all([store.exportRows(from, to), store.loadSettings()]);
    csv = buildCallsCsv(rows, cfg);
    name = from === "2000-01-01" ? `book_advisor_calls_to_${to}.csv` : `book_advisor_calls_${from}_${to}.csv`;
  } else {
    return new Response("type must be calls or features", { status: 400 });
  }

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}
