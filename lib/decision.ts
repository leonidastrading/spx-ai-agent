/** Rule-based baseline and LLM response validation. Pure. */

import { z } from "zod";
import { RULES } from "@/config/rules";
import { STRATEGIES, STRATEGY_NAMES, type StrategyDef } from "@/config/strategies";
import type { Features } from "./features";

export type Call = "run" | "reduce" | "skip";
export type Source = "rule" | "llm";

export interface StrategyCall {
  strategy: string;
  call: Call;
  confidence: number | null;
  reason: string;
}

/** Share of history values strictly below x, in [0, 1]. */
export function percentileRank(history: number[], x: number): number {
  if (!history.length) return NaN;
  return history.filter((h) => h < x).length / history.length;
}

/** Value at quantile q (linear interpolation). */
export function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export interface RuleResult {
  call: Call;
  reason: string;
  atrThresholdBp: number | null;
  atrPctRank: number | null;
  historyDays: number;
  calls: StrategyCall[];
}

/**
 * "reduce" if the 30-min ATR is in the top decile of the trailing window OR SPY
 * is more than RULES.spyDownPct below the prior close; otherwise "run".
 * `atrHistory` = prior days' atr30_bp, most recent last, today excluded.
 */
export function ruleDecision(
  f: Pick<Features, "atr30_bp" | "spy_ret_prev_close_pct">,
  atrHistory: number[],
  rules = RULES,
  names: string[] = STRATEGY_NAMES,
): RuleResult {
  const hist = atrHistory.filter((x) => Number.isFinite(x)).slice(-rules.atrLookbackDays);
  const reasons: string[] = [];
  let atrThreshold: number | null = null;
  let atrRank: number | null = null;
  let reduce = false;

  if (hist.length >= rules.atrMinHistoryDays && f.atr30_bp !== null) {
    atrThreshold = quantile(hist, rules.atrPercentile);
    atrRank = percentileRank(hist, f.atr30_bp);
    if (f.atr30_bp >= atrThreshold) {
      reduce = true;
      reasons.push(
        `30-min ATR ${f.atr30_bp.toFixed(2)}bp >= p${Math.round(rules.atrPercentile * 100)} ${atrThreshold.toFixed(2)}bp of last ${hist.length}d`,
      );
    }
  } else {
    reasons.push(`ATR leg skipped (${hist.length}/${rules.atrMinHistoryDays} days of history)`);
  }

  if (f.spy_ret_prev_close_pct !== null && f.spy_ret_prev_close_pct < -rules.spyDownPct) {
    reduce = true;
    reasons.push(`SPY ${f.spy_ret_prev_close_pct.toFixed(2)}% vs prior close (< -${rules.spyDownPct}%)`);
  }

  const call: Call = reduce ? "reduce" : "run";
  if (!reduce) {
    const atrTxt = atrRank === null ? "n/a" : `p${Math.round(atrRank * 100)}`;
    reasons.push(`ATR rank ${atrTxt}, SPY ${f.spy_ret_prev_close_pct?.toFixed(2) ?? "n/a"}% vs prior close`);
  }
  const reason = reasons.join("; ");
  return {
    call,
    reason,
    atrThresholdBp: atrThreshold,
    atrPctRank: atrRank,
    historyDays: hist.length,
    calls: names.map((strategy) => ({ strategy, call, confidence: null, reason })),
  };
}

// ---------------------------------------------------------------------------
// LLM output
// ---------------------------------------------------------------------------

const callSchema = z.object({
  call: z.enum(["run", "reduce", "skip"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export const llmOutputSchema = z.object({
  market_read: z.string().min(1),
  // A list of calls (current shape); an object keyed by strategy name is still accepted.
  strategies: z.union([z.array(callSchema.extend({ strategy: z.string().min(1) })), z.record(z.string(), callSchema)]),
});

export interface LlmDecision {
  marketRead: string;
  calls: StrategyCall[];
}

/**
 * JSON schema for structured output. The calls are a list (strategy name from an enum), so the schema's size
 * doesn't grow with the number of strategies; that every strategy is answered exactly once is checked in code.
 * (An object with one required key per strategy compiled into a grammar too large for the API at 18 strategies.)
 */
export function llmJsonSchema(names: string[] = STRATEGY_NAMES): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["market_read", "strategies"],
    properties: {
      market_read: { type: "string" },
      strategies: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["strategy", "call", "confidence", "reason"],
          properties: {
            strategy: { type: "string", enum: names },
            call: { type: "string", enum: ["run", "reduce", "skip"] },
            confidence: { type: "number" },
            reason: { type: "string" },
          },
        },
      },
    },
  };
}

/** Extract the first JSON object from model text (tolerates ``` fences). */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in response");
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Validate the model's text. Throws with a readable message on any problem:
 * bad JSON, wrong shape, missing or unknown strategies.
 */
export function parseLlmOutput(text: string, names: string[] = STRATEGY_NAMES): LlmDecision {
  const parsed = llmOutputSchema.safeParse(extractJson(text));
  if (!parsed.success) throw new Error(`schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const raw = parsed.data.strategies;
  let got: Record<string, z.infer<typeof callSchema>>;
  if (Array.isArray(raw)) {
    got = {};
    const dup = new Set<string>();
    for (const { strategy, ...c } of raw) {
      if (strategy in got) dup.add(strategy);
      got[strategy] = c;
    }
    if (dup.size) throw new Error(`strategies answered twice: ${[...dup].join(", ")}`);
  } else got = raw;
  const missing = names.filter((n) => !(n in got));
  const unknown = Object.keys(got).filter((k) => !names.includes(k));
  if (missing.length) throw new Error(`missing strategies: ${missing.join(", ")}`);
  if (unknown.length) throw new Error(`unknown strategies: ${unknown.join(", ")}`);
  return {
    marketRead: parsed.data.market_read,
    calls: names.map((n) => ({ strategy: n, ...got[n] })),
  };
}

/** Volatility and the live book at 10:50 ET, from oo-trading's read-only export (Schwab). */
export interface BookContext {
  vol: { vix: number | null; vixChangePct: number | null; vix9d: number | null; vix9dChangePct: number | null; asOf: string } | null;
  /** Entries open at 10:50 ET; null when the export doesn't provide them. */
  open: Array<{ bot: string | null; legs: string; expiry: string; contracts: number; openPl: number }> | null;
  /** Why something is missing (shown to the model). */
  note?: string;
}

export interface PromptInput {
  date: string;
  features: Features;
  /** VIX / VIX9D and open positions (v2). Absent = not available. */
  book?: BookContext;
  /** Defaults to config/strategies.ts. */
  strategies?: StrategyDef[];
  headlines: Array<{ ts: string; headline: string }>;
}

export const SYSTEM_PROMPT = `You are a risk advisor for a discretionary SPX options book. Each trading day at 10:50 ET you see the morning's market features and headlines and recommend, for each strategy entering later that day, whether to "run" it at normal size, "reduce" it to half size, or "skip" it.

Context:
- Most strategies are short-premium 0DTE structures that lose on large intraday moves, trend days and volatility expansions. Their edge comes from running on most days; skipping costs money on quiet days. Recommend "skip" only when the morning gives a specific reason the strategy's loss scenario is unusually likely, and "reduce" when the risk is elevated but unclear.
- Some strategies only trigger on a setup (e.g. a down-trend day, a breakout, VIX up on the day or above a level, an FOMC day); judge them on whether today looks like that setup and how the risk looks if it triggers.
- Some strategies buy premium (e.g. a long straddle) and profit from big moves; for those, a volatile morning is not by itself a reason to reduce. Read each strategy's description.
- Prices are SPY (a proxy for SPX). The VIX and VIX9D levels and their change since the prior close are given when available (VIXY, a VIX-futures ETF, is also in the features as a rough proxy). VIX9D above VIX means near-term stress.
- The book's open positions (bot, strikes, expiry, size, open P/L) are listed: weigh each new entry against the risk already on.
- You are advising in shadow mode; no orders are placed from your output.

Answer with JSON only, no prose outside it, matching this shape:
{"market_read": "<one paragraph>", "strategies": [{"strategy": "<strategy name>", "call": "run"|"reduce"|"skip", "confidence": <0-1>, "reason": "<one sentence>"}, ...]}
One entry per strategy, using exactly the strategy names given, all of them, each once.`;

export function buildUserPrompt(p: PromptInput): string {
  const strategies = (p.strategies ?? STRATEGIES).map((s) => `- ${s.name} — entry ${s.entryEt} ET — ${s.description}`).join("\n");
  const feat = Object.entries(p.features)
    .filter(([k]) => !["date", "as_of", "prior_close_at", "feed"].includes(k))
    .map(([k, v]) => `${k}: ${v ?? "n/a"}`)
    .join("\n");
  const heads = p.headlines.length
    ? p.headlines.map((h) => `${h.ts} ${h.headline}`).join("\n")
    : "(no headlines)";
  return `Date: ${p.date}. Features as of ${p.features.as_of} (10:50 ET), price feed ${p.features.feed}.

Strategies to call:
${strategies}

Morning features (returns in %, ranges/ATR in basis points of the open, range_pos 0=low 1=high, kw_* are keyword-category headline counts since the prior close):
${feat}

Volatility and the book at 10:50 ET (from Schwab, via oo-trading):
${renderBook(p.book)}

Most relevant headlines since the prior close (UTC timestamp, headline; press releases and single-stock halts removed):
${heads}`;
}

const fmt = (x: number | null, d = 2) => (x === null ? "n/a" : x.toFixed(d));
const sgn = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);

export function renderBook(b: BookContext | undefined): string {
  if (!b) return "unavailable (oo-trading export not connected)";
  const vol = b.vol
    ? `VIX ${fmt(b.vol.vix)} (${sgn(b.vol.vixChangePct)} vs prior close), VIX9D ${fmt(b.vol.vix9d)} (${sgn(b.vol.vix9dChangePct)})${b.vol.vix && b.vol.vix9d ? `, VIX9D/VIX ${(b.vol.vix9d / b.vol.vix).toFixed(2)}` : ""}`
    : "VIX/VIX9D unavailable";
  const open =
    b.open === null
      ? "Open positions: not provided by the export."
      : b.open.length
        ? `Open positions (${b.open.length}):\n${b.open.map((o) => `- ${o.bot ?? "unmatched"}: ${o.legs}, exp ${o.expiry}, ${o.contracts} lots, open P/L $${Math.round(o.openPl).toLocaleString("en-US")}`).join("\n")}`
        : "Open positions: none.";
  return [vol, open, b.note].filter(Boolean).join("\n");
}

/**
 * "inactive (8/60)" when a rule call was made without enough ATR history (its reason says the ATR leg was
 * skipped), else null. Such calls are shown as inactive and left out of comparisons.
 */
export function ruleInactive(reason: string | null | undefined): string | null {
  const m = reason?.match(/ATR leg skipped \((\d+)\/(\d+) days/);
  return m ? `inactive (${m[1]}/${m[2]})` : null;
}
