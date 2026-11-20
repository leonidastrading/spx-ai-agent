import { describe, expect, it } from "vitest";
import { dailyResults, type DailyTrade } from "@/lib/trader/daily";

const t = (p: Partial<DailyTrade> & Pick<DailyTrade, "id" | "date">): DailyTrade => ({
  versionId: 3, side: "long", qty: 15, entryPrice: 600, exitPrice: 601, status: "closed", ...p,
});

describe("trader daily results", () => {
  const { days, totals } = dailyResults(
    [
      // Today's screenshot: short 15 at 628.06, stopped at 628.87 → −$12.15 gross.
      t({ id: 9, date: "2026-11-20", side: "short", entryPrice: 628.06, exitPrice: 628.87 }),
      t({ id: 7, date: "2026-11-19", side: "long", entryPrice: 620, exitPrice: 622 }), // +30
      t({ id: 8, date: "2026-11-19", side: "short", entryPrice: 621, exitPrice: 622 }), // −15
      t({ id: 6, date: "2026-11-18", entryPrice: null, exitPrice: null, status: "failed" }),
      t({ id: 5, date: "2026-11-18", versionId: 2, entryPrice: 610, exitPrice: null, status: "open" }),
    ],
    [
      { date: "2026-11-20", cost: 1.57, versionId: 3 },
      { date: "2026-11-19", cost: 1.2, versionId: 3 },
      { date: "2026-11-17", cost: 0.9, versionId: 2 }, // a day with decisions but no trades
      { date: "2026-11-16", cost: 0 }, // nothing at all: no row
    ],
  );

  it("one row per day with a trade or LLM cost, newest first", () => {
    expect(days.map((d) => d.date)).toEqual(["2026-11-20", "2026-11-19", "2026-11-18", "2026-11-17"]);
  });

  it("gross from fills, net after $0.01/share slippage each way", () => {
    expect(days[0]).toMatchObject({ closed: 1, wins: 0, losses: 1, gross: -12.15, net: -12.45, llmCost: 1.57, versionIds: [3] });
    expect(days[1]).toMatchObject({ filled: 2, closed: 2, wins: 1, losses: 1, gross: 15, net: 14.4 });
    expect(days[1].trades.map((x) => x.id)).toEqual([7, 8]);
  });

  it("counts unfilled and still-open trades but no P/L for them", () => {
    expect(days[2]).toMatchObject({ filled: 1, closed: 0, gross: 0, net: 0, versionIds: [2, 3] });
    expect(days[3]).toMatchObject({ filled: 0, closed: 0, llmCost: 0.9, versionIds: [2] });
  });

  it("totals over every day", () => {
    expect(totals).toMatchObject({
      days: 4, tradingDays: 2, filled: 4, closed: 3, wins: 1, losses: 2,
      gross: 2.85, net: 1.95, llmCost: 3.67,
      bestDay: { date: "2026-11-19", net: 14.4 }, worstDay: { date: "2026-11-20", net: -12.45 },
    });
    expect(totals.winRate).toBeCloseTo(1 / 3, 6);
  });

  it("is empty without data", () => {
    expect(dailyResults([], [])).toEqual({
      days: [],
      totals: { days: 0, tradingDays: 0, filled: 0, closed: 0, wins: 0, losses: 0, winRate: null, gross: 0, net: 0, llmCost: 0, bestDay: null, worstDay: null },
    });
  });
});
