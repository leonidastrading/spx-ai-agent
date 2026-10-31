/** Mechanical headline tagging (keyword counts) and relevance ranking. No LLM. */

import { KEYWORD_CATEGORIES, MEGA_CAPS, MEGA_CAP_NAMES, type KeywordCategory } from "@/config/keywords";

export interface Headline {
  id: number;
  ts: string;
  headline: string;
  summary?: string;
  symbols: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(terms: string[]): RegExp {
  return new RegExp(`\\b(?:${terms.map(escapeRe).join("|")})\\b`, "i");
}

const COMPILED = KEYWORD_CATEGORIES.map((c) => ({ cat: c, re: compile(c.terms) }));
const MEGA_NAME_RE = compile(MEGA_CAP_NAMES);
const MEGA_SET = new Set<string>(MEGA_CAPS);

export function mentionsMegaCap(h: Headline): boolean {
  if (h.symbols.some((s) => MEGA_SET.has(s))) return true;
  return MEGA_NAME_RE.test(h.headline);
}

/** Category keys a headline matches. */
export function categorize(h: Headline, categories: KeywordCategory[] = KEYWORD_CATEGORIES): string[] {
  const compiled = categories === KEYWORD_CATEGORIES ? COMPILED : categories.map((c) => ({ cat: c, re: compile(c.terms) }));
  const text = `${h.headline} ${h.summary ?? ""}`;
  const out: string[] = [];
  for (const { cat, re } of compiled) {
    if (!re.test(text)) continue;
    if (cat.megaCapOnly && !mentionsMegaCap(h)) continue;
    out.push(cat.key);
  }
  return out;
}

export function keywordCounts(headlines: Headline[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of KEYWORD_CATEGORIES) counts[`kw_${c.key}`] = 0;
  for (const h of headlines) for (const k of categorize(h)) counts[`kw_${k}`]++;
  return counts;
}

const BROAD = new Set(["SPY", "SPX", "QQQ", "IWM", "DIA", "VIX", "VIXY", "TLT", "ES", "NQ"]);

/**
 * Score for "most relevant headlines": keyword categories dominate, then
 * index/mega-cap tickers, and stories tagged with dozens of symbols (sector
 * round-ups) are down-weighted. Ties go to the most recent.
 */
export function relevanceScore(h: Headline): number {
  let score = categorize(h).length * 3;
  if (h.symbols.some((s) => BROAD.has(s))) score += 2;
  if (mentionsMegaCap(h)) score += 1;
  if (h.symbols.length > 8) score -= 1;
  if (h.symbols.length === 0) score -= 0.5;
  return score;
}

/** Top-n relevant headlines, returned in chronological order. */
export function topHeadlines<T extends Headline>(headlines: T[], n: number): T[] {
  return headlines
    .map((h) => ({ h, s: relevanceScore(h) }))
    .sort((a, b) => b.s - a.s || b.h.ts.localeCompare(a.h.ts))
    .slice(0, n)
    .map((x) => x.h)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
