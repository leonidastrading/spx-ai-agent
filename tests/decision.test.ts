import { describe, expect, it } from "vitest";
import { STRATEGY_NAMES } from "@/config/strategies";
import { buildUserPrompt, llmJsonSchema, parseLlmOutput, percentileRank, quantile, ruleDecision } from "@/lib/decision";
import { runLlmDecision } from "@/lib/llm";
import { computeFeatures } from "@/lib/features";
import { etToUtc } from "@/lib/time";
import { flatSession, makeBars, session } from "./fixtures/sample";

const history = Array.from({ length: 250 }, (_, i) => i + 1); // 1..250 bp, p90 = 225.1

describe("rule baseline", () => {
  it("quantile/percentile", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile(history, 0.9)).toBeCloseTo(225.1, 6);
    expect(percentileRank(history, 100)).toBeCloseTo(99 / 250, 6);
  });

  it("run on a normal morning", () => {
    const r = ruleDecision({ atr30_bp: 100, spy_ret_prev_close_pct: -0.3 }, history);
    expect(r.call).toBe("run");
    expect(r.calls).toHaveLength(STRATEGY_NAMES.length);
    expect(r.calls.every((c) => c.call === "run")).toBe(true);
  });

  it("reduce when ATR is in the top decile", () => {
    const r = ruleDecision({ atr30_bp: 230, spy_ret_prev_close_pct: 0.2 }, history);
    expect(r.call).toBe("reduce");
    expect(r.reason).toMatch(/ATR/);
  });

  it("reduce when SPY is down more than 1%", () => {
    expect(ruleDecision({ atr30_bp: 10, spy_ret_prev_close_pct: -1.01 }, history).call).toBe("reduce");
    expect(ruleDecision({ atr30_bp: 10, spy_ret_prev_close_pct: -1.0 }, history).call).toBe("run");
  });

  it("uses only the trailing 250 days", () => {
    const long = [...Array(100).fill(1000), ...history];
    expect(ruleDecision({ atr30_bp: 230, spy_ret_prev_close_pct: 0 }, long).call).toBe("reduce");
  });

  it("skips the ATR leg with too little history but still applies the SPY leg", () => {
    const r = ruleDecision({ atr30_bp: 9999, spy_ret_prev_close_pct: 0 }, [1, 2, 3]);
    expect(r.call).toBe("run");
    expect(r.reason).toMatch(/history/);
    expect(ruleDecision({ atr30_bp: 1, spy_ret_prev_close_pct: -2 }, []).call).toBe("reduce");
  });
});

const validJson = () =>
  JSON.stringify({
    market_read: "Quiet open.",
    strategies: Object.fromEntries(STRATEGY_NAMES.map((n) => [n, { call: "run", confidence: 0.7, reason: "calm" }])),
  });

describe("LLM output validation", () => {
  it("accepts valid JSON, also inside a code fence", () => {
    expect(parseLlmOutput(validJson()).calls).toHaveLength(STRATEGY_NAMES.length);
    expect(parseLlmOutput("```json\n" + validJson() + "\n```").marketRead).toBe("Quiet open.");
  });

  it("rejects malformed JSON, bad calls, out-of-range confidence, missing/unknown strategies", () => {
    expect(() => parseLlmOutput("not json")).toThrow();
    expect(() => parseLlmOutput("{bad")).toThrow();
    const o = JSON.parse(validJson());
    expect(() => parseLlmOutput(JSON.stringify({ ...o, strategies: { ...o.strategies, BWB: { call: "hold", confidence: 0.5, reason: "x" } } }))).toThrow(/schema/);
    expect(() => parseLlmOutput(JSON.stringify({ ...o, strategies: { ...o.strategies, BWB: { call: "run", confidence: 1.5, reason: "x" } } }))).toThrow(/schema/);
    const { BWB: _drop, ...rest } = o.strategies;
    expect(() => parseLlmOutput(JSON.stringify({ ...o, strategies: rest }))).toThrow(/missing strategies: BWB/);
    expect(() => parseLlmOutput(JSON.stringify({ ...o, strategies: { ...o.strategies, Extra: { call: "run", confidence: 1, reason: "x" } } }))).toThrow(/unknown/);
  });

  it("JSON schema requires every strategy", () => {
    const s = llmJsonSchema() as any;
    expect(s.properties.strategies.required).toEqual(STRATEGY_NAMES);
  });
});

describe("LLM call with retry (fake client)", () => {
  const s = session("2024-03-11");
  const prior = session("2024-03-08");
  const features = computeFeatures({
    session: s, prior, asOf: etToUtc(s.date, "10:50"),
    bars: [...flatSession("SPY", prior, 500), ...makeBars("SPY", s, 500, Array(80).fill(501))], news: [], feed: "sip",
  });
  const input = { date: s.date, features, headlines: [{ ts: "2024-03-11T13:00:00.000Z", headline: "Stocks edge higher" }] };

  function fakeClient(texts: string[]) {
    const requests: any[] = [];
    const client = {
      beta: {
        messages: {
          create: async (req: any) => {
            requests.push(req);
            return { content: [{ type: "text", text: texts.shift() ?? "" }], stop_reason: "end_turn" };
          },
        },
      },
    };
    return { client: client as any, requests };
  }

  it("retries once after a parse failure", async () => {
    const { client, requests } = fakeClient(["oops", validJson()]);
    const r = await runLlmDecision(input, { client, model: "claude-opus-5-5" });
    expect(r.decision?.calls).toHaveLength(STRATEGY_NAMES.length);
    expect(r.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[0].content).toMatch(/could not be used/);
    expect(requests[0].model).toBe("claude-opus-5-5");
  });

  it("returns decision=null after two failures", async () => {
    const { client, requests } = fakeClient(["oops", "still bad"]);
    const r = await runLlmDecision(input, { client, model: "claude-opus-5-5" });
    expect(r.decision).toBeNull();
    expect(r.attempts).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });

  it("prompt carries features, strategies and headlines (timestamp + headline only)", () => {
    const p = buildUserPrompt(input);
    for (const n of STRATEGY_NAMES) expect(p).toContain(n);
    expect(p).toContain("atr30_bp:");
    expect(p).toContain("2024-03-11T13:00:00.000Z Stocks edge higher");
    expect(p).not.toMatch(/reduce if|baseline/i);
  });
});
