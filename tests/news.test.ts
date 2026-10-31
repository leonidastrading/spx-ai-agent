import { describe, expect, it } from "vitest";
import { categorize, keywordCounts, topHeadlines, type Headline } from "@/lib/news";

const h = (id: number, headline: string, symbols: string[] = [], ts = `2024-03-11T13:${String(id).padStart(2, "0")}:00Z`): Headline => ({ id, ts, headline, symbols });

describe("keyword tagging", () => {
  it("matches whole words, case-insensitive", () => {
    expect(categorize(h(1, "FOMC minutes: Powell sees cuts"))).toEqual(["fed"]);
    expect(categorize(h(2, "Federated Hermes earnings"))).toEqual([]); // not "fed"
    expect(categorize(h(3, "New tariffs on steel spark trade war fears"))).toEqual(["trade", "geopolitical"]);
  });

  it("mega-cap category needs a mega-cap symbol or name", () => {
    expect(categorize(h(1, "Morgan Stanley downgrades Nvidia"))).toContain("megacap_negative");
    expect(categorize(h(2, "Downgrade hits regional lender", ["XYZ"]))).not.toContain("megacap_negative");
    expect(categorize(h(3, "Company misses estimates", ["TSLA"]))).toContain("megacap_negative");
  });

  it("counts per category", () => {
    const c = keywordCounts([h(1, "CPI hot"), h(2, "Payrolls beat"), h(3, "Exchange outage halts trading")]);
    expect(c.kw_macro_data).toBe(2);
    expect(c.kw_halt_outage).toBe(1);
    expect(c.kw_fed).toBe(0);
  });

  it("top headlines: relevant first, returned chronologically", () => {
    const list = [h(1, "Stock X rises", ["X"]), h(2, "Powell speaks on CPI", ["SPY"]), h(3, "Another small cap moves", ["Y"]), h(4, "Tariff news", [])];
    const top = topHeadlines(list, 2);
    expect(top.map((x) => x.id)).toEqual([2, 4]);
  });
});
