/** Postgres access for the entry advisor. */

import { ENTRY } from "@/config/entry";
import { query as q } from "../db";
import type { OoExport } from "./contract";
import type { BookSnapshot } from "./packet";

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const dateStr = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : new Date(v as string).toISOString().slice(0, 10));

// ---------------------------------------------------------------- settings / versions

export interface EntrySettings {
  enabled: boolean;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}
export const DEFAULT_ENTRY_SETTINGS: EntrySettings = { enabled: true, model: "", effort: ENTRY.defaultEffort };

export async function loadEntrySettings(): Promise<EntrySettings> {
  const rows = await q(`SELECT value FROM settings WHERE key = 'entry'`);
  return { ...DEFAULT_ENTRY_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export async function saveEntrySettings(s: EntrySettings): Promise<void> {
  await q(`INSERT INTO settings (key, value, updated_at) VALUES ('entry', $1, now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`, [JSON.stringify(s)]);
}

export interface EntryVersion {
  id: number;
  hash: string;
  model: string;
  effort: string;
  createdAt: string;
}
const toVersion = (r: Record<string, any>): EntryVersion => ({ id: Number(r.id), hash: r.hash, model: r.model, effort: r.effort, createdAt: iso(r.created_at)! });

export async function ensureEntryVersion(hash: string, model: string, effort: string, spec: unknown): Promise<EntryVersion> {
  await q(`INSERT INTO entry_versions (hash, model, effort, spec) VALUES ($1,$2,$3,$4) ON CONFLICT (hash) DO NOTHING`, [hash, model, effort, JSON.stringify(spec)]);
  return toVersion((await q(`SELECT * FROM entry_versions WHERE hash = $1`, [hash]))[0]);
}

export async function listEntryVersions(): Promise<EntryVersion[]> {
  return (await q(`SELECT * FROM entry_versions ORDER BY id`)).map(toVersion);
}

// ---------------------------------------------------------------- calls

export interface CallRow {
  versionId: number;
  entryId: string;
  bot: string | null;
  match: string;
  matchConfidence: number;
  matchReason: string | null;
  filledAt: string;
  detectedAt: string;
  loggedAt: string;
  latencyMs: number;
  status: "called" | "no_opinion" | "late" | "error";
  statusReason: string | null;
  verdict: string | null;
  confidence: number | null;
  dayType: string | null;
  reply: unknown;
  replyText: string | null;
  dataOk: boolean | null;
  packetComplete: boolean | null;
  packetHash: string | null;
  packet: unknown;
  modelServed: string | null;
  usage: unknown;
  costUsd: number | null;
  vixChangePct: number | null;
  /** v2: rules | live_profile (oo-trading) | local_profile (this app). */
  matchSource?: string | null;
  /** v2: reply fields cut to the word limit. */
  trimmed?: string[] | null;
}

/** Append a call; null if this entry was already logged for this version. */
export async function logCall(c: CallRow): Promise<number | null> {
  const j = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
  const rows = await q(
    `INSERT INTO entry_calls (version_id, entry_id, bot, match, match_confidence, match_reason, filled_at, detected_at, logged_at, latency_ms, status, status_reason,
       verdict, confidence, day_type, reply, reply_text, data_ok, packet_complete, packet_hash, packet, model_served, usage, cost_usd, vix_change_pct, match_source, trimmed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     ON CONFLICT (version_id, entry_id) DO NOTHING RETURNING id`,
    [
      c.versionId, c.entryId, c.bot, c.match, c.matchConfidence, c.matchReason, c.filledAt, c.detectedAt, c.loggedAt, c.latencyMs, c.status, c.statusReason,
      c.verdict, c.confidence, c.dayType, j(c.reply), c.replyText, c.dataOk, c.packetComplete, c.packetHash, j(c.packet), c.modelServed, j(c.usage), c.costUsd, c.vixChangePct, c.matchSource ?? null, c.trimmed?.length ? j(c.trimmed) : null,
    ],
  );
  return rows.length ? Number(rows[0].id) : null;
}

export async function loggedEntryIds(versionId: number, since: string): Promise<Set<string>> {
  return new Set((await q(`SELECT entry_id FROM entry_calls WHERE version_id = $1 AND filled_at >= $2`, [versionId, since])).map((r) => r.entry_id as string));
}

export async function lastCallAt(versionId: number, since: string): Promise<string | null> {
  return iso((await q(`SELECT max(filled_at) AS t FROM entry_calls WHERE version_id = $1 AND filled_at >= $2`, [versionId, since]))[0]?.t);
}

export interface CallView {
  id: number;
  versionId: number;
  entryId: string;
  bot: string | null;
  match: string;
  matchConfidence: number;
  filledAt: string;
  loggedAt: string;
  latencyMs: number;
  status: string;
  statusReason: string | null;
  verdict: string | null;
  confidence: number | null;
  dayType: string | null;
  reply: any;
  dataOk: boolean | null;
  packetComplete: boolean | null;
  packetHash: string | null;
  costUsd: number | null;
  vixChangePct: number | null;
  matchSource: string | null;
  matchReason: string | null;
  trimmed: string[] | null;
}

const toCall = (r: Record<string, any>): CallView => ({
  id: Number(r.id), versionId: Number(r.version_id), entryId: r.entry_id, bot: r.bot, match: r.match, matchConfidence: Number(r.match_confidence),
  filledAt: iso(r.filled_at)!, loggedAt: iso(r.logged_at)!, latencyMs: Number(r.latency_ms), status: r.status, statusReason: r.status_reason,
  verdict: r.verdict, confidence: num(r.confidence), dayType: r.day_type, reply: r.reply, dataOk: r.data_ok, packetComplete: r.packet_complete,
  packetHash: r.packet_hash, costUsd: num(r.cost_usd), vixChangePct: num(r.vix_change_pct),
  matchSource: r.match_source ?? null, matchReason: r.match_reason ?? null, trimmed: r.trimmed ?? null,
});
const CALL_COLS = `id, version_id, entry_id, bot, match, match_confidence, filled_at, logged_at, latency_ms, status, status_reason, verdict, confidence, day_type, reply, data_ok, packet_complete, packet_hash, cost_usd, vix_change_pct, match_source, match_reason, trimmed`;

export async function callsForVersion(versionId: number): Promise<CallView[]> {
  return (await q(`SELECT ${CALL_COLS} FROM entry_calls WHERE version_id = $1 ORDER BY filled_at`, [versionId])).map(toCall);
}

export async function recentCalls(limit = 100): Promise<CallView[]> {
  return (await q(`SELECT ${CALL_COLS} FROM entry_calls ORDER BY filled_at DESC LIMIT $1`, [limit])).map(toCall);
}

export async function callPacket(id: number) {
  return (await q(`SELECT packet, packet_hash, reply_text FROM entry_calls WHERE id = $1`, [id]))[0] ?? null;
}

// ---------------------------------------------------------------- outcomes, snapshots, market days

export async function upsertOutcomes(outcomes: OoExport["outcomes"], dateOf: (iso: string) => string): Promise<void> {
  for (const o of outcomes) {
    await q(
      `INSERT INTO entry_outcomes (entry_id, bot, date, pl, closed_at, how) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (entry_id) DO UPDATE SET pl = excluded.pl, closed_at = excluded.closed_at, how = excluded.how, bot = excluded.bot, updated_at = now()`,
      [o.entryId, o.bot, dateOf(o.closedAt), o.pl, o.closedAt, o.how],
    );
  }
}

export async function allOutcomes(): Promise<Map<string, { pl: number; date: string; bot: string | null }>> {
  const rows = await q(`SELECT entry_id, bot, date, pl FROM entry_outcomes`);
  return new Map(rows.map((r) => [r.entry_id as string, { pl: Number(r.pl), date: dateStr(r.date), bot: r.bot }]));
}

export async function saveBookSnapshot(asOf: string, book: OoExport["book"]): Promise<void> {
  await q(`INSERT INTO entry_book_snapshots (as_of, book) VALUES ($1, $2)`, [asOf, JSON.stringify(book)]);
  await q(`DELETE FROM entry_book_snapshots WHERE as_of < $1::timestamptz - interval '3 days'`, [asOf]);
}

export async function bookSnapshotsSince(since: string): Promise<BookSnapshot[]> {
  return (await q(`SELECT as_of, book FROM entry_book_snapshots WHERE as_of >= $1 ORDER BY as_of`, [since])).map((r) => ({ asOf: iso(r.as_of)!, book: r.book }));
}

export async function saveQuoteSnapshots(snaps: OoExport["market"]["snapshots"]): Promise<void> {
  for (const s of snaps) await q(`INSERT INTO entry_quote_snapshots (at, spx, vix, vix9d) VALUES ($1,$2,$3,$4) ON CONFLICT (at) DO NOTHING`, [s.at, s.spx, s.vix, s.vix9d]);
  const newest = snaps.map((s) => s.at).sort().at(-1);
  if (newest) await q(`DELETE FROM entry_quote_snapshots WHERE at < $1::timestamptz - interval '3 days'`, [newest]);
}

export async function quoteSnapshotsSince(since: string): Promise<OoExport["market"]["snapshots"]> {
  return (await q(`SELECT at, spx, vix, vix9d FROM entry_quote_snapshots WHERE at >= $1 ORDER BY at`, [since])).map((r) => ({ at: iso(r.at)!, spx: Number(r.spx), vix: num(r.vix), vix9d: num(r.vix9d) }));
}

export async function upsertMarketDay(date: string, vixClose: number | null, vixPrev: number | null): Promise<void> {
  await q(
    `INSERT INTO entry_market_days (date, vix_close, vix_prev_close) VALUES ($1,$2,$3)
     ON CONFLICT (date) DO UPDATE SET vix_close = excluded.vix_close, vix_prev_close = excluded.vix_prev_close, updated_at = now()`,
    [date, vixClose, vixPrev],
  );
}

export async function marketDays(): Promise<Map<string, { vixClose: number | null; vixPrev: number | null }>> {
  return new Map((await q(`SELECT date, vix_close, vix_prev_close FROM entry_market_days`)).map((r) => [dateStr(r.date), { vixClose: num(r.vix_close), vixPrev: num(r.vix_prev_close) }]));
}

// ---------------------------------------------------------------- news summary, human calls, verdicts

export async function newsSummaryFor(date: string): Promise<{ text: string; asOf: string } | null> {
  const r = (await q(`SELECT text, as_of FROM entry_news_summaries WHERE date = $1`, [date]))[0];
  return r ? { text: r.text, asOf: iso(r.as_of)! } : null;
}

export async function saveNewsSummary(date: string, asOf: string, text: string, model: string, cost: number | null): Promise<void> {
  await q(`INSERT INTO entry_news_summaries (date, as_of, text, model, cost_usd) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (date) DO NOTHING`, [date, asOf, text, model, cost]);
}

export async function summaryCosts(): Promise<Map<string, number>> {
  return new Map((await q(`SELECT date, cost_usd FROM entry_news_summaries`)).map((r) => [dateStr(r.date), num(r.cost_usd) ?? 0]));
}

export type HumanCall = "normal" | "half" | "skip_afternoon";

/** Insert only; the caller enforces "before 09:30 ET". */
export async function saveHumanCall(date: string, call: HumanCall, reason: string): Promise<boolean> {
  return (await q(`INSERT INTO entry_human_calls (date, call, reason) VALUES ($1,$2,$3) ON CONFLICT (date) DO NOTHING RETURNING 1`, [date, call, reason])).length > 0;
}

export async function humanCalls(): Promise<Map<string, { call: HumanCall; reason: string; createdAt: string }>> {
  return new Map((await q(`SELECT date, call, reason, created_at FROM entry_human_calls`)).map((r) => [dateStr(r.date), { call: r.call, reason: r.reason, createdAt: iso(r.created_at)! }]));
}

export async function entryVerdict(versionId: number) {
  const r = (await q(`SELECT verdict, decided_at FROM entry_verdicts WHERE version_id = $1`, [versionId]))[0];
  return r ? { verdict: r.verdict as string, decidedAt: iso(r.decided_at)! } : null;
}

export async function recordEntryVerdict(versionId: number, verdict: "pass" | "fail", detail: unknown): Promise<void> {
  await q(`INSERT INTO entry_verdicts (version_id, verdict, detail) VALUES ($1,$2,$3) ON CONFLICT (version_id) DO NOTHING`, [versionId, verdict, JSON.stringify(detail)]);
}

/** The Book advisor's 10:50 calls (llm source), per day and strategy, with when they were made. */
export async function morningCalls(): Promise<Array<{ date: string; strategy: string; call: string; reason: string; createdAt: string }>> {
  return (await q(`SELECT date, strategy, call, reason, created_at FROM decisions WHERE source = 'llm' AND call <> 'error'`)).map((r) => ({
    date: dateStr(r.date), strategy: r.strategy, call: r.call, reason: r.reason, createdAt: iso(r.created_at)!,
  }));
}

// ---------------------------------------------------------------- account net liquidation value

/** Store the NLV readings an export carries (live now, plus each end of day at 16:00 ET). */
export async function saveNlv(account: OoExport["account"], eodAt: (date: string) => string): Promise<void> {
  if (!account) return;
  const rows: Array<[string, number, string]> = account.eod.map((e) => [eodAt(e.date), e.netLiq, "eod"]);
  if (account.netLiq !== null) rows.push([account.asOf, account.netLiq, "live"]);
  for (const [at, v, src] of rows) await q(`INSERT INTO entry_nlv (at, net_liq, source) VALUES ($1,$2,$3) ON CONFLICT (at) DO NOTHING`, [at, v, src]);
}

export interface NlvPoint { at: string; netLiq: number }

/** Latest NLV at or before `at`, and the highest NLV from `since` (ET date, 00:00 UTC-ish bound) up to `at`. */
export async function nlvAt(at: string, sinceIso: string): Promise<{ current: NlvPoint | null; high: NlvPoint | null }> {
  const cur = await q(`SELECT at, net_liq FROM entry_nlv WHERE at <= $1 ORDER BY at DESC LIMIT 1`, [at]);
  const hi = await q(`SELECT at, net_liq FROM entry_nlv WHERE at >= $1 AND at <= $2 ORDER BY net_liq DESC, at LIMIT 1`, [sinceIso, at]);
  const pt = (r?: Record<string, any>) => (r ? { at: iso(r.at)!, netLiq: Number(r.net_liq) } : null);
  return { current: pt(cur[0]), high: pt(hi[0]) };
}
