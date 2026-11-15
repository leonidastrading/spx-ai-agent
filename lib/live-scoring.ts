/**
 * Score the 10:50 calls on the book's live Schwab fills (since Oct 19, 2026). Pure.
 *
 *  - A call is matched to that bot's entries on the same ENTRY date, filled at or after 10:50 ET (a fill before
 *    the call couldn't have followed it). The day's P/L for the bot is the sum of those entries' realized P/L.
 *  - A bot that didn't enter that day is "n/a – no entry" and left out of every statistic.
 *  - LLM calls are reported per version; the rule baseline only where it was active (60+ days of ATR history).
 *  - Legacy strategies (not in Settings, e.g. "2DTE", "VIX-up") and error rows are dropped.
 */

import { SCHEDULE } from "@/config/rules";
import { settingsBotFor, type BookEntryRow, LIVE_SINCE } from "./book-entries";
import { ruleInactive } from "./decision";
import { coinFlipBaseline, scoreDecisions, withTotals, type CoinFlipRow, type ScoreRow, type ScoredDecision } from "./scoring";
import { etToUtc } from "./time";

export interface CallRow {
  date: string;
  strategy: string;
  source: string;
  call: string;
  reason: string;
  version_id: number | null;
}

export type DayStatus =
  | { kind: "scored"; pl: number; entries: number }
  | { kind: "no_entry" }
  | { kind: "before_call"; entries: number }
  | { kind: "awaiting_pl"; entries: number; open: number }
  | { kind: "not_synced" };

export const STATUS_LABEL: Record<DayStatus["kind"], string> = {
  scored: "scored",
  no_entry: "n/a – no entry",
  before_call: "entered before the 10:50 call",
  awaiting_pl: "awaiting P/L (still open)",
  not_synced: "fills not synced yet",
};

export interface LiveScore {
  rows: ScoreRow[];
  coin: CoinFlipRow[];
  /** Per source: pooled coin-flip p-value and the number of entries behind the ALL row. */
  all: Record<string, { pValue: number | null; entries: number; reliable: boolean }>;
  /** date → bot → status, for the dashboard and diagnostics. */
  status: Map<string, Map<string, DayStatus>>;
  /** Per bot: call days with no matched P/L, and why. */
  diagnostics: Array<{ bot: string; callDays: number; scoredDays: number; reasons: Record<string, number>; examples: string[] }>;
  /** Fills that map to no bot in Settings, with why (name mismatch, unknown VIX, unattributed). */
  unmapped: Array<{ date: string; rawBot: string | null; note: string; couldBe: string[] }>;
  scoredEntries: number;
  sources: string[];
}

/** Settings bots an unmapped fill could belong to: both VIX variants when VIX is unknown, every bot when unattributed. */
function couldBe(rawBot: string | null, names: string[]): string[] {
  if (!rawBot) return names;
  const both = [settingsBotFor({ rawBot, vixAtEntry: 10 }, names).bot, settingsBotFor({ rawBot, vixAtEntry: 30 }, names).bot];
  return [...new Set(both.filter((x): x is string => !!x))];
}

export const MIN_ENTRIES = 300;
export const MAX_P = 0.05;

/** source label: "LLM v2", "LLM v1", "Rule". */
const sourceLabel = (d: CallRow, versionNumber: (id: number | null) => number) => (d.source === "llm" ? `LLM v${versionNumber(d.version_id)}` : "Rule");

export function buildLiveScore(args: {
  calls: CallRow[];
  entries: BookEntryRow[];
  names: string[];
  versionNumber: (id: number | null) => number;
  /** Days up to this ET date are known to be synced (entries absent = no entry). */
  syncedThrough: string | null;
  sims?: number;
}): LiveScore {
  const { names } = args;
  const callAt = (date: string) => etToUtc(date, SCHEDULE.decisionAt).getTime();

  // Entries per (date, settings bot); unmapped ones listed.
  const byDayBot = new Map<string, BookEntryRow[]>();
  const unmapped: LiveScore["unmapped"] = [];
  for (const e of args.entries) {
    if (e.entryDate < LIVE_SINCE) continue;
    const m = settingsBotFor(e, names);
    if (!m.bot) {
      unmapped.push({ date: e.entryDate, rawBot: e.rawBot, note: m.note ?? "unmapped", couldBe: couldBe(e.rawBot, names) });
      continue;
    }
    const k = `${e.entryDate}|${m.bot}`;
    byDayBot.set(k, [...(byDayBot.get(k) ?? []), e]);
  }

  const calls = args.calls.filter((d) => d.date >= LIVE_SINCE && names.includes(d.strategy) && d.call !== "error" && !(d.source === "rule" && ruleInactive(d.reason)));

  const status = new Map<string, Map<string, DayStatus>>();
  const statusFor = (date: string, bot: string): DayStatus => {
    const cached = status.get(date)?.get(bot);
    if (cached) return cached;
    const all = byDayBot.get(`${date}|${bot}`) ?? [];
    const after = all.filter((e) => Date.parse(e.filledAt) >= callAt(date));
    let s: DayStatus;
    if (!all.length) s = args.syncedThrough && date <= args.syncedThrough ? { kind: "no_entry" } : { kind: "not_synced" };
    else if (!after.length) s = { kind: "before_call", entries: all.length };
    else if (after.some((e) => e.pl === null)) s = { kind: "awaiting_pl", entries: after.length, open: after.filter((e) => e.pl === null).length };
    else s = { kind: "scored", pl: Math.round(after.reduce((a, e) => a + (e.pl ?? 0), 0) * 100) / 100, entries: after.length };
    if (!status.has(date)) status.set(date, new Map());
    status.get(date)!.set(bot, s);
    return s;
  };

  const scored: ScoredDecision[] = [];
  const outcomes: Array<{ date: string; strategy: string; pl: number; entries: number }> = [];
  const seenOutcome = new Set<string>();
  for (const d of calls) {
    const s = statusFor(d.date, d.strategy);
    if (s.kind !== "scored") continue;
    // Each source is scored on its own rows; the outcome key is shared.
    scored.push({ date: d.date, strategy: d.strategy, source: sourceLabel(d, args.versionNumber), call: d.call as ScoredDecision["call"] });
    const k = `${d.date}|${d.strategy}`;
    if (!seenOutcome.has(k)) {
      seenOutcome.add(k);
      outcomes.push({ date: d.date, strategy: d.strategy, pl: s.pl, entries: s.entries });
    }
  }

  const rows = withTotals(scoreDecisions(scored, outcomes));
  const coin = coinFlipBaseline(scored, outcomes, { sims: args.sims });
  const sources = [...new Set(scored.map((s) => s.source))].sort();
  const entriesOf = new Map(outcomes.map((o) => [`${o.date}|${o.strategy}`, o.entries]));
  const all: LiveScore["all"] = {};
  for (const src of sources) {
    const mine = scored.filter((s) => s.source === src);
    // Pooled coin flip: every (day, bot) of this source as one sample.
    const pooled = coinFlipBaseline(
      mine.map((s) => ({ ...s, date: `${s.date}|${s.strategy}`, strategy: "ALL" })),
      mine.map((s) => ({ date: `${s.date}|${s.strategy}`, strategy: "ALL", pl: outcomes.find((o) => o.date === s.date && o.strategy === s.strategy)!.pl })),
      { sims: args.sims },
    )[0];
    const entries = mine.reduce((a, s) => a + (entriesOf.get(`${s.date}|${s.strategy}`) ?? 0), 0);
    const pValue = pooled && pooled.skipDays + pooled.reduceDays > 0 ? pooled.pValue : null;
    all[src] = { pValue, entries, reliable: pValue !== null && pValue <= MAX_P && entries >= MIN_ENTRIES };
  }

  const diagnostics: LiveScore["diagnostics"] = [];
  for (const bot of names) {
    const days = [...new Set(calls.filter((c) => c.strategy === bot).map((c) => c.date))].sort();
    const reasons: Record<string, number> = {};
    const examples: string[] = [];
    let scoredDays = 0;
    for (const date of days) {
      const s = statusFor(date, bot);
      if (s.kind === "scored") {
        scoredDays++;
        continue;
      }
      let why: string = STATUS_LABEL[s.kind];
      // A day with no entry for this bot but unmapped fills could be a name mismatch.
      if (s.kind === "no_entry" && unmapped.some((u) => u.date === date && u.couldBe.includes(bot))) why = "no entry matched (a fill that day couldn't be attributed)";
      reasons[why] = (reasons[why] ?? 0) + 1;
      if (examples.length < 5) examples.push(`${date}: ${why}`);
    }
    diagnostics.push({ bot, callDays: days.length, scoredDays, reasons, examples });
  }

  return { rows, coin, all, status, diagnostics, unmapped, scoredEntries: outcomes.reduce((a, o) => a + o.entries, 0), sources };
}
