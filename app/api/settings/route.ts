import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import * as store from "@/lib/db";
import { DEFAULT_SETTINGS, validateSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
const noDb = () => NextResponse.json({ errors: ["Database not connected: add DATABASE_URL (Vercel → Storage → Neon) and redeploy."] }, { status: 503 });

/** Current settings; ?download=1 returns them as a JSON file (usable with the backfill's --settings). */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return unauthorized();
  if (!store.hasDatabase()) return noDb();
  const settings = await store.loadSettings();
  if (new URL(request.url).searchParams.get("download")) {
    return new Response(JSON.stringify(settings, null, 2), {
      headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="book_advisor_settings.json"' },
    });
  }
  return NextResponse.json({ settings, defaults: DEFAULT_SETTINGS, updatedAt: await store.settingsUpdatedAt() });
}

export async function PUT(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return unauthorized();
  if (!store.hasDatabase()) return noDb();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ errors: ["body is not JSON"] }, { status: 400 });
  }
  const v = validateSettings(body);
  if (!v.ok) return NextResponse.json({ errors: v.errors }, { status: 422 });
  await store.saveSettings(v.settings);
  return NextResponse.json({ settings: v.settings, updatedAt: await store.settingsUpdatedAt() });
}

/** Reset to the defaults in config/. */
export async function DELETE(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return unauthorized();
  if (!store.hasDatabase()) return noDb();
  await store.resetSettings();
  return NextResponse.json({ settings: DEFAULT_SETTINGS, updatedAt: null });
}
