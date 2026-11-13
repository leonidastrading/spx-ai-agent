/** Mechanical headline tagging (keyword counts) and relevance ranking. No LLM. */

import { KEYWORD_CATEGORIES, MEGA_CAPS, MEGA_CAP_NAMES, NEWS_SCREEN, type KeywordCategory } from "@/config/keywords";

export interface Headline {
  id: number;
  ts: string;
  headline: string;
  summary?: string;
  symbols: string[];
  author?: string;
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
  cats: Array<{ cat: KeywordCategory; re: RegExp; ex: RegExp }>;
  megaName: RegExp;
  megaSet: Set<string>;
}

const cache = new WeakMap<KeywordConfig, Compiled>();
function compiled(kc: KeywordConfig): Compiled {
  let c = cache.get(kc);
  if (!c) {
    c = {
      cats: kc.categories.map((cat) => ({ cat, re: compile(cat.terms), ex: compile(cat.exclude ?? []) })),
      megaName: compile(kc.megaCapNames),
      megaSet: new Set(kc.megaCaps.map((s) => s.toUpperCase())),
    };
    cache.set(kc, c);
  }
  return c;
}

/**
 * A mega-cap is the subject: named in the headline, or among at most 3 tagged symbols (round-ups tag dozens, and
 * a small-cap story that mentions Nvidia once is not a mega-cap story).
 */
export function mentionsMegaCap(h: Headline, kc: KeywordConfig = DEFAULT_KEYWORDS): boolean {
  const c = compiled(kc);
  if (c.megaName.test(h.headline)) return true;
  return h.symbols.length <= 3 && h.symbols.some((s) => c.megaSet.has(s.toUpperCase()));
}

const BROAD = new Set(["SPY", "SPX", "QQQ", "IWM", "DIA", "VIX", "VIXY", "TLT", "ES", "NQ", "RSP", "GLD", "USO", "UUP", "HYG"]);
const MARKET_WORDS = compile(NEWS_SCREEN.marketWords);

/** About the market as a whole rather than one company: no company symbols, only broad ones, or market words. */
export function isMarketSubject(h: Headline): boolean {
  const company = h.symbols.filter((s) => !BROAD.has(s.toUpperCase()));
  if (company.length === 0) return true;
  return MARKET_WORDS.test(h.headline);
}

const PR_AUTHOR = compile(NEWS_SCREEN.prWireAuthors);
const PR_TEXT = new RegExp(NEWS_SCREEN.prTextPattern, "i");
const FOREIGN = new RegExp(NEWS_SCREEN.foreignVenuePattern, "i");
const HALT = /\b(?:halt|halted|halts|resumes? trading|trading resumption|circuit breaker)\b/i;

export type DropReason = "pr_wire" | "foreign_halt" | "single_stock_halt";
export const DROP_LABELS: Record<DropReason, string> = {
  pr_wire: "press-release wire",
  foreign_halt: "non-US halt",
  single_stock_halt: "single small-cap halt",
};

/** Why a headline is screened out, or null to keep it. */
export function screenHeadline(h: Headline, kc: KeywordConfig = DEFAULT_KEYWORDS): DropReason | null {
  if (h.author && PR_AUTHOR.test(h.author)) return "pr_wire";
  if (PR_TEXT.test(h.headline)) return "pr_wire";
  if (HALT.test(h.headline)) {
    if (FOREIGN.test(`${h.headline} ${h.summary ?? ""}`) || h.symbols.some((s) => /\.(V|CN|TO|NE)$/i.test(s))) return "foreign_halt";
    // A volatility halt in one stock that is neither an index product nor a mega-cap is not a market event.
    if (!isMarketSubject(h) && !mentionsMegaCap(h, kc)) return "single_stock_halt";
  }
  return null;
}

export interface Screened<T> {
  kept: T[];
  total: number;
  dropped: Record<DropReason, number>;
}

/** Split headlines into kept and dropped (with counts per reason). */
export function screenHeadlines<T extends Headline>(headlines: T[], kc: KeywordConfig = DEFAULT_KEYWORDS): Screened<T> {
  const dropped: Record<DropReason, number> = { pr_wire: 0, foreign_halt: 0, single_stock_halt: 0 };
  const kept: T[] = [];
  for (const h of headlines) {
    const r = screenHeadline(h, kc);
    if (r) dropped[r]++;
    else kept.push(h);
  }
  return { kept, total: headlines.length, dropped };
}

/**
 * Category keys a headline matches. A term has to match and no exclude phrase may; market categories also need the
 * headline to be about the market (see isMarketSubject), the mega-cap category needs a mega-cap as the subject.
 */
export function categorize(h: Headline, kc: KeywordConfig = DEFAULT_KEYWORDS): string[] {
  const text = `${h.headline} ${h.summary ?? ""}`;
  const out: string[] = [];
  for (const { cat, re, ex } of compiled(kc).cats) {
    if (!re.test(text) || ex.test(text)) continue;
    const scope = cat.scope ?? (cat.megaCapOnly ? "company" : "market");
    if (cat.megaCapOnly && !mentionsMegaCap(h, kc)) continue;
    if (scope === "market" && !isMarketSubject(h)) continue;
    out.push(cat.key);
  }
  return out;
}

/** Keyword counts over the headlines that pass screening. */
export function keywordCounts(headlines: Headline[], kc: KeywordConfig = DEFAULT_KEYWORDS): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of kc.categories) counts[`kw_${c.key}`] = 0;
  for (const h of screenHeadlines(headlines, kc).kept) for (const k of categorize(h, kc)) counts[`kw_${k}`]++;
  return counts;
}

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

/** Top-n relevant headlines among those that pass screening, returned in chronological order. */
export function topHeadlines<T extends Headline>(headlines: T[], n: number, kc: KeywordConfig = DEFAULT_KEYWORDS): T[] {
  return screenHeadlines(headlines, kc).kept
    .map((h) => ({ h, s: relevanceScore(h, kc) }))
    .sort((a, b) => b.s - a.s || b.h.ts.localeCompare(a.h.ts))
    .slice(0, n)
    .map((x) => x.h)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
