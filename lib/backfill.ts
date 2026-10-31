/** Pure helpers for scripts/backfill.ts (chunking and the per-day feature loop). */

import { RULES, SCHEDULE } from "@/config/rules";
import type { Bar, Feed } from "./alpaca";
import { ruleDecision } from "./decision";
import { FEATURE_COLUMNS, computeFeatures, type Features } from "./features";
import { DEFAULT_KEYWORDS, type Headline, type KeywordConfig } from "./news";
import { addDays, etToUtc, isEarlyClose, priorSession, type Session } from "./time";

export interface MonthChunk {
  /** "YYYY-MM" */
  key: string;
  /** first date included, YYYY-MM-DD */
  from: string;
  /** last date included, YYYY-MM-DD */
  to: string;
}

/** Calendar-month chunks covering [from, to], clipped at both ends. */
export function monthChunks(from: string, to: string): MonthChunk[] {
  const out: MonthChunk[] = [];
  let cur = from;
  while (cur <= to) {
    const [y, m] = cur.split("-").map(Number);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const end = monthEnd < to ? monthEnd : to;
    out.push({ key: cur.slice(0, 7), from: cur, to: end });
    cur = addDays(end, 1);
  }
  return out;
}

/** UTC bounds for a chunk: ET midnight of `from` to ET midnight after `to`. */
export function chunkBounds(c: { from: string; to: string }): { start: Date; end: Date } {
  return { start: etToUtc(c.from, "00:00"), end: etToUtc(addDays(c.to, 1), "00:00") };
}

/** Keep only bars inside some session's regular hours. */
export function regularSessionOnly(bars: Bar[], sessions: Session[]): Bar[] {
  const windows = new Map(sessions.map((s) => [s.date, [etToUtc(s.date, s.open).getTime(), etToUtc(s.date, s.close).getTime()]]));
  return bars.filter((b) => {
    const t = Date.parse(b.ts);
    // A bar's ET date is its UTC date shifted back 4-5h; checking the UTC date and the day before covers both.
    const d = b.ts.slice(0, 10);
    for (const key of [d, addDays(d, -1)]) {
      const w = windows.get(key);
      if (w && t >= w[0] && t < w[1]) return true;
    }
    return false;
  });
}

export function morningColumns(kc: KeywordConfig = DEFAULT_KEYWORDS): string[] {
  return [...FEATURE_COLUMNS, ...kc.categories.map((c) => `kw_${c.key}`), "early_close", "atr30_pct_rank", "atr30_history_days", "rule_call"];
}

export const MORNING_COLUMNS: string[] = morningColumns();

export type MorningRow = Features & {
  early_close: boolean;
  atr30_pct_rank: number | null;
  atr30_history_days: number;
  rule_call: string;
};

/**
 * Features at the decision time (10:50 ET) for each session, plus the
 * mechanical rule call using the trailing ATR history built up in order.
 * `atrHistory` is mutated (appended) so callers can stream month by month.
 */
export function morningRows(args: {
  sessions: Session[];
  allSessions: Session[];
  bars: Bar[];
  news: Headline[];
  feed: Feed;
  atrHistory: number[];
  keywords?: KeywordConfig;
  rules?: typeof RULES;
}): MorningRow[] {
  const rules = args.rules ?? RULES;
  const out: MorningRow[] = [];
  // Regular-session bars always share the UTC date with their ET session date.
  const byDate = new Map<string, Bar[]>();
  for (const b of args.bars) {
    const d = b.ts.slice(0, 10);
    const list = byDate.get(d);
    if (list) list.push(b);
    else byDate.set(d, [b]);
  }
  const news = [...args.news].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const session of args.sessions) {
    const prior = priorSession(args.allSessions, session.date);
    if (!prior) continue;
    const asOf = etToUtc(session.date, SCHEDULE.decisionAt);
    const from = etToUtc(prior.date, prior.close).toISOString();
    const to = asOf.toISOString();
    const f = computeFeatures({
      session,
      prior,
      asOf,
      bars: [...(byDate.get(prior.date) ?? []), ...(byDate.get(session.date) ?? [])],
      news: news.slice(lowerBound(news, from), lowerBound(news, to)),
      feed: args.feed,
      keywords: args.keywords,
    });
    const rule = ruleDecision(f, args.atrHistory, rules);
    out.push({
      ...f,
      early_close: isEarlyClose(session),
      atr30_pct_rank: rule.atrPctRank === null ? null : Number(rule.atrPctRank.toFixed(4)),
      atr30_history_days: rule.historyDays,
      rule_call: rule.call,
    });
    if (f.atr30_bp !== null) {
      args.atrHistory.push(f.atr30_bp);
      if (args.atrHistory.length > rules.atrLookbackDays) args.atrHistory.shift();
    }
  }
  return out;
}

/** First index whose ts >= iso (news sorted by ts). */
function lowerBound(news: Headline[], iso: string): number {
  let lo = 0;
  let hi = news.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (news[mid].ts < iso) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
