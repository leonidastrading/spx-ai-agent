/** Option Omega trade-log CSV -> daily P/L per strategy. Pure. */

import { OO_STRATEGY_MAP, OO_STRATEGY_PATTERNS } from "@/config/strategies";
import { parseCsvObjects } from "./csv";

export interface Outcome {
  date: string;
  strategy: string;
  pl: number;
  trades: number;
}

export interface ParseReport {
  outcomes: Outcome[];
  rows: number;
  unmapped: Record<string, number>;
  badRows: Array<{ line: number; reason: string }>;
}

/**
 * Exact name in `map` first (case-insensitive), then the regex fallbacks in
 * config/strategies.ts — only if they point at a strategy in `known`.
 */
export function mapStrategy(ooName: string, map: Record<string, string> = OO_STRATEGY_MAP, known?: string[]): string | null {
  const key = ooName.trim().toLowerCase();
  if (key in map) return map[key];
  for (const [re, name] of OO_STRATEGY_PATTERNS) if (re.test(ooName) && (!known || known.includes(name))) return name;
  return null;
}

/** Accepts YYYY-MM-DD, M/D/YYYY and M/D/YY. */
export function normalizeDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

/** "$1,234.50", "(1,234.50)", "-1234.5" -> number. */
export function parseMoney(s: string): number | null {
  let t = s.trim().replace(/[$,\s]/g, "");
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (t === "" || !/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return neg ? -n : n;
}

/**
 * Sum P/L by (Date Opened, mapped strategy). "P/L" in the OO trade log is the
 * trade's total P/L already scaled by "No. of Contracts", so it is summed as is.
 */
export function parseTradeLog(csv: string, map: Record<string, string> = OO_STRATEGY_MAP, known?: string[]): ParseReport {
  const rows = parseCsvObjects(csv);
  const agg = new Map<string, Outcome>();
  const unmapped: Record<string, number> = {};
  const badRows: ParseReport["badRows"] = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const date = normalizeDate(r["Date Opened"] ?? "");
    const pl = parseMoney(r["P/L"] ?? "");
    const ooName = (r["Strategy"] ?? "").trim();
    if (!date) return badRows.push({ line, reason: `bad Date Opened "${r["Date Opened"] ?? ""}"` });
    if (pl === null) return badRows.push({ line, reason: `bad P/L "${r["P/L"] ?? ""}"` });
    const strategy = mapStrategy(ooName, map, known);
    if (!strategy) {
      unmapped[ooName || "(blank)"] = (unmapped[ooName || "(blank)"] ?? 0) + 1;
      return;
    }
    const key = `${date}|${strategy}`;
    const o = agg.get(key) ?? { date, strategy, pl: 0, trades: 0 };
    o.pl += pl;
    o.trades++;
    agg.set(key, o);
  });
  const outcomes = [...agg.values()]
    .map((o) => ({ ...o, pl: Math.round(o.pl * 100) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.strategy.localeCompare(b.strategy));
  return { outcomes, rows: rows.length, unmapped, badRows };
}
