import { describe, expect, it } from "vitest";
import { categorize, keywordCounts, screenHeadline, screenHeadlines, topHeadlines, type Headline } from "@/lib/news";

let id = 0;
const h = (headline: string, symbols: string[] = [], author = "Benzinga Newsdesk"): Headline => ({ id: ++id, ts: `2026-11-12T1${id % 10}:00:00Z`, headline, symbols, author });

describe("headline screening (Nov 11-12, 2026 examples)", () => {
  it("drops press-release wires, by author or by a (NASDAQ: XXX) tag", () => {
    expect(screenHeadline(h("Acme Named 2027 Military Friendly Employer", ["ACME"], "Business Wire"))).toBe("pr_wire");
    expect(screenHeadline(h("Kyndryl Unveils New Sovereignty Approach to Strengthen Operational Resilience", ["KD"], "PRNewswire"))).toBe("pr_wire");
    expect(screenHeadline(h("Ideal Power (NASDAQ: IPWR) Finalizing 800V DC Circuit Breaker Development", ["IPWR"], ""))).toBe("pr_wire");
    expect(screenHeadline(h("Fed's Hammack Says Fed Has Been Missing On Inflation Mandate"))).toBeNull();
  });

  it("drops non-US halts and single small-cap halts; keeps market-wide ones", () => {
    expect(screenHeadline(h("CIRO Trading Halt - Lithium Co. (TSXV) halted pending news", ["LITH.V"]))).toBe("foreign_halt");
    expect(screenHeadline(h("Ainos Shares Halted On Circuit Breaker To The Upside; Stock Now Up 123.76%", ["AIMD"]))).toBe("single_stock_halt");
    expect(screenHeadline(h("GreenPower Motor Shares Halted On Circuit Breaker To The Upside, Stock Now Up 162.87%", ["GP"]))).toBe("single_stock_halt");
    expect(screenHeadline(h("NYSE Reports Market-Wide Trading Halt After Systems Issue"))).toBeNull();
  });

  it("tags only when the headline's subject fits the tag", () => {
    expect(categorize(h("Intellia Says Lonvo-Z Cut HAE Attack Rate 81% Vs Prior Long-Term Prophylaxis", ["NTLA"]))).not.toContain("geopolitical");
    expect(categorize(h("Nvidia Executive Kimberly Powell Suddenly Drops Out of Major Health Summit", ["NVDA"]))).not.toContain("fed");
    expect(categorize(h("Why Is IonQ Stock Falling on Thursday?", ["IONQ", "NVDA", "MSFT", "GOOGL", "IBM"]))).not.toContain("megacap_negative");
    expect(categorize(h("Bessent Moved to Military Housing Following Iranian Threats"))).toContain("geopolitical");
    expect(categorize(h("Keybanc Downgrades NVIDIA to Sector Weight", ["NVDA"]))).toContain("megacap_negative");
    expect(categorize(h("USA Initial Jobless Claims 200K Vs 194K Est."))).toContain("macro_data");
    expect(categorize(h("Fed's Hammack Says Prefers To See Smaller, Steadier FOMC Rate Moves"))).toContain("fed");
  });

  it("counts and rankings use only kept headlines; kept + dropped = total", () => {
    const list = [
      h("Acme Named Military Friendly Employer; War Veterans Program Expands", ["ACME"], "GlobeNewswire"),
      h("Missile Strike On Port Raises Oil Prices"),
      h("Ainos Shares Halted On Circuit Breaker To The Upside", ["AIMD"]),
    ];
    const s = screenHeadlines(list);
    expect(s.kept).toHaveLength(1);
    expect(s.dropped).toEqual({ pr_wire: 1, foreign_halt: 0, single_stock_halt: 1 });
    expect(keywordCounts(list).kw_geopolitical).toBe(1);
    expect(keywordCounts(list).kw_halt_outage).toBe(0);
    expect(topHeadlines(list, 10).map((x) => x.headline)).toEqual(["Missile Strike On Port Raises Oil Prices"]);
  });
});
