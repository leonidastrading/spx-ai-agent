/**
 * One tick of the AI day-trader paper test. Called every minute (09:00–16:00 ET)
 * by an external scheduler. All time rules use the server clock (`now`).
 * Orders go only through PaperBroker (paper-api.alpaca.markets).
 */

import { SYMBOLS } from "@/config/rules";
import { TRADER } from "@/config/trader";
import { AlpacaClient, credsFromEnv, referenceHostFromEnv, type Feed } from "../alpaca";
import * as store from "../db";
import { sendEmail } from "../email";
import { PaperBroker, brokerConfigured, brokerCredsFromEnv } from "../paper-broker";
import { addDays, etToUtc, hhmmToMinutes, priorSession, sessionOn, toEt, type Session } from "../time";
import { callTraderModel, type CallModel } from "./llm";
import { buildInputs, hashInputs, renderUserPrompt, versionHash, versionSpec } from "./prompt";
import { versionReport } from "./report";
import { dataProblems, decisionSlot, entryBlocked, parseReply, slotKey, timeExitDue, validateAction, type DayState } from "./rules";
import * as ts from "./store";
import { syncSwing } from "../swing/engine";

export type DataClient = Pick<AlpacaClient, "getCalendar" | "getBars" | "getNews" | "getLatestQuotes" | "resolveFeed">;
export type Broker = Pick<
  PaperBroker,
  "submitBracket" | "submitMarket" | "submitExit" | "getOrder" | "getOrderByClientId" | "replaceStop" | "cancel" | "getPosition" | "getAsset"
>;

export interface TraderDeps {
  data: DataClient;
  /** The trader's own paper account. */
  broker: () => Broker;
  /** The swing sleeve's own (different) paper account. */
  swingBroker: () => Broker;
  /** Which parts have their own paper keys configured. */
  ready: { trader: boolean; swing: boolean };
  callModel: CallModel;
  sleep: (ms: number) => Promise<void>;
  /** Server clock. */
  clock: () => Date;
  /** Send an alert on the dashboard's alert channel; true if it went out. */
  notify: (subject: string, text: string) => Promise<boolean>;
}

export function defaultDeps(): TraderDeps {
  const creds = credsFromEnv();
  let broker: PaperBroker | null = null;
  let swingBroker: PaperBroker | null = null;
  return {
    data: new AlpacaClient({ creds, referenceHost: referenceHostFromEnv(), maxRetries: 3, maxPerMinute: Number(process.env.ALPACA_MAX_RPM) || undefined }),
    broker: () => (broker ??= new PaperBroker(brokerCredsFromEnv("trader"))),
    swingBroker: () => (swingBroker ??= new PaperBroker(brokerCredsFromEnv("swing"))),
    ready: { trader: brokerConfigured("trader"), swing: brokerConfigured("swing") },
    callModel: callTraderModel,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    clock: () => new Date(),
    notify: async (subject, text) => {
      if (!process.env.RESEND_API_KEY?.trim()) return false;
      await sendEmail({ subject, text, html: `<pre style="font-family:inherit">${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>` });
      return true;
    },
  };
}

export interface TraderTickResult {
  status: "ok" | "skipped" | "busy" | "error";
  minuteEt: string;
  notes: string[];
  error?: string;
}

let feedCache: { date: string; feed: Feed } | null = null;

export async function runTraderTick(deps: TraderDeps = defaultDeps()): Promise<TraderTickResult> {
  const now = deps.clock();
  const et = toEt(now);
  const minuteEt = `${et.date} ${et.hhmm}`;
  const notes: string[] = [];
  // Cheap gate before any request: weekdays, 09:00–16:05 ET.
  if (et.weekday === 0 || et.weekday === 6 || et.minutes < 9 * 60 || et.minutes > 16 * 60 + 5) {
    return { status: "skipped", minuteEt, notes: ["outside 09:00–16:05 ET on a weekday"] };
  }
  const sessions = await deps.data.getCalendar(addDays(et.date, -10), et.date);
  const session = sessionOn(sessions, et.date);
  const prior = priorSession(sessions, et.date);
  if (!session || !prior) return { status: "skipped", minuteEt, notes: ["not a trading day"] };

  if (!(await ts.acquireLock("trader", 240))) return { status: "busy", minuteEt, notes: ["previous tick still running"] };
  try {
    await checkMissedCycles(now, et.date, deps);
    const cfg = await ts.loadTraderSettings();
    const model = cfg.model.trim() || TRADER.defaultModel;
    const version = await ts.ensureVersion(versionHash(model, cfg.effort), model, cfg.effort, versionSpec(model, cfg.effort));

    if (feedCache?.date !== session.date) feedCache = { date: session.date, feed: await deps.data.resolveFeed({ forced: process.env.ALPACA_FEED }) };
    const feed = feedCache.feed;

    const end = new Date(Math.floor(now.getTime() / 60000) * 60000);
    const newsOk = await ingest(deps, feed, prior, end, notes);
    if (!newsOk) {
      await ts.flagDay(session.date, version.id, true, `news feed down at ${et.hhmm}`);
      if (!(await ts.alertSince("news_down", etToUtc(session.date, "00:00")))) await alert(deps, "news_down", `News feed down at ${et.hhmm} ET; the model is told and the day is flagged.`);
    }

    // Keep execution records in step with the broker, then enforce time exits.
    for (const t of await ts.activeTrades()) await syncTrade(t, deps, now, notes);
    for (const t of await ts.activeTrades()) {
      if (t.status !== "open") continue;
      const due = timeExitDue(now, ts.toOpenTrade(t));
      if (due) await closeTrade(t, due, deps, notes);
    }

    const slot = decisionSlot(now);
    if (slot && !(await ts.slotDecided(version.id, slotKey(session.date, slot.hhmm)))) {
      await decide({ now, session, prior, slot, version, cfg, feed, newsOk, deps, notes });
    }

    if (deps.ready.swing) await syncSwing(now, session, { data: deps.data, broker: deps.swingBroker }, feed, notes);

    if (et.minutes >= hhmmToMinutes(TRADER.flatBy) + 1) await endOfDayGate(version, deps, notes);

    await ts.heartbeat(minuteEt, "ok", notes.join("; ") || undefined);
    return { status: "ok", minuteEt, notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ts.heartbeat(minuteEt, "error", message).catch(() => {});
    return { status: "error", minuteEt, notes, error: message };
  } finally {
    await ts.releaseLock("trader").catch(() => {});
  }
}

async function alert(deps: TraderDeps, kind: string, message: string) {
  const id = await ts.addAlert(kind, message);
  try {
    if (await deps.notify(`AI trader (paper): ${kind.replace(/_/g, " ")}`, message)) await ts.markAlertEmailed(id);
  } catch {
    /* the alert row is the record; email is best effort */
  }
}

/** Alert once per gap when no heartbeat arrived for `missedCyclesAlert` decision cycles during the session. */
async function checkMissedCycles(now: Date, date: string, deps: TraderDeps) {
  const m = toEt(now).minutes;
  const from = hhmmToMinutes(TRADER.premarketRead);
  if (m < from || m > hhmmToMinutes(TRADER.flatBy)) return;
  const last = await ts.lastHeartbeat();
  const dayStart = etToUtc(date, TRADER.premarketRead).getTime();
  const lastTs = last && Date.parse(last.ts) >= dayStart ? Date.parse(last.ts) : dayStart;
  const gapMin = (now.getTime() - lastTs) / 60000;
  const limit = TRADER.missedCyclesAlert * TRADER.decisionEveryMinutes;
  if (gapMin > limit && !(await ts.alertSince("missed_cycles", new Date(lastTs)))) {
    await alert(deps, "missed_cycles", `No trader heartbeat for ${Math.round(gapMin)} minutes (since ${toEt(new Date(lastTs)).hhmm} ET): at least ${TRADER.missedCyclesAlert} cycles missed.`);
  }
}

/** Fetch new bars and headlines into the shared tables. Returns whether the news fetch worked. */
async function ingest(deps: TraderDeps, feed: Feed, prior: Session, end: Date, notes: string[]): Promise<boolean> {
  const priorCloseUtc = etToUtc(prior.date, prior.close);
  const since = new Date(priorCloseUtc.getTime() - 5 * 60000);
  const last = await store.lastBarTs(since);
  // Re-fetch a trailing window each tick so bars that arrived late fill their gaps
  // (duplicates are ignored on insert).
  const lookback = end.getTime() - (TRADER.barCompletenessMinutes + 1) * 60000;
  const newest = Math.min(...SYMBOLS.map((s) => (last[s] ? Date.parse(last[s]) + 60000 : since.getTime())));
  const start = new Date(Math.max(since.getTime(), Math.min(newest, lookback)));
  if (start < end) {
    const bars = await deps.data.getBars({ symbols: SYMBOLS, start, end, feed });
    await store.insertBars(bars.filter((b) => Date.parse(b.ts) < end.getTime()));
  }
  try {
    const lastNews = await store.lastNewsTs(priorCloseUtc);
    await store.insertNews(await deps.data.getNews({ start: lastNews ? new Date(lastNews) : priorCloseUtc, end: new Date(end.getTime() + 60000) }));
    return true;
  } catch (err) {
    notes.push(`news fetch failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ---------------------------------------------------------------- decisions

async function dayState(date: string, enabled: boolean, versionId: number, disabledReason?: string): Promise<DayState> {
  const today = await ts.tradesForDate(date);
  const active = await ts.activeTrades();
  const open = active.find((t) => t.status === "open" || t.status === "pending" || t.status === "submitting" || t.status === "closing") ?? null;
  const verdict = await ts.verdictFor(versionId);
  return {
    open: open ? ts.toOpenTrade(open) : null,
    tradesToday: today.filter((t) => t.status !== "failed").length,
    closedToday: today.map(ts.toClosed).filter((c): c is NonNullable<typeof c> => c !== null).sort((a, b) => a.exitAt.localeCompare(b.exitAt)),
    gateFailed: verdict?.verdict === "fail",
    enabled,
    disabledReason,
  };
}

async function decide(a: {
  now: Date;
  session: Session;
  prior: Session;
  slot: { phase: "premarket" | "intraday"; hhmm: string };
  version: ts.Version;
  cfg: ts.TraderSettings;
  feed: Feed;
  newsOk: boolean;
  deps: TraderDeps;
  notes: string[];
}) {
  const { now, session, prior, slot, version, deps, notes } = a;
  const key = slotKey(session.date, slot.hhmm);
  const sym = TRADER.symbol;
  const base = { versionId: version.id, slot: key, phase: slot.phase, newsOk: a.newsOk } as const;
  const priorCloseUtc = etToUtc(prior.date, prior.close);
  const sessionOpen = etToUtc(session.date, session.open);

  // The last completed minute's bar can land a few seconds late; give it a moment.
  const lastClosed = Math.floor(now.getTime() / 60000) * 60000 - 60000;
  let bars = await store.loadBars(new Date(priorCloseUtc.getTime() - 5 * 60000), new Date(lastClosed + 60000));
  for (let i = 0; i < 3 && slot.phase === "intraday" && !bars.some((b) => b.symbol === sym && Date.parse(b.ts) === lastClosed); i++) {
    await deps.sleep(4000);
    await ingest(deps, a.feed, prior, new Date(lastClosed + 60000), notes);
    bars = await store.loadBars(new Date(priorCloseUtc.getTime() - 5 * 60000), new Date(lastClosed + 60000));
  }
  const quote = (await deps.data.getLatestQuotes([sym], a.feed))[sym];
  const serverNow = deps.clock(); // re-read the server clock after the waits above
  const evalNow = serverNow.getTime() > now.getTime() ? serverNow : now;

  if (slot.phase === "intraday") {
    const problems = dataProblems({ now: evalNow, quote, bars1m: bars.filter((b) => b.symbol === sym), sessionOpen });
    if (problems.length) {
      await ts.logDecision({ ...base, serverTs: evalNow.toISOString(), inputsHash: null, inputs: null, reply: null, replyText: null, status: "no_action", reason: `bad data: ${problems.join("; ")}`, modelServed: null, usage: null, costUsd: null, dataOk: false });
      notes.push(`no action: bad data (${problems[0]})`);
      return;
    }
  }

  const state = await dayState(
    session.date,
    a.cfg.enabled && deps.ready.trader,
    version.id,
    a.cfg.enabled && !deps.ready.trader ? "trader has no paper account of its own (TRADER_ALPACA_KEY_ID not set)" : undefined,
  );
  const blocked = slot.phase === "premarket" ? "pre-market read: no orders" : entryBlocked(evalNow, state);
  const [bars15, bars1d] = await Promise.all([
    deps.data.getBars({ symbols: [sym], start: etToUtc(addDays(session.date, -8), "04:00"), end: new Date(lastClosed + 60000), feed: a.feed, timeframe: "15Min" }),
    deps.data.getBars({ symbols: [sym], start: etToUtc(addDays(session.date, -95), "00:00"), end: etToUtc(session.date, "00:00"), feed: a.feed, timeframe: "1Day" }),
  ]);
  const lastCall = await ts.lastDecisionTs(version.id, session.date);
  const news = await store.loadNews(lastCall ? new Date(lastCall) : priorCloseUtc, evalNow);
  const settings = await store.loadSettings();
  const econ = await ts.econFor(session.date);
  const inputs = buildInputs({
    now: evalNow, phase: slot.phase, session, prior, quote, bars1m: bars, bars15m5d: bars15.filter((b) => Date.parse(b.ts) >= etToUtc(addDays(session.date, -7), "00:00").getTime()),
    bars1d60: bars1d, newsOk: a.newsOk, headlines: news, keywords: settings.keywords, econ: econ.map((e) => ({ time_et: e.time_et, event: e.event })),
    open: state.open, closedToday: state.closedToday, tradesToday: state.tradesToday, entryBlocked: blocked,
  });
  const inputsHash = hashInputs(inputs);

  let call;
  try {
    call = await deps.callModel({ model: version.model, effort: version.effort, user: renderUserPrompt(inputs) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ts.logDecision({ ...base, serverTs: deps.clock().toISOString(), inputsHash, inputs, reply: null, replyText: null, status: "error", reason: `model call failed: ${message}`, modelServed: null, usage: null, costUsd: null, dataOk: true });
    notes.push("model call failed");
    return;
  }

  const logged = (status: ts.DecisionRow["status"], reason: string | null, reply: unknown) =>
    ts.logDecision({ ...base, serverTs: deps.clock().toISOString(), inputsHash, inputs, reply, replyText: call.text, status, reason, modelServed: call.modelServed, usage: call.usage, costUsd: call.costUsd, dataOk: true });

  let reply;
  try {
    if (call.stopReason === "refusal") throw new Error("model refused");
    if (call.stopReason === "max_tokens") throw new Error("reply truncated");
    reply = parseReply(call.text);
  } catch (err) {
    await logged("rejected", `invalid reply: ${err instanceof Error ? err.message : err}`, null);
    return;
  }

  if (slot.phase === "premarket") {
    await logged("hold", "pre-market read (no orders before 09:35)", reply);
    return;
  }

  const price = quote ? (quote.bid + quote.ask) / 2 : NaN;
  const v = validateAction(reply, price, evalNow, state);
  // Log the full decision before any order is sent.
  const decisionId = await logged(
    !v.ok ? "rejected" : v.kind === "hold" ? "hold" : "accepted",
    !v.ok ? v.reason : v.kind === "hold" && v.tightenStop !== null ? `tighten stop to ${v.tightenStop}` : null,
    reply,
  );
  if (decisionId === null || !v.ok) return; // slot already taken by another tick, or rejected

  const active = (await ts.activeTrades()).find((t) => t.status === "open");
  if (v.kind === "enter") {
    const existing = await deps.broker().getPosition(TRADER.symbol);
    if (existing && Number(existing.qty) !== 0) {
      await alert(deps, "foreign_position", `Entry skipped: the paper account already holds ${existing.qty} ${TRADER.symbol} that the trader did not open.`);
      return;
    }
    const trade = await ts.createTrade({
      versionId: version.id, decisionId, date: session.date, side: v.side, qty: v.qty, refPrice: price, stopInitial: v.stop, stop: v.stop,
      target: v.target, maxHoldMinutes: v.maxHoldMinutes, confidence: reply.confidence, catalyst: reply.catalyst, clientOrderId: `aitrader-v${version.id}-d${decisionId}`,
    });
    try {
      const o = await deps.broker().submitBracket({ symbol: TRADER.symbol, side: v.side === "long" ? "buy" : "sell", qty: v.qty, stop: v.stop, target: v.target, clientOrderId: trade.clientOrderId });
      await ts.updateTrade(trade.id, { entryOrderId: o.id, status: "pending" });
      notes.push(`entered ${v.side} ${v.qty} ${TRADER.symbol}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ts.updateTrade(trade.id, { status: "failed", error: message });
      await alert(deps, "order_failed", `Entry order failed: ${message}`);
    }
  } else if (v.kind === "close" && active) {
    await closeTrade(active, "model", deps, notes);
  } else if (v.kind === "hold" && v.tightenStop !== null && active?.stopOrderId) {
    await deps.broker().replaceStop(active.stopOrderId, v.tightenStop);
    await ts.recordStopChange(active.id, decisionId, active.stop, v.tightenStop);
    await ts.updateTrade(active.id, { stop: v.tightenStop });
    notes.push(`stop tightened to ${v.tightenStop}`);
  }
}

// ---------------------------------------------------------------- execution sync

const FINAL_BAD = new Set(["canceled", "expired", "rejected", "suspended"]);

async function syncTrade(t: ts.TradeRow, deps: TraderDeps, now: Date, notes: string[]) {
  const broker = deps.broker();
  if (!t.entryOrderId) {
    // Crash between logging and submitting: recover by client order id.
    const found = await broker.getOrderByClientId(t.clientOrderId);
    if (found) await ts.updateTrade(t.id, { entryOrderId: found.id, status: "pending" });
    else if (t.status === "submitting") await ts.updateTrade(t.id, { status: "failed", error: "order not found at broker" });
    return;
  }
  const o = await broker.getOrder(t.entryOrderId);
  if (o.status !== "filled") {
    if (FINAL_BAD.has(o.status)) await ts.updateTrade(t.id, { status: "failed", error: `entry ${o.status}` });
    return;
  }
  const legs = o.legs ?? [];
  const stopLeg = legs.find((l) => l.type === "stop" || l.type === "stop_limit");
  const targetLeg = legs.find((l) => l.type === "limit");
  const patch: Partial<ts.TradeRow> = {};
  if (t.entryPrice === null) {
    Object.assign(patch, { entryPrice: Number(o.filled_avg_price), entryAt: o.filled_at, stopOrderId: stopLeg?.id ?? null, targetOrderId: targetLeg?.id ?? null });
    if (t.status === "pending" || t.status === "submitting") patch.status = "open";
  }
  const filledLeg = legs.find((l) => l.status === "filled");
  if (filledLeg) {
    Object.assign(patch, { exitPrice: Number(filledLeg.filled_avg_price), exitAt: filledLeg.filled_at, exitReason: filledLeg === stopLeg ? "stop" : "target", status: "closed" });
  } else if (t.status === "closing" && t.closeOrderId) {
    const c = await broker.getOrder(t.closeOrderId);
    if (c.status === "filled") Object.assign(patch, { exitPrice: Number(c.filled_avg_price), exitAt: c.filled_at, status: "closed" });
    else if (FINAL_BAD.has(c.status)) await alert(deps, "order_failed", `Close order for trade ${t.id} ${c.status}; position may still be open.`);
  }
  if (Object.keys(patch).length) {
    await ts.updateTrade(t.id, patch);
    if (patch.status === "closed") notes.push(`trade ${t.id} closed (${patch.exitReason ?? t.exitReason})`);
  }
  void now;
}

/** Exit at market: cancel the bracket legs, then send the closing order (unless a leg filled meanwhile). */
async function closeTrade(t: ts.TradeRow, reason: "time" | "eod" | "model", deps: TraderDeps, notes: string[]) {
  const broker = deps.broker();
  for (const id of [t.stopOrderId, t.targetOrderId]) if (id) await broker.cancel(id);
  for (let i = 0; i < 6 && t.entryOrderId; i++) {
    const o = await broker.getOrder(t.entryOrderId);
    const legs = o.legs ?? [];
    const filled = legs.find((l) => l.status === "filled");
    if (filled) {
      await ts.updateTrade(t.id, { exitPrice: Number(filled.filled_avg_price), exitAt: filled.filled_at, exitReason: filled.type === "limit" ? "target" : "stop", status: "closed" });
      return;
    }
    if (legs.every((l) => FINAL_BAD.has(l.status))) break;
    await deps.sleep(500);
  }
  const c = await broker.submitMarket({ symbol: TRADER.symbol, side: t.side === "long" ? "sell" : "buy", qty: t.qty, clientOrderId: `${t.clientOrderId}-x` });
  await ts.updateTrade(t.id, { closeOrderId: c.id, exitReason: reason, status: "closing" });
  notes.push(`closing trade ${t.id} (${reason})`);
}

// ---------------------------------------------------------------- gate

async function endOfDayGate(version: ts.Version, deps: TraderDeps, notes: string[]) {
  if (await ts.verdictFor(version.id)) return;
  const report = await versionReport(version);
  if (!report.gate.ready || !report.gate.verdict) return;
  await ts.recordVerdict(version.id, report.gate.verdict, { checks: report.gate.checks, trades: report.trades.length, days: report.days.length });
  await alert(deps, "verdict", `Version ${version.id} decision gate: ${report.gate.verdict.toUpperCase()}. ${report.gate.verdict === "fail" ? "Trading stops for this version; the record is kept." : ""}`);
  notes.push(`verdict ${report.gate.verdict}`);
}
