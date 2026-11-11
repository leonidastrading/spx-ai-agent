/**
 * The contract for oo-trading's read-only export endpoint (see docs/oo-trading-export.md).
 * Validated on every response so a change on the other side fails loudly, not silently.
 */

import { z } from "zod";

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "ISO timestamp");
const leg = z.object({ putCall: z.enum(["P", "C"]), strike: z.number(), qty: z.number(), expiration: z.string() });
const bar = z.object({ t: iso, o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number().optional() });
const quote = z.object({ last: z.number(), quoteTime: iso, prevClose: z.number().nullable() });

export const exportSchema = z.object({
  asOf: iso,
  schwab: z.object({ connected: z.boolean(), fillsFetchedAt: iso.nullable(), errors: z.array(z.string()) }),
  /** Opening entries (grouped fills) since `since`, oldest first. */
  entries: z.array(
    z.object({
      /** Stable id from Schwab order/activity ids hashed; never an account number. */
      id: z.string().min(6).max(80),
      /** Schwab's fill timestamp (latest fill of the entry's legs). */
      filledAt: iso,
      /** When oo-trading first saw the fill (null if unknown). */
      detectedAt: iso.nullable(),
      bot: z.string().nullable(),
      candidates: z.array(z.string()),
      match: z.enum(["exact", "ambiguous", "none"]),
      /** 0–1: how sure the leg/width/expiry/time rules are about the bot. */
      matchConfidence: z.number().min(0).max(1),
      matchReason: z.string(),
      structure: z.string(),
      underlying: z.string(),
      legs: z.array(leg).min(1),
      contracts: z.number(),
      /** Positive = credit received, negative = debit paid, per contract set, in index points. */
      netPrice: z.number(),
      /** The bot's stop and target rules as configured (free text). */
      rules: z.object({ stop: z.string().nullable(), target: z.string().nullable() }),
    }),
  ),
  /** Realized P/L per entry once closed or expired (net of fees), for scoring. */
  outcomes: z.array(z.object({ entryId: z.string(), bot: z.string().nullable(), closedAt: iso, pl: z.number(), how: z.string() })),
  book: z.object({
    today: z.array(z.object({ entryId: z.string(), bot: z.string().nullable(), filledAt: iso, status: z.enum(["open", "closed", "stopped", "expired"]), pl: z.number() })),
    todayTotal: z.number(),
    stoppedOutBots: z.array(z.string()),
    daily: z.array(z.object({ date: z.string(), pl: z.number() })),
    /** <= 0; 0 = at the high. */
    drawdownFromHigh: z.number(),
  }),
  bots: z.record(
    z.string(),
    z.object({
      last10Days: z.array(z.object({ date: z.string(), trades: z.array(z.object({ time: z.string(), pl: z.number() })) })),
      backtest: z.object({
        byEntryTime: z.array(z.object({ time: z.string(), trades: z.number(), winRate: z.number(), avgPl: z.number() })),
        byVixBucket: z.array(z.object({ bucket: z.string(), trades: z.number(), winRate: z.number(), avgPl: z.number() })),
      }),
      liveVsBacktest: z.object({ days: z.number(), livePl: z.number(), backtestPl: z.number(), gap: z.number() }).nullable(),
    }),
  ),
  market: z.object({
    spx: quote,
    vix: quote,
    vix9d: quote.nullable(),
    /** Quote snapshots oo-trading has taken in the last ~10 minutes, oldest first (so a value at or before an entry can be found). */
    snapshots: z.array(z.object({ at: iso, spx: z.number(), vix: z.number().nullable(), vix9d: z.number().nullable() })),
    spxBars1m: z.array(bar),
    spxBars5m5d: z.array(bar),
    spxDaily60: z.array(bar),
    vixDaily15: z.array(bar),
    vix9dDaily15: z.array(bar),
    gauge: z.object({
      today: z.object({ straddle: z.number().nullable(), strike: z.number().nullable(), capturedAt: iso.nullable() }).nullable(),
      avgMoveRatio10d: z.number().nullable(),
    }),
  }),
});

export type OoExport = z.infer<typeof exportSchema>;
export type OoEntry = OoExport["entries"][number];
