import { describe, expect, it } from "vitest";
import { STRATEGY_NAMES } from "@/config/strategies";
import { buildSummaryEmail } from "@/lib/email";

describe("summary email", () => {
  const rule = STRATEGY_NAMES.map((strategy) => ({ strategy, call: "run" as const, confidence: null, reason: "calm" }));
  it("subject counts LLM skips and reduces; body has table and top 5 headlines", () => {
    const llm = STRATEGY_NAMES.map((strategy, i) => ({ strategy, call: (i < 2 ? "skip" : i < 5 ? "reduce" : "run") as any, confidence: 0.6, reason: `r${i}` }));
    const headlines = Array.from({ length: 8 }, (_, i) => ({ ts: "2024-03-11T13:00:00Z", headline: `Headline <${i}>` }));
    const m = buildSummaryEmail({ date: "2024-03-11", marketRead: "Choppy & heavy.", llmError: null, llm, rule, headlines });
    expect(m.subject).toBe("Book advisor 2024-03-11: 2 skip / 3 reduce");
    expect(m.html).toContain("Choppy &amp; heavy.");
    expect(m.html).toContain("Headline &lt;4&gt;");
    expect(m.html).not.toContain("Headline &lt;5&gt;");
    for (const n of STRATEGY_NAMES) expect(m.text).toContain(n);
    expect(m.text).toContain("09:00 Headline <0>");
  });

  it("flags an LLM error", () => {
    const m = buildSummaryEmail({ date: "2024-03-11", marketRead: null, llmError: "invalid JSON twice", llm: [], rule, headlines: [] });
    expect(m.subject).toBe("Book advisor 2024-03-11: LLM error / rule run");
    expect(m.html).toContain("invalid JSON twice");
  });
});
