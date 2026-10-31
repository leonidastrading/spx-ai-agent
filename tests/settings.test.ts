import { describe, expect, it } from "vitest";
import { STRATEGY_NAMES } from "@/config/strategies";
import { categorize, type KeywordConfig } from "@/lib/news";
import { parseTradeLog } from "@/lib/optionomega";
import { DEFAULT_SETTINGS, effectiveModel, envStatus, mergeSettings, validateSettings } from "@/lib/settings";

const clone = () => structuredClone(DEFAULT_SETTINGS);

describe("settings validation", () => {
  it("defaults are valid and round-trip", () => {
    const v = validateSettings(clone());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.settings.strategies.map((s) => s.name)).toEqual(STRATEGY_NAMES);
  });

  it("rejects bad values with readable paths", () => {
    const s = clone();
    s.rules.atrPercentile = 1.5;
    s.strategies.push({ name: "BWB", entryEt: "", description: "" });
    s.ooMap["foo"] = "Nope";
    s.keywords.categories[0].key = "Bad Key";
    s.email.to = "not-an-email";
    const v = validateSettings(s);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      const all = v.errors.join("\n");
      expect(all).toMatch(/rules\.atrPercentile/);
      expect(all).toMatch(/strategy names must be unique/);
      expect(all).toMatch(/ooMap\.foo: maps to unknown strategy "Nope"/);
      expect(all).toMatch(/keywords\.categories\.0\.key/);
      expect(all).toMatch(/email\.to/);
    }
  });

  it("lower-cases OO names and upper-cases tickers", () => {
    const s = clone();
    s.ooMap = { "  My BWB Put  ": "BWB" };
    s.keywords.megaCaps = ["aapl"];
    const v = validateSettings(s);
    expect(v.ok && v.settings.ooMap).toEqual({ "my bwb put": "BWB" });
    expect(v.ok && v.settings.keywords.megaCaps).toEqual(["AAPL"]);
  });

  it("merge fills missing sections from defaults and ignores invalid stored data", () => {
    expect(mergeSettings({ rules: { spyDownPct: 2 } }).rules).toEqual({ ...DEFAULT_SETTINGS.rules, spyDownPct: 2 });
    expect(mergeSettings({ rules: { spyDownPct: -9 } })).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("model precedence: settings, then CLAUDE_MODEL, then default", () => {
    const s = clone();
    expect(effectiveModel(s, {})).toBe("claude-opus-5-5");
    expect(effectiveModel(s, { CLAUDE_MODEL: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
    s.llm.model = "claude-haiku-5-5";
    expect(effectiveModel(s, { CLAUDE_MODEL: "claude-sonnet-5-5" })).toBe("claude-haiku-5-5");
  });

  it("env status reports presence only, never secret values", () => {
    const st = envStatus({ ALPACA_API_KEY_ID: "SECRETKEY", ANTHROPIC_API_KEY: "sk-secret", ALPACA_FEED: "iex" });
    expect(JSON.stringify(st)).not.toMatch(/SECRETKEY|sk-secret/);
    expect(st.find((e) => e.key === "ALPACA_API_KEY_ID")?.set).toBe(true);
    expect(st.find((e) => e.key === "DATABASE_URL")?.set).toBe(false);
    expect(st.find((e) => e.key === "ALPACA_FEED")?.value).toBe("iex");
  });
});

describe("settings take effect", () => {
  it("custom keyword lists change tagging", () => {
    const kc: KeywordConfig = { categories: [{ key: "crypto", label: "Crypto", terms: ["bitcoin"] }], megaCaps: [], megaCapNames: [] };
    expect(categorize({ id: 1, ts: "", headline: "Bitcoin jumps", symbols: [] }, kc)).toEqual(["crypto"]);
    expect(categorize({ id: 1, ts: "", headline: "Powell speaks", symbols: [] }, kc)).toEqual([]);
  });

  it("custom OO map, and pattern fallbacks only to known strategies", () => {
    const csv = "Date Opened,P/L,Strategy\n2024-03-11,100,Iron Fly Special\n2024-03-11,50,Put BWB 13:50\n";
    const r = parseTradeLog(csv, { "iron fly special": "Fly" }, ["Fly"]);
    expect(r.outcomes).toEqual([{ date: "2024-03-11", strategy: "Fly", pl: 100, trades: 1 }]);
    expect(r.unmapped).toEqual({ "Put BWB 13:50": 1 });
  });
});
