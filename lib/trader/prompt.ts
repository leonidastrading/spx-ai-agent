/** Trader inputs, prompt and version identity. Pure. */

import { NEWS_SCREEN } from "@/config/keywords";
import { createHash } from "node:crypto";
import { MODEL_PRICES, TRADER } from "@/config/trader";
import type { Bar, Feed } from "../alpaca";
import { categorize, type Headline, type KeywordConfig } from "../news";
import { etToUtc, toEt, type Session } from "../time";
import { REPLY_JSON_SCHEMA, stopBand, type ClosedTrade, type OpenTrade } from "./rules";

export const TRADER_SYSTEM_PROMPT = `You are an intraday trader running a forward paper test on QQQ. The question being tested is whether you can day-trade QQQ profitably from live prices and news. This is a day-trading test: on a normal session, take about ${TRADER.targetTradesPerDay} trades (at most ${TRADER.maxTradesPerDay}), choosing the best setups the day offers. Waiting all day for a perfect setup can't be scored and is a failure of this test, just as forcing a trade with no reason is. Each trade needs a specific, current reason: a level, a trend, a reaction to news or data. At each check, if there is a setup with positive expected value, take it. You are only asked when an action is possible.

Rules the code enforces (replies that break them are rejected and logged):
- QQQ shares only, one position at a time, at most ${TRADER.maxTradesPerDay} trades a day. New entries only ${TRADER.firstEntry}–${TRADER.lastEntry} ET; everything is closed at ${TRADER.flatBy} ET.
- The code sets the size: every trade risks $${TRADER.riskPerTrade} at its stop. Shares = $${TRADER.riskPerTrade} ÷ stop distance (at most $${TRADER.maxNotional.toLocaleString("en-US")} of QQQ), so a wider stop means fewer shares, not more risk. Big-range days are tradable with wider stops.
- An entry ("long" or "short") must give stop, target and max_hold_minutes. The stop distance from price.last must be inside entry_sizing's band (${TRADER.stopMinAtr}–${TRADER.stopMaxAtr}× the 15-minute ATR), the target at least ${TRADER.targetMinMultiple}× the stop distance, both on the correct side.
- Stop and target are fixed at entry; you cannot move them. The code moves the stop to the entry price once, after the trade has been ahead by the amount risked. While in a position, reply "hold" or "close" (exit at market).
- confidence: for an entry, your honest estimate (0–100) of the chance that the target is hit before the stop. The entry must have positive expected value by your own estimate: confidence above the break-even rate for the reward-to-risk you chose, 100 × stop distance ÷ (stop distance + target distance). That's 50 at 1:1, 40 at 1.5:1 and 33 at 2:1. Don't inflate it: calibration is scored, so entries you put at 45 should reach the target first about 45% of the time. For "hold" and "close", confidence is null.
- No new entries after ${TRADER.maxConsecutiveLosses} losing trades in a row or a day's loss of $${TRADER.dailyLossFraction * TRADER.notional}.
- With no position, "close" is invalid; for "hold"/"close", stop/target/max_hold_minutes may be null.

Data: price.last is the close of the last completed 1-minute bar. Read data_note for what the price and volume feed can and cannot tell you.

Reply with JSON only: {"action": "long"|"short"|"close"|"hold", "confidence": 0-100|null, "stop": price|null, "target": price|null, "max_hold_minutes": n|null, "catalyst": "news"|"technical"|"macro"|"panic_reversal"|"none", "thesis": "at most ${TRADER.maxThesisWords} words"}.`;

// ---------------------------------------------------------------- inputs

const r2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r3 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const pct = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : r3((a / b - 1) * 100));

function bySymbol(bars: Bar[], symbol: string) {
  return bars.filter((b) => b.symbol === symbol).sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Aggregate 1-min bars into N-minute bars aligned to the session open. */
export function aggregate(bars: Bar[], minutes: number, anchor: Date): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const t = Date.parse(b.ts);
    const bucket = anchor.getTime() + Math.floor((t - anchor.getTime()) / (minutes * 60000)) * minutes * 60000;
    const ts = new Date(bucket).toISOString();
    const last = out[out.length - 1];
    if (last && last.ts === ts) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else out.push({ ...b, ts });
  }
  return out;
}

export interface DayStats {
  prior_close: number | null;
  premarket_high: number | null;
  premarket_low: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  last: number | null;
  vwap: number | null;
  range_pos: number | null;
  ret_prev_close_pct: number | null;
}

/** Day statistics for one symbol from 1-min bars (prior session included for the prior close). */
export function dayStats(bars1m: Bar[], symbol: string, session: Session, prior: Session, asOf: Date): DayStats {
  const all = bySymbol(bars1m, symbol).filter((b) => Date.parse(b.ts) < asOf.getTime());
  const open = etToUtc(session.date, session.open).getTime();
  const priorOpen = etToUtc(prior.date, prior.open).getTime();
  const priorClose = etToUtc(prior.date, prior.close).getTime();
  const priorRegular = all.filter((b) => Date.parse(b.ts) >= priorOpen && Date.parse(b.ts) < priorClose);
  const pre = all.filter((b) => Date.parse(b.ts) >= etToUtc(session.date, "04:00").getTime() && Date.parse(b.ts) < open);
  const reg = all.filter((b) => Date.parse(b.ts) >= open);
  const pc = priorRegular.length ? priorRegular[priorRegular.length - 1].c : null;
  const hi = reg.length ? Math.max(...reg.map((b) => b.h)) : null;
  const lo = reg.length ? Math.min(...reg.map((b) => b.l)) : null;
  const last = reg.length ? reg[reg.length - 1].c : pre.length ? pre[pre.length - 1].c : null;
  const vol = reg.reduce((a, b) => a + b.v, 0);
  const vwap = vol ? reg.reduce((a, b) => a + ((b.h + b.l + b.c) / 3) * b.v, 0) / vol : null;
  return {
    prior_close: r2(pc),
    premarket_high: pre.length ? r2(Math.max(...pre.map((b) => b.h))) : null,
    premarket_low: pre.length ? r2(Math.min(...pre.map((b) => b.l))) : null,
    open: reg.length ? r2(reg[0].o) : null,
    high: r2(hi),
    low: r2(lo),
    last: r2(last),
    vwap: r2(vwap),
    range_pos: hi !== null && lo !== null && last !== null ? (hi > lo ? r3((last - lo) / (hi - lo)) : 0.5) : null,
    ret_prev_close_pct: pct(last, pc),
  };
}

const barRow = (b: Bar, withDate = false) => {
  const et = toEt(new Date(b.ts));
  return [withDate ? `${et.date.slice(5)} ${et.hhmm}` : et.hhmm, r2(b.o), r2(b.h), r2(b.l), r2(b.c), Math.round(b.v)];
};

export interface TraderInputs {
  now_et: string;
  phase: "premarket" | "intraday";
  /** v4: the last completed 1-min bar's close; the quote is no longer sent (see data_note). */
  price: { last: number | null; bar_et: string | null };
  data_note: string;
  /** ATR(14) of regular-session 15-min bars, and what it allows for an entry now. */
  atr_15m: number | null;
  entry_sizing: { stop_distance_min: number; stop_distance_max: number; risk_per_trade: number; shares: string } | null;
  qqq: DayStats;
  vs_today_pct: Record<string, number | null>;
  bars_1m_last60: Array<Array<string | number | null>>;
  bars_5m_today: Array<Array<string | number | null>>;
  bars_15m_5d: Array<Array<string | number | null>>;
  bars_1d_60: Array<Array<string | number | null>>;
  news_feed_ok: boolean;
  headlines_since_last_call: Array<{ et: string; headline: string; symbols: string[]; tags: string[] }>;
  econ_today: Array<{ time_et: string; event: string }> | "no economic calendar entries for today";
  position: null | { side: string; qty: number; entry: number | null; entry_et: string | null; stop: number; target: number; exit_by_et: string | null };
  closed_today: Array<{ side: string; pl: number; exit_et: string }>;
  trades_left_today: number;
  entry_blocked: string | null;
}

export function buildInputs(args: {
  now: Date;
  phase: "premarket" | "intraday";
  session: Session;
  prior: Session;
  feed: Feed;
  atr15: number | null;
  bars1m: Bar[];
  bars15m5d: Bar[];
  bars1d60: Bar[];
  newsOk: boolean;
  headlines: Headline[];
  keywords: KeywordConfig;
  econ: Array<{ time_et: string; event: string }>;
  open: OpenTrade | null;
  closedToday: ClosedTrade[];
  tradesToday: number;
  entryBlocked: string | null;
}): TraderInputs {
  const { now, session, prior } = args;
  const sym = TRADER.symbol;
  const openAt = etToUtc(session.date, session.open);
  const done = args.bars1m.filter((b) => Date.parse(b.ts) < Math.floor(now.getTime() / 60000) * 60000);
  const q1 = bySymbol(done, sym);
  const today = q1.filter((b) => Date.parse(b.ts) >= openAt.getTime());
  const stats = dayStats(done, sym, session, prior, now);
  const vs: Record<string, number | null> = {};
  for (const s of TRADER.contextSymbols) vs[s] = dayStats(done, s, session, prior, now).ret_prev_close_pct;
  vs["QQQ_minus_SPY"] = stats.ret_prev_close_pct !== null && vs.SPY !== null ? r3(stats.ret_prev_close_pct - vs.SPY) : null;
  const lastBar = q1[q1.length - 1] ?? null;
  const last = lastBar ? r2(lastBar.c) : null;
  const band = last !== null && args.atr15 !== null ? stopBand(last, args.atr15) : null;
  const etOf = (iso: string | null) => (iso ? toEt(new Date(iso)).hhmm : null);

  return {
    now_et: `${toEt(now).date} ${toEt(now).hhmm}`,
    phase: args.phase,
    price: { last, bar_et: lastBar ? toEt(new Date(lastBar.ts)).hhmm : null },
    data_note: dataNote(args.feed),
    atr_15m: r2(args.atr15),
    entry_sizing: band
      ? {
          stop_distance_min: band.min,
          stop_distance_max: band.max,
          risk_per_trade: TRADER.riskPerTrade,
          shares: `${TRADER.riskPerTrade} ÷ stop distance, at most ${Math.floor(TRADER.maxNotional / last!)} shares`,
        }
      : null,
    qqq: stats,
    vs_today_pct: vs,
    bars_1m_last60: q1.slice(-60).map((b) => barRow(b)),
    bars_5m_today: aggregate(today, 5, openAt).map((b) => barRow(b)),
    bars_15m_5d: bySymbol(args.bars15m5d, sym).map((b) => barRow(b, true)),
    bars_1d_60: bySymbol(args.bars1d60, sym).slice(-60).map((b) => [toEt(new Date(b.ts)).date, r2(b.o), r2(b.h), r2(b.l), r2(b.c), Math.round(b.v)]),
    news_feed_ok: args.newsOk,
    headlines_since_last_call: args.headlines.map((h) => ({ et: toEt(new Date(h.ts)).hhmm, headline: h.headline, symbols: h.symbols.slice(0, 8), tags: categorize(h, args.keywords) })),
    econ_today: args.econ.length ? args.econ : "no economic calendar entries for today",
    position: args.open
      ? {
          side: args.open.side,
          qty: args.open.qty,
          entry: args.open.entryPrice,
          entry_et: etOf(args.open.entryAt),
          stop: args.open.stop,
          target: args.open.target,
          exit_by_et: args.open.entryAt ? etOf(new Date(Date.parse(args.open.entryAt) + args.open.maxHoldMinutes * 60000).toISOString()) : null,
        }
      : null,
    closed_today: args.closedToday.map((t) => ({ side: t.side, pl: r2(t.pl)!, exit_et: etOf(t.exitAt)! })),
    trades_left_today: Math.max(0, TRADER.maxTradesPerDay - args.tradesToday),
    entry_blocked: args.entryBlocked,
  };
}

/** What the bars can and cannot tell the model, by feed. */
export function dataNote(feed: Feed): string {
  return feed === "iex"
    ? "Prices and volumes come from the IEX exchange only (a few percent of US volume), not the whole market. Volumes are only comparable with each other, not with normal market volume. There is no usable bid/ask spread here: QQQ's real spread is about $0.01, so ignore spread and liquidity concerns. A minute with no IEX trade has no bar."
    : "Prices and volumes are consolidated across all US exchanges (SIP). QQQ's spread is about $0.01.";
}

export function renderUserPrompt(i: TraderInputs): string {
  const head = `Time ${i.now_et} ET (${i.phase === "premarket" ? "pre-market read: no orders are placed from this reply" : "intraday decision"}).`;
  const news = i.news_feed_ok ? "" : "\nWARNING: the news feed is DOWN for this call; headlines may be missing.";
  return `${head}${news}
Bar rows are [time ET, open, high, low, close, volume]. Returns are % from the prior close.

${JSON.stringify(i)}`;
}

/** Canonical JSON (sorted keys) for hashing. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hashInputs = (i: TraderInputs) => sha256(canonical(i));

/** Everything that defines a version: model, effort, prompt, reply schema and rules. */
export function versionSpec(model: string, effort: string) {
  // newsScreen: the headlines the model sees are screened (config/keywords.ts NEWS_SCREEN); a change is a new version.
  return { model, effort, system: TRADER_SYSTEM_PROMPT, schema: REPLY_JSON_SCHEMA, rules: TRADER, newsScreen: NEWS_SCREEN };
}
export const versionHash = (model: string, effort: string) => sha256(canonical(versionSpec(model, effort)));

/** Approximate $ cost of one call from its usage. */
export function callCost(model: string, usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  const inTok = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25;
  return Math.round(((inTok * p.input + (usage.cache_read_input_tokens ?? 0) * p.cacheRead + (usage.output_tokens ?? 0) * p.output) / 1e6) * 1e4) / 1e4;
}
