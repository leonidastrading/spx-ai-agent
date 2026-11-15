import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AlpacaClient, Bar } from "@/lib/alpaca";
import { backfillAtrBatch } from "@/lib/atr-backfill";
import * as store from "@/lib/db";
import { etToUtc } from "@/lib/time";

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  store.setQuerierForTests({ query: async (t, p) => (await pg.query(t, p as any[])).rows as any[] });
});
afterAll(() => store.setQuerierForTests(null));

// 70 weekday sessions before 2024-06-14, regular hours.
const sessions: Array<{ date: string; open: string; close: string }> = [];
for (let d = new Date("2024-02-01T12:00:00Z"); sessions.length < 90; d.setUTCDate(d.getUTCDate() + 1)) {
  if ([0, 6].includes(d.getUTCDay())) continue;
  const date = d.toISOString().slice(0, 10);
  if (date >= "2024-06-14") break;
  sessions.push({ date, open: "09:30", close: "16:00" });
}
let barCalls = 0;
const fake = {
  getCalendar: async (start: string, end: string) => sessions.filter((s) => s.date >= start && s.date <= end),
  resolveFeed: async () => "iex",
  getBars: async ({ start, end }: { start: Date; end: Date }) => {
    barCalls++;
    const out: Bar[] = [];
    for (let t = Math.ceil(start.getTime() / 60000) * 60000; t < end.getTime(); t += 60000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const s = sessions.find((x) => x.date === day);
      if (!s || t < etToUtc(day, "09:30").getTime() || t >= etToUtc(day, "16:00").getTime()) continue;
      const c = 500 + Math.sin(t / 600000) * 2;
      out.push({ symbol: "SPY", ts: new Date(t).toISOString(), o: c, h: c + 0.2, l: c - 0.2, c, v: 100, feed: "iex" });
    }
    return out;
  },
} as unknown as AlpacaClient;

describe("ATR history backfill", () => {
  it("fills the newest missing days in batches until the lookback is covered, then makes no data calls", async () => {
    const now = new Date("2024-06-14T22:00:00Z");
    const a = await backfillAtrBatch(fake, now, { maxDays: 25, lookbackDays: 60 });
    expect(a.filled).toBe(25);
    expect(a.missing).toBe(35);
    let r = a;
    for (let i = 0; i < 5 && r.missing; i++) r = await backfillAtrBatch(fake, now, { maxDays: 25, lookbackDays: 60 });
    expect(r.missing).toBe(0);
    expect((await store.atrHistory("2024-06-14", 250)).length).toBeGreaterThanOrEqual(59);
    const calls = barCalls;
    const done = await backfillAtrBatch(fake, now, { maxDays: 25, lookbackDays: 60 });
    expect(done).toMatchObject({ filled: 0, missing: 0 });
    expect(barCalls).toBe(calls);
    const rows = await pg.query<any>(`SELECT count(*)::int AS n FROM morning_history WHERE source = 'backfill'`);
    expect(rows.rows[0].n).toBe(60);
  }, 30000);
});
