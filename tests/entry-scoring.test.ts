import { describe, expect, it } from "vitest";
import { actualDayType, asAdvised, asRun, bucketBy, entryGate, humanWeight, morningWeight, randomSkipBaseline, savedVsMissed, simpleRule, type ScoredCall } from "@/lib/entry/scoring";
import { etToUtc } from "@/lib/time";

const c = (date: string, bot: string, verdict: ScoredCall["verdict"], pl: number, vix = 0, hhmm = "13:30"): ScoredCall => ({
  entryId: `${date}-${bot}-${pl}`, date, bot, filledAt: etToUtc(date, hhmm).toISOString(), verdict, confidence: 60, dayType: "range", categories: ["price"], vixChangePct: vix, pl,
});

const calls = [
  c("2024-03-11", "BWB", "skip", -800),   // saved 800
  c("2024-03-11", "5d IC", "take", 300),
  c("2024-03-12", "BWB", "reduce", 400),  // missed 200
  c("2024-03-12", "5d IC", "take", -100),
  c("2024-03-13", "BWB", "take", 250, 12), // VIX up 12% → rule reduces
];

describe("book as run vs advised", () => {
  it("totals, drawdown on daily sums, worst day, trades", () => {
    expect(asRun(calls)).toEqual({ trades: 5, total: 50, maxDrawdown: 500, worstDay: { date: "2024-03-11", pl: -500 } });
    // advised: day1 +300, day2 +100, day3 +250
    expect(asAdvised(calls)).toEqual({ trades: 4, total: 650, maxDrawdown: 0, worstDay: { date: "2024-03-12", pl: 100 } });
  });
  it("saved vs missed, both shown", () => expect(savedVsMissed(calls)).toEqual({ saved: 800, missed: 200, net: 600 }));
  it("simple rule: reduce all when VIX up > 10%", () => expect(simpleRule(calls).total).toBe(50 - 125));
  it("by verdict buckets", () => {
    expect(bucketBy(calls, (x) => x.verdict).find((b) => b.key === "take")).toMatchObject({ n: 3, avgPl: 150 });
  });
});

describe("random-skip baseline", () => {
  it("keeps each bot's verdict counts, is deterministic, and ranks a perfect advisor high", () => {
    const many = Array.from({ length: 60 }, (_, i) => c(`2024-04-${String((i % 28) + 1).padStart(2, "0")}`, i % 2 ? "BWB" : "5d IC", i % 5 === 0 ? "skip" : "take", i % 5 === 0 ? -500 : 100));
    const a = randomSkipBaseline(many);
    expect(a).toEqual(randomSkipBaseline(many));
    expect(a.percentile!).toBeGreaterThan(0.95); // every skip was a loser
    const bad = many.map((x) => ({ ...x, verdict: (x.pl < 0 ? "take" : x.verdict) as ScoredCall["verdict"] }));
    const swapped = bad.map((x, i) => (x.pl > 0 && i % 5 === 1 ? { ...x, verdict: "skip" as const } : x));
    expect(randomSkipBaseline(swapped).percentile!).toBeLessThan(0.1); // skipped winners, took losers
  });
});

describe("comparisons and gate", () => {
  it("human and morning weights", () => {
    expect(humanWeight("half", etToUtc("2024-03-11", "10:00").toISOString())).toBe(0.5);
    expect(humanWeight("skip_afternoon", etToUtc("2024-03-11", "11:59").toISOString())).toBe(1);
    expect(humanWeight("skip_afternoon", etToUtc("2024-03-11", "13:30").toISOString())).toBe(0);
    expect(morningWeight({ call: "skip", decidedAt: etToUtc("2024-03-11", "10:50").toISOString() }, etToUtc("2024-03-11", "10:30").toISOString())).toBe(1); // before the call
    expect(morningWeight({ call: "skip", decidedAt: etToUtc("2024-03-11", "10:50").toISOString() }, etToUtc("2024-03-11", "13:30").toISOString())).toBe(0);
  });
  it("gate: 300 entries AND 40 days; all three checks", () => {
    const run = { trades: 300, total: 1000, maxDrawdown: 900, worstDay: null };
    const adv = { trades: 280, total: 1500, maxDrawdown: 600, worstDay: null };
    expect(entryGate({ scored: 299, tradingDays: 50, run, advised: adv, percentile: 0.99 }).ready).toBe(false);
    expect(entryGate({ scored: 300, tradingDays: 39, run, advised: adv, percentile: 0.99 }).ready).toBe(false);
    expect(entryGate({ scored: 300, tradingDays: 40, run, advised: adv, percentile: 0.96 }).verdict).toBe("pass");
    expect(entryGate({ scored: 300, tradingDays: 40, run, advised: { ...adv, maxDrawdown: 950 }, percentile: 0.99 }).verdict).toBe("fail");
    expect(entryGate({ scored: 300, tradingDays: 40, run, advised: adv, percentile: 0.94 }).verdict).toBe("fail");
  });
});

describe("day types (fixed definitions)", () => {
  const D = "2024-03-11";
  const day = (path: (i: number) => number) =>
    Array.from({ length: 390 }, (_, i) => ({ t: new Date(etToUtc(D, "09:30").getTime() + i * 60000).toISOString(), o: path(i), h: path(i) + 0.05, l: path(i) - 0.05, c: path(i) }));
  it("trend up / down / range / reversal / vol expansion", () => {
    expect(actualDayType(D, day((i) => 500 + i * 0.01), 15, 15)).toBe("trend_up"); // +0.78%, closes at the high
    expect(actualDayType(D, day((i) => 500 - i * 0.01), 15, 15)).toBe("trend_down");
    expect(actualDayType(D, day((i) => 500 + Math.sin(i / 30)), 15, 15)).toBe("range");
    expect(actualDayType(D, day((i) => (i < 150 ? 500 - i * 0.02 : 497 + (i - 150) * 0.015)), 15, 15)).toBe("reversal"); // −0.6% by noon, closes up
    expect(actualDayType(D, day((i) => 500 + Math.sin(i / 10) * 4), 17, 15)).toBe("vol_expansion"); // VIX +13%, range 1.6%
    expect(actualDayType(D, day((i) => 500).slice(0, 100), 15, 15)).toBeNull(); // incomplete
  });
});
