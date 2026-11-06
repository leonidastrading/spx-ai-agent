/**
 * The SPX strategies the 10:50 ET call covers, plus the mapping from Option
 * Omega "Strategy" names (trade-log CSV) to these short names. Edit freely.
 */

export interface StrategyDef {
  name: string;
  entryEt: string;
  description: string;
}

export const STRATEGIES: StrategyDef[] = [
  { name: "Short", entryEt: "~11:11", description: "0DTE short call spread after a breakdown below the opening range" },
  { name: "8SMA", entryEt: "13:30", description: "0DTE put-skewed iron condor" },
  { name: "$8 IC", entryEt: "13:35", description: "0DTE iron condor, $8 wings" },
  { name: "5d IC", entryEt: "13:30 and 14:30", description: "0DTE 5-delta iron condor, 100 wide" },
  { name: "BWB", entryEt: "13:50 / 14:20 / 14:50", description: "0DTE put broken-wing butterfly" },
  { name: "2DTE", entryEt: "15:30", description: "2DTE put spread (down-trend days only)" },
  { name: "VIX-up", entryEt: "15:50", description: "1DTE put spreads when VIX is up >=5% on the day" },
  {
    name: "Long",
    entryEt: "~10:56–13:45",
    description: "0DTE short put spread (32Δ, 100 wide) after a breakout above the opening-range high, SPX above 4-day SMA",
  },
  { name: "VIX>30", entryEt: "13:30", description: "1DTE 10Δ put spread, 50 wide, only when VIX ≥ 30" },
  { name: "FOMC", entryEt: "14:35", description: "Long 0DTE ATM straddle, FOMC days only (buys premium; wins on big moves)" },
];

export const STRATEGY_NAMES = STRATEGIES.map((s) => s.name);

/**
 * Option Omega strategy name -> short name. Case-insensitive. A key matches an
 * OO name that equals it or contains it as whole words; the longest matching
 * key wins, so "long straddle" (FOMC) beats any shorter key it contains.
 * Anything unmatched is reported on the upload page and skipped.
 */
export const OO_STRATEGY_MAP: Record<string, string> = {
  "short": "Short",
  "short call spread": "Short",
  "8sma": "8SMA",
  "8 sma": "8SMA",
  "$8 ic": "$8 IC",
  "8 ic": "$8 IC",
  "5d ic": "5d IC",
  "5 delta ic": "5d IC",
  "bwb": "BWB",
  "put bwb": "BWB",
  "2dte": "2DTE",
  "2dte put spread": "2DTE",
  "vix-up": "VIX-up",
  "vix up": "VIX-up",
  // Not plain "long": the FOMC bot's name contains "long straddle".
  "long (sell puts)": "Long",
  "vix>30": "VIX>30",
  "vix > 30": "VIX>30",
  "long straddle": "FOMC",
  "fomc": "FOMC",
};

/**
 * Fallback: if no map key matches, the first rule whose regex matches the OO
 * name wins. Keeps the map short when OO names carry suffixes like "(1:30)".
 * More specific rules come first.
 */
export const OO_STRATEGY_PATTERNS: Array<[RegExp, string]> = [
  [/\bfomc\b|\blong\s+straddle\b/i, "FOMC"],
  [/\blong\s*\(\s*sell\s+puts?\s*\)/i, "Long"],
  [/\bvix\s*(?:>=?|≥)\s*30\b/i, "VIX>30"],
  [/\bvix[\s-]?up\b/i, "VIX-up"],
  [/\b2\s?dte\b/i, "2DTE"],
  [/\bbwb\b|broken[\s-]?wing/i, "BWB"],
  [/\b5\s?d(elta)?\b.*\bic\b/i, "5d IC"],
  [/\$?8\s?(wide\s)?ic\b/i, "$8 IC"],
  [/\b8\s?sma\b/i, "8SMA"],
  [/\bshort\b/i, "Short"],
];
