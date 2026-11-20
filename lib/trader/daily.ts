/**
 * Day-by-day results of the AI trader, for the trader page. Pure.
 * Gross P/L comes from fills; net subtracts the assumed slippage each way (as on the scoring page);
 * the LLM cost is the day's model spend, shown beside the trading result.
 */

import { grossPl, slippage } from "./scoring";

export interface DailyTrade {
  id: number;
  versionId: number;
  date: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number | null;
  exitPrice: number | null;
  status: string;
}

export interface DayResult {
  date: string;
  /** Version ids that traded or made decisions that day, ascending. */
  versionIds: number[];
  /** Trades with an entry fill. */
  filled: number;
  /** Filled trades that have also exited (P/L is counted for these only). */
  closed: number;
  wins: number;
  losses: number;
  gross: number;
  net: number;
  llmCost: number;
  trades: DailyTrade[];
}

export interface DailyTotals {
  days: number;
  tradingDays: number;
  filled: number;
  closed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  gross: number;
  net: number;
  llmCost: number;
  bestDay: { date: string; net: number } | null;
  worstDay: { date: string; net: number } | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100 || 0; // no negative zero

/**
 * One row per date that had a trade or an LLM cost, newest first, plus totals over every row.
 * `costs` is the LLM spend per date (and version, if known).
 */
export function dailyResults(
  trades: DailyTrade[],
  costs: Array<{ date: string; cost: number; versionId?: number }>,
): { days: DayResult[]; totals: DailyTotals } {
  const byDate = new Map<string, DayResult>();
  const day = (date: string) => {
    let d = byDate.get(date);
    if (!d) {
      d = { date, versionIds: [], filled: 0, closed: 0, wins: 0, losses: 0, gross: 0, net: 0, llmCost: 0, trades: [] };
      byDate.set(date, d);
    }
    return d;
  };
  const addVersion = (d: DayResult, v: number | undefined) => {
    if (v !== undefined && !d.versionIds.includes(v)) d.versionIds.push(v);
  };

  for (const t of [...trades].sort((a, b) => a.id - b.id)) {
    const d = day(t.date);
    d.trades.push(t);
    addVersion(d, t.versionId);
    if (t.entryPrice === null) continue;
    d.filled++;
    if (t.exitPrice === null) continue;
    d.closed++;
    const g = grossPl({ side: t.side, qty: t.qty, entryPrice: t.entryPrice, exitPrice: t.exitPrice });
    d.gross += g;
    d.net += g - slippage(t.qty);
    if (g > 0) d.wins++;
    else if (g < 0) d.losses++;
  }
  for (const c of costs) {
    if (!(c.cost > 0)) continue;
    const d = day(c.date);
    d.llmCost += c.cost;
    addVersion(d, c.versionId);
  }

  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  for (const d of days) {
    d.versionIds.sort((a, b) => a - b);
    d.gross = r2(d.gross);
    d.net = r2(d.net);
    d.llmCost = r2(d.llmCost);
  }

  const traded = days.filter((d) => d.closed > 0);
  const sum = (f: (d: DayResult) => number) => days.reduce((a, d) => a + f(d), 0);
  const wins = sum((d) => d.wins);
  const losses = sum((d) => d.losses);
  const closed = sum((d) => d.closed);
  const pick = (better: (a: number, b: number) => boolean) =>
    traded.reduce<{ date: string; net: number } | null>((m, d) => (m === null || better(d.net, m.net) ? { date: d.date, net: d.net } : m), null);

  return {
    days,
    totals: {
      days: days.length,
      tradingDays: traded.length,
      filled: sum((d) => d.filled),
      closed,
      wins,
      losses,
      winRate: closed ? wins / closed : null,
      gross: r2(sum((d) => d.gross)),
      net: r2(sum((d) => d.net)),
      llmCost: r2(sum((d) => d.llmCost)),
      bestDay: pick((a, b) => a > b),
      worstDay: pick((a, b) => a < b),
    },
  };
}
