import { describe, expect, it } from "vitest";
import { parseCsvObjects } from "@/lib/csv";
import { buildCallsCsv, buildFeaturesCsv, callEffect, safeText } from "@/lib/export";
import { DEFAULT_SETTINGS } from "@/lib/settings";

describe("CSV export", () => {
  const input = {
    decisions: [
      { date: "2024-03-11", strategy: "BWB", source: "llm", call: "skip", confidence: 0.8, reason: "trend day, risk" },
      { date: "2024-03-11", strategy: "BWB", source: "rule", call: "reduce", confidence: null, reason: "SPY -1.3%" },
      { date: "2024-03-11", strategy: "Short", source: "llm", call: "run", confidence: 0.6, reason: '=HYPERLINK("x")' },
      { date: "2024-03-12", strategy: "*", source: "llm", call: "error", confidence: null, reason: "invalid JSON twice" },
      { date: "2024-03-12", strategy: "BWB", source: "rule", call: "run", confidence: null, reason: "calm" },
    ],
    reads: [{ date: "2024-03-11", model: "claude-opus-5-5", market_read: "Risk-off, \"heavy\" tape." }],
    features: [{ date: "2024-03-11", data: { feed: "sip", spy_ret_prev_close_pct: -1.3, atr30_bp: 4.2, kw_fed: 2 } as any }],
    outcomes: [
      { date: "2024-03-11", strategy: "BWB", pl: -400, trades: 3 },
      { date: "2024-03-13", strategy: "8SMA", pl: 120, trades: 1 },
    ],
  };
  const rows = parseCsvObjects(buildCallsCsv(input, DEFAULT_SETTINGS));
  const find = (d: string, s: string) => rows.find((r) => r.date === d && r.strategy === s)!;

  it("one row per date and strategy, in strategy order", () => {
    expect(rows.slice(0, 2).map((r) => r.strategy)).toEqual(["Short", "BWB"]);
    // 2024-03-12 LLM error day expands to every configured strategy; P/L-only day included.
    expect(rows.filter((r) => r.date === "2024-03-12")).toHaveLength(DEFAULT_SETTINGS.strategies.length);
    expect(find("2024-03-13", "8SMA").pl).toBe("120");
  });

  it("carries calls, reasons, read, features, P/L and effects", () => {
    const r = find("2024-03-11", "BWB");
    expect(r).toMatchObject({
      entry_et: "13:50 / 14:20 / 14:50", llm_call: "skip", llm_confidence: "0.8", llm_reason: "trend day, risk",
      rule_call: "reduce", pl: "-400", trades: "3", llm_effect: "400", rule_effect: "200",
      llm_model: "claude-opus-5-5", market_read: 'Risk-off, "heavy" tape.', feed: "sip",
      spy_ret_prev_close_pct: "-1.3", atr30_bp: "4.2", kw_fed: "2",
    });
    expect(find("2024-03-12", "BWB")).toMatchObject({ llm_call: "error", llm_reason: "invalid JSON twice", rule_call: "run" });
  });

  it("neutralizes spreadsheet formulas in free text but not numbers", () => {
    expect(find("2024-03-11", "Short").llm_reason).toBe(`'=HYPERLINK("x")`);
    expect(safeText("-1.5")).toBe("-1.5");
    expect(safeText("-cmd")).toBe("'-cmd");
    expect(callEffect("reduce", -100)).toBe(50);
    expect(callEffect("run", -100)).toBe(0);
    expect(callEffect(undefined, 5)).toBeNull();
  });

  it("features CSV has every minute and column", () => {
    const csv = buildFeaturesCsv([
      { minute_et: "09:31", data: { a: 1, b: null } as any },
      { minute_et: "09:32", data: { a: 2, c: "x" } as any },
    ]);
    expect(csv).toBe("minute_et,a,b,c\n09:31,1,,\n09:32,2,,x\n");
  });
});
