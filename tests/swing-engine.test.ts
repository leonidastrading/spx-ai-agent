import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import type { PaperOrder } from "@/lib/paper-broker";
import { statesByIdea, submitIdea, syncSwing } from "@/lib/swing/engine";
import type { Broker, DataClient } from "@/lib/trader/engine";
import * as ts from "@/lib/trader/store";
import { etToUtc } from "@/lib/time";
import { session } from "./fixtures/sample";

let pg: PGlite;
const S = session("2024-03-11");
const orders = new Map<string, PaperOrder>();
const calls: string[] = [];
let seq = 0;
const mk = (p: Partial<PaperOrder>): PaperOrder => {
  const o = { id: `s${++seq}`, client_order_id: "", symbol: "", side: "buy", qty: "0", type: "market", status: "accepted", order_class: "", filled_qty: "0", filled_avg_price: null, filled_at: null, stop_price: null, limit_price: null, ...p } as PaperOrder;
  orders.set(o.id, o);
  return o;
};
const broker: Broker = {
  submitBracket: async () => { throw new Error("not used"); },
  submitMarket: async (a) => (calls.push(`market ${a.side} ${a.qty} ${a.symbol}`), mk({ symbol: a.symbol, side: a.side, qty: String(a.qty), client_order_id: a.clientOrderId })),
  submitExit: async (a) => (calls.push(`exit ${a.side} ${a.qty} ${"limit" in a ? `limit ${a.limit}` : `trail ${a.trailPercent}%`}`), mk({ symbol: a.symbol, side: a.side, qty: String(a.qty), type: "limit" })),
  getOrder: async (id) => orders.get(id)!,
  getOrderByClientId: async () => null,
  replaceStop: async () => { throw new Error("not used"); },
  cancel: async () => {},
  getPosition: async () => null,
  getAsset: async (symbol) => ({ symbol, class: "us_equity", tradable: true, shortable: true, easy_to_borrow: true }),
};
const data: DataClient = {
  getCalendar: async () => [S],
  resolveFeed: async () => "iex",
  getNews: async () => [],
  getLatestQuotes: async (symbols) => Object.fromEntries(symbols.map((s) => [s, { ts: new Date().toISOString(), bid: 199.9, ask: 200.1 }])),
  getBars: async ({ symbols, end }) => symbols.map((symbol) => ({ symbol, ts: new Date(end.getTime() - 60000).toISOString(), o: 500, h: 500, l: 500, c: symbol === "SPY" ? 500 : 200, v: 1, feed: "iex" as const })),
};
const deps = { data, broker: () => broker, feed: "iex" as const };
const fill = (id: string, price: number, at: Date) => Object.assign(orders.get(id)!, { status: "filled", filled_avg_price: String(price), filled_at: at.toISOString(), filled_qty: orders.get(id)!.qty });
const idea = (p: object = {}) => ({ ticker: "AAPL", side: "long", thesis: "Panic dip on a non-event.", catalyst: "panic_dip", speculative: false, notional: 5000, exitRule: "target", exitParam: 220, ...p });

beforeAll(() => {
  pg = new PGlite();
  setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as any[])).rows as any[] });
});
afterAll(() => setQuerierForTests(null));

describe("swing ideas end to end", () => {
  it("saves, enters at market, places the target exit after the fill, closes on its fill", async () => {
    const r = await submitIdea(idea(), deps);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["market buy 25 AAPL"]);
    const at = etToUtc(S.date, "10:00");
    const states = async () => statesByIdea(await ts.allIdeas(), await ts.allIdeaEvents());
    const entry = (await states()).get(1)!;
    fill(entry.entryOrderId!, 200.05, at);
    await syncSwing(at, S, deps, "iex", []);
    let s = (await states()).get(1)!;
    expect(s).toMatchObject({ status: "closing", entryPrice: 200.05, qty: 25, spyEntry: 500 });
    expect(calls.at(-1)).toBe("exit sell 25 limit 220");
    fill(s.exitOrderId!, 220, new Date(at.getTime() + 86400000));
    await syncSwing(at, S, deps, "iex", []);
    s = (await states()).get(1)!;
    expect(s).toMatchObject({ status: "closed", exitPrice: 220, exitReason: "target" });
  });

  it("time-limit ideas exit at market once due, during market hours", async () => {
    await submitIdea(idea({ ticker: "MSFT", exitRule: "time", exitParam: 3 }), deps);
    const states = async () => statesByIdea(await ts.allIdeas(), await ts.allIdeaEvents());
    const at = etToUtc(S.date, "10:00");
    fill((await states()).get(2)!.entryOrderId!, 200, at);
    await syncSwing(at, S, deps, "iex", []);
    expect((await states()).get(2)!.status).toBe("open");
    const S14 = { date: "2024-03-14", open: "09:30", close: "16:00" }; // that day's session
    await syncSwing(new Date(at.getTime() + 3 * 86400000 - 60000), S14, deps, "iex", []);
    expect((await states()).get(2)!.status).toBe("open");
    await syncSwing(new Date(at.getTime() + 3 * 86400000), S14, deps, "iex", []);
    expect((await states()).get(2)!).toMatchObject({ status: "closing", exitReason: "time" });
    expect(calls.at(-1)).toBe("market sell 25 MSFT");
  });

  it("enforces sleeve limits against live ideas and blocks QQQ / leveraged funds", async () => {
    expect(await submitIdea(idea({ notional: 12000 }), deps)).toMatchObject({ ok: false, errors: [expect.stringMatching(/per-position cap/)] });
    expect(await submitIdea(idea({ speculative: true, notional: 3000 }), deps)).toMatchObject({ ok: true });
    expect(await submitIdea(idea({ speculative: true, notional: 2500 }), deps)).toMatchObject({ ok: false, errors: [expect.stringMatching(/speculative/)] });
    expect(await submitIdea(idea({ ticker: "SQQQ" }), deps)).toMatchObject({ ok: false });
    expect(await submitIdea(idea({ ticker: "QQQ" }), deps)).toMatchObject({ ok: false });
  });

  it("ideas and their events are locked", async () => {
    await expect(pg.query(`UPDATE swing_ideas SET thesis = 'edited'`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`DELETE FROM swing_events`)).rejects.toThrow(/append-only/);
  });
});
