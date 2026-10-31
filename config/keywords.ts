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
}

export const KEYWORD_CATEGORIES: KeywordCategory[] = [
  {
    key: "fed",
    label: "Fed / FOMC / Powell",
    terms: ["fed", "federal reserve", "fomc", "powell", "rate cut", "rate hike", "fed funds"],
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
  },
  {
    key: "megacap_negative",
    label: "Mega-cap downgrade / guidance / miss",
    terms: ["downgrade", "downgrades", "downgraded", "cuts guidance", "lowers guidance", "guidance", "misses", "miss", "below estimates", "weak outlook"],
    megaCapOnly: true,
  },
  {
    key: "halt_outage",
    label: "Halt / outage",
    terms: ["halt", "halted", "trading halt", "circuit breaker", "outage", "glitch", "systems issue"],
  },
];
