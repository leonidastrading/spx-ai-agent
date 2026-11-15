/**
 * End-to-end trader ticks against real Postgres SQL (PGlite, in-process), with a
 * fake market-data client, a fake paper broker and a scripted model.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bar } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import type { PaperOrder } from "@/lib/paper-broker";
import { runTraderTick, type Broker, type TraderDeps } from "@/lib/trader/engine";
import * as ts from "@/lib/trader/store";
import { etToUtc } from "@/lib/time";
import { session } from "./fixtures/sample";

const S = session("2024-03-11"); // first EDT session
const P = session("2024-03-08"); // last EST session
const SYMS = ["SPY", "QQQ", "IWM", "TLT", "VIXY"];

let pg: PGlite;
let now = new Date();
const missing = new Set<string>(); // bar timestamps to hold back (bad-data test)

/** 1-min bars: prior session regular hours, today 04:00–16:00, flat prices. */
function source(): Bar[] {
  const out: Bar[] = [];
  const add = (date: string, from: string, to: string) => {
    for (let t = etToUtc(date, from).getTime(); t < etToUtc(date, to).getTime(); t += 60000)
      for (const s of SYMS) {
        const px = s === "QQQ" ? 440 : 100;
        out.push({ symbol: s, ts: new Date(t).toISOString(), o: px, h: px + 0.05, l: px - 0.05, c: px, v: 1000, feed: "iex" });
      }
  };
  add(P.date, "09:30", "16:00");
  add(S.date, "04:00", "16:00");
  return out;
}
const BARS = source();

const data: TraderDeps["data"] = {
  getCalendar: async () => [P, S],
  resolveFeed: async () => "iex",
  getNews: async () => [],
  getLatestQuotes: async () => ({ QQQ: { ts: new Date(now.getTime() - 2000).toISOString(), bid: 439.99, ask: 440.01 } }),
  getBars: async ({ symbols, start, end, timeframe }) => {
    if (timeframe && timeframe !== "1Min") return [{ symbol: "QQQ", ts: start.toISOString(), o: 440, h: 441, l: 439, c: 440, v: 1, feed: "iex" }];
    return BARS.filter((b) => symbols.includes(b.symbol) && Date.parse(b.ts) >= start.getTime() && Date.parse(b.ts) < end.getTime() && !missing.has(b.ts));
  },
};

// ------------------------------------------------------------ fake broker
const orders = new Map<string, PaperOrder>();
const brokerCalls: string[] = [];
let decisionsAtFirstOrder = -1;
let seq = 0;
const order = (p: Partial<PaperOrder>): PaperOrder => {
  const o: PaperOrder = { id: `o${++seq}`, client_order_id: "", symbol: "QQQ", side: "buy", qty: "0", type: "market", status: "accepted", order_class: "", filled_qty: "0", filled_avg_price: null, filled_at: null, stop_price: null, limit_price: null, ...p };
  orders.set(o.id, o);
  return o;
};
const broker: Broker = {
  submitBracket: async (a) => {
    brokerCalls.push(`bracket ${a.side} ${a.qty} stop ${a.stop} target ${a.target}`);
    if (decisionsAtFirstOrder < 0) decisionsAtFirstOrder = Number((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM trader_decisions WHERE status = 'accepted'`)).rows[0].n);
    const legs = [order({ type: "limit", side: a.side === "buy" ? "sell" : "buy", status: "held" }), order({ type: "stop", side: a.side === "buy" ? "sell" : "buy", status: "held" })];
    return order({ client_order_id: a.clientOrderId, side: a.side, qty: String(a.qty), order_class: "bracket", legs });
  },
  submitMarket: async (a) => (brokerCalls.push(`market ${a.side} ${a.qty}`), order({ client_order_id: a.clientOrderId, side: a.side, qty: String(a.qty) })),
  submitExit: async () => order({}),
  getOrder: async (id) => {
    const o = orders.get(id)!;
    return { ...o, legs: o.legs?.map((l) => orders.get(l.id)!) };
  },
  getOrderByClientId: async () => null,
  replaceStop: async (id, stop) => (brokerCalls.push(`replace ${stop}`), orders.get(id)!),
  cancel: async (id) => {
    brokerCalls.push(`cancel ${id}`);
    orders.get(id)!.status = "canceled";
  },
  getPosition: async () => null,
  getAsset: async () => ({ symbol: "QQQ", class: "us_equity", tradable: true, shortable: true, easy_to_borrow: true }),
};
const fill = (id: string, price: number) => Object.assign(orders.get(id)!, { status: "filled", filled_avg_price: String(price), filled_at: now.toISOString(), filled_qty: orders.get(id)!.qty });

// ------------------------------------------------------------ scripted model
const replies: string[] = [];
let modelCalls = 0;
const deps: TraderDeps = {
  data,
  broker: () => broker,
  swingBroker: () => broker,
  ready: { trader: true, swing: true },
  callModel: async () => {
    modelCalls++;
    return { text: replies.shift() ?? "{}", stopReason: "end_turn", modelServed: "test-model", usage: { input_tokens: 1000, output_tokens: 200 }, costUsd: 0.008 };
  },
  sleep: async () => {},
  clock: () => now,
  notify: async () => false,
};
const tick = (hhmm: string, sec = 5) => {
  now = new Date(etToUtc(S.date, hhmm).getTime() + sec * 1000);
  return runTraderTick(deps);
};
const reply = (r: object) => JSON.stringify({ action: "hold", confidence: 50, stop: null, target: null, max_hold_minutes: null, catalyst: "none", thesis: "Nothing compelling.", ...r });
const decisions = async () => (await pg.query<any>(`SELECT slot, phase, status, reason, reply FROM trader_decisions ORDER BY id`)).rows;

beforeAll(async () => {
  pg = new PGlite();
  setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as any[])).rows as any[] });
  await ts.saveTraderSettings({ enabled: true, model: "", effort: "medium" });
});
afterAll(() => setQuerierForTests(null));

describe("trader engine, one morning", () => {
  it("09:25 pre-market read: logged, no orders", async () => {
    replies.push(reply({ action: "long", stop: 439, target: 442, max_hold_minutes: 30 }));
    const r = await tick("09:25");
    expect(r.status).toBe("ok");
    const d = await decisions();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ slot: "2024-03-11 09:25", phase: "premarket", status: "hold" });
    expect(brokerCalls).toEqual([]);
  });

  it("09:30 is not a decision slot", async () => {
    await tick("09:30");
    expect(await decisions()).toHaveLength(1);
  });

  it("09:35 long: decision is logged BEFORE the bracket order; $10k notional", async () => {
    replies.push(reply({ action: "long", confidence: 72, stop: 439, target: 441.5, max_hold_minutes: 30, catalyst: "technical", thesis: "Holding VWAP after the open." }));
    await tick("09:35");
    expect(brokerCalls).toEqual(["bracket buy 22 stop 439 target 441.5"]);
    expect(decisionsAtFirstOrder).toBe(1);
    const [t] = await ts.tradesForDate(S.date);
    expect(t).toMatchObject({ side: "long", qty: 22, status: "pending", stop: 439, target: 441.5, confidence: 72, catalyst: "technical" });
    expect(t.clientOrderId).toMatch(/^aitrader-v1-d\d+$/);
  });

  it("09:36 entry fill is synced; legs recorded", async () => {
    const [t] = await ts.tradesForDate(S.date);
    now = new Date(etToUtc(S.date, "09:35").getTime() + 20000);
    fill(t.entryOrderId!, 440.02);
    await tick("09:36");
    const [u] = await ts.tradesForDate(S.date);
    expect(u).toMatchObject({ status: "open", entryPrice: 440.02 });
    expect(u.stopOrderId).toBeTruthy();
    expect(u.targetOrderId).toBeTruthy();
  });

  it("09:40 hold with a tighter stop: replaced and logged; 09:45 wider stop is ignored", async () => {
    replies.push(reply({ action: "hold", stop: 439.5 }));
    await tick("09:40");
    expect(brokerCalls.at(-1)).toBe("replace 439.5");
    expect((await ts.tradesForDate(S.date))[0].stop).toBe(439.5);
    replies.push(reply({ action: "hold", stop: 438 }));
    await tick("09:45");
    expect(brokerCalls.at(-1)).toBe("replace 439.5");
    expect((await ts.tradesForDate(S.date))[0]).toMatchObject({ stop: 439.5, stopInitial: 439 });
  });

  it("a second entry while in a position is rejected and logged", async () => {
    replies.push(reply({ action: "short", stop: 441, target: 438.5, max_hold_minutes: 20 }));
    await tick("09:50");
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: "already in a position" });
    expect(brokerCalls.filter((c) => c.startsWith("bracket"))).toHaveLength(1);
  });

  it("time limit: legs cancelled, closed at market, then synced as closed", async () => {
    await tick("10:04"); // entry 09:35:20 + 30 min → due at 10:05:20
    expect((await ts.tradesForDate(S.date))[0].status).toBe("open");
    await tick("10:06"); // not a decision slot: only the exit runs
    const t = (await ts.tradesForDate(S.date))[0];
    expect(t).toMatchObject({ status: "closing", exitReason: "time" });
    expect(brokerCalls.slice(-3)).toEqual([`cancel ${t.stopOrderId}`, `cancel ${t.targetOrderId}`, "market sell 22"]);
    fill(t.closeOrderId!, 440.4);
    await tick("10:07");
    expect((await ts.tradesForDate(S.date))[0]).toMatchObject({ status: "closed", exitPrice: 440.4, exitReason: "time" });
  });

  it("bad data: two missing bars (one is tolerated) means no action and no model call", async () => {
    missing.add(etToUtc(S.date, "10:07").toISOString()); // after the 10:07 tick, so not stored yet
    missing.add(etToUtc(S.date, "10:08").toISOString());
    const calls = modelCalls;
    await tick("10:10");
    expect(modelCalls).toBe(calls);
    expect((await decisions()).at(-1)).toMatchObject({ slot: "2024-03-11 10:10", status: "no_action", reason: expect.stringMatching(/bad data: missing 1-min bars at 10:07, 10:08/) });
    missing.clear();
  });

  it("rules the code enforces: too-wide stop rejected; invalid JSON rejected", async () => {
    replies.push(reply({ action: "long", stop: 435, target: 450, max_hold_minutes: 30 }));
    await tick("10:15");
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/stop distance/) });
    replies.push("I think we should buy");
    await tick("10:20");
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/invalid reply/) });
    expect(brokerCalls.filter((c) => c.startsWith("bracket"))).toHaveLength(1);
  });

  it("a slot is decided once, even if the tick runs twice", async () => {
    replies.push(reply({}));
    const calls = modelCalls;
    await tick("10:25");
    await tick("10:25", 40);
    expect(modelCalls).toBe(calls + 1);
    expect((await decisions()).filter((d) => d.slot === "2024-03-11 10:25")).toHaveLength(1);
  });

  it("logged decisions and versions cannot be edited or deleted", async () => {
    await expect(pg.query(`UPDATE trader_decisions SET status = 'accepted'`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`DELETE FROM trader_decisions`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`UPDATE trader_versions SET model = 'x'`)).rejects.toThrow(/append-only/);
  });

  it("changing the model starts a new version; trading disabled blocks entries", async () => {
    await ts.saveTraderSettings({ enabled: false, model: "claude-sonnet-5-5", effort: "medium" });
    replies.push(reply({ action: "long", stop: 439, target: 441.5, max_hold_minutes: 30 }));
    await tick("10:30");
    const versions = await ts.listVersions();
    expect(versions.map((v) => v.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: "trading disabled" });
  });

  it("without its own paper account the trader logs decisions but never enters", async () => {
    await ts.saveTraderSettings({ enabled: true, model: "claude-sonnet-5-5", effort: "medium" });
    deps.ready.trader = false;
    replies.push(reply({ action: "long", stop: 439, target: 441.5, max_hold_minutes: 30 }));
    const before = brokerCalls.length;
    await tick("10:35");
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/no paper account of its own/) });
    expect(brokerCalls.length).toBe(before);
    deps.ready.trader = true;
  });

  it("heartbeat every tick; off-hours ticks do nothing", async () => {
    expect((await ts.lastHeartbeat())?.minuteEt).toBe("2024-03-11 10:35");
    const r = await tick("16:30");
    expect(r.status).toBe("skipped");
  });
});
