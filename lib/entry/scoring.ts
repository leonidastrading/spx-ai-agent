/**
 * Entry advisor scoring. Pure. Forward results only: each scored row is a
 * logged call (on time, data_ok, not no_opinion) joined to the trade's actual
 * P/L. take = 100%, reduce = 50%, skip = 0%.
 */

import { DAY_TYPE_RULES, ENTRY } from "@/config/entry";
import { mulberry32 } from "../scoring";
import { etToUtc, hhmmToMinutes, toEt } from "../time";

export type Verdict = "take" | "reduce" | "skip";
export const WEIGHT: Record<Verdict, number> = { take: 1, reduce: ENTRY.reduceFraction, skip: 0 };

export interface ScoredCall {
  entryId: string;
  date: string;
  bot: string;
  filledAt: string;
  verdict: Verdict;
  confidence: number;
  dayType: string;
  categories: string[];
  /** The category of the first (leading) reason: what drove the call. */
  driver?: string | null;
  /** VIX % change on the day at the entry (for the simple-rule baseline). */
  vixChangePct: number | null;
  pl: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100 || 0;

export interface BookStats {
  trades: number;
  total: number;
  maxDrawdown: number;
  worstDay: { date: string; pl: number } | null;
}

/** Totals over per-trade P/Ls already weighted; drawdown and worst day on daily sums. */
export function bookStats(rows: Array<{ date: string; pl: number; counted: boolean }>): BookStats {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.pl);
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const [, pl] of days) {
    eq += pl;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const worst = days.length ? days.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
  return {
    trades: rows.filter((r) => r.counted).length,
    total: r2(rows.reduce((a, r) => a + r.pl, 0)),
    maxDrawdown: r2(dd),
    worstDay: worst ? { date: worst[0], pl: r2(worst[1]) } : null,
  };
}

export const asRun = (calls: ScoredCall[]) => bookStats(calls.map((c) => ({ date: c.date, pl: c.pl, counted: true })));
export const withWeights = (calls: ScoredCall[], weight: (c: ScoredCall) => number) =>
  bookStats(calls.map((c) => ({ date: c.date, pl: c.pl * weight(c), counted: weight(c) > 0 })));
export const asAdvised = (calls: ScoredCall[]) => withWeights(calls, (c) => WEIGHT[c.verdict]);

/** Losses avoided and winners given up by skip/reduce calls (both positive numbers). */
export function savedVsMissed(calls: ScoredCall[]) {
  let saved = 0;
  let missed = 0;
  for (const c of calls) {
    const cut = 1 - WEIGHT[c.verdict];
    if (cut === 0) continue;
    if (c.pl < 0) saved += -c.pl * cut;
    else missed += c.pl * cut;
  }
  return { saved: r2(saved), missed: r2(missed), net: r2(saved - missed) };
}

/**
 * Random-skip baseline: shuffle the same verdicts across the same trades,
 * within each bot (so each bot keeps its number of skips and reduces).
 * Returns where the advised total sits among the shuffled totals.
 */
export function randomSkipBaseline(calls: ScoredCall[], n = ENTRY.randomPermutations, seed = 13) {
  if (!calls.length) return { percentile: null, mean: null, p95: null };
  const rand = mulberry32(seed);
  const byBot = new Map<string, ScoredCall[]>();
  for (const c of calls) byBot.set(c.bot, [...(byBot.get(c.bot) ?? []), c]);
  const totals: number[] = [];
  for (let k = 0; k < n; k++) {
    let total = 0;
    for (const group of byBot.values()) {
      const v = group.map((c) => c.verdict);
      for (let i = v.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [v[i], v[j]] = [v[j], v[i]];
      }
      group.forEach((c, i) => (total += c.pl * WEIGHT[v[i]]));
    }
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  const advised = calls.reduce((a, c) => a + c.pl * WEIGHT[c.verdict], 0);
  return {
    percentile: totals.length ? totals.filter((t) => t < advised - 1e-9).length / totals.length : null,
    mean: totals.length ? r2(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
    p95: totals.length ? r2(totals[Math.floor(totals.length * ENTRY.gatePercentile)]) : null,
  };
}

/** One-line rule: reduce everything when VIX is up more than 10% on the day at the entry. */
export const simpleRule = (calls: ScoredCall[]) =>
  withWeights(calls, (c) => (c.vixChangePct !== null && c.vixChangePct > ENTRY.ruleVixUpPct ? ENTRY.reduceFraction : 1));

export interface Bucket {
  key: string;
  n: number;
  avgPl: number | null;
  totalPl: number;
}

export function bucketBy(calls: ScoredCall[], key: (c: ScoredCall) => string | string[]): Bucket[] {
  const m = new Map<string, number[]>();
  for (const c of calls) for (const k of [key(c)].flat()) m.set(k, [...(m.get(k) ?? []), c.pl]);
  return [...m.entries()]
    .map(([k, pls]) => ({ key: k, n: pls.length, avgPl: pls.length ? r2(pls.reduce((a, b) => a + b, 0) / pls.length) : null, totalPl: r2(pls.reduce((a, b) => a + b, 0)) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function confidenceBand(c: number): string {
  const b = ENTRY.confidenceBands;
  for (let i = 0; i < b.length - 1; i++) if (c >= b[i] && c < b[i + 1]) return `${b[i]}–${Math.min(b[i + 1] - 1, 100)}`;
  return "?";
}

export const hourBucket = (iso: string) => `${toEt(new Date(iso)).hhmm.slice(0, 2)}:00`;

// ---------------------------------------------------------------- day types

/**
 * The day's actual type from SPY regular-session 1-min bars and VIX closes,
 * per the fixed definitions in config/entry.ts (DAY_TYPE_RULES).
 */
export function actualDayType(date: string, spy1m: Array<{ t: string; o: number; h: number; l: number; c: number }>, vixClose: number | null, vixPrevClose: number | null): string | null {
  const bars = spy1m.filter((b) => Date.parse(b.t) >= etToUtc(date, "09:30").getTime() && Date.parse(b.t) < etToUtc(date, "16:00").getTime()).sort((a, b) => a.t.localeCompare(b.t));
  if (bars.length < 300) return null; // incomplete day
  const o = bars[0].o;
  const c = bars[bars.length - 1].c;
  const h = Math.max(...bars.map((b) => b.h));
  const l = Math.min(...bars.map((b) => b.l));
  const rangePct = ((h - l) / o) * 100;
  const movePct = ((c - o) / o) * 100;
  const posInRange = h > l ? (c - l) / (h - l) : 0.5;
  const R = DAY_TYPE_RULES;
  if (vixClose !== null && vixPrevClose && (vixClose / vixPrevClose - 1) * 100 >= R.volVixUpPct && rangePct >= R.volRangePct) return "vol_expansion";
  if (movePct >= R.trendPct && posInRange >= 1 - R.trendCloseQuartile) return "trend_up";
  if (movePct <= -R.trendPct && posInRange <= R.trendCloseQuartile) return "trend_down";
  const noon = bars.filter((b) => Date.parse(b.t) < etToUtc(date, R.reversalCheckpoint).getTime()).at(-1);
  if (noon) {
    const morning = ((noon.c - o) / o) * 100;
    if (Math.abs(morning) >= R.reversalMorningPct && Math.sign(c - o) === -Math.sign(morning) && c !== o) return "reversal";
  }
  return "range";
}

export function dayTypeAccuracy(calls: Array<{ date: string; dayType: string }>, actual: Map<string, string | null>) {
  const known = calls.filter((c) => actual.get(c.date));
  const decided = known.filter((c) => c.dayType !== "unclear");
  const hits = known.filter((c) => c.dayType === actual.get(c.date)).length;
  return {
    n: known.length,
    accuracy: known.length ? hits / known.length : null,
    nWithoutUnclear: decided.length,
    accuracyWithoutUnclear: decided.length ? decided.filter((c) => c.dayType === actual.get(c.date)).length / decided.length : null,
  };
}

// ---------------------------------------------------------------- comparisons

/** Vadim's pre-open call as a weight on an entry. */
export function humanWeight(call: "normal" | "half" | "skip_afternoon" | undefined, filledAt: string): number {
  if (!call || call === "normal") return 1;
  if (call === "half") return ENTRY.reduceFraction;
  return toEt(new Date(filledAt)).minutes >= hhmmToMinutes(ENTRY.afternoonFrom) ? 0 : 1;
}

/** The Book advisor's morning call (run/reduce/skip per strategy) as a weight, if it was made before the entry. */
export function morningWeight(call: { call: string; decidedAt: string } | undefined, filledAt: string): number {
  if (!call || Date.parse(call.decidedAt) > Date.parse(filledAt)) return 1;
  return call.call === "skip" ? 0 : call.call === "reduce" ? ENTRY.reduceFraction : 1;
}

// ---------------------------------------------------------------- gate

export function entryGate(args: { scored: number; tradingDays: number; run: BookStats; advised: BookStats; percentile: number | null }) {
  const ready = args.scored >= ENTRY.gateMinEntries && args.tradingDays >= ENTRY.gateMinTradingDays;
  const any = args.scored > 0;
  const checks = [
    { label: "Advised book made more than the book as run", ok: any ? args.advised.total > args.run.total : null, detail: any ? `$${args.advised.total} vs $${args.run.total}` : "no scored entries yet" },
    { label: "Advised book had a smaller max drawdown", ok: any ? args.advised.maxDrawdown < args.run.maxDrawdown : null, detail: any ? `$${args.advised.maxDrawdown} vs $${args.run.maxDrawdown}` : "no scored entries yet" },
    {
      label: `Above the ${ENTRY.gatePercentile * 100}th percentile of random skips`,
      ok: args.percentile === null ? null : args.percentile > ENTRY.gatePercentile,
      detail: args.percentile === null ? "no data" : `${(args.percentile * 100).toFixed(1)}th percentile`,
    },
  ];
  return { ready, verdict: ready ? (checks.every((c) => c.ok === true) ? ("pass" as const) : ("fail" as const)) : null, checks };
}

/** Groups for "what drove a reduce/skip": the bot's own recent results vs the market vs anything else. */
export const DRIVER_GROUPS = [
  { key: "bot_record", label: "Bot's recent record (bot_record)", cats: ["bot_record"] },
  { key: "market", label: "Market: price / vol / news", cats: ["price", "vol", "news"] },
  { key: "other", label: "Other: calendar / book / data", cats: ["calendar", "book", "data"] },
] as const;

export interface DriverRow {
  key: string;
  label: string;
  n: number;
  reduce: number;
  skip: number;
  /** Average actual (as-run) P/L of these trades: negative means the cut trades were losers on average. */
  avgPl: number | null;
  saved: number;
  missed: number;
  net: number;
}

/**
 * Reduce/skip calls split by the category of their leading reason, so calls based on the bot's recent losses can be
 * compared with calls based on price, vol or news. Each row: how many, their average actual P/L, and what cutting
 * them saved (losers) and missed (winners).
 */
export function reasonSplit(calls: ScoredCall[]): DriverRow[] {
  const cut = calls.filter((c) => c.verdict !== "take");
  return DRIVER_GROUPS.map((g) => {
    const xs = cut.filter((c) => (g.cats as readonly string[]).includes(c.driver ?? c.categories[0] ?? "other"));
    const sm = savedVsMissed(xs);
    return {
      key: g.key,
      label: g.label,
      n: xs.length,
      reduce: xs.filter((c) => c.verdict === "reduce").length,
      skip: xs.filter((c) => c.verdict === "skip").length,
      avgPl: xs.length ? r2(xs.reduce((a, c) => a + c.pl, 0) / xs.length) : null,
      ...sm,
    };
  });
}
