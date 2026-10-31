/**
 * One cron tick. Shadow mode: reads market data/news, writes to our own
 * Postgres, calls the LLM once a day and sends one email. It has no access to
 * any order endpoint (see lib/alpaca.ts).
 */

import { RULES, SCHEDULE, SYMBOLS, LLM } from "@/config/rules";
import { AlpacaClient, credsFromEnv, referenceHostFromEnv, type Feed } from "./alpaca";
import * as store from "./db";
import { ruleDecision, buildUserPrompt, type StrategyCall } from "./decision";
import { buildSummaryEmail, sendEmail } from "./email";
import { computeFeatures, newsWindow } from "./features";
import { runLlmDecision } from "./llm";
import { topHeadlines } from "./news";
import { addDays, cronGate, etToUtc, hhmmToMinutes, minutesToHhmm, priorSession, sessionOn, toEt, type Session } from "./time";

export interface TickResult {
  status: "ok" | "skipped" | "error";
  action: string;
  minuteEt: string | null;
  feed: Feed | null;
  rowsWritten: Record<string, number>;
  notes: string[];
  error?: string;
}

let feedCache: { date: string; feed: Feed } | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTick(now = new Date()): Promise<TickResult> {
  const alpaca = new AlpacaClient({
    creds: credsFromEnv(),
    referenceHost: referenceHostFromEnv(),
    maxRetries: 3,
    maxPerMinute: Number(process.env.ALPACA_MAX_RPM) || undefined,
  });
  const etNow = toEt(now);
  const sessions = await alpaca.getCalendar(addDays(etNow.date, -10), etNow.date);
  const gate = cronGate(now, sessionOn(sessions, etNow.date), SCHEDULE);

  if (gate.action === "skip") {
    const id = await store.startRun("skip", null);
    await store.finishRun(id, { status: "skipped", detail: gate.reason });
    return { status: "skipped", action: "skip", minuteEt: null, feed: null, rowsWritten: {}, notes: [gate.reason] };
  }

  const { session, et } = gate;
  const prior = priorSession(sessions, session.date);
  const minuteEt = `${et.date} ${et.hhmm}`;
  const runId = await store.startRun(gate.action, minuteEt);
  const rows: Record<string, number> = {};
  const notes: string[] = [];
  let feed: Feed | null = null;

  try {
    if (!prior) throw new Error(`no prior session found before ${session.date}`);

    if (feedCache?.date !== session.date) {
      feedCache = { date: session.date, feed: await alpaca.resolveFeed({ forced: process.env.ALPACA_FEED }) };
    }
    feed = feedCache.feed;

    const decisionMin = hhmmToMinutes(SCHEDULE.decisionAt);
    // Ingest through the current minute, but never past the decision time.
    const asOfMin = Math.min(et.minutes, decisionMin);
    const asOf = etToUtc(session.date, minutesToHhmm(asOfMin));

    Object.assign(rows, await ingest(alpaca, feed, prior, asOf));
    await computeAndStoreFeatures(session, prior, asOf, feed, minutesToHhmm(asOfMin));
    rows.features = 1;

    if (et.minutes >= decisionMin) {
      Object.assign(rows, await decide(alpaca, feed, session, prior, et.minutes, notes));
    }
    if (et.minutes >= hhmmToMinutes(SCHEDULE.emailAt)) {
      rows.email = await maybeEmail(session.date, prior, notes);
    }

    await store.finishRun(runId, { status: "ok", feed, rowsWritten: rows, detail: notes.join("; ") || undefined });
    return { status: "ok", action: gate.action, minuteEt, feed, rowsWritten: rows, notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.finishRun(runId, { status: "error", feed, rowsWritten: rows, detail: notes.join("; ") || undefined, error: message });
    return { status: "error", action: gate.action, minuteEt, feed, rowsWritten: rows, notes, error: message };
  }
}

/** Fetch bars and headlines newer than what's stored, up to `end` (exclusive). */
async function ingest(alpaca: AlpacaClient, feed: Feed, prior: Session, end: Date): Promise<Record<string, number>> {
  const priorCloseUtc = etToUtc(prior.date, prior.close);
  // Start a few minutes before the prior close so the prior close bar is stored.
  const since = new Date(priorCloseUtc.getTime() - 5 * 60000);

  const last = await store.lastBarTs(since);
  const starts = SYMBOLS.map((s) => (last[s] ? Date.parse(last[s]) + 60000 : since.getTime()));
  const barStart = new Date(Math.min(...starts));
  let bars = 0;
  if (barStart < end) {
    const fetched = await alpaca.getBars({ symbols: SYMBOLS, start: barStart, end, feed });
    bars = await store.insertBars(fetched.filter((b) => Date.parse(b.ts) < end.getTime()));
  }

  // Re-fetch from the newest stored headline (inclusive); duplicates are ignored by id.
  const lastNews = await store.lastNewsTs(priorCloseUtc);
  const newsStart = lastNews ? new Date(lastNews) : priorCloseUtc;
  let news = 0;
  if (newsStart < end) {
    news = await store.insertNews(await alpaca.getNews({ start: newsStart, end }));
  }
  return { bars, news };
}

async function computeAndStoreFeatures(session: Session, prior: Session, asOf: Date, feed: Feed, hhmm: string) {
  const priorCloseUtc = etToUtc(prior.date, prior.close);
  const bars = await store.loadBars(new Date(priorCloseUtc.getTime() - 5 * 60000), asOf);
  const news = await store.loadNews(priorCloseUtc, asOf);
  const features = computeFeatures({ session, prior, asOf, bars, news, feed });
  await store.upsertFeatures(session.date, hhmm, features);
  return { features, news };
}

async function decide(
  alpaca: AlpacaClient,
  feed: Feed,
  session: Session,
  prior: Session,
  etMinutes: number,
  notes: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const haveRule = await store.hasDecision(session.date, "rule");
  const haveLlm = await store.hasDecision(session.date, "llm");
  if (haveRule && haveLlm) return out;

  const asOf = etToUtc(session.date, SCHEDULE.decisionAt);

  // The 10:49 bar can land a few seconds after 10:50:00; give it a moment.
  for (let i = 0; i < 3; i++) {
    const lastBar = (await store.lastBarTs(new Date(asOf.getTime() - 60000))).SPY;
    if (lastBar) break;
    await sleep(5000);
    Object.assign(out, await ingest(alpaca, feed, prior, asOf));
  }

  const { features, news } = await computeAndStoreFeatures(session, prior, asOf, feed, SCHEDULE.decisionAt);
  await store.upsertMorningHistory(session.date, features.atr30_bp, features.spy_ret_prev_close_pct, "live");

  if (!haveRule) {
    const hist = await store.atrHistory(session.date, RULES.atrLookbackDays);
    const rule = ruleDecision(features, hist);
    out.rule_decisions = await store.insertDecisions(session.date, "rule", rule.calls);
    notes.push(`rule: ${rule.call}`);
  }

  if (!haveLlm) {
    const headlines = topHeadlines(newsWindow(news, prior, asOf), LLM.maxHeadlines).map((h) => ({ ts: h.ts, headline: h.headline }));
    const promptInput = { date: session.date, features, headlines };
    const lastChance = etMinutes >= hhmmToMinutes(SCHEDULE.catchUpUntil) - 1;
    try {
      const res = await runLlmDecision(promptInput);
      if (res.decision) {
        out.llm_decisions = await store.insertDecisions(session.date, "llm", res.decision.calls);
        await store.insertLlmRead(session.date, res.model, res.decision.marketRead, buildUserPrompt(promptInput), res.attempts);
        notes.push(`llm: ${summarize(res.decision.calls)}`);
      } else {
        const reason = `invalid JSON twice: ${res.attempts.map((a) => a.error).join(" | ")}`;
        out.llm_decisions = await store.insertDecisions(session.date, "llm", [{ strategy: "*", call: "error", confidence: null, reason }]);
        await store.insertLlmRead(session.date, res.model, null, buildUserPrompt(promptInput), res.attempts);
        notes.push("llm: error row stored");
      }
    } catch (err) {
      // API/network error: leave no row so the next minute retries, until the last catch-up minute.
      const message = err instanceof Error ? err.message : String(err);
      if (!lastChance) throw new Error(`LLM call failed (will retry next minute): ${message}`);
      out.llm_decisions = await store.insertDecisions(session.date, "llm", [{ strategy: "*", call: "error", confidence: null, reason: `API error: ${message}` }]);
      notes.push("llm: API error row stored");
    }
  }
  return out;
}

function summarize(calls: StrategyCall[]): string {
  const n = (c: string) => calls.filter((x) => x.call === c).length;
  return `${n("skip")} skip / ${n("reduce")} reduce / ${n("run")} run`;
}

async function maybeEmail(date: string, prior: Session, notes: string[]): Promise<number> {
  const decisions = await store.decisionsForDate(date);
  const llm = decisions.filter((d) => d.source === "llm");
  const rule = decisions.filter((d) => d.source === "rule");
  if (!llm.length || !rule.length) return 0;

  const read = await store.llmRead(date);
  const llmErr = llm.find((d) => d.call === "error");
  const asOf = etToUtc(date, SCHEDULE.decisionAt);
  const news = await store.loadNews(etToUtc(prior.date, prior.close), asOf);

  const appUrl = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
  const msg = buildSummaryEmail({
    date,
    marketRead: read?.market_read ?? null,
    llmError: llmErr ? llmErr.reason : null,
    llm: llm.filter((d) => d.call !== "error") as StrategyCall[],
    rule: rule as StrategyCall[],
    headlines: topHeadlines(news, 5),
    dashboardUrl: appUrl ? `${appUrl}/dashboard` : undefined,
  });

  if (!(await store.claimEmail(date, msg.subject))) return 0;
  try {
    const id = await sendEmail(msg);
    await store.setEmailProviderId(date, id);
    notes.push(`email sent: ${msg.subject}`);
    return 1;
  } catch (err) {
    await store.releaseEmail(date);
    throw err;
  }
}
