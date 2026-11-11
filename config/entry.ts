/**
 * Entry advisor (shadow mode): fixed rules. Code constants, part of each frozen
 * version; not editable in the UI.
 */

export const ENTRY = {
  /** Packet layout version: bump when the packet's shape or contents change (starts a new version). */
  packetLayout: 1,
  /** Advice should be logged within this many seconds of Schwab's fill time... */
  targetLatencySeconds: 60,
  /** ...and is logged "late" and excluded from scoring beyond this. */
  lateAfterSeconds: 120,
  /** How the poll loop runs inside one cron invocation (cron-job.org calls once a minute). */
  pollEverySeconds: 10,
  loopSeconds: 50,
  /** A quote older than this at the entry time is flagged to the model as stale. */
  maxQuoteAgeSeconds: 15,
  /** reduce = half size. */
  reduceFraction: 0.5,
  /** Random-skip baseline: permutations of the verdicts within each bot. */
  randomPermutations: 1000,
  gatePercentile: 0.95,
  /** Simple-rule baseline: reduce everything when VIX is up more than this on the day at entry. */
  ruleVixUpPct: 10,
  /** Decision gate: after this many scored entries AND trading days. */
  gateMinEntries: 300,
  gateMinTradingDays: 40,
  /** Word limits in the reply. */
  maxReasonWords: 25,
  /** Human pre-open call: "skip afternoon group" skips entries at or after this ET time. */
  afternoonFrom: "12:00",
  defaultModel: "claude-opus-5-5",
  /** Low effort keeps the reply fast enough for the 60-second target. */
  defaultEffort: "low" as const,
  /** Bands for the "by confidence" table. */
  confidenceBands: [0, 50, 65, 80, 101],
};

/**
 * Day-type definitions, fixed before scoring starts. Computed after the close
 * from SPY 1-minute regular-session bars and VIX daily closes, first match wins:
 *  1. vol_expansion: VIX close ≥ 10% above the prior close AND day range (H−L)/O ≥ 1.2%.
 *  2. trend_up:   (C−O)/O ≥ +0.6% AND the close is in the top 25% of the day's range.
 *  3. trend_down: (C−O)/O ≤ −0.6% AND the close is in the bottom 25% of the day's range.
 *  4. reversal:   the move from the open to 12:00 ET is ≥ 0.5% in one direction AND the close is on
 *                 the other side of the open.
 *  5. range:      everything else.
 * "unclear" is never a correct answer; accuracy is shown with and without "unclear" calls.
 */
export const DAY_TYPE_RULES = {
  volVixUpPct: 10,
  volRangePct: 1.2,
  trendPct: 0.6,
  trendCloseQuartile: 0.25,
  reversalMorningPct: 0.5,
  reversalCheckpoint: "12:00",
};
