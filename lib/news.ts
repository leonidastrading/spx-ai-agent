/** Mechanical headline tagging (keyword counts) and relevance ranking. No LLM. */

import { KEYWORD_CATEGORIES, MEGA_CAPS, MEGA_CAP_NAMES, type KeywordCategory } from "@/config/keywords";

export interface Headline {
  id: number;
  ts: string;
  headline: string;
  summary?: string;
  symbols: string[];
}

/** Keyword lists; defaults come from config/keywords.ts, the Settings page can override them. */
export interface KeywordConfig {
  categories: KeywordCategory[];
  megaCaps: string[];
  megaCapNames: string[];
}

export const DEFAULT_KEYWORDS: KeywordConfig = {
  categories: KEYWORD_CATEGORIES,
  megaCaps: [...MEGA_CAPS],
  megaCapNames: MEGA_CAP_NAMES,
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(terms: string[]): RegExp {
  const t = terms.map((x) => x.trim()).filter(Boolean);
  // A regex that never matches when the list is empty.
  return t.length ? new RegExp(`\\b(?:${t.map(escapeRe).join("|")})\\b`, "i") : /(?!)/;
}

interface Compiled {
  cats: Array<{ cat: KeywordCategory; re: RegExp }>;
  megaName: RegExp;
  megaSet: Set<string>;
}

const cache = new WeakMap<KeywordConfig, Compiled>();
function compiled(kc: KeywordConfig): Compiled {
  let c = cache.get(kc);
  if (!c) {
    c = {
      cats: kc.categories.map((cat) => ({ cat, re: compile(cat.terms) })),
      megaName: compile(kc.megaCapNames),
      megaSet: new Set(kc.megaCaps.map((s) => s.toUpperCase())),
    };
    cache.set(kc, c);
  }
  return c;
}

export function mentionsMegaCap(h: Headline, kc: KeywordConfig = DEFAULT_KEYWORDS): boolean {
  const c = compiled(kc);
  if (h.symbols.some((s) => c.megaSet.has(s))) return true;
  return c.megaName.test(h.headline);
}

/** Category keys a headline matches. */
export function categorize(h: Headline, kc: KeywordConfig = DEFAULT_KEYWORDS): string[] {
  const text = `${h.headline} ${h.summary ?? ""}`;
  const out: string[] = [];
  for (const { cat, re } of compiled(kc).cats) {
    if (!re.test(text)) continue;
    if (cat.megaCapOnly && !mentionsMegaCap(h, kc)) continue;
    out.push(cat.key);
  }
  return out;
}

export function keywordCounts(headlines: Headline[], kc: KeywordConfig = DEFAULT_KEYWORDS): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of kc.categories) counts[`kw_${c.key}`] = 0;
  for (const h of headlines) for (const k of categorize(h, kc)) counts[`kw_${k}`]++;
  return counts;
}

const BROAD = new Set(["SPY", "SPX", "QQQ", "IWM", "DIA", "VIX", "VIXY", "TLT", "ES", "NQ"]);

/**
 * Score for "most relevant headlines": keyword categories dominate, then
 * index/mega-cap tickers, and stories tagged with dozens of symbols (sector
 * round-ups) are down-weighted. Ties go to the most recent.
 */
export function relevanceScore(h: Headline, kc: KeywordConfig = DEFAULT_KEYWORDS): number {
  let score = categorize(h, kc).length * 3;
  if (h.symbols.some((s) => BROAD.has(s))) score += 2;
  if (mentionsMegaCap(h, kc)) score += 1;
  if (h.symbols.length > 8) score -= 1;
  if (h.symbols.length === 0) score -= 0.5;
  return score;
}

/** Top-n relevant headlines, returned in chronological order. */
export function topHeadlines<T extends Headline>(headlines: T[], n: number, kc: KeywordConfig = DEFAULT_KEYWORDS): T[] {
  return headlines
    .map((h) => ({ h, s: relevanceScore(h, kc) }))
    .sort((a, b) => b.s - a.s || b.h.ts.localeCompare(a.h.ts))
    .slice(0, n)
    .map((x) => x.h)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
