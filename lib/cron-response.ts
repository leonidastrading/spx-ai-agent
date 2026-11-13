/**
 * Cron endpoints answer at once and finish their work in the background (Next's `after`, which keeps the Vercel
 * function running up to its maxDuration). cron-job.org gives up after 30 s; the entry advisor's poll loop alone
 * runs ~50 s, so waiting for the work made every run look failed. Add `?wait=1` to run in the foreground and get
 * the result in the reply (for manual checks).
 */

import { after, NextResponse } from "next/server";

type Result = { status: string; error?: string };

export async function cronResponse(request: Request, name: string, work: () => Promise<Result>): Promise<NextResponse> {
  const run = async (): Promise<Result> => {
    try {
      const r = await work();
      if (r.status === "error") console.error(`${name} failed: ${r.error ?? "see run log"}`);
      return r;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${name} failed: ${message}`);
      return { status: "error", error: message };
    }
  };
  if (new URL(request.url).searchParams.get("wait") === "1") {
    const r = await run();
    return NextResponse.json(r, { status: r.status === "error" ? 500 : 200 });
  }
  after(run);
  return NextResponse.json({ status: "started", note: `${name} runs in the background; add ?wait=1 to wait for its result` });
}
