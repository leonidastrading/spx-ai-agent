/**
 * Historical backfill (run locally, not on Vercel).
 *
 *   npx tsx scripts/backfill.ts --from 2016-01-01 --to 2026-10-30
 *
 * Options:
 *   --from YYYY-MM-DD     first session (required)
 *   --to YYYY-MM-DD       last session (default: yesterday, ET)
 *   --out DIR             output directory (default: data)
 *   --feed sip|iex        force a feed (default: probe SIP, fall back to IEX)
 *   --skip-news           bars and features only (keyword/news columns will be 0)
 *   --rpm N               max Alpaca requests per minute (default 190)
 *
 * Reads ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY from the environment
 * (.env.local, .env or the shell). Writes:
 *   DIR/bars_<SYMBOL>.csv       regular-session 1-minute bars
 *   DIR/news.csv                id, ts_utc, headline, symbols, source
 *   DIR/morning_features.csv    one row per session, features as of 10:50 ET
 * and resumes from DIR/.cache (completed month chunks are not re-fetched).
 *
 * NO LLM CALLS. Historical tagging is mechanical (keyword counts) only: a model
 * may already know how past days turned out, which would fake an edge.
 */

import "./env";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { SYMBOLS } from "@/config/rules";
import { AlpacaClient, credsFromEnv, referenceHostFromEnv, type Bar, type Feed, type NewsItem } from "@/lib/alpaca";
import { MORNING_COLUMNS, chunkBounds, monthChunks, morningRows, regularSessionOnly, type MonthChunk } from "@/lib/backfill";
import { csvLine, parseCsv } from "@/lib/csv";
import { addDays, etToUtc, priorSession, toEt, type Session } from "@/lib/time";

const { values: args } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string", default: "data" },
    feed: { type: "string" },
    "skip-news": { type: "boolean", default: false },
    rpm: { type: "string", default: "190" },
  },
});

function fail(msg: string): never {
  console.error(`backfill: ${msg}`);
  process.exit(1);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!args.from || !DATE_RE.test(args.from)) fail("--from YYYY-MM-DD is required");
const FROM = args.from;
const TO = args.to ?? addDays(toEt(new Date()).date, -1);
if (!DATE_RE.test(TO) || TO < FROM) fail("--to must be YYYY-MM-DD and >= --from");
if (TO >= toEt(new Date()).date) fail("--to must be before today (ET): today's session has not settled");
if (args.feed && args.feed !== "sip" && args.feed !== "iex") fail("--feed must be sip or iex");
if (!process.env.ALPACA_API_KEY_ID || !process.env.ALPACA_API_SECRET_KEY) fail("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set");

const OUT = args.out!;
const CACHE = path.join(OUT, ".cache");
const CHECKPOINT = path.join(CACHE, "checkpoint.json");
mkdirSync(CACHE, { recursive: true });

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const alpaca = new AlpacaClient({ creds: credsFromEnv(), referenceHost: referenceHostFromEnv(), maxPerMinute: Number(args.rpm), log });

// ---------------------------------------------------------------- checkpoint

type Checkpoint = { feed?: Feed; done: Record<string, string> };
const checkpoint: Checkpoint = existsSync(CHECKPOINT) ? JSON.parse(readFileSync(CHECKPOINT, "utf8")) : { done: {} };
function saveCheckpoint() {
  writeFileSync(CHECKPOINT + ".tmp", JSON.stringify(checkpoint, null, 1));
  renameSync(CHECKPOINT + ".tmp", CHECKPOINT);
}
/** A chunk is done if it was completed through at least `to`. */
const isDone = (key: string, to: string) => (checkpoint.done[key] ?? "") >= to;

function writeAtomic(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", content);
  renameSync(file + ".tmp", file);
}

// --------------------------------------------------------------- cache files

const BAR_HEADER = ["ts_utc", "o", "h", "l", "c", "v", "feed"];
const NEWS_HEADER = ["id", "ts_utc", "headline", "symbols", "source"];
const barFile = (sym: string, month: string) => path.join(CACHE, "bars", sym, `${month}.csv`);
const newsFile = (month: string) => path.join(CACHE, "news", `${month}.csv`);

function readBars(sym: string, month: string): Bar[] {
  const f = barFile(sym, month);
  if (!existsSync(f)) return [];
  return parseCsv(readFileSync(f, "utf8"))
    .slice(1)
    .map(([ts, o, h, l, c, v, feed]) => ({ symbol: sym, ts, o: +o, h: +h, l: +l, c: +c, v: +v, feed: feed as Feed }));
}

function readNews(month: string): NewsItem[] {
  const f = newsFile(month);
  if (!existsSync(f)) return [];
  return parseCsv(readFileSync(f, "utf8"))
    .slice(1)
    .map(([id, ts, headline, symbols, source]) => ({ id: +id, ts, headline, summary: "", symbols: symbols ? symbols.split("|") : [], source, url: "" }));
}

// ---------------------------------------------------------------------- main

async function main() {
  log(`Backfill ${FROM} .. ${TO} -> ${OUT} (no LLM calls)`);
  const allSessions: Session[] = await alpaca.getCalendar(addDays(FROM, -14), TO);
  const sessions = allSessions.filter((s) => s.date >= FROM && s.date <= TO);
  if (!sessions.length) throw new Error("no trading sessions in range");
  const first = priorSession(allSessions, sessions[0].date)!;
  log(`${sessions.length} sessions; prior session for the first day: ${first.date}`);

  const feed: Feed = (args.feed as Feed) ?? checkpoint.feed ?? (await alpaca.resolveFeed({ historicalOnly: true }));
  if (checkpoint.feed && checkpoint.feed !== feed) throw new Error(`cache was built with feed=${checkpoint.feed}; use --feed ${checkpoint.feed} or a new --out`);
  checkpoint.feed = feed;
  saveCheckpoint();
  log(`feed: ${feed}`);

  const chunks = monthChunks(first.date, TO);

  // 1) bars, per symbol per month
  for (const sym of SYMBOLS) {
    for (const c of chunks) {
      const key = `bars:${sym}:${c.key}`;
      if (isDone(key, c.to)) continue;
      const { start, end } = chunkBounds(c);
      const fetched = await alpaca.getBars({ symbols: [sym], start, end, feed });
      const regular = regularSessionOnly(fetched, allSessions);
      writeAtomic(barFile(sym, c.key), csvLine(BAR_HEADER) + regular.map((b) => csvLine([b.ts, b.o, b.h, b.l, b.c, b.v, b.feed])).join(""));
      checkpoint.done[key] = c.to;
      saveCheckpoint();
      log(`bars ${sym} ${c.key}: ${regular.length} regular-session bars`);
    }
  }

  // 2) news, per month (prior close of the first day onward)
  if (!args["skip-news"]) {
    for (const c of chunks) {
      const key = `news:${c.key}`;
      if (isDone(key, c.to)) continue;
      const { start, end } = chunkBounds(c);
      const items = await alpaca.getNews({ start, end });
      writeAtomic(newsFile(c.key), csvLine(NEWS_HEADER) + items.map((n) => csvLine([n.id, n.ts, n.headline, n.symbols.join("|"), n.source])).join(""));
      checkpoint.done[key] = c.to;
      saveCheckpoint();
      log(`news ${c.key}: ${items.length} headlines`);
    }
  }

  // 3) merged outputs
  const rangeStart = etToUtc(FROM, "00:00").getTime();
  for (const sym of SYMBOLS) {
    const out = createWriteStream(path.join(OUT, `bars_${sym}.csv`));
    out.write(csvLine(BAR_HEADER));
    for (const c of chunks) for (const b of readBars(sym, c.key)) if (Date.parse(b.ts) >= rangeStart) out.write(csvLine([b.ts, b.o, b.h, b.l, b.c, b.v, b.feed]));
    await new Promise((r) => out.end(r));
  }
  const newsStart = etToUtc(first.date, first.close).getTime();
  if (!args["skip-news"]) {
    const out = createWriteStream(path.join(OUT, "news.csv"));
    out.write(csvLine(NEWS_HEADER));
    const seen = new Set<number>();
    for (const c of chunks)
      for (const n of readNews(c.key)) {
        if (Date.parse(n.ts) < newsStart || seen.has(n.id)) continue;
        seen.add(n.id);
        out.write(csvLine([n.id, n.ts, n.headline, n.symbols.join("|"), n.source]));
      }
    await new Promise((r) => out.end(r));
  }
  log("wrote bars_*.csv and news.csv");

  // 4) morning features, month by month with the previous month kept for prior closes/overnight news
  const out = createWriteStream(path.join(OUT, "morning_features.csv"));
  out.write(csvLine(MORNING_COLUMNS));
  const atrHistory: number[] = [];
  let prev: MonthChunk | null = null;
  let rows = 0;
  for (const c of chunks) {
    const monthSessions = sessions.filter((s) => s.date >= c.from && s.date <= c.to);
    const keys = prev ? [prev.key, c.key] : [c.key];
    const bars = keys.flatMap((k) => SYMBOLS.flatMap((sym) => readBars(sym, k)));
    const news = args["skip-news"] ? [] : keys.flatMap((k) => readNews(k));
    for (const r of morningRows({ sessions: monthSessions, allSessions, bars, news, feed, atrHistory })) {
      out.write(csvLine(MORNING_COLUMNS.map((col) => (r as unknown as Record<string, unknown>)[col])));
      rows++;
    }
    prev = c;
  }
  await new Promise((r) => out.end(r));
  log(`wrote morning_features.csv (${rows} sessions)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
