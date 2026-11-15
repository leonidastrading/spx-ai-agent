/**
 * Keyword categories for mechanical headline tagging. This is the one place to
 * edit them; the live cron and the historical backfill both read this file.
 *
 * Matching is case-insensitive on whole words/phrases in the headline (and the
 * summary when present). A headline can count toward several categories.
 */

export const MEGA_CAPS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"] as const;

/** Company names that identify a mega-cap even when the symbols field is empty. */
export const MEGA_CAP_NAMES = [
  "apple", "microsoft", "nvidia", "amazon", "alphabet", "google", "meta platforms", "tesla",
];

export interface KeywordCategory {
  /** Column name used in features rows and morning_features.csv (prefixed kw_). */
  key: string;
  label: string;
  terms: string[];
  /**
   * When true the headline also has to concern a mega-cap (symbols field
   * contains one of MEGA_CAPS, or the text names one of MEGA_CAP_NAMES).
   */
  megaCapOnly?: boolean;
  /**
   * "market" (default for every category but the mega-cap one): the headline must be about the market, not one
   * company: no company symbols, only index/broad symbols, or market words in the text. A drug trial's "attack
   * rate" or a company's "circuit breaker" product is not geopolitics or a market halt.
   */
  scope?: "market" | "company";
  /** Phrases that cancel the category even when a term matches (e.g. "military friendly"). */
  exclude?: string[];
}

export const KEYWORD_CATEGORIES: KeywordCategory[] = [
  {
    key: "fed",
    label: "Fed / FOMC / Powell",
    terms: ["fed", "federal reserve", "fomc", "powell", "rate cut", "rate hike", "fed funds"],
    exclude: ["fedex", "fed up"],
  },
  {
    key: "macro_data",
    label: "CPI / PPI / jobs / payrolls",
    terms: ["cpi", "ppi", "inflation", "jobs report", "jobless claims", "payrolls", "nonfarm", "unemployment rate", "pce"],
  },
  {
    key: "trade",
    label: "Tariff / trade",
    terms: ["tariff", "tariffs", "trade war", "trade deal", "trade talks", "export controls", "sanctions"],
  },
  {
    key: "geopolitical",
    label: "War / attack / geopolitical",
    terms: ["war", "attack", "attacks", "missile", "invasion", "geopolitical", "military", "airstrike", "strike on", "ceasefire"],
    exclude: ["military friendly", "attack rate", "heart attack", "cyber attack simulation", "price war", "talent war", "console war"],
  },
  {
    key: "megacap_negative",
    label: "Mega-cap downgrade / guidance / miss",
    terms: ["downgrade", "downgrades", "downgraded", "cuts guidance", "lowers guidance", "guidance", "misses", "miss", "below estimates", "weak outlook"],
    megaCapOnly: true,
    scope: "company",
  },
  {
    key: "halt_outage",
    label: "Halt / outage",
    terms: ["halt", "halted", "trading halt", "circuit breaker", "outage", "glitch", "systems issue"],
  },
];

/**
 * Headline screening (no LLM), applied before counting, tagging and ranking. Bump `version` when these rules
 * change: it is part of the entry advisor's packet layout and the day trader's frozen rules.
 */
export const NEWS_SCREEN = {
  version: 1,
  /** Press-release distributors (the news item's author): company announcements, not market news. */
  prWireAuthors: ["business wire", "businesswire", "pr newswire", "prnewswire", "globe newswire", "globenewswire", "accesswire", "access newswire", "newsfile", "ein presswire", "einpresswire", "newswire", "press release", "presswire"],
  /** "(NASDAQ: ABCD)"-style ticker tags are the mark of a press release when the author is unknown. */
  prTextPattern: "\\((?:nasdaq|nyse|nyse american|otcqb|otcqx|otc|tsxv?|cse|asx|lse|aim)\\s*:\\s*[a-z.]+\\)",
  /** Canadian / non-US venues: halts there are not US market events. */
  foreignVenuePattern: "\\b(?:iiroc|ciro|tsxv?|tsx venture|cse|canadian securities exchange|neo exchange|cboe canada|asx|lse|aim)\\b",
  /** Words that make a headline about the market as a whole. */
  marketWords: ["stocks", "stock market", "markets", "wall street", "s&p", "s&p 500", "nasdaq composite", "dow", "russell", "treasury", "treasuries", "yields", "economy", "economic", "u.s.", "us ", "fed", "fomc", "white house", "trump", "congress", "tariff", "tariffs", "oil", "dollar", "futures", "nyse", "exchange-wide", "market-wide", "cboe", "cme"],
};
