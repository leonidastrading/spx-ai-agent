/**
 * Morning features. Pure: the same function produces the live per-minute rows
 * and the backfill's morning_features.csv (evaluated at 10:50 ET).
 *
 * Point-in-time rule: features "as of" T use only bars whose 1-minute interval
 * has fully closed by T (bar start < T) and headlines created before T.
 */

import { SCHEDULE } from "@/config/rules";
import type { Bar, Feed } from "./alpaca";
import { keywordCounts, type Headline } from "./news";
import { etToUtc, type Session } from "./time";

export interface FeatureInput {
  session: Session;
  prior: Session;
  /** As-of instant (exclusive). */
  asOf: Date;
  /** Bars for any symbols, any time; filtered here. Must include the prior session's last minutes. */
  bars: Bar[];
  /** Headlines, any time; filtered here to [prior close, asOf). */
  news: Headline[];
  feed: Feed;
}

export interface Features {
  date: string;
  as_of: string;
  /** Prior session's close (start of the news window), ISO UTC. */
  prior_close_at: string;
  feed: Feed;
  bars_used: number;
  spy_prior_close: number | null;
  spy_open: number | null;
  spy_last: number | null;
  spy_ret_prev_close_pct: number | null;
  spy_ret_open_pct: number | null;
  gap_pct: number | null;
  spy_high: number | null;
  spy_low: number | null;
  range_bp: number | null;
  /** Mean 1-minute true range over the first 30 minutes (or fewer if earlier), bp of the open. */
  atr30_bp: number | null;
  atr30_minutes: number;
  /** (last - low) / (high - low); 0.5 when the range is zero. */
  range_pos: number | null;
  new_highs: number;
  new_lows: number;
  qqq_ret_pct: number | null;
  iwm_ret_pct: number | null;
  qqq_minus_spy_pct: number | null;
  iwm_minus_spy_pct: number | null;
  tlt_ret_pct: number | null;
  vixy_ret_pct: number | null;
  news_since_prior_close: number;
  news_since_open: number;
  [kw: `kw_${string}`]: number;
}

/** Ordered list of numeric/feature columns (for CSV output). */
export const FEATURE_COLUMNS = [
  "date", "as_of", "prior_close_at", "feed", "bars_used",
  "spy_prior_close", "spy_open", "spy_last",
  "spy_ret_prev_close_pct", "spy_ret_open_pct", "gap_pct",
  "spy_high", "spy_low", "range_bp", "atr30_bp", "atr30_minutes", "range_pos",
  "new_highs", "new_lows",
  "qqq_ret_pct", "iwm_ret_pct", "qqq_minus_spy_pct", "iwm_minus_spy_pct",
  "tlt_ret_pct", "vixy_ret_pct",
  "news_since_prior_close", "news_since_open",
] as const;

const round = (x: number | null, dp = 4): number | null => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(dp)));

/** Regular-session bars for one symbol in [open, min(asOf, close)), ascending. */
export function sessionBars(bars: Bar[], symbol: string, session: Session, asOf?: Date): Bar[] {
  const start = etToUtc(session.date, session.open).getTime();
  let end = etToUtc(session.date, session.close).getTime();
  if (asOf) end = Math.min(end, asOf.getTime());
  return bars
    .filter((b) => b.symbol === symbol)
    .filter((b) => {
      const t = Date.parse(b.ts);
      return t >= start && t < end;
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Prior close = close of the last regular-session 1-minute bar of the prior
 * session (15:59 ET normally, 12:59 ET on early-close days).
 */
export function priorClose(bars: Bar[], symbol: string, prior: Session): number | null {
  const sb = sessionBars(bars, symbol, prior);
  return sb.length ? sb[sb.length - 1].c : null;
}

function pct(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return (a / b - 1) * 100;
}

function symbolReturn(bars: Bar[], symbol: string, input: FeatureInput): number | null {
  const pc = priorClose(bars, symbol, input.prior);
  const sb = sessionBars(bars, symbol, input.session, input.asOf);
  return pct(sb.length ? sb[sb.length - 1].c : null, pc);
}

export function computeFeatures(input: FeatureInput): Features {
  const { session, prior, asOf, bars, news, feed } = input;
  const spy = sessionBars(bars, "SPY", session, asOf);
  const pc = priorClose(bars, "SPY", prior);
  const open = spy.length ? spy[0].o : null;
  const last = spy.length ? spy[spy.length - 1].c : null;

  let high: number | null = null;
  let low: number | null = null;
  let newHighs = 0;
  let newLows = 0;
  for (let i = 0; i < spy.length; i++) {
    const b = spy[i];
    if (i === 0) {
      high = b.h;
      low = b.l;
      continue;
    }
    if (b.h > high!) {
      high = b.h;
      newHighs++;
    }
    if (b.l < low!) {
      low = b.l;
      newLows++;
    }
  }

  // 1-minute ATR over the first N minutes. The first bar uses its own high-low
  // (not the overnight gap); later bars use true range vs the previous close.
  const openMs = etToUtc(session.date, session.open).getTime();
  const atrWindow = spy.filter((b) => Date.parse(b.ts) < openMs + SCHEDULE.atrMinutes * 60000);
  let trSum = 0;
  for (let i = 0; i < atrWindow.length; i++) {
    const b = atrWindow[i];
    trSum += i === 0 ? b.h - b.l : Math.max(b.h, atrWindow[i - 1].c) - Math.min(b.l, atrWindow[i - 1].c);
  }
  const atr30 = atrWindow.length && open ? (trSum / atrWindow.length / open) * 1e4 : null;

  const rangeBp = high !== null && low !== null && open ? ((high - low) / open) * 1e4 : null;
  const rangePos =
    high !== null && low !== null && last !== null ? (high > low ? (last - low) / (high - low) : 0.5) : null;

  const spyRet = pct(last, pc);
  const qqq = symbolReturn(bars, "QQQ", input);
  const iwm = symbolReturn(bars, "IWM", input);

  const priorCloseMs = etToUtc(prior.date, prior.close).getTime();
  const asOfMs = asOf.getTime();
  const overnight = news.filter((h) => {
    const t = Date.parse(h.ts);
    return t >= priorCloseMs && t < asOfMs;
  });
  const sinceOpen = overnight.filter((h) => Date.parse(h.ts) >= openMs);

  return {
    date: session.date,
    as_of: asOf.toISOString(),
    prior_close_at: new Date(priorCloseMs).toISOString(),
    feed,
    bars_used: spy.length,
    spy_prior_close: round(pc),
    spy_open: round(open),
    spy_last: round(last),
    spy_ret_prev_close_pct: round(spyRet),
    spy_ret_open_pct: round(pct(last, open)),
    gap_pct: round(pct(open, pc)),
    spy_high: round(high),
    spy_low: round(low),
    range_bp: round(rangeBp, 2),
    atr30_bp: round(atr30, 3),
    atr30_minutes: atrWindow.length,
    range_pos: round(rangePos),
    new_highs: newHighs,
    new_lows: newLows,
    qqq_ret_pct: round(qqq),
    iwm_ret_pct: round(iwm),
    qqq_minus_spy_pct: round(qqq !== null && spyRet !== null ? qqq - spyRet : null),
    iwm_minus_spy_pct: round(iwm !== null && spyRet !== null ? iwm - spyRet : null),
    tlt_ret_pct: round(symbolReturn(bars, "TLT", input)),
    vixy_ret_pct: round(symbolReturn(bars, "VIXY", input)),
    news_since_prior_close: overnight.length,
    news_since_open: sinceOpen.length,
    ...keywordCounts(overnight),
  };
}

/** Headlines in [prior close, asOf) — the window the features and the LLM see. */
export function newsWindow<T extends Headline>(news: T[], prior: Session, asOf: Date): T[] {
  const from = etToUtc(prior.date, prior.close).getTime();
  const to = asOf.getTime();
  return news.filter((h) => {
    const t = Date.parse(h.ts);
    return t >= from && t < to;
  });
}
