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
/** Regular-session 15-min QQQ bars with a $2 range: ATR 2, so at $440 the stop band is $1–$5. */
const BARS15: Bar[] = [P.date, S.date].flatMap((date) =>
  Array.from({ length: 26 }, (_, i) => ({ symbol: "QQQ", ts: new Date(etToUtc(date, "09:30").getTime() + i * 900000).toISOString(), o: 440, h: 441, l: 439, c: 440, v: 1, feed: "iex" as const })),
);
const qqqBar = (hhmm: string) => BARS.find((b) => b.symbol === "QQQ" && b.ts === etToUtc(S.date, hhmm).toISOString())!;

const data: TraderDeps["data"] = {
  getCalendar: async () => [P, S],
  resolveFeed: async () => "iex",
  getNews: async () => [],
  getLatestQuotes: async () => ({ QQQ: { ts: new Date(now.getTime() - 2000).toISOString(), bid: 439.99, ask: 440.01 } }),
  getBars: async ({ symbols, start, end, timeframe }) => {
    if (timeframe === "15Min") return BARS15.filter((b) => Date.parse(b.ts) >= start.getTime() && Date.parse(b.ts) < end.getTime());
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
  // Like Alpaca: the stop is replaced by a new order with a new id; the old one is dead.
  replaceStop: async (id, stop) => {
    brokerCalls.push(`replace ${id} ${stop}`);
    const old = orders.get(id)!;
    old.status = "replaced";
    return order({ type: old.type, side: old.side, status: "held", stop_price: String(stop) });
  },
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
const prompts: string[] = [];
let modelCalls = 0;
let calendarCalls = 0;
const deps: TraderDeps = {
  data,
  broker: () => broker,
  swingBroker: () => broker,
  ready: { trader: true, swing: true },
  callModel: async ({ user }) => {
    modelCalls++;
    prompts.push(user);
    return { text: replies.shift() ?? "{}", stopReason: "end_turn", modelServed: "test-model", usage: { input_tokens: 1000, output_tokens: 200 }, costUsd: 0.008 };
  },
  sleep: async () => {},
  clock: () => now,
  notify: async () => false,
  calendar: async (from) => {
    calendarCalls++;
    return { rows: [{ date: from, time_et: "10:00", event: "ISM services", source: "fred" as const }], errors: [], skipped: [] };
  },
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

describe("trader engine, one morning (v4 rules)", () => {
  it("09:00 before the open: the economic calendar is filled once a day; no model call", async () => {
    await tick("09:00");
    await tick("09:01");
    expect(calendarCalls).toBe(1);
    expect(await ts.econFor(S.date)).toMatchObject([{ time_et: "10:00", event: "ISM services" }]);
    expect(modelCalls).toBe(0);
  });

  it("09:25 is not a decision slot any more (no pre-market read)", async () => {
    await tick("09:25");
    expect(await decisions()).toHaveLength(0);
    expect(modelCalls).toBe(0);
  });

  it("09:35 long: logged BEFORE the bracket; sized by $50 risk; the model sees the last price, not the quote", async () => {
    replies.push(reply({ action: "long", confidence: 72, stop: 439, target: 441.5, max_hold_minutes: 30, catalyst: "technical", thesis: "Holding VWAP after the open." }));
    await tick("09:35");
    // $1 stop: $50 ÷ $1 = 50 shares, capped at $20,000 of QQQ = 45.
    expect(brokerCalls).toEqual(["bracket buy 45 stop 439 target 441.5"]);
    expect(decisionsAtFirstOrder).toBe(1);
    const [t] = await ts.tradesForDate(S.date);
    expect(t).toMatchObject({ side: "long", qty: 45, status: "pending", stop: 439, target: 441.5, confidence: 72, catalyst: "technical", refPrice: 440 });
    expect(t.clientOrderId).toMatch(/^aitrader-v1-d\d+$/);
    const sent = JSON.parse(prompts.at(-1)!.slice(prompts.at(-1)!.indexOf("{")));
    expect(sent.quote).toBeUndefined();
    expect(sent.price).toEqual({ last: 440, bar_et: "09:34" });
    expect(sent.data_note).toMatch(/IEX exchange only/);
    expect(sent.atr_15m).toBe(2);
    expect(sent.entry_sizing).toMatchObject({ stop_distance_min: 1, stop_distance_max: 5, risk_per_trade: 50 });
    expect(sent.econ_today).toEqual([{ time_et: "10:00", event: "ISM services" }]);
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

  it("09:40 a hold can't move the stop any more", async () => {
    replies.push(reply({ action: "hold", stop: 439.5 }));
    await tick("09:40");
    expect(brokerCalls.some((c) => c.startsWith("replace"))).toBe(false);
    expect((await ts.tradesForDate(S.date))[0]).toMatchObject({ stop: 439, stopInitial: 439 });
  });

  it("breakeven: once the trade is ahead by its risk the code moves the stop to entry, once, and keeps the new order id", async () => {
    const [before] = await ts.tradesForDate(S.date);
    qqqBar("09:41").h = 441.1; // entry 440.02, risk 1.02: needs 441.04
    await tick("09:42");
    const [t] = await ts.tradesForDate(S.date);
    expect(brokerCalls.at(-1)).toBe(`replace ${before.stopOrderId} 440.02`);
    expect(t).toMatchObject({ stop: 440.02, stopInitial: 439 });
    expect(t.stopOrderId).not.toBe(before.stopOrderId); // the replacement's id
    expect((await pg.query<any>(`SELECT decision_id, old_stop, new_stop, reason FROM trader_stop_changes`)).rows).toEqual([{ decision_id: null, old_stop: 439, new_stop: 440.02, reason: "breakeven" }]);
    await tick("09:43");
    expect(brokerCalls.filter((c) => c.startsWith("replace"))).toHaveLength(1);
  });

  it("a second entry while in a position is rejected and logged", async () => {
    replies.push(reply({ action: "short", confidence: 60, stop: 441, target: 438.5, max_hold_minutes: 20 }));
    await tick("09:50");
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: "already in a position" });
    expect(brokerCalls.filter((c) => c.startsWith("bracket"))).toHaveLength(1);
  });

  it("time limit: the live (replacement) stop and the target are cancelled, closed at market, then synced as closed", async () => {
    await tick("10:04"); // entry 09:35:20 + 30 min → due at 10:05:20
    expect((await ts.tradesForDate(S.date))[0].status).toBe("open");
    await tick("10:06"); // not a decision slot: only the exit runs
    const t = (await ts.tradesForDate(S.date))[0];
    expect(t).toMatchObject({ status: "closing", exitReason: "time" });
    expect(brokerCalls.slice(-3)).toEqual([`cancel ${t.stopOrderId}`, `cancel ${t.targetOrderId}`, "market sell 45"]);
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

  it("rules the code enforces: stop outside the ATR band, low chance of target, invalid JSON", async () => {
    replies.push(reply({ action: "long", confidence: 70, stop: 434, target: 450, max_hold_minutes: 30 }));
    await tick("10:15");
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/stop distance 6\.00 outside the allowed 1\.00–5\.00/) });
    replies.push(reply({ action: "long", confidence: 40, stop: 439, target: 441.5, max_hold_minutes: 30 }));
    await tick("10:20");
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/40% is not above the 40% break-even/) });
    replies.push("I think we should buy");
    await tick("10:25");
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/invalid reply/) });
    expect(brokerCalls.filter((c) => c.startsWith("bracket"))).toHaveLength(1);
  });

  it("a slot is decided once, even if the tick runs twice", async () => {
    replies.push(reply({}));
    const calls = modelCalls;
    await tick("10:30");
    await tick("10:30", 40);
    expect(modelCalls).toBe(calls + 1);
    expect((await decisions()).filter((d) => d.slot === "2024-03-11 10:30")).toHaveLength(1);
  });

  it("logged decisions and versions cannot be edited or deleted", async () => {
    await expect(pg.query(`UPDATE trader_decisions SET status = 'accepted'`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`DELETE FROM trader_decisions`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`UPDATE trader_versions SET model = 'x'`)).rejects.toThrow(/append-only/);
  });

  it("changing the model starts a new version; trading off is a dry run: the model is called, entries rejected", async () => {
    await ts.saveTraderSettings({ enabled: false, model: "claude-sonnet-5-5", effort: "medium" });
    replies.push(reply({ action: "long", confidence: 70, stop: 439, target: 441.5, max_hold_minutes: 30 }));
    await tick("10:35");
    expect((await ts.listVersions()).map((v) => v.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: "trading disabled" });
  });

  it("without its own paper account the trader logs decisions but never enters", async () => {
    await ts.saveTraderSettings({ enabled: true, model: "claude-sonnet-5-5", effort: "medium" });
    deps.ready.trader = false;
    replies.push(reply({ action: "long", confidence: 70, stop: 439, target: 441.5, max_hold_minutes: 30 }));
    const before = brokerCalls.length;
    await tick("10:40");
    expect((await decisions()).at(-1)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/no paper account of its own/) });
    expect(brokerCalls.length).toBe(before);
    deps.ready.trader = true;
  });

  it("flat with no entry possible (3 trades used), the model isn't called", async () => {
    await ts.saveTraderSettings({ enabled: true, model: "claude-sonnet-5-5", effort: "medium" });
    const [v2] = (await ts.listVersions()).slice(-1);
    for (let i = 0; i < 3; i++) {
      const d = await ts.logDecision({ versionId: v2.id, slot: `2024-03-11 10:4${i}x`, phase: "intraday", newsOk: true, serverTs: now.toISOString(), inputsHash: null, inputs: null, reply: null, replyText: null, status: "accepted", reason: null, modelServed: null, usage: null, costUsd: null, dataOk: true });
      const t = await ts.createTrade({ versionId: v2.id, decisionId: d!, date: S.date, side: "long", qty: 1, refPrice: 440, stopInitial: 439, stop: 439, target: 441, maxHoldMinutes: 30, confidence: 60, catalyst: "none", clientOrderId: `limit-${i}` });
      await ts.updateTrade(t.id, { status: "closed", entryPrice: 440, entryAt: now.toISOString(), exitPrice: 440.5, exitAt: now.toISOString() });
    }
    const calls = modelCalls;
    await tick("10:45");
    expect(modelCalls).toBe(calls);
    expect((await decisions()).at(-1)).toMatchObject({ slot: "2024-03-11 10:45", status: "no_action", reason: "no action possible: 3 trades already today" });
  });

  it("heartbeat every tick; off-hours ticks do nothing", async () => {
    expect((await ts.lastHeartbeat())?.minuteEt).toBe("2024-03-11 10:45");
    const r = await tick("16:30");
    expect(r.status).toBe("skipped");
  });
});
