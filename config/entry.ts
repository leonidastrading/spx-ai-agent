/**
 * Entry advisor (shadow mode): fixed rules. Code constants, part of each frozen
 * version; not editable in the UI.
 */

export const ENTRY = {
  /** Packet layout version: bump when the packet's shape or contents change (starts a new version). */
  packetLayout: 2,
  /** Below this bot-match confidence the call is logged "no opinion" (no model call). */
  matchMinConfidence: 0.6,
  /** Account drawdown in the packet: Schwab net liquidation value against its high since this date. */
  drawdownSince: "2026-10-19",
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
  /** Word limits in the reply (v3: 40; at 25, 5 of 6 calls on Nov 12, 2026 had text cut). */
  maxReasonWords: 40,
  /** Human pre-open call: "skip afternoon group" skips entries at or after this ET time. */
  afternoonFrom: "12:00",
  defaultModel: "claude-opus-5-5",
  /** Low effort keeps the reply fast enough for the 60-second target. */
  defaultEffort: "low" as const,
  /** Bands for the "by confidence" table. */
  confidenceBands: [0, 50, 65, 80, 101],
};

/**
 * How bots actually fill at Schwab, for entries oo-trading's structure rules don't match (e.g. Nov 11, 2026: the
 * 13:30 8SMA IC and the 13:35 $8 IC both filled as iron condors with puts 55 / calls 50 wide). Learned from the
 * live fills Oct 19 – Nov 11, 2026; credit is per contract set in index points, widths in points.
 * Used only when the export itself has no confident match (its own Live-tab attribution comes first).
 */
export interface LiveProfile {
  bot: string;
  kind: "iron_condor";
  dte: number;
  /** Usual entry times, HH:MM ET. */
  times: string[];
  credit: [number, number];
  /** Tie-breaker only: lot count changes with sizing, so it never lowers a match's confidence. */
  contracts: [number, number];
  putWidth: [number, number];
  callWidth: [number, number];
}
export const LIVE_PROFILES: LiveProfile[] = [
  { bot: "8SMA IC", kind: "iron_condor", dte: 0, times: ["13:30"], credit: [7, 11], contracts: [10, 30], putWidth: [20, 60], callWidth: [45, 105] },
  { bot: "$8 IC", kind: "iron_condor", dte: 0, times: ["13:35"], credit: [12, 17.5], contracts: [5, 15], putWidth: [45, 60], callWidth: [45, 60] },
  { bot: "5d IC", kind: "iron_condor", dte: 0, times: ["13:30", "14:30"], credit: [0.3, 3], contracts: [8, 20], putWidth: [95, 105], callWidth: [95, 105] },
];

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
