/**
 * Entry advisor tick (shadow mode). Called once a minute 09:00–16:59 ET; inside
 * one call it polls oo-trading's export every ~10 s for ~50 s, so new Schwab
 * entries are picked up quickly. It only reads and logs: it cannot place,
 * change or block any order, and nothing it says is sent anywhere.
 */

import { ENTRY } from "@/config/entry";
import type { AlpacaClient, Feed } from "../alpaca";
import * as store from "../db";
import { mapStrategy } from "../optionomega";
import { topHeadlines } from "../news";
import { strategyNames } from "../settings";
import { addDays, etToUtc, hhmmToMinutes, toEt } from "../time";
import { acquireLock, econFor, econUpcoming, releaseLock } from "../trader/store";
import type { OoEntry, OoExport } from "./contract";
import type { FetchExport } from "./client";
import type { EntryCallModel } from "./llm";
import { entriesFromExport, upsertBookEntries } from "../book-entries";
import { resolveBot } from "./matcher";
import { buildPacket, packetHash, type RelBars } from "./packet";
import { entryVersionHash, entryVersionSpec, parseEntryReply, renderEntryPrompt } from "./prompt";
import { entryReport } from "./report";
import * as es from "./store";

export interface EntryDeps {
  fetchExport: FetchExport;
  data: Pick<AlpacaClient, "getBars" | "getNews" | "resolveFeed">;
  callModel: EntryCallModel;
  clock: () => Date;
  sleep: (ms: number) => Promise<void>;
  loopSeconds?: number;
}

export interface EntryTickResult {
  status: "ok" | "skipped" | "busy" | "error";
  notes: string[];
  error?: string;
}

const REL_SYMBOLS = ["SPY", "QQQ", "IWM", "TLT", "RSP"];

export async function runEntryTick(deps: EntryDeps): Promise<EntryTickResult> {
  const now = deps.clock();
  const et = toEt(now);
  const notes: string[] = [];
  if (et.weekday === 0 || et.weekday === 6 || et.minutes < 9 * 60 || et.minutes > 16 * 60 + 59) return { status: "skipped", notes: ["outside 09:00–16:59 ET on a weekday"] };
  if (!(await acquireLock("entry", 90))) return { status: "busy", notes: ["previous tick still running"] };
  try {
    const cfg = await es.loadEntrySettings();
    const model = cfg.model.trim() || ENTRY.defaultModel;
    const version = await es.ensureEntryVersion(entryVersionHash(model, cfg.effort), model, cfg.effort, entryVersionSpec(model, cfg.effort));
    const verdict = await es.entryVerdict(version.id);
    const calling = cfg.enabled && verdict?.verdict !== "fail";
    const feed = await deps.data.resolveFeed({ forced: process.env.ALPACA_FEED });
    const dayStart = etToUtc(et.date, "00:00").toISOString();

    if (calling && et.minutes < 9 * 60 + 30 && !(await es.newsSummaryFor(et.date))) await refreshNewsSummary(deps, et.date, model, notes);

    const until = now.getTime() + (deps.loopSeconds ?? ENTRY.loopSeconds) * 1000;
    let relCache: { at: number; rel: RelBars } | null = null;
    let entriesSynced = false;
    for (;;) {
      let exp: OoExport | null = null;
      try {
        exp = await deps.fetchExport(dayStart);
      } catch (err) {
        notes.push(`export failed: ${err instanceof Error ? err.message : err}`);
      }
      if (exp) {
        await es.saveBookSnapshot(exp.asOf, exp.book);
        await es.saveNlv(exp.account ?? null, (d) => etToUtc(d, "16:00").toISOString());
        await es.saveQuoteSnapshots(exp.market.snapshots);
        // Keep the book's entries for scoring the 10:50 calls (once per tick is enough).
        if (!entriesSynced) {
          await upsertBookEntries(entriesFromExport(exp, await es.quoteSnapshotsSince(dayStart)));
          entriesSynced = true;
        }
        await es.upsertOutcomes(exp.outcomes, (iso) => toEt(new Date(iso)).date);
        if (toEt(deps.clock()).minutes >= 16 * 60) await es.upsertMarketDay(et.date, exp.market.vix.last, exp.market.vix.prevClose);
        if (calling) {
          const logged = await es.loggedEntryIds(version.id, dayStart);
          const fresh = exp.entries.filter((e) => !logged.has(e.id) && e.filledAt >= dayStart);
          if (fresh.length) {
            if (!relCache || deps.clock().getTime() - relCache.at > 20000) relCache = { at: deps.clock().getTime(), rel: await relBars(deps, feed, et.date) };
            const newsOk = await ingestNews(deps, dayStart);
            await Promise.all(fresh.map((e) => handleEntry(e, exp!, version, cfg, relCache!.rel, newsOk, deps, notes)));
          }
        }
      }
      if (deps.clock().getTime() + ENTRY.pollEverySeconds * 1000 > until) break;
      await deps.sleep(ENTRY.pollEverySeconds * 1000);
    }

    if (et.minutes >= 16 * 60 + 5 && !verdict) {
      const r = await entryReport(version);
      if (r.gate.ready && r.gate.verdict) {
        await es.recordEntryVerdict(version.id, r.gate.verdict, { checks: r.gate.checks, scored: r.scored.length, days: r.tradingDays });
        notes.push(`verdict ${r.gate.verdict}`);
      }
    }
    return { status: "ok", notes };
  } catch (err) {
    return { status: "error", notes, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await releaseLock("entry").catch(() => {});
  }
}

async function relBars(deps: EntryDeps, feed: Feed, date: string): Promise<RelBars> {
  const [daily, intraday] = await Promise.all([
    deps.data.getBars({ symbols: REL_SYMBOLS, start: etToUtc(addDays(date, -25), "00:00"), end: etToUtc(date, "00:00"), feed, timeframe: "1Day" }),
    deps.data.getBars({ symbols: REL_SYMBOLS, start: etToUtc(date, "09:30"), end: deps.clock(), feed }),
  ]);
  const group = (bars: typeof daily) => {
    const out: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> = {};
    for (const b of bars) (out[b.symbol] ??= []).push({ t: b.ts, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    return out;
  };
  return { daily: group(daily), intraday: group(intraday) };
}

/** Pull new headlines into the shared news table; false if the feed failed. */
async function ingestNews(deps: EntryDeps, dayStart: string): Promise<boolean> {
  try {
    const since = new Date(Date.parse(dayStart) - 3 * 86400000);
    const last = await store.lastNewsTs(since);
    await store.insertNews(await deps.data.getNews({ start: last ? new Date(last) : since, end: deps.clock() }));
    return true;
  } catch {
    return false;
  }
}

async function handleEntry(
  entry: OoEntry,
  exp: OoExport,
  version: es.EntryVersion,
  cfg: es.EntrySettings,
  rel: RelBars,
  newsOk: boolean,
  deps: EntryDeps,
  notes: string[],
) {
  const detectedAt = deps.clock().toISOString();
  const filledMs = Date.parse(entry.filledAt);
  // Which bot: the export's match, else how the bots fill live (v2). Shown with its confidence either way.
  const who = resolveBot(entry);
  const base = {
    versionId: version.id, entryId: entry.id, bot: who.bot, match: who.confident ? "exact" : entry.match, matchConfidence: who.confidence, matchReason: who.reason,
    matchSource: who.source, filledAt: entry.filledAt, detectedAt,
  };
  entry = { ...entry, bot: who.bot, match: who.confident ? "exact" : entry.match, matchConfidence: who.confidence, matchReason: who.reason };
  const empty = { verdict: null, confidence: null, dayType: null, reply: null, replyText: null, dataOk: null, packetComplete: null, packetHash: null, packet: null, modelServed: null, usage: null, costUsd: null, vixChangePct: null };
  const stamp = () => {
    const loggedAt = deps.clock();
    return { loggedAt: loggedAt.toISOString(), latencyMs: loggedAt.getTime() - filledMs };
  };

  // A fill that doesn't map confidently to one bot gets no opinion (no model call).
  if (!who.confident || !who.bot) {
    await es.logCall({ ...base, ...empty, ...stamp(), status: "no_opinion", statusReason: `bot match below ${ENTRY.matchMinConfidence} (confidence ${who.confidence}${who.bot ? `, best guess ${who.bot}` : ""}): ${who.reason}` });
    return;
  }
  // Already past the limit when first seen (e.g. the scheduler was down): log late, don't call.
  if (deps.clock().getTime() - filledMs > ENTRY.lateAfterSeconds * 1000) {
    await es.logCall({ ...base, ...empty, ...stamp(), status: "late", statusReason: `first seen ${Math.round((deps.clock().getTime() - filledMs) / 1000)}s after the fill` });
    return;
  }

  const date = toEt(new Date(filledMs)).date;
  const settings = await store.loadSettings();
  const [quoteSnaps, books, lastCall, econ, upcoming, morning, summary, nlv] = await Promise.all([
    es.quoteSnapshotsSince(etToUtc(date, "00:00").toISOString()),
    es.bookSnapshotsSince(new Date(filledMs - 15 * 60000).toISOString()),
    es.lastCallAt(version.id, etToUtc(date, "00:00").toISOString()),
    econFor(date),
    econUpcoming(date),
    es.morningCalls(),
    es.newsSummaryFor(date),
    es.nlvAt(entry.filledAt, etToUtc(ENTRY.drawdownSince, "00:00").toISOString()),
  ]);
  const since = lastCall && Date.parse(lastCall) < filledMs ? lastCall : new Date(filledMs - 18 * 3600000).toISOString();
  const headlines = topHeadlines(await store.loadNews(new Date(since), new Date(filledMs + 1)), 40, settings.keywords);
  const strategy = entry.bot && mapStrategy(entry.bot, settings.ooMap, strategyNames(settings));
  const mc = strategy ? morning.find((m) => m.date === date && m.strategy === strategy) : undefined;
  const nextFed = upcoming.find((e) => /fomc|fed\b/i.test(e.event) && (e.date > date || e.time_et >= toEt(new Date(filledMs)).hhmm));
  const merged = new Map(quoteSnaps.map((s) => [s.at, s]));
  for (const s of exp.market.snapshots) merged.set(s.at, s);

  const { packet, complete } = buildPacket({
    entry,
    exp: { ...exp, market: { ...exp.market, snapshots: [...merged.values()] } },
    bookSnapshots: books,
    rel,
    headlines,
    headlinesSince: since,
    newsFeedOk: newsOk,
    newsSummary10d: summary,
    econToday: econ.map((e) => ({ time_et: e.time_et, event: e.event })),
    nextFed: nextFed ? `${nextFed.date} ${nextFed.time_et} ${nextFed.event}` : null,
    morningCall: mc ? { call: mc.call, reason: mc.reason, decidedAt: mc.createdAt } : null,
    keywords: settings.keywords,
    nlv,
  });
  const hash = packetHash(packet);
  const vixChangePct = (packet.market.vol as { vix_change_today_pct: number | null }).vix_change_today_pct;
  const withPacket = { packetComplete: complete, packetHash: hash, packet, vixChangePct };

  let call;
  try {
    call = await deps.callModel({ model: version.model, effort: version.effort, user: renderEntryPrompt(packet), kind: "entry" });
  } catch (err) {
    await es.logCall({ ...base, ...empty, ...withPacket, ...stamp(), status: "error", statusReason: `model call failed: ${err instanceof Error ? err.message : err}` });
    return;
  }
  const modelBits = { replyText: call.text, modelServed: call.modelServed, usage: call.usage, costUsd: call.costUsd };
  let reply;
  let trimmed: string[] = [];
  try {
    if (call.stopReason === "refusal") throw new Error("model refused");
    ({ reply, trimmed } = parseEntryReply(call.text));
  } catch (err) {
    await es.logCall({ ...base, ...empty, ...withPacket, ...modelBits, ...stamp(), status: "error", statusReason: `invalid reply: ${err instanceof Error ? err.message : err}` });
    return;
  }

  const t = stamp();
  // Code-enforced rules: incomplete packet or data_ok=false → no_opinion; > 120 s → late (excluded).
  const status = !complete || !reply.data_ok ? "no_opinion" : t.latencyMs > ENTRY.lateAfterSeconds * 1000 ? "late" : "called";
  const statusReason =
    status === "no_opinion"
      ? !complete
        ? `packet incomplete: ${packet.health.missing.join(", ")}`
        : "model said data_ok=false"
      : status === "late"
        ? `logged ${Math.round(t.latencyMs / 1000)}s after the fill`
        : [
            t.latencyMs > ENTRY.targetLatencySeconds * 1000 ? `slow: ${Math.round(t.latencyMs / 1000)}s (over the ${ENTRY.targetLatencySeconds}s target)` : null,
            trimmed.length ? `trimmed: ${trimmed.join(", ")}` : null,
          ].filter(Boolean).join("; ") || null;
  await es.logCall({
    ...base, ...withPacket, ...modelBits, ...t, status, statusReason,
    verdict: status === "no_opinion" ? null : reply.verdict, confidence: reply.confidence, dayType: reply.day_type, reply, dataOk: reply.data_ok,
    trimmed,
  });
  notes.push(`${entry.bot}: ${status === "no_opinion" ? "no_opinion" : reply.verdict} (${Math.round(t.latencyMs / 1000)}s)`);
}

async function refreshNewsSummary(deps: EntryDeps, date: string, model: string, notes: string[]) {
  const from = etToUtc(addDays(date, -14), "00:00");
  const settings = await store.loadSettings();
  const news = await store.loadNews(from, deps.clock());
  const top = topHeadlines(news, 150, settings.keywords);
  const text = top.length ? top.map((h) => `${toEt(new Date(h.ts)).date} ${h.headline}`).join("\n") : "(no headlines stored yet)";
  try {
    const call = await deps.callModel({ model, effort: "low", user: `Headlines (date, headline), last two weeks:\n${text}`, kind: "summary" });
    await es.saveNewsSummary(date, deps.clock().toISOString(), call.text.trim(), call.modelServed, call.costUsd);
    notes.push("10-day news summary refreshed");
  } catch (err) {
    notes.push(`news summary failed: ${err instanceof Error ? err.message : err}`);
  }
}

export const minutesEt = (iso: string) => hhmmToMinutes(toEt(new Date(iso)).hhmm);
