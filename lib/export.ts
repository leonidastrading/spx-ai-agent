/** CSV exports (pure). Served by app/api/export. */

import { csvLine } from "./csv";
import type { Features } from "./features";
import type { Settings } from "./settings";

export const FEATURE_EXPORT_COLUMNS = [
  "spy_prior_close", "spy_last", "spy_ret_prev_close_pct", "spy_ret_open_pct", "gap_pct", "range_bp",
  "atr30_bp", "range_pos", "new_highs", "new_lows", "qqq_minus_spy_pct", "iwm_minus_spy_pct",
  "tlt_ret_pct", "vixy_ret_pct", "news_since_prior_close", "news_since_open",
] as const;

/** Stop spreadsheet apps from treating free text (LLM reasons, reads) as a formula. */
export function safeText(v: string | null | undefined): string {
  if (!v) return "";
  return /^[=+@\t\r]|^-(?![\d.])/.test(v) ? `'${v}` : v;
}

const WEIGHT: Record<string, number> = { run: 0, reduce: 0.5, skip: 1 };

/** P/L change if the call had been followed (skip = no trade, reduce = half size). */
export function callEffect(call: string | undefined, pl: number | undefined): number | null {
  if (call === undefined || pl === undefined || !(call in WEIGHT)) return null;
  return Math.round(-WEIGHT[call] * pl * 100) / 100;
}

export interface ExportInput {
  decisions: Array<{ date: string; strategy: string; source: string; call: string; confidence: number | null; reason: string }>;
  reads: Array<{ date: string; model: string; market_read: string | null }>;
  features: Array<{ date: string; data: Features }>;
  outcomes: Array<{ date: string; strategy: string; pl: number; trades: number }>;
}

/**
 * One row per (date, strategy): both calls, the LLM's market read, the 10:50
 * features, the uploaded P/L and what following each call would have changed.
 * Dates come from decisions and outcomes, so P/L-only days are included too.
 */
export function buildCallsCsv(input: ExportInput, settings: Settings): string {
  const kwCols = settings.keywords.categories.map((c) => `kw_${c.key}`);
  const header = [
    "date", "strategy", "entry_et",
    "llm_call", "llm_confidence", "llm_reason", "rule_call", "rule_reason",
    "pl", "trades", "llm_effect", "rule_effect",
    "llm_model", "market_read", "feed",
    ...FEATURE_EXPORT_COLUMNS, ...kwCols,
  ];

  const entry = new Map(settings.strategies.map((s) => [s.name, s.entryEt]));
  const order = new Map(settings.strategies.map((s, i) => [s.name, i]));
  const dec = new Map(input.decisions.map((d) => [`${d.date}|${d.strategy}|${d.source}`, d]));
  const reads = new Map(input.reads.map((r) => [r.date, r]));
  const feats = new Map(input.features.map((f) => [f.date, f.data]));
  const pl = new Map(input.outcomes.map((o) => [`${o.date}|${o.strategy}`, o]));

  const keys = new Set<string>();
  for (const d of input.decisions) if (d.strategy !== "*") keys.add(`${d.date}|${d.strategy}`);
  for (const o of input.outcomes) keys.add(`${o.date}|${o.strategy}`);
  // Days where the LLM failed still get a row per configured strategy.
  for (const d of input.decisions) if (d.strategy === "*") for (const s of settings.strategies) keys.add(`${d.date}|${s.name}`);

  const rows = [...keys]
    .map((k) => k.split("|") as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]) || (order.get(a[1]) ?? 99) - (order.get(b[1]) ?? 99) || a[1].localeCompare(b[1]));

  let out = csvLine(header);
  for (const [date, strategy] of rows) {
    const llm = dec.get(`${date}|${strategy}|llm`) ?? dec.get(`${date}|*|llm`);
    const rule = dec.get(`${date}|${strategy}|rule`);
    const o = pl.get(`${date}|${strategy}`);
    const f = feats.get(date) as Record<string, unknown> | undefined;
    const r = reads.get(date);
    out += csvLine([
      date, strategy, entry.get(strategy) ?? "",
      llm?.call ?? "", llm?.confidence ?? "", safeText(llm?.reason), rule?.call ?? "", safeText(rule?.reason),
      o?.pl ?? "", o?.trades ?? "", callEffect(llm?.call, o?.pl) ?? "", callEffect(rule?.call, o?.pl) ?? "",
      r?.model ?? "", safeText(r?.market_read), f?.feed ?? "",
      ...FEATURE_EXPORT_COLUMNS.map((c) => f?.[c] ?? ""),
      ...kwCols.map((c) => f?.[c] ?? ""),
    ]);
  }
  return out;
}

/** Every stored minute for one day, all feature columns. */
export function buildFeaturesCsv(rows: Array<{ minute_et: string; data: Features }>): string {
  const cols = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.data)) cols.add(k);
  const header = ["minute_et", ...[...cols]];
  let out = csvLine(header);
  for (const r of rows) out += csvLine([r.minute_et, ...[...cols].map((c) => (r.data as unknown as Record<string, unknown>)[c] ?? "")]);
  return out;
}
