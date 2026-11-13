/**
 * Fill morning_history (SPY 30-min ATR at 10:50 ET per past session) from Alpaca's historical 1-min bars, so the
 * rule baseline has its 60+ days of history. Runs a small batch on cron ticks outside the trading window, newest
 * days first, until the lookback is covered. Read-only market data; no LLM.
 */

import { RULES, SCHEDULE } from "@/config/rules";
import type { AlpacaClient } from "./alpaca";
import * as store from "./db";
import { computeFeatures } from "./features";
import { addDays, etToUtc, priorSession, toEt } from "./time";

export async function backfillAtrBatch(alpaca: AlpacaClient, now: Date, opts: { maxDays?: number; lookbackDays?: number } = {}) {
  const lookback = opts.lookbackDays ?? RULES.atrLookbackDays;
  const today = toEt(now).date;
  // Enough calendar to cover the lookback plus each day's prior session.
  const sessions = (await alpaca.getCalendar(addDays(today, -Math.ceil(lookback * 1.6) - 10), addDays(today, -1))).filter((s) => s.date < today);
  const want = sessions.slice(-lookback);
  const have = await store.morningHistoryDates(want[0]?.date ?? today);
  const missing = want.filter((s) => !have.has(s.date)).reverse().slice(0, opts.maxDays ?? 10);
  if (!missing.length) return { filled: 0, missing: 0, have: have.size };
  const feed = await alpaca.resolveFeed({ forced: process.env.ALPACA_FEED });
  let filled = 0;
  for (const session of missing) {
    const prior = priorSession(sessions, session.date);
    if (!prior) {
      // Oldest day in the window: no prior session to measure from; record it so it isn't retried.
      await store.upsertMorningHistory(session.date, null, null, "backfill");
      continue;
    }
    const asOf = etToUtc(session.date, SCHEDULE.decisionAt);
    const priorCloseUtc = etToUtc(prior.date, prior.close);
    const bars = await alpaca.getBars({ symbols: ["SPY"], start: new Date(priorCloseUtc.getTime() - 5 * 60000), end: asOf, feed });
    const f = computeFeatures({ session, prior, asOf, bars: bars.filter((b) => Date.parse(b.ts) < asOf.getTime()), news: [], feed });
    // A null ATR (no bars) is stored too, so the day isn't fetched again; it doesn't count as history.
    await store.upsertMorningHistory(session.date, f.atr30_bp, f.spy_ret_prev_close_pct, "backfill");
    if (f.atr30_bp !== null) filled++;
  }
  return { filled, missing: want.filter((s) => !have.has(s.date)).length - missing.length, have: have.size + filled };
}
