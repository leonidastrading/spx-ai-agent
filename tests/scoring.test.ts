import { describe, expect, it } from "vitest";
import { coinFlipBaseline, scoreDecisions, withTotals, type ScoredDecision } from "@/lib/scoring";

const outcomes = [
  { date: "d1", strategy: "BWB", pl: -1000 },
  { date: "d2", strategy: "BWB", pl: 400 },
  { date: "d3", strategy: "BWB", pl: 300 },
  { date: "d4", strategy: "BWB", pl: -200 },
  { date: "d5", strategy: "BWB", pl: 100 },
];
const decisions: ScoredDecision[] = [
  { date: "d1", strategy: "BWB", source: "llm", call: "skip" },   // hit, saves 1000
  { date: "d2", strategy: "BWB", source: "llm", call: "reduce" }, // miss, forgoes 200
  { date: "d3", strategy: "BWB", source: "llm", call: "run" },
  { date: "d4", strategy: "BWB", source: "llm", call: "run" },
  { date: "d5", strategy: "BWB", source: "llm", call: "run" },
  { date: "d6", strategy: "BWB", source: "llm", call: "skip" },   // no outcome -> ignored
  { date: "d1", strategy: "BWB", source: "rule", call: "run" },
  { date: "d1", strategy: "*", source: "llm", call: "error" },
];

describe("scoring", () => {
  it("computes P/L by call, hit rate, saved/forgone/net", () => {
    const [llm, rule] = scoreDecisions(decisions, outcomes);
    expect(llm).toMatchObject({
      source: "llm", strategy: "BWB", days: 5, skipDays: 1, reduceDays: 1, runDays: 3,
      plSkipDays: -1000, plReduceDays: 400, plRunDays: 200, hits: 1, hitRate: 0.5, baseLossRate: 0.4,
      saved: 1000, forgone: 200, net: 800,
    });
    expect(rule).toMatchObject({ source: "rule", days: 1, runDays: 1, hitRate: null, net: 0 });
  });

  it("adds totals per source", () => {
    const rows = withTotals(scoreDecisions(decisions, outcomes));
    expect(rows.find((r) => r.source === "llm" && r.strategy === "ALL")).toMatchObject({ net: 800, skipDays: 1 });
  });

  it("coin flip with the same skip/reduce counts is deterministic and unbiased", () => {
    const a = coinFlipBaseline(decisions, outcomes, { sims: 4000, seed: 7 });
    const b = coinFlipBaseline(decisions, outcomes, { sims: 4000, seed: 7 });
    expect(a).toEqual(b);
    const llm = a.find((r) => r.source === "llm")!;
    expect(llm).toMatchObject({ skipDays: 1, reduceDays: 1, actualNet: 800 });
    // E[net] = -(1 * mean + 0.5 * mean) = -1.5 * (-400 / 5) = 120
    expect(llm.meanNet).toBeGreaterThan(90);
    expect(llm.meanNet).toBeLessThan(150);
    // Expected hit rate = share of losing days = 0.4
    expect(llm.meanHitRate!).toBeCloseTo(0.4, 1);
    // Of the 20 equally likely (skip, reduce) placements, exactly 4 (skip d1 + any reduce) net >= 800.
    expect(llm.pValue).toBeCloseTo(0.2, 1);
  });
});
