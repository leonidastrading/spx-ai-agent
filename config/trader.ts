/**
 * AI day-trader paper test: hard limits. These are code constants on purpose —
 * not editable in Settings — and are part of each version's frozen rules.
 */

export const TRADER = {
  symbol: "QQQ",
  contextSymbols: ["SPY", "IWM", "TLT", "VIXY"],
  /** Reference notional: buy-and-hold baseline, the 3× illustration and the daily loss limit. */
  notional: 10_000,
  /** v4: dollars lost if the stop is hit (before slippage). Shares = this ÷ stop distance, capped at maxNotional. */
  riskPerTrade: 50,
  maxNotional: 20_000,
  maxTradesPerDay: 3,
  /** Server-clock ET times. */
  firstEntry: "09:35",
  lastEntry: "15:30",
  flatBy: "15:55",
  decisionEveryMinutes: 5,
  /** Daily stop: no new entries after this many consecutive losers... */
  maxConsecutiveLosses: 2,
  /** ...or a day's realized loss of this fraction of notional. */
  dailyLossFraction: 0.015,
  /**
   * v4: stop distance bounds in multiples of ATR(atrPeriod) on regular-session 15-min bars, so stops widen on
   * volatile days (and share count shrinks to keep riskPerTrade), never below stopFloorFraction or above
   * stopCapFraction of price. Target >= targetMinMultiple × stop distance.
   */
  atrPeriod: 14,
  stopMinAtr: 0.5,
  stopMaxAtr: 2.5,
  stopFloorFraction: 0.001,
  stopCapFraction: 0.02,
  targetMinMultiple: 1,
  /** v4: stop and target are fixed at entry; the code moves the stop to the entry price once, when the trade is ahead by this many R. */
  breakevenAtR: 1,
  /** v4: "confidence" is the stated chance (%) that the target is hit before the stop; entries below this are rejected. */
  minTargetProbability: 55,
  minHoldMinutes: 5,
  /** Slippage assumed for "net" results: $ per share, each way. */
  slippagePerShare: 0.01,
  /** Data guards (v4: bars only; the quote is not used, see the prompt's feed note). */
  maxClockSkewSeconds: 5,
  /** Minutes of 1-min bars checked for gaps before a decision... */
  barCompletenessMinutes: 15,
  /** ...of which this many may be missing (v2; the free IEX feed skips minutes with no trades). The latest closed
   *  minute must always be there. */
  maxMissingBars: 1,
  /** Thesis word limit: longer theses are trimmed and flagged (v2), not rejected. */
  maxThesisWords: 40,
  /** Alert when this many decision cycles pass without a heartbeat. */
  missedCyclesAlert: 3,
  /** Random-entry baseline: simulated trades per real trade. */
  randomSimsPerTrade: 20,
  /** Decision gate (v4: 100 trades and 40 trading days, about ten weeks at two trades a day). */
  gateMinTrades: 100,
  gateMinTradingDays: 40,
  /** VWAP-side rule baseline (scoring only): at each decision slot while flat, long above VWAP, short below. */
  vwapRule: { stopAtr: 1, targetMultiple: 1.5, holdMinutes: 60 },
  gatePercentile: 0.95,
  /** "3× hypothetical" multiplier (TQQQ/SQQQ illustration only). */
  hypotheticalMultiple: 3,
  defaultModel: "claude-opus-5-5",
  defaultEffort: "medium" as const,
};

/** Approximate list prices, $ per million tokens (input, output). Update if prices change. */
export const MODEL_PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/** Part B: swing ideas sleeve. */
export const SWING = {
  /** Base for the sleeve's return %; not a limit on idea sizes. */
  sleeve: 100_000,
  verdictClosedIdeas: 30,
  verdictMonths: 6,
  /** Reserved for the day trader, and leveraged/inverse funds (no leverage in either part). */
  blockedTickers: [
    "QQQ", "TQQQ", "SQQQ", "QLD", "QID", "SPXL", "SPXS", "SPXU", "UPRO", "SSO", "SDS", "SH", "PSQ",
    "TNA", "TZA", "UDOW", "SDOW", "SOXL", "SOXS", "LABU", "LABD", "TECL", "TECS", "FAS", "FAZ",
    "UVXY", "SVXY", "VXX", "UVIX", "SVIX", "NVDL", "TSLL", "TSLQ", "BITX", "YINN", "YANG",
  ],
};
