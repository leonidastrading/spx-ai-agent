/**
 * The per-entry packet. Pure. Rule: everything in it carries a timestamp at or
 * before the entry's fill time — bars that had closed, headlines published,
 * the latest quote/book snapshot taken at or before the fill. What's missing is
 * named in `health` so the model is told.
 */

import { createHash } from "node:crypto";
import { ENTRY } from "@/config/entry";
import { categorize, type Headline, type KeywordConfig } from "../news";
import { addDays, etToUtc, toEt } from "../time";
import type { OoEntry, OoExport } from "./contract";

type Bar = { t: string; o: number; h: number; l: number; c: number; v?: number };
export interface RelBars {
  /** Daily bars (prior sessions) and today's 1-min bars per symbol, from Alpaca. */
  daily: Record<string, Bar[]>;
  intraday: Record<string, Bar[]>;
}

export interface BookSnapshot {
  asOf: string;
  book: OoExport["book"];
}

export interface PacketInput {
  entry: OoEntry;
  exp: OoExport;
  /** Book snapshots this app stored on earlier polls (any order). */
  bookSnapshots: BookSnapshot[];
  rel: RelBars;
  headlines: Headline[];
  headlinesSince: string;
  newsFeedOk: boolean;
  newsSummary10d: { text: string; asOf: string } | null;
  econToday: Array<{ time_et: string; event: string }>;
  nextFed: string | null;
  morningCall: { call: string; reason: string; decidedAt: string } | null;
  keywords: KeywordConfig;
  /** Schwab net liquidation value at or before the fill, and its high since ENTRY.drawdownSince (v2). */
  nlv?: { current: { at: string; netLiq: number } | null; high: { at: string; netLiq: number } | null };
}

const r2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || b === 0 ? null : r2((a / b - 1) * 100));
const before = (iso: string, ms: number) => Date.parse(iso) <= ms;
/** A bar of `minutes` length that started at t has closed by `ms`. */
const closedBy = (b: Bar, minutes: number, ms: number) => Date.parse(b.t) + minutes * 60000 <= ms;

/** Index option expirations on a date (SPX/SPXW only; others not tracked). */
export function expirationsOn(date: string): string[] {
  const out = ["SPXW 0DTE (daily)"];
  const d = new Date(`${date}T12:00:00Z`);
  const dom = d.getUTCDate();
  if (d.getUTCDay() === 5 && dom >= 15 && dom <= 21) out.push("SPX monthly (AM-settled, third Friday)");
  // Last weekday of a quarter-end month (holidays not considered).
  let next = addDays(date, 1);
  while ([0, 6].includes(new Date(`${next}T12:00:00Z`).getUTCDay())) next = addDays(next, 1);
  if (next.slice(5, 7) !== date.slice(5, 7) && ["03", "06", "09", "12"].includes(date.slice(5, 7))) out.push("quarter-end SPX (PM)");
  return out;
}

export interface Packet {
  entry_time_et: string;
  trade: Record<string, unknown>;
  bot_record: unknown;
  book: unknown;
  market: Record<string, unknown>;
  calendar: Record<string, unknown>;
  news: Record<string, unknown>;
  sentiment: unknown;
  morning_call: unknown;
  health: { quote_age_s: number | null; missing: string[]; news_feed_ok: boolean; notes: string[] };
}

/** Required blocks: if any is missing the call is recorded as no_opinion whatever the model says. */
export const REQUIRED_BLOCKS = ["trade", "bot_record", "book", "spx_bars", "vix"] as const;

export function buildPacket(p: PacketInput): { packet: Packet; complete: boolean } {
  const { entry, exp } = p;
  const at = Date.parse(entry.filledAt);
  const et = toEt(new Date(at));
  const date = et.date;
  const missing: string[] = [];
  const notes: string[] = [];

  // ---- trade
  const spxSnap = [...exp.market.snapshots].filter((s) => before(s.at, at)).sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
  const spot = spxSnap?.spx ?? null;
  const shorts = entry.legs.filter((l) => l.qty < 0);
  const trade = {
    bot: entry.bot,
    structure: entry.structure,
    underlying: entry.underlying,
    legs: entry.legs,
    expiration: [...new Set(entry.legs.map((l) => l.expiration))],
    net_price: entry.netPrice,
    credit_or_debit: entry.netPrice >= 0 ? "credit" : "debit",
    contracts: entry.contracts,
    short_strikes_from_spot: spot
      ? shorts.map((l) => ({ strike: l.strike, type: l.putCall, points: r2(l.strike - spot), pct: pct(l.strike, spot) }))
      : null,
    stop_rule: entry.rules.stop,
    target_rule: entry.rules.target,
    bot_match: { confidence: entry.matchConfidence, reason: entry.matchReason },
  };

  // ---- bot record (prior days only)
  const rec = entry.bot ? exp.bots[entry.bot] : undefined;
  if (!rec) missing.push("bot_record");
  const vixAtEntry = spxSnap?.vix ?? null;
  const bucket = vixAtEntry === null ? null : vixAtEntry < 15 ? "<15" : vixAtEntry < 20 ? "15-20" : vixAtEntry < 25 ? "20-25" : vixAtEntry < 30 ? "25-30" : "30+";
  const hhmm = et.hhmm;
  const bot_record = rec
    ? {
        last_10_days: rec.last10Days.filter((d) => d.date < date),
        backtest_this_entry_time: rec.backtest.byEntryTime.find((b) => b.time === hhmm) ?? rec.backtest.byEntryTime,
        backtest_vix_bucket: bucket ? rec.backtest.byVixBucket.find((b) => b.bucket === bucket) ?? null : null,
        vix_bucket: bucket,
        live_vs_backtest: rec.liveVsBacktest,
        units: "backtest avgPl is $ per contract; live P/L is $ for the whole position",
      }
    : null;

  // ---- book: the latest snapshot taken at or before the fill
  const snap = p.bookSnapshots.filter((s) => before(s.asOf, at)).sort((a, b) => a.asOf.localeCompare(b.asOf)).at(-1) ?? null;
  if (!snap || at - Date.parse(snap.asOf) > ENTRY.lateAfterSeconds * 1000) missing.push("book");
  const book = snap
    ? {
        as_of_et: toEt(new Date(snap.asOf)).hhmm,
        today: snap.book.today.filter((t) => t.entryId !== entry.id && Date.parse(t.filledAt) < at),
        today_total: snap.book.todayTotal,
        stopped_out_today: snap.book.stoppedOutBots,
        daily_last_10: snap.book.daily.filter((d) => d.date < date).slice(-10),
        account_drawdown: accountDrawdown(p.nlv, at),
        units: "$; account_drawdown.drawdown is <= 0 (0 = at the high)",
      }
    : null;
  if (book && typeof book.account_drawdown === "string") notes.push(book.account_drawdown);

  // ---- market
  const sessionOpen = etToUtc(date, "09:30").getTime();
  const spx1 = exp.market.spxBars1m.filter((b) => closedBy(b, 1, at) && Date.parse(b.t) >= sessionOpen).sort((a, b) => a.t.localeCompare(b.t));
  if (spx1.length === 0 && at > sessionOpen + 60000) missing.push("spx_bars");
  const lastClosed = Math.floor(at / 60000) * 60000 - 60000;
  const gap: string[] = [];
  for (let t = Math.max(sessionOpen, lastClosed - 14 * 60000); t <= lastClosed && at > sessionOpen + 60000; t += 60000) if (!spx1.some((b) => Date.parse(b.t) === t)) gap.push(toEt(new Date(t)).hhmm);
  if (gap.length) notes.push(`SPX 1-min bars missing at ${gap.slice(0, 5).join(", ")}`);
  const daily = exp.market.spxDaily60.filter((b) => b.t.slice(0, 10) < date || Date.parse(b.t) + 86400000 <= at).slice(-60);
  const prevClose = exp.market.spx.prevClose ?? daily.at(-1)?.c ?? null;
  const open = spx1[0]?.o ?? null;
  const hi = spx1.length ? Math.max(...spx1.map((b) => b.h)) : null;
  const lo = spx1.length ? Math.min(...spx1.map((b) => b.l)) : null;
  const last = spot ?? spx1.at(-1)?.c ?? null;
  const or = spx1.filter((b) => Date.parse(b.t) < sessionOpen + 30 * 60000);
  const spy = (p.rel.intraday.SPY ?? []).filter((b) => closedBy(b, 1, at) && Date.parse(b.t) >= sessionOpen);
  const spyVol = spy.reduce((a, b) => a + (b.v ?? 0), 0);
  const spyVwap = spyVol ? spy.reduce((a, b) => a + ((b.h + b.l + b.c) / 3) * (b.v ?? 0), 0) / spyVol : null;
  const spyLast = spy.at(-1)?.c ?? null;

  const vixQ = exp.market.vix;
  const vixNow = spxSnap?.vix ?? null;
  if (vixNow === null) missing.push("vix");
  const vix9dNow = spxSnap?.vix9d ?? null;
  const vixDaily = exp.market.vixDaily15.filter((b) => b.t.slice(0, 10) < date);
  const vix9dDaily = exp.market.vix9dDaily15.filter((b) => b.t.slice(0, 10) < date);
  const quoteAge = spxSnap ? Math.round((at - Date.parse(spxSnap.at)) / 1000) : null;
  if (quoteAge === null) notes.push("no quote snapshot at or before the entry");
  else if (quoteAge > ENTRY.maxQuoteAgeSeconds) notes.push(`latest quote before the entry is ${quoteAge}s old (limit ${ENTRY.maxQuoteAgeSeconds}s)`);

  const g = exp.market.gauge;
  const gaugeOk = g.today?.capturedAt && before(g.today.capturedAt, at) && g.today.straddle;
  const moveSoFar = gaugeOk && last !== null && g.today!.strike !== null ? Math.abs(last - g.today!.strike!) : null;

  const rel = (sym: string) => {
    const d = (p.rel.daily[sym] ?? []).filter((b) => b.t.slice(0, 10) < date);
    const intr = (p.rel.intraday[sym] ?? []).filter((b) => closedBy(b, 1, at));
    const now = intr.at(-1)?.c ?? null;
    return { today_pct: pct(now, d.at(-1)?.c), d10_pct: pct(now, d.at(-10)?.c) };
  };
  const relSyms = ["SPY", "QQQ", "IWM", "TLT", "RSP"].map((s) => [s, rel(s)] as const);
  const relObj = Object.fromEntries(relSyms);
  const spyRel = relObj.SPY;
  const market = {
    spx: {
      last: r2(last),
      open: r2(open),
      high: r2(hi),
      low: r2(lo),
      prior_close: r2(prevClose),
      overnight_gap_pct: pct(open, prevClose),
      change_pct: pct(last, prevClose),
      position_in_range: hi !== null && lo !== null && last !== null ? (hi > lo ? r2((last - lo) / (hi - lo)) : 0.5) : null,
      opening_range_30m: or.length ? { high: r2(Math.max(...or.map((b) => b.h))), low: r2(Math.min(...or.map((b) => b.l))) } : null,
      spy_vwap: r2(spyVwap),
      spy_vs_vwap_pct: pct(spyLast, spyVwap),
      bars_1m_today: spx1.map((b) => [toEt(new Date(b.t)).hhmm, r2(b.o), r2(b.h), r2(b.l), r2(b.c)]),
      bars_5m_5d: exp.market.spxBars5m5d.filter((b) => closedBy(b, 5, at)).map((b) => [`${toEt(new Date(b.t)).date.slice(5)} ${toEt(new Date(b.t)).hhmm}`, r2(b.o), r2(b.h), r2(b.l), r2(b.c)]),
      daily_60: daily.map((b) => [b.t.slice(0, 10), r2(b.o), r2(b.h), r2(b.l), r2(b.c)]),
    },
    vol: {
      vix: r2(vixNow),
      vix_change_today_pct: pct(vixNow, vixQ.prevClose ?? vixDaily.at(-1)?.c),
      vix_change_10d_pct: pct(vixNow, vixDaily.at(-10)?.c),
      vix9d: r2(vix9dNow),
      vix9d_change_today_pct: pct(vix9dNow, exp.market.vix9d?.prevClose ?? vix9dDaily.at(-1)?.c),
      vix9d_change_10d_pct: pct(vix9dNow, vix9dDaily.at(-10)?.c),
      vix9d_over_vix: vixNow && vix9dNow ? r2(vix9dNow / vixNow) : null,
      straddle_10am: gaugeOk ? { straddle: g.today!.straddle, strike: g.today!.strike, move_so_far: r2(moveSoFar), move_over_straddle: moveSoFar !== null ? r2(moveSoFar / g.today!.straddle!) : null } : "not captured before this entry",
      avg_move_over_straddle_10d: g.avgMoveRatio10d,
    },
    relative: { ...relObj, spy_minus: Object.fromEntries(relSyms.filter(([s]) => s !== "SPY").map(([s, v]) => [s, { today: v.today_pct !== null && spyRel.today_pct !== null ? r2(spyRel.today_pct - v.today_pct) : null, d10: v.d10_pct !== null && spyRel.d10_pct !== null ? r2(spyRel.d10_pct - v.d10_pct) : null }])) },
  };
  if (!vix9dNow) notes.push("VIX9D unavailable");
  if (!gaugeOk) notes.push("today's 10:00 straddle not captured before this entry");

  // ---- calendar
  const calendar = {
    econ_today: p.econToday.map((e) => ({ ...e, happened: e.time_et <= hhmm })),
    econ_calendar_note: p.econToday.length ? "entered by hand" : "no releases entered for today (calendar is entered by hand)",
    next_fed: p.nextFed ?? "not entered",
    index_option_expirations_today: expirationsOn(date),
    megacap_earnings: "MISSING: no earnings-calendar source",
  };

  // ---- news
  const heads = p.headlines.filter((h) => before(h.ts, at));
  const news = {
    since_et: toEt(new Date(p.headlinesSince)).hhmm,
    headlines: heads.map((h) => ({ et: toEt(new Date(h.ts)).hhmm, headline: h.headline, tags: categorize(h, p.keywords) })),
    summary_10d: p.newsSummary10d && before(p.newsSummary10d.asOf, at) ? p.newsSummary10d.text : "not available",
  };
  if (!p.newsFeedOk) notes.push("news feed DOWN: headlines may be missing");

  const packet: Packet = {
    entry_time_et: `${date} ${et.hhmm}:${String(et.second).padStart(2, "0")}`,
    trade,
    bot_record,
    book,
    market,
    calendar,
    news,
    sentiment: "MISSING: no Stocktwits source",
    morning_call: p.morningCall && before(p.morningCall.decidedAt, at) ? p.morningCall : "no morning call for this bot before this entry (it is made at 10:50 ET)",
    health: { quote_age_s: quoteAge, missing, news_feed_ok: p.newsFeedOk, notes },
  };
  return { packet, complete: missing.length === 0 };
}

/** Drawdown from Schwab net liquidation value against its high since ENTRY.drawdownSince, both at or before the fill. */
export function accountDrawdown(nlv: PacketInput["nlv"], at: number) {
  const cur = nlv?.current && before(nlv.current.at, at) ? nlv.current : null;
  const high = nlv?.high && before(nlv.high.at, at) ? nlv.high : null;
  if (!cur || !high) return "account drawdown unavailable: no Schwab net liquidation value from oo-trading yet";
  const hi = Math.max(high.netLiq, cur.netLiq);
  return {
    net_liq: r2(cur.netLiq),
    net_liq_as_of_et: `${toEt(new Date(cur.at)).date} ${toEt(new Date(cur.at)).hhmm}`,
    high_since: ENTRY.drawdownSince,
    high: r2(hi),
    high_date: hi === cur.netLiq ? toEt(new Date(cur.at)).date : toEt(new Date(high.at)).date,
    drawdown: r2(cur.netLiq - hi),
    drawdown_pct: pct(cur.netLiq, hi),
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const packetHash = (p: Packet) => sha256(canonical(p));
export const canonicalJson = canonical;
