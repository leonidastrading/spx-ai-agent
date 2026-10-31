/** Thresholds and market constants. Shared by the live cron and the backfill. */

export const SYMBOLS = ["SPY", "QQQ", "IWM", "TLT", "VIXY"] as const;
export type Symbol = (typeof SYMBOLS)[number];

export const RULES = {
  /** "reduce" if today's 30-min ATR is at/above this percentile of the trailing window. */
  atrPercentile: 0.9,
  /** Trailing window length in trading days for the ATR percentile. */
  atrLookbackDays: 250,
  /** Minimum history needed before the ATR leg of the rule is applied. */
  atrMinHistoryDays: 60,
  /** "reduce" if SPY is below the prior close by more than this many percent at decision time. */
  spyDownPct: 1.0,
};

export const SCHEDULE = {
  /** Data collection window, ET. */
  windowStart: "09:30",
  windowEnd: "10:50",
  /** Decision time, ET. Features at this time use bars that started before it. */
  decisionAt: "10:50",
  /** Email time, ET. */
  emailAt: "10:51",
  /**
   * If the cron missed the exact minute, the decision/email still run up to
   * this time (before the 11:11 "Short" entry). Ingestion stops at windowEnd.
   */
  catchUpUntil: "11:05",
  /** Minutes over which the opening ATR is measured. */
  atrMinutes: 30,
};

export const LLM = {
  defaultModel: "claude-opus-5-5",
  maxHeadlines: 30,
};
