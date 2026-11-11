/** Per-version results: loads the version's own trades and recorded bars, then scores them. */

import { TRADER } from "@/config/trader";
import type { Bar } from "../alpaca";
import { loadBars } from "../db";
import { etToUtc } from "../time";
import {
  breakdown, buyAndHold, confidenceBucket, decisionGate, grossPl, randomBaseline, slippage, stats, timeBucket,
  type GateResult, type ScoredTrade, type Stats,
} from "./scoring";
import * as ts from "./store";

export interface VersionReport {
  version: ts.Version;
  days: Array<{ date: string; newsDown: boolean }>;
  trades: ScoredTrade[];
  gross: Stats;
  net: Stats;
  hypothetical3x: { gross: Stats; net: Stats };
  buyHold: { days: number; gross: Stats; net: Stats };
  random: { percentile: number | null; mean: number | null; p95: number | null; sims: number };
  breakdowns: Record<string, Array<{ key: string; net: Stats }>>;
  cost: { total: number; perDay: number | null; perTrade: number | null; byDay: Array<{ date: string; cost: number; calls: number }> };
  gate: GateResult;
  verdict: { verdict: string; decidedAt: string } | null;
}

/** Regular-session QQQ 1-min bars per date. */
export async function qqqBarsByDate(dates: string[]): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  for (const d of dates) {
    const bars = await loadBars(etToUtc(d, "09:30"), etToUtc(d, "16:00"));
    out.set(d, bars.filter((b) => b.symbol === TRADER.symbol).sort((a, b) => a.ts.localeCompare(b.ts)));
  }
  return out;
}

export function toScored(rows: ts.TradeRow[]): ScoredTrade[] {
  return rows
    .filter((t) => t.status === "closed" && t.entryPrice !== null && t.exitPrice !== null && t.entryAt && t.exitAt)
    .map((t) => ({
      id: t.id, date: t.date, side: t.side, qty: t.qty, entryPrice: t.entryPrice!, exitPrice: t.exitPrice!, entryAt: t.entryAt!, exitAt: t.exitAt!,
      stop: t.stopInitial, target: t.target, maxHoldMinutes: t.maxHoldMinutes, confidence: t.confidence, catalyst: t.catalyst, exitReason: t.exitReason ?? "",
    }))
    .sort((a, b) => a.exitAt.localeCompare(b.exitAt));
}

export async function versionReport(version: ts.Version): Promise<VersionReport> {
  const [rows, days, costRows, verdict] = await Promise.all([
    ts.tradesForVersion(version.id),
    ts.versionDays(version.id),
    ts.costByDay(version.id),
    ts.verdictFor(version.id),
  ]);
  const trades = toScored(rows);
  const dates = days.map((d) => d.date);
  const bars = await qqqBarsByDate(dates);

  const gross = trades.map(grossPl);
  const net = trades.map((t) => grossPl(t) - slippage(t.qty));
  const bh = buyAndHold(bars, dates);
  const rb = randomBaseline(trades, bars);
  const netStats = stats(net);
  const bhNet = stats(bh.map((d) => d.net));
  const totalCost = costRows.reduce((a, r) => a + r.cost, 0);

  return {
    version,
    days,
    trades,
    gross: stats(gross),
    net: netStats,
    hypothetical3x: { gross: stats(gross.map((p) => p * TRADER.hypotheticalMultiple)), net: stats(net.map((p) => p * TRADER.hypotheticalMultiple)) },
    buyHold: { days: bh.length, gross: stats(bh.map((d) => d.gross)), net: bhNet },
    random: { percentile: rb.percentile, mean: rb.mean, p95: rb.p95, sims: rb.simsPerTrade.reduce((a, s) => a + s.length, 0) },
    breakdowns: {
      "Confidence": breakdown(trades, (t) => confidenceBucket(t.confidence)),
      "Time of day (entry, ET)": breakdown(trades, (t) => timeBucket(t.entryAt)),
      "Direction": breakdown(trades, (t) => t.side),
      "Catalyst": breakdown(trades, (t) => t.catalyst),
      "Exit": breakdown(trades, (t) => t.exitReason || "?"),
    },
    cost: {
      total: Math.round(totalCost * 100) / 100,
      perDay: costRows.length ? Math.round((totalCost / costRows.length) * 100) / 100 : null,
      perTrade: trades.length ? Math.round((totalCost / trades.length) * 100) / 100 : null,
      byDay: costRows,
    },
    gate: decisionGate({
      trades: trades.length,
      tradingDays: dates.length,
      netExpectancy: netStats.expectancy,
      percentile: rb.percentile,
      strategyTotal: netStats.total,
      strategyMaxDd: netStats.maxDrawdown,
      bhTotal: bhNet.total,
      bhMaxDd: bhNet.maxDrawdown,
    }),
    verdict: verdict ? { verdict: verdict.verdict, decidedAt: verdict.decidedAt } : null,
  };
}
