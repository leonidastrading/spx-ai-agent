/** Per-version entry-advisor results. */

import * as store from "../db";
import { mapStrategy } from "../optionomega";
import { strategyNames } from "../settings";
import { etToUtc, toEt } from "../time";
import {
  actualDayType, asAdvised, asRun, bucketBy, confidenceBand, dayTypeAccuracy, entryGate, hourBucket, humanWeight, morningWeight,
  randomSkipBaseline, reasonSplit, savedVsMissed, simpleRule, withWeights, type DriverRow, type BookStats, type Bucket, type ScoredCall,
} from "./scoring";
import * as es from "./store";

export interface EntryReport {
  version: es.EntryVersion;
  counts: { logged: number; called: number; noOpinion: number; late: number; error: number; awaitingOutcome: number; trimmed: number; lengthErrors: number; matchedByLiveFills: number; lowMatch: number };
  scored: ScoredCall[];
  tradingDays: number;
  run: BookStats;
  advised: BookStats;
  savedMissed: { saved: number; missed: number; net: number };
  random: { percentile: number | null; mean: number | null; p95: number | null };
  rule: BookStats;
  human: { days: number; stats: BookStats | null };
  morning: BookStats;
  byVerdict: Bucket[];
  byConfidence: Bucket[];
  byBot: Bucket[];
  byHour: Bucket[];
  byReason: Bucket[];
  /** Reduce/skip calls by the category of their leading reason (bot_record vs price/vol/news vs other). */
  byDriver: DriverRow[];
  /** Average actual P/L of the "take" calls, as the reference for byDriver. */
  takeAvgPl: number | null;
  dayTypes: ReturnType<typeof dayTypeAccuracy> & { rows: Array<{ date: string; said: string[]; actual: string | null }> };
  cost: { total: number; perDay: number | null; avgLatencySec: number | null; slowShare: number | null };
  gate: ReturnType<typeof entryGate>;
  verdict: { verdict: string; decidedAt: string } | null;
}

export async function entryReport(version: es.EntryVersion): Promise<EntryReport> {
  const [calls, outcomes, days, humans, mornings, summaryCosts, verdict, settings] = await Promise.all([
    es.callsForVersion(version.id),
    es.allOutcomes(),
    es.marketDays(),
    es.humanCalls(),
    es.morningCalls(),
    es.summaryCosts(),
    es.entryVerdict(version.id),
    store.loadSettings(),
  ]);

  const scorable = calls.filter((c) => c.status === "called" && c.verdict);
  const scored: ScoredCall[] = scorable
    .filter((c) => outcomes.has(c.entryId))
    .map((c) => ({
      entryId: c.entryId,
      date: toEt(new Date(c.filledAt)).date,
      bot: c.bot ?? "?",
      filledAt: c.filledAt,
      verdict: c.verdict as ScoredCall["verdict"],
      confidence: c.confidence ?? 0,
      dayType: c.dayType ?? "unclear",
      categories: [...new Set(((c.reply?.reasons ?? []) as Array<{ category: string }>).map((r) => r.category))],
      // v2: the model names the deciding reason; v1 replies fall back to the first reason listed.
      driver: (c.reply?.primary_category as string | undefined) ?? (c.reply?.reasons?.[0]?.category as string | undefined) ?? null,
      vixChangePct: c.vixChangePct,
      pl: outcomes.get(c.entryId)!.pl,
    }));
  const dates = [...new Set(scored.map((c) => c.date))].sort();

  // Day types from recorded SPY 1-min bars and stored VIX closes.
  const actual = new Map<string, string | null>();
  for (const d of [...new Set(calls.map((c) => toEt(new Date(c.filledAt)).date))]) {
    const bars = (await store.loadBars(etToUtc(d, "09:30"), etToUtc(d, "16:00"))).filter((b) => b.symbol === "SPY");
    const m = days.get(d);
    actual.set(d, actualDayType(d, bars.map((b) => ({ t: b.ts, o: b.o, h: b.h, l: b.l, c: b.c })), m?.vixClose ?? null, m?.vixPrev ?? null));
  }
  const dayCalls = calls.filter((c) => c.dayType && c.status !== "error").map((c) => ({ date: toEt(new Date(c.filledAt)).date, dayType: c.dayType! }));

  const names = strategyNames(settings);
  const morningFor = (c: ScoredCall) => {
    const s = mapStrategy(c.bot, settings.ooMap, names);
    const m = s ? mornings.find((x) => x.date === c.date && x.strategy === s) : undefined;
    return m ? { call: m.call, decidedAt: m.createdAt } : undefined;
  };
  const humanDays = scored.filter((c) => humans.has(c.date));

  const run = asRun(scored);
  const advised = asAdvised(scored);
  const random = randomSkipBaseline(scored);
  const costDays = new Map<string, number>();
  for (const c of calls) {
    const d = toEt(new Date(c.filledAt)).date;
    costDays.set(d, (costDays.get(d) ?? 0) + (c.costUsd ?? 0));
  }
  for (const [d, c] of summaryCosts) if (costDays.has(d)) costDays.set(d, costDays.get(d)! + c);
  const totalCost = [...costDays.values()].reduce((a, b) => a + b, 0);
  const timed = calls.filter((c) => c.status === "called" || c.status === "late" || c.status === "no_opinion");

  return {
    version,
    counts: {
      logged: calls.length,
      called: scorable.length,
      noOpinion: calls.filter((c) => c.status === "no_opinion").length,
      late: calls.filter((c) => c.status === "late").length,
      error: calls.filter((c) => c.status === "error").length,
      awaitingOutcome: scorable.length - scored.length,
      trimmed: calls.filter((c) => c.trimmed?.length).length,
      // v1 dropped over-long replies as errors; v2 trims them instead.
      lengthErrors: calls.filter((c) => c.status === "error" && /at most \d+ words/.test(c.statusReason ?? "")).length,
      matchedByLiveFills: calls.filter((c) => c.matchSource === "local_profile" || c.matchSource === "live_profile").length,
      lowMatch: calls.filter((c) => c.status === "no_opinion" && /bot match/.test(c.statusReason ?? "")).length,
    },
    scored,
    tradingDays: dates.length,
    run,
    advised,
    savedMissed: savedVsMissed(scored),
    random,
    rule: simpleRule(scored),
    human: { days: new Set(humanDays.map((c) => c.date)).size, stats: humanDays.length ? withWeights(humanDays, (c) => humanWeight(humans.get(c.date)?.call, c.filledAt)) : null },
    morning: withWeights(scored, (c) => morningWeight(morningFor(c), c.filledAt)),
    byVerdict: bucketBy(scored, (c) => c.verdict),
    byConfidence: bucketBy(scored, (c) => confidenceBand(c.confidence)),
    byBot: bucketBy(scored, (c) => c.bot),
    byHour: bucketBy(scored, (c) => hourBucket(c.filledAt)),
    byReason: bucketBy(scored, (c) => (c.categories.length ? c.categories : ["none"])),
    byDriver: reasonSplit(scored),
    takeAvgPl: (() => {
      const t = scored.filter((c) => c.verdict === "take");
      return t.length ? Math.round((t.reduce((a, c) => a + c.pl, 0) / t.length) * 100) / 100 : null;
    })(),
    dayTypes: {
      ...dayTypeAccuracy(dayCalls, actual),
      rows: [...actual.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30).map(([date, a]) => ({ date, said: dayCalls.filter((c) => c.date === date).map((c) => c.dayType), actual: a })),
    },
    cost: {
      total: Math.round(totalCost * 100) / 100,
      perDay: costDays.size ? Math.round((totalCost / costDays.size) * 100) / 100 : null,
      avgLatencySec: timed.length ? Math.round(timed.reduce((a, c) => a + c.latencyMs, 0) / timed.length / 100) / 10 : null,
      slowShare: timed.length ? timed.filter((c) => c.latencyMs > 60000).length / timed.length : null,
    },
    gate: entryGate({ scored: scored.length, tradingDays: dates.length, run, advised, percentile: random.percentile }),
    verdict,
  };
}
