/**
 * Scoring of skip/reduce calls against the book's actual P/L. Pure.
 *
 * Counterfactual if the calls had been followed:
 *   run    -> book unchanged
 *   reduce -> half size: P/L changes by -0.5 * pl
 *   skip   -> no trade:  P/L changes by -1.0 * pl
 * "saved"   = sum of avoided losses   (pl < 0 on skip/reduce days)
 * "forgone" = sum of avoided profits  (pl > 0 on skip/reduce days)
 * net = saved - forgone (positive = following the calls would have helped).
 * Hit = a skip or reduce on a day the strategy lost money.
 */

import type { Call } from "./decision";

export interface ScoredDecision {
  date: string;
  strategy: string;
  source: string;
  call: Call | "error";
}

export interface OutcomeRow {
  date: string;
  strategy: string;
  pl: number;
}

export interface ScoreRow {
  source: string;
  strategy: string;
  days: number;
  runDays: number;
  skipDays: number;
  reduceDays: number;
  plRunDays: number;
  plSkipDays: number;
  plReduceDays: number;
  hits: number;
  hitRate: number | null;
  /** Hit rate a random pick of the same days would get on average (= share of losing days). */
  baseLossRate: number | null;
  saved: number;
  forgone: number;
  net: number;
}

const WEIGHT: Record<string, number> = { run: 0, reduce: 0.5, skip: 1 };

function emptyRow(source: string, strategy: string): ScoreRow {
  return {
    source, strategy, days: 0, runDays: 0, skipDays: 0, reduceDays: 0,
    plRunDays: 0, plSkipDays: 0, plReduceDays: 0, hits: 0, hitRate: null, baseLossRate: null,
    saved: 0, forgone: 0, net: 0,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Join decisions to outcomes on (date, strategy); only days with both count. */
export function scoreDecisions(decisions: ScoredDecision[], outcomes: OutcomeRow[]): ScoreRow[] {
  const pl = new Map(outcomes.map((o) => [`${o.date}|${o.strategy}`, o.pl]));
  const rows = new Map<string, ScoreRow>();
  const losing = new Map<string, { n: number; losses: number }>();

  for (const d of decisions) {
    if (d.call === "error") continue;
    const p = pl.get(`${d.date}|${d.strategy}`);
    if (p === undefined) continue;
    const key = `${d.source}|${d.strategy}`;
    const r = rows.get(key) ?? emptyRow(d.source, d.strategy);
    const l = losing.get(key) ?? { n: 0, losses: 0 };
    r.days++;
    l.n++;
    if (p < 0) l.losses++;
    if (d.call === "run") {
      r.runDays++;
      r.plRunDays += p;
    } else {
      if (d.call === "skip") {
        r.skipDays++;
        r.plSkipDays += p;
      } else {
        r.reduceDays++;
        r.plReduceDays += p;
      }
      if (p < 0) r.hits++;
      const delta = -WEIGHT[d.call] * p;
      if (delta > 0) r.saved += delta;
      else r.forgone += -delta;
    }
    rows.set(key, r);
    losing.set(key, l);
  }

  return [...rows.entries()]
    .map(([key, r]) => {
      const flagged = r.skipDays + r.reduceDays;
      const l = losing.get(key)!;
      return {
        ...r,
        plRunDays: round2(r.plRunDays),
        plSkipDays: round2(r.plSkipDays),
        plReduceDays: round2(r.plReduceDays),
        hitRate: flagged ? r.hits / flagged : null,
        baseLossRate: l.n ? l.losses / l.n : null,
        saved: round2(r.saved),
        forgone: round2(r.forgone),
        net: round2(r.saved - r.forgone),
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.strategy.localeCompare(b.strategy));
}

/** Deterministic PRNG (mulberry32) so the coin-flip table is stable between page loads. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CoinFlipRow {
  source: string;
  strategy: string;
  days: number;
  skipDays: number;
  reduceDays: number;
  /** Mean over simulations. */
  meanNet: number;
  meanHitRate: number | null;
  p5Net: number;
  p95Net: number;
  /** The source's actual net. */
  actualNet: number;
  /** Share of random draws whose net >= actual (one-sided p-value). */
  pValue: number;
}

/**
 * For each (source, strategy) score row: draw `sims` random assignments of the
 * same number of skip and reduce days among that row's scored days, and compare.
 */
export function coinFlipBaseline(
  decisions: ScoredDecision[],
  outcomes: OutcomeRow[],
  opts: { sims?: number; seed?: number } = {},
): CoinFlipRow[] {
  const sims = opts.sims ?? 2000;
  const pl = new Map(outcomes.map((o) => [`${o.date}|${o.strategy}`, o.pl]));
  const actual = scoreDecisions(decisions, outcomes);
  const out: CoinFlipRow[] = [];

  for (const row of actual) {
    const days = decisions
      .filter((d) => d.source === row.source && d.strategy === row.strategy && d.call !== "error")
      .map((d) => pl.get(`${d.date}|${d.strategy}`))
      .filter((p): p is number => p !== undefined);
    const rand = mulberry32((opts.seed ?? 42) ^ hash(`${row.source}|${row.strategy}`));
    const nets: number[] = [];
    let hitSum = 0;
    let atLeast = 0;
    const k = row.skipDays + row.reduceDays;
    for (let s = 0; s < sims; s++) {
      const idx = shuffle(days.map((_, i) => i), rand);
      let net = 0;
      let hits = 0;
      idx.slice(0, k).forEach((i, j) => {
        const w = j < row.skipDays ? 1 : 0.5;
        net += -w * days[i];
        if (days[i] < 0) hits++;
      });
      nets.push(net);
      if (k) hitSum += hits / k;
      if (net >= row.net - 1e-9) atLeast++;
    }
    nets.sort((a, b) => a - b);
    out.push({
      source: row.source,
      strategy: row.strategy,
      days: row.days,
      skipDays: row.skipDays,
      reduceDays: row.reduceDays,
      meanNet: round2(nets.reduce((a, b) => a + b, 0) / sims),
      meanHitRate: k ? hitSum / sims : null,
      p5Net: round2(nets[Math.floor(sims * 0.05)]),
      p95Net: round2(nets[Math.min(sims - 1, Math.floor(sims * 0.95))]),
      actualNet: row.net,
      pValue: atLeast / sims,
    });
  }
  return out;
}

function shuffle(a: number[], rand: () => number): number[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Add an "ALL" row per source summing across strategies. */
export function withTotals(rows: ScoreRow[]): ScoreRow[] {
  const bySource = new Map<string, ScoreRow>();
  for (const r of rows) {
    const t = bySource.get(r.source) ?? emptyRow(r.source, "ALL");
    t.days += r.days;
    t.runDays += r.runDays;
    t.skipDays += r.skipDays;
    t.reduceDays += r.reduceDays;
    t.plRunDays += r.plRunDays;
    t.plSkipDays += r.plSkipDays;
    t.plReduceDays += r.plReduceDays;
    t.hits += r.hits;
    t.saved += r.saved;
    t.forgone += r.forgone;
    bySource.set(r.source, t);
  }
  const totals = [...bySource.values()].map((t) => {
    const flagged = t.skipDays + t.reduceDays;
    return {
      ...t,
      plRunDays: round2(t.plRunDays),
      plSkipDays: round2(t.plSkipDays),
      plReduceDays: round2(t.plReduceDays),
      hitRate: flagged ? t.hits / flagged : null,
      saved: round2(t.saved),
      forgone: round2(t.forgone),
      net: round2(t.saved - t.forgone),
    };
  });
  return [...rows, ...totals];
}
