/**
 * Scoring for the AI trader paper test. Pure. Forward results only: inputs are
 * the version's own logged trades and the 1-minute bars recorded on those days.
 */

import { TRADER } from "@/config/trader";
import type { Bar } from "../alpaca";
import { mulberry32 } from "../scoring";
import { etToUtc, toEt } from "../time";

export interface ScoredTrade {
  id: number;
  date: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryAt: string;
  exitAt: string;
  /** stop/target as given at entry (before any tightening) */
  stop: number;
  target: number;
  maxHoldMinutes: number;
  confidence: number;
  catalyst: string;
  exitReason: string;
}

export const slippage = (qty: number) => 2 * TRADER.slippagePerShare * qty;

export function grossPl(t: { side: "long" | "short"; qty: number; entryPrice: number; exitPrice: number }): number {
  return (t.side === "long" ? 1 : -1) * (t.exitPrice - t.entryPrice) * t.qty;
}

const r2 = (x: number) => Math.round(x * 100) / 100 || 0; // no negative zero

export interface Stats {
  n: number;
  wins: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number | null;
  total: number;
  maxDrawdown: number;
}

/** Stats over a list of per-trade P/Ls, in time order. */
export function stats(pls: number[]): Stats {
  const wins = pls.filter((p) => p > 0);
  const losses = pls.filter((p) => p <= 0);
  let peak = 0;
  let eq = 0;
  let dd = 0;
  for (const p of pls) {
    eq += p;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const total = pls.reduce((a, b) => a + b, 0);
  return {
    n: pls.length,
    wins: wins.length,
    winRate: pls.length ? wins.length / pls.length : null,
    avgWin: wins.length ? r2(wins.reduce((a, b) => a + b, 0) / wins.length) : null,
    avgLoss: losses.length ? r2(losses.reduce((a, b) => a + b, 0) / losses.length) : null,
    expectancy: pls.length ? r2(total / pls.length) : null,
    total: r2(total),
    maxDrawdown: r2(dd),
  };
}

// ---------------------------------------------------------------- simulation

export interface SimResult {
  entry: number;
  exit: number;
  qty: number;
  reason: "stop" | "target" | "time" | "eod";
  gross: number;
}

/**
 * Simulate one trade on a day's regular-session 1-min bars (ascending): enter at
 * the open of the first bar at/after `entryAt`, exit on stop/target (stop first
 * if both are touched in the same bar), at the time limit, or at the flat-by time.
 */
export function simulateTrade(
  bars: Bar[],
  date: string,
  entryAt: number,
  side: "long" | "short",
  stopFrac: number,
  targetFrac: number,
  holdMinutes: number,
): SimResult | null {
  const i0 = bars.findIndex((b) => Date.parse(b.ts) >= entryAt);
  if (i0 < 0) return null;
  const entry = bars[i0].o;
  const qty = Math.floor(TRADER.notional / entry);
  if (qty < 1) return null;
  const long = side === "long";
  const stop = long ? entry * (1 - stopFrac) : entry * (1 + stopFrac);
  const target = long ? entry * (1 + targetFrac) : entry * (1 - targetFrac);
  const deadline = Math.min(Date.parse(bars[i0].ts) + holdMinutes * 60000, etToUtc(date, TRADER.flatBy).getTime());
  let exit = bars[bars.length - 1].c;
  let reason: SimResult["reason"] = "eod";
  for (let i = i0; i < bars.length; i++) {
    const b = bars[i];
    const t = Date.parse(b.ts);
    if (t >= deadline) {
      exit = b.o;
      reason = deadline < etToUtc(date, TRADER.flatBy).getTime() ? "time" : "eod";
      break;
    }
    const hitStop = long ? b.l <= stop : b.h >= stop;
    const hitTarget = long ? b.h >= target : b.l <= target;
    if (hitStop) {
      exit = stop;
      reason = "stop";
      break;
    }
    if (hitTarget) {
      exit = target;
      reason = "target";
      break;
    }
  }
  return { entry, exit, qty, reason, gross: r2((long ? 1 : -1) * (exit - entry) * qty) };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Random-entry baseline: for each real trade, `perTrade` simulated trades on the
 * same day, random entry minute in [first entry, last entry], random direction,
 * the real trade's stop distance, target distance and time limit. Net of slippage.
 * Then `histories` random histories (one sim per real trade each) give a
 * distribution of expectancy; returns where the real net expectancy sits in it.
 */
export function randomBaseline(
  trades: ScoredTrade[],
  barsByDate: Map<string, Bar[]>,
  opts: { perTrade?: number; histories?: number; seed?: number } = {},
): { simsPerTrade: number[][]; expectancies: number[]; percentile: number | null; mean: number | null; p95: number | null } {
  const perTrade = opts.perTrade ?? TRADER.randomSimsPerTrade;
  const simsPerTrade: number[][] = [];
  for (const t of trades) {
    const bars = barsByDate.get(t.date) ?? [];
    const rand = mulberry32((opts.seed ?? 7) ^ hash(`trade-${t.id}`));
    const from = etToUtc(t.date, TRADER.firstEntry).getTime();
    const to = etToUtc(t.date, TRADER.lastEntry).getTime();
    const minutes = Math.floor((to - from) / 60000);
    const stopFrac = Math.abs(t.entryPrice - t.stop) / t.entryPrice;
    const targetFrac = Math.abs(t.target - t.entryPrice) / t.entryPrice;
    const sims: number[] = [];
    for (let k = 0; k < perTrade && bars.length; k++) {
      const at = from + Math.floor(rand() * (minutes + 1)) * 60000;
      const side = rand() < 0.5 ? "long" : "short";
      const s = simulateTrade(bars, t.date, at, side, stopFrac, targetFrac, t.maxHoldMinutes);
      if (s) sims.push(r2(s.gross - slippage(s.qty)));
    }
    simsPerTrade.push(sims);
  }
  const usable = simsPerTrade.filter((s) => s.length);
  if (!usable.length) return { simsPerTrade, expectancies: [], percentile: null, mean: null, p95: null };

  const histories = opts.histories ?? 2000;
  const rand = mulberry32(opts.seed ?? 11);
  const expectancies: number[] = [];
  for (let h = 0; h < histories; h++) {
    let sum = 0;
    for (const s of usable) sum += s[Math.floor(rand() * s.length)];
    expectancies.push(sum / usable.length);
  }
  expectancies.sort((a, b) => a - b);
  const real = trades.filter((_, i) => simsPerTrade[i].length).map((t) => grossPl(t) - slippage(t.qty));
  const realExp = real.reduce((a, b) => a + b, 0) / real.length;
  const below = expectancies.filter((e) => e < realExp).length;
  return {
    simsPerTrade,
    expectancies,
    percentile: below / expectancies.length,
    mean: r2(expectancies.reduce((a, b) => a + b, 0) / expectancies.length),
    p95: r2(expectancies[Math.floor(expectancies.length * TRADER.gatePercentile)]),
  };
}

/** Buy and hold QQQ open→close on each day, same notional; gross and net of slippage. */
export function buyAndHold(barsByDate: Map<string, Bar[]>, dates: string[]): Array<{ date: string; gross: number; net: number }> {
  const out: Array<{ date: string; gross: number; net: number }> = [];
  for (const d of dates) {
    const bars = barsByDate.get(d);
    if (!bars?.length) continue;
    const open = bars[0].o;
    const close = bars[bars.length - 1].c;
    const qty = Math.floor(TRADER.notional / open);
    const gross = r2((close - open) * qty);
    out.push({ date: d, gross, net: r2(gross - slippage(qty)) });
  }
  return out;
}

/** Return per unit of drawdown; the drawdown floor (1% of notional) avoids dividing by ~0. */
export const ddAdjusted = (total: number, maxDrawdown: number) => total / Math.max(maxDrawdown, 0.01 * TRADER.notional);

// ---------------------------------------------------------------- breakdowns

export function confidenceBucket(c: number): string {
  if (c < 50) return "<50";
  if (c < 65) return "50–64";
  if (c < 80) return "65–79";
  return "80–100";
}

export function timeBucket(entryAt: string): string {
  const m = toEt(new Date(entryAt)).minutes;
  if (m < 10 * 60 + 30) return "09:35–10:29";
  if (m < 12 * 60) return "10:30–11:59";
  if (m < 14 * 60) return "12:00–13:59";
  return "14:00–15:30";
}

export function breakdown(trades: ScoredTrade[], key: (t: ScoredTrade) => string): Array<{ key: string; net: Stats }> {
  const groups = new Map<string, number[]>();
  for (const t of trades) {
    const k = key(t);
    groups.set(k, [...(groups.get(k) ?? []), grossPl(t) - slippage(t.qty)]);
  }
  return [...groups.entries()].map(([k, pls]) => ({ key: k, net: stats(pls) })).sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------- gate

export interface GateResult {
  ready: boolean;
  verdict: "pass" | "fail" | null;
  checks: Array<{ label: string; ok: boolean | null; detail: string }>;
}

export function decisionGate(args: {
  trades: number;
  tradingDays: number;
  netExpectancy: number | null;
  percentile: number | null;
  strategyTotal: number;
  strategyMaxDd: number;
  bhTotal: number;
  bhMaxDd: number;
}): GateResult {
  const ready = args.trades >= TRADER.gateMinTrades && args.tradingDays >= TRADER.gateMinTradingDays;
  const stratDd = ddAdjusted(args.strategyTotal, args.strategyMaxDd);
  const bhDd = ddAdjusted(args.bhTotal, args.bhMaxDd);
  const checks = [
    { label: "Net expectancy > 0", ok: args.netExpectancy === null ? null : args.netExpectancy > 0, detail: args.netExpectancy === null ? "no trades" : `$${args.netExpectancy.toFixed(2)} per trade` },
    {
      label: `Above the ${TRADER.gatePercentile * 100}th percentile of random entries`,
      ok: args.percentile === null ? null : args.percentile > TRADER.gatePercentile,
      detail: args.percentile === null ? "no baseline yet" : `at the ${(args.percentile * 100).toFixed(1)}th percentile`,
    },
    {
      label: "Beats buy and hold, drawdown-adjusted",
      ok: stratDd > bhDd,
      detail: `net P/L ÷ max drawdown: ${stratDd.toFixed(2)} vs buy and hold ${bhDd.toFixed(2)}`,
    },
  ];
  return {
    ready,
    verdict: ready ? (checks.every((c) => c.ok === true) ? "pass" : "fail") : null,
    checks,
  };
}
