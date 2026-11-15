/** Postgres access for the AI trader (Part A) and swing ideas (Part B). */

import { TRADER } from "@/config/trader";
import { query as q } from "../db";
import type { Idea, IdeaEvent, IdeaInput } from "../swing/rules";
import type { ClosedTrade, OpenTrade } from "./rules";

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------- settings

export interface TraderSettings {
  enabled: boolean;
  /** Blank = TRADER.defaultModel */
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

export const DEFAULT_TRADER_SETTINGS: TraderSettings = { enabled: false, model: "", effort: TRADER.defaultEffort };

export async function loadTraderSettings(): Promise<TraderSettings> {
  const rows = await q(`SELECT value FROM settings WHERE key = 'trader'`);
  return { ...DEFAULT_TRADER_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export async function saveTraderSettings(s: TraderSettings): Promise<void> {
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ('trader', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [JSON.stringify(s)],
  );
}

// ---------------------------------------------------------------- versions

export interface Version {
  id: number;
  hash: string;
  model: string;
  effort: string;
  createdAt: string;
  /** 1, 2, 3… in creation order (ids skip numbers, so they are not shown). */
  number: number;
}

const toVersion = (r: Record<string, any>): Version => ({ id: Number(r.id), hash: r.hash, model: r.model, effort: r.effort, createdAt: iso(r.created_at)!, number: Number(r.number ?? r.id) });

/** The version row for this exact spec, created on first use. */
export async function ensureVersion(hash: string, model: string, effort: string, spec: unknown): Promise<Version> {
  const sel = () => q(`SELECT id, hash, model, effort, created_at, (SELECT count(*) FROM trader_versions o WHERE o.id <= trader_versions.id) AS number FROM trader_versions WHERE hash = $1`, [hash]);
  // Look first: an INSERT ... ON CONFLICT uses up an id even when the row exists, on every tick.
  let rows = await sel();
  if (!rows.length) {
    await q(`INSERT INTO trader_versions (hash, model, effort, spec) VALUES ($1, $2, $3, $4) ON CONFLICT (hash) DO NOTHING`, [hash, model, effort, JSON.stringify(spec)]);
    rows = await sel();
  }
  return toVersion(rows[0]);
}

export async function listVersions(): Promise<Version[]> {
  return (await q(`SELECT id, hash, model, effort, created_at, (SELECT count(*) FROM trader_versions o WHERE o.id <= trader_versions.id) AS number FROM trader_versions ORDER BY id`)).map(toVersion);
}

export async function versionSpec(id: number): Promise<unknown> {
  return (await q(`SELECT spec FROM trader_versions WHERE id = $1`, [id]))[0]?.spec ?? null;
}

// ---------------------------------------------------------------- lock

/** Take a short lease; false if another tick holds it. */
export async function acquireLock(key: string, seconds: number): Promise<boolean> {
  const rows = await q(
    `INSERT INTO trader_lock (key, until) VALUES ($1, now() + make_interval(secs => $2))
     ON CONFLICT (key) DO UPDATE SET until = excluded.until WHERE trader_lock.until < now()
     RETURNING 1`,
    [key, seconds],
  );
  return rows.length > 0;
}

export async function releaseLock(key: string): Promise<void> {
  // Into the past, so an immediate re-acquire never sees "until = now()" as still held.
  await q(`UPDATE trader_lock SET until = now() - interval '1 second' WHERE key = $1`, [key]);
}

// ---------------------------------------------------------------- decisions

export interface DecisionRow {
  versionId: number;
  slot: string;
  phase: "premarket" | "intraday";
  serverTs: string;
  inputsHash: string | null;
  inputs: unknown;
  reply: unknown;
  replyText: string | null;
  status: "accepted" | "rejected" | "hold" | "no_action" | "error";
  reason: string | null;
  modelServed: string | null;
  usage: unknown;
  costUsd: number | null;
  dataOk: boolean | null;
  newsOk: boolean | null;
}

/** Append a decision. Returns its id, or null if this slot was already decided (another tick). */
export async function logDecision(d: DecisionRow): Promise<number | null> {
  const rows = await q(
    `INSERT INTO trader_decisions (version_id, slot, phase, server_ts, inputs_hash, inputs, reply, reply_text, status, reason, model_served, usage, cost_usd, data_ok, news_ok)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (version_id, slot) DO NOTHING RETURNING id`,
    [
      d.versionId, d.slot, d.phase, d.serverTs, d.inputsHash, d.inputs === null ? null : JSON.stringify(d.inputs),
      d.reply === null ? null : JSON.stringify(d.reply), d.replyText, d.status, d.reason, d.modelServed,
      d.usage === null ? null : JSON.stringify(d.usage), d.costUsd, d.dataOk, d.newsOk,
    ],
  );
  return rows.length ? Number(rows[0].id) : null;
}

export async function slotDecided(versionId: number, slot: string): Promise<boolean> {
  return (await q(`SELECT 1 FROM trader_decisions WHERE version_id = $1 AND slot = $2`, [versionId, slot])).length > 0;
}

export async function lastDecisionTs(versionId: number, date: string): Promise<string | null> {
  const rows = await q(`SELECT max(server_ts) AS ts FROM trader_decisions WHERE version_id = $1 AND slot LIKE $2 AND inputs IS NOT NULL`, [versionId, `${date}%`]);
  return iso(rows[0]?.ts);
}

export async function recentDecisions(limit = 100, versionId?: number) {
  const rows = await q(
    `SELECT d.id, d.version_id, d.slot, d.phase, d.server_ts, d.inputs_hash, d.reply, d.status, d.reason, d.cost_usd, d.data_ok, d.news_ok, d.model_served
     FROM trader_decisions d ${versionId ? "WHERE d.version_id = $2" : ""} ORDER BY d.id DESC LIMIT $1`,
    versionId ? [limit, versionId] : [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    version_id: Number(r.version_id),
    slot: r.slot as string,
    phase: r.phase as "premarket" | "intraday",
    server_ts: iso(r.server_ts),
    inputs_hash: r.inputs_hash as string | null,
    reply: r.reply as unknown,
    status: r.status as DecisionRow["status"],
    reason: r.reason as string | null,
    cost_usd: num(r.cost_usd),
    data_ok: r.data_ok as boolean | null,
    news_ok: r.news_ok as boolean | null,
    model_served: r.model_served as string | null,
  }));
}

export async function decisionInputs(id: number) {
  return (await q(`SELECT inputs, reply_text FROM trader_decisions WHERE id = $1`, [id]))[0] ?? null;
}

export async function costByDay(versionId: number) {
  const rows = await q(
    `SELECT substr(slot, 1, 10) AS date, sum(cost_usd) AS cost, count(*) FILTER (WHERE reply IS NOT NULL) AS calls
     FROM trader_decisions WHERE version_id = $1 GROUP BY 1 ORDER BY 1`,
    [versionId],
  );
  return rows.map((r) => ({ date: r.date as string, cost: num(r.cost) ?? 0, calls: Number(r.calls) }));
}

// ---------------------------------------------------------------- trades

export interface TradeRow {
  id: number;
  versionId: number;
  decisionId: number;
  date: string;
  side: "long" | "short";
  qty: number;
  refPrice: number;
  stopInitial: number;
  stop: number;
  target: number;
  maxHoldMinutes: number;
  confidence: number;
  catalyst: string;
  clientOrderId: string;
  entryOrderId: string | null;
  stopOrderId: string | null;
  targetOrderId: string | null;
  closeOrderId: string | null;
  entryPrice: number | null;
  entryAt: string | null;
  exitPrice: number | null;
  exitAt: string | null;
  exitReason: string | null;
  status: "submitting" | "pending" | "open" | "closing" | "closed" | "failed";
  error: string | null;
}

const toTrade = (r: Record<string, any>): TradeRow => ({
  id: Number(r.id), versionId: Number(r.version_id), decisionId: Number(r.decision_id),
  date: typeof r.date === "string" ? r.date.slice(0, 10) : new Date(r.date).toISOString().slice(0, 10),
  side: r.side, qty: Number(r.qty), refPrice: Number(r.ref_price), stopInitial: Number(r.stop_initial), stop: Number(r.stop),
  target: Number(r.target), maxHoldMinutes: Number(r.max_hold_minutes), confidence: Number(r.confidence), catalyst: r.catalyst,
  clientOrderId: r.client_order_id, entryOrderId: r.entry_order_id, stopOrderId: r.stop_order_id, targetOrderId: r.target_order_id,
  closeOrderId: r.close_order_id, entryPrice: num(r.entry_price), entryAt: iso(r.entry_at), exitPrice: num(r.exit_price),
  exitAt: iso(r.exit_at), exitReason: r.exit_reason, status: r.status, error: r.error,
});

const TRADE_COLS = `id, version_id, decision_id, to_char(date, 'YYYY-MM-DD') AS date, side, qty, ref_price, stop_initial, stop, target, max_hold_minutes,
  confidence, catalyst, client_order_id, entry_order_id, stop_order_id, target_order_id, close_order_id, entry_price, entry_at,
  exit_price, exit_at, exit_reason, status, error`;

export async function createTrade(t: Omit<TradeRow, "id" | "entryOrderId" | "stopOrderId" | "targetOrderId" | "closeOrderId" | "entryPrice" | "entryAt" | "exitPrice" | "exitAt" | "exitReason" | "status" | "error">): Promise<TradeRow> {
  const rows = await q(
    `INSERT INTO trader_trades (version_id, decision_id, date, side, qty, ref_price, stop_initial, stop, target, max_hold_minutes, confidence, catalyst, client_order_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,'submitting') RETURNING ${TRADE_COLS}`,
    [t.versionId, t.decisionId, t.date, t.side, t.qty, t.refPrice, t.stopInitial, t.target, t.maxHoldMinutes, t.confidence, t.catalyst, t.clientOrderId],
  );
  return toTrade(rows[0]);
}

const COLUMN: Record<string, string> = {
  entryOrderId: "entry_order_id", stopOrderId: "stop_order_id", targetOrderId: "target_order_id", closeOrderId: "close_order_id",
  entryPrice: "entry_price", entryAt: "entry_at", exitPrice: "exit_price", exitAt: "exit_at", exitReason: "exit_reason",
  status: "status", error: "error", stop: "stop",
};

export async function updateTrade(id: number, patch: Partial<TradeRow>): Promise<void> {
  const keys = Object.keys(patch).filter((k) => k in COLUMN);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${COLUMN[k]} = $${i + 2}`).join(", ");
  await q(`UPDATE trader_trades SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => (patch as Record<string, unknown>)[k])]);
}

/** Trades not yet final (any day): the engine keeps syncing these. */
export async function activeTrades(): Promise<TradeRow[]> {
  return (await q(`SELECT ${TRADE_COLS} FROM trader_trades WHERE status IN ('submitting','pending','open','closing') ORDER BY id`)).map(toTrade);
}

export async function tradesForDate(date: string, versionId?: number): Promise<TradeRow[]> {
  return (await q(`SELECT ${TRADE_COLS} FROM trader_trades WHERE date = $1 ${versionId ? "AND version_id = $2" : ""} ORDER BY id`, versionId ? [date, versionId] : [date])).map(toTrade);
}

export async function tradesForVersion(versionId: number): Promise<TradeRow[]> {
  return (await q(`SELECT ${TRADE_COLS} FROM trader_trades WHERE version_id = $1 ORDER BY id`, [versionId])).map(toTrade);
}

export async function recordStopChange(tradeId: number, decisionId: number, oldStop: number, newStop: number): Promise<void> {
  await q(`INSERT INTO trader_stop_changes (trade_id, decision_id, old_stop, new_stop) VALUES ($1,$2,$3,$4)`, [tradeId, decisionId, oldStop, newStop]);
}

export function toOpenTrade(t: TradeRow): OpenTrade {
  return { id: t.id, side: t.side, qty: t.qty, entryPrice: t.entryPrice, entryAt: t.entryAt, stop: t.stop, target: t.target, maxHoldMinutes: t.maxHoldMinutes };
}

export function toClosed(t: TradeRow): ClosedTrade | null {
  if (t.status !== "closed" || t.entryPrice === null || t.exitPrice === null || !t.exitAt) return null;
  return { side: t.side, pl: (t.side === "long" ? 1 : -1) * (t.exitPrice - t.entryPrice) * t.qty, exitAt: t.exitAt };
}

// ---------------------------------------------------------------- heartbeats / alerts / days

export async function heartbeat(minuteEt: string, status: "ok" | "skipped" | "error", detail?: string): Promise<void> {
  await q(`INSERT INTO trader_heartbeats (minute_et, status, detail) VALUES ($1, $2, $3)`, [minuteEt, status, detail ?? null]);
}

export async function lastHeartbeat(): Promise<{ ts: string; minuteEt: string; status: string; detail: string | null } | null> {
  const r = (await q(`SELECT ts, minute_et, status, detail FROM trader_heartbeats ORDER BY id DESC LIMIT 1`))[0];
  return r ? { ts: iso(r.ts)!, minuteEt: r.minute_et, status: r.status, detail: r.detail } : null;
}

export async function addAlert(kind: string, message: string): Promise<number> {
  const rows = await q(`INSERT INTO trader_alerts (kind, message) VALUES ($1, $2) RETURNING id`, [kind, message]);
  return Number(rows[0].id);
}

export async function markAlertEmailed(id: number): Promise<void> {
  await q(`UPDATE trader_alerts SET emailed = true WHERE id = $1`, [id]);
}

export async function recentAlerts(limit = 20) {
  return (await q(`SELECT id, ts, kind, message, emailed FROM trader_alerts ORDER BY id DESC LIMIT $1`, [limit])).map((r) => ({
    id: Number(r.id),
    ts: iso(r.ts),
    kind: r.kind as string,
    message: r.message as string,
    emailed: !!r.emailed,
  }));
}

export async function alertSince(kind: string, since: Date): Promise<boolean> {
  return (await q(`SELECT 1 FROM trader_alerts WHERE kind = $1 AND ts >= $2 LIMIT 1`, [kind, since.toISOString()])).length > 0;
}

export async function flagDay(date: string, versionId: number, newsDown: boolean, note?: string): Promise<void> {
  await q(
    `INSERT INTO trader_days (date, version_id, news_down, notes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (date, version_id) DO UPDATE SET news_down = trader_days.news_down OR excluded.news_down,
       notes = COALESCE(trader_days.notes || '; ', '') || COALESCE(excluded.notes, '')`,
    [date, versionId, newsDown, note ?? null],
  );
}

/** Trading days the version was running (it logged at least one decision), with flags. */
export async function versionDays(versionId: number): Promise<Array<{ date: string; newsDown: boolean }>> {
  const rows = await q(
    `SELECT DISTINCT substr(d.slot, 1, 10) AS date, COALESCE(t.news_down, false) AS news_down
     FROM trader_decisions d LEFT JOIN trader_days t ON t.date = substr(d.slot, 1, 10)::date AND t.version_id = d.version_id
     WHERE d.version_id = $1 AND d.phase = 'intraday' ORDER BY 1`,
    [versionId],
  );
  return rows.map((r) => ({ date: r.date, newsDown: !!r.news_down }));
}

export async function verdictFor(versionId: number): Promise<{ verdict: string; decidedAt: string; detail: unknown } | null> {
  const r = (await q(`SELECT verdict, decided_at, detail FROM trader_verdicts WHERE version_id = $1`, [versionId]))[0];
  return r ? { verdict: r.verdict, decidedAt: iso(r.decided_at)!, detail: r.detail } : null;
}

export async function recordVerdict(versionId: number, verdict: "pass" | "fail", detail: unknown): Promise<void> {
  await q(`INSERT INTO trader_verdicts (version_id, verdict, detail) VALUES ($1, $2, $3) ON CONFLICT (version_id) DO NOTHING`, [versionId, verdict, JSON.stringify(detail)]);
}

// ---------------------------------------------------------------- economic calendar

export async function econFor(date: string): Promise<Array<{ id: number; time_et: string; event: string }>> {
  return (await q(`SELECT id, time_et, event FROM econ_events WHERE date = $1 ORDER BY time_et`, [date])).map((r) => ({ id: Number(r.id), time_et: r.time_et, event: r.event }));
}

export async function econUpcoming(from: string) {
  return (await q(`SELECT id, to_char(date, 'YYYY-MM-DD') AS date, time_et, event FROM econ_events WHERE date >= $1 ORDER BY date, time_et LIMIT 200`, [from])).map((r) => ({
    id: Number(r.id),
    date: r.date as string,
    time_et: r.time_et as string,
    event: r.event as string,
  }));
}

export async function addEcon(date: string, timeEt: string, event: string): Promise<void> {
  await q(`INSERT INTO econ_events (date, time_et, event) VALUES ($1, $2, $3)`, [date, timeEt, event]);
}

export async function deleteEcon(id: number): Promise<void> {
  await q(`DELETE FROM econ_events WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------- swing ideas

const toIdea = (r: Record<string, any>): Idea => ({
  id: Number(r.id), createdAt: iso(r.created_at)!, ticker: r.ticker, side: r.side, thesis: r.thesis, catalyst: r.catalyst,
  speculative: !!r.speculative, notional: Number(r.notional), exitRule: r.exit_rule, exitParam: Number(r.exit_param), refPrice: Number(r.ref_price),
});

export async function addIdea(i: IdeaInput, refPrice: number): Promise<Idea> {
  const rows = await q(
    `INSERT INTO swing_ideas (ticker, side, thesis, catalyst, speculative, notional, exit_rule, exit_param, ref_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [i.ticker, i.side, i.thesis, i.catalyst, i.speculative, i.notional, i.exitRule, i.exitParam, refPrice],
  );
  return toIdea(rows[0]);
}

export async function allIdeas(): Promise<Idea[]> {
  return (await q(`SELECT * FROM swing_ideas ORDER BY id`)).map(toIdea);
}

export async function addIdeaEvent(e: Omit<IdeaEvent, "at"> & { at?: string }): Promise<void> {
  await q(
    `INSERT INTO swing_events (idea_id, kind, order_id, price, qty, spy_price, at, detail) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8)`,
    [e.ideaId, e.kind, e.orderId, e.price, e.qty, e.spyPrice, e.at ?? null, e.detail],
  );
}

export async function allIdeaEvents(): Promise<IdeaEvent[]> {
  return (await q(`SELECT idea_id, kind, order_id, price, qty, spy_price, at, detail FROM swing_events ORDER BY id`)).map((r) => ({
    ideaId: Number(r.idea_id), kind: r.kind, orderId: r.order_id, price: num(r.price), qty: num(r.qty), spyPrice: num(r.spy_price), at: iso(r.at)!, detail: r.detail,
  }));
}
