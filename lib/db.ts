/** Postgres access (Neon serverless driver; works with Vercel Postgres / Neon URLs). */

import { neon } from "@neondatabase/serverless";
import type { Bar, NewsItem } from "./alpaca";
import type { StrategyCall } from "./decision";
import type { Features } from "./features";
import type { Outcome } from "./optionomega";
import { schemaStatements } from "./schema";
import { mergeSettings, type Settings } from "./settings";

type Row = Record<string, any>;

/** The one capability the app needs from a Postgres driver. */
export interface Querier {
  query(text: string, params?: unknown[]): Promise<Row[]>;
}

let cached: Querier | null = null;

export function db(): Querier {
  if (!cached) {
    const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const sql = neon(url);
    cached = { query: (text, params = []) => sql.query(text, params) as Promise<Row[]> };
  }
  return cached;
}

/** Tests: run against another driver (e.g. PGlite). */
export function setQuerierForTests(q: Querier | null): void {
  cached = q;
  schemaReady = null;
}

export function hasDatabase(): boolean {
  return cached !== null || !!(process.env.DATABASE_URL ?? process.env.POSTGRES_URL);
}

let schemaReady: Promise<void> | null = null;

/** Create tables on first use (idempotent), once per server instance. */
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const st of schemaStatements()) await db().query(st);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/** Run a query after making sure the schema exists. */
export const query = async (text: string, params: unknown[] = []): Promise<Row[]> => {
  await ensureSchema();
  return db().query(text, params);
};
const q = query;

const CHUNK = 2000;

/** Insert bars; existing (symbol, ts) rows are left alone. Returns rows inserted. */
export async function insertBars(bars: Bar[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < bars.length; i += CHUNK) {
    const c = bars.slice(i, i + CHUNK);
    const rows = await q(
      `INSERT INTO bars (symbol, ts, o, h, l, c, v, feed)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::bigint[], $8::text[])
       ON CONFLICT (symbol, ts) DO NOTHING RETURNING 1`,
      [c.map((b) => b.symbol), c.map((b) => b.ts), c.map((b) => b.o), c.map((b) => b.h), c.map((b) => b.l), c.map((b) => b.c), c.map((b) => Math.round(b.v)), c.map((b) => b.feed)],
    );
    n += rows.length;
  }
  return n;
}

export async function insertNews(items: NewsItem[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const c = items.slice(i, i + CHUNK);
    const rows = await q(
      `INSERT INTO news (id, ts, headline, summary, symbols, source, url, author)
       SELECT id, ts, headline, summary, string_to_array(symbols, '|'), source, url, author
       FROM unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
         AS t(id, ts, headline, summary, symbols, source, url, author)
       ON CONFLICT (id) DO NOTHING RETURNING 1`,
      [c.map((x) => x.id), c.map((x) => x.ts), c.map((x) => x.headline), c.map((x) => x.summary), c.map((x) => x.symbols.join("|")), c.map((x) => x.source), c.map((x) => x.url), c.map((x) => x.author ?? "")],
    );
    n += rows.length;
  }
  return n;
}

/** Latest stored bar start per symbol at or after `since`. */
export async function lastBarTs(since: Date): Promise<Record<string, string>> {
  const rows = await q(`SELECT symbol, max(ts) AS ts FROM bars WHERE ts >= $1 GROUP BY symbol`, [since.toISOString()]);
  return Object.fromEntries(rows.map((r) => [r.symbol, new Date(r.ts).toISOString()]));
}

export async function lastNewsTs(since: Date): Promise<string | null> {
  const rows = await q(`SELECT max(ts) AS ts FROM news WHERE ts >= $1`, [since.toISOString()]);
  return rows[0]?.ts ? new Date(rows[0].ts).toISOString() : null;
}

export async function loadBars(from: Date, to: Date): Promise<Bar[]> {
  const rows = await q(`SELECT symbol, ts, o, h, l, c, v, feed FROM bars WHERE ts >= $1 AND ts < $2 ORDER BY ts`, [from.toISOString(), to.toISOString()]);
  return rows.map((r) => ({ symbol: r.symbol, ts: new Date(r.ts).toISOString(), o: r.o, h: r.h, l: r.l, c: r.c, v: Number(r.v), feed: r.feed }));
}

export async function loadNews(from: Date, to: Date): Promise<NewsItem[]> {
  const rows = await q(`SELECT id, ts, headline, summary, symbols, source, url, author FROM news WHERE ts >= $1 AND ts < $2 ORDER BY ts`, [from.toISOString(), to.toISOString()]);
  return rows.map((r) => ({ id: Number(r.id), ts: new Date(r.ts).toISOString(), headline: r.headline, summary: r.summary, symbols: r.symbols ?? [], source: r.source, url: r.url, author: r.author ?? "" }));
}

export async function upsertFeatures(date: string, minuteEt: string, f: Features): Promise<void> {
  await q(
    `INSERT INTO features (date, minute_et, as_of, data) VALUES ($1, $2, $3, $4)
     ON CONFLICT (date, minute_et) DO UPDATE SET as_of = excluded.as_of, data = excluded.data`,
    [date, minuteEt, f.as_of, JSON.stringify(f)],
  );
}

export async function featuresForDate(date: string): Promise<Array<{ minute_et: string; data: Features }>> {
  return (await q(`SELECT minute_et, data FROM features WHERE date = $1 ORDER BY minute_et`, [date])) as any;
}

export async function upsertMorningHistory(date: string, atr: number | null, ret: number | null, source: "live" | "backfill"): Promise<void> {
  await q(
    `INSERT INTO morning_history (date, atr30_bp, spy_ret_prev_close_pct, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (date) DO UPDATE SET atr30_bp = excluded.atr30_bp, spy_ret_prev_close_pct = excluded.spy_ret_prev_close_pct, source = excluded.source`,
    [date, atr, ret, source],
  );
}

/** Up to `limit` prior days' atr30_bp, oldest first, strictly before `date`. */
export async function atrHistory(date: string, limit: number): Promise<number[]> {
  const rows = await q(
    `SELECT atr30_bp FROM (SELECT date, atr30_bp FROM morning_history WHERE date < $1 AND atr30_bp IS NOT NULL ORDER BY date DESC LIMIT $2) t ORDER BY date`,
    [date, limit],
  );
  return rows.map((r) => Number(r.atr30_bp));
}

export async function hasDecision(date: string, source: "rule" | "llm"): Promise<boolean> {
  const rows = await q(`SELECT 1 FROM decisions WHERE date = $1 AND source = $2 LIMIT 1`, [date, source]);
  return rows.length > 0;
}

export async function insertDecisions(date: string, source: "rule" | "llm", calls: Array<Omit<StrategyCall, "call"> & { call: string }>): Promise<number> {
  if (!calls.length) return 0;
  const rows = await q(
    `INSERT INTO decisions (date, strategy, source, call, confidence, reason)
     SELECT $1::date, s, $2, c, conf, r FROM unnest($3::text[], $4::text[], $5::float8[], $6::text[]) AS t(s, c, conf, r)
     ON CONFLICT (date, strategy, source) DO NOTHING RETURNING 1`,
    [date, source, calls.map((c) => c.strategy), calls.map((c) => c.call), calls.map((c) => c.confidence), calls.map((c) => c.reason)],
  );
  return rows.length;
}

export async function decisionsForDate(date: string): Promise<Array<{ strategy: string; source: string; call: string; confidence: number | null; reason: string }>> {
  return (await q(`SELECT strategy, source, call, confidence, reason FROM decisions WHERE date = $1 ORDER BY source, strategy`, [date])) as any;
}

export async function allDecisions(): Promise<Array<{ date: string; strategy: string; source: string; call: string; confidence: number | null; reason: string }>> {
  const rows = await q(`SELECT to_char(date, 'YYYY-MM-DD') AS date, strategy, source, call, confidence, reason FROM decisions ORDER BY date DESC, source, strategy`);
  return rows as any;
}

export async function insertLlmRead(date: string, model: string, marketRead: string | null, prompt: string, raw: unknown): Promise<void> {
  await q(
    `INSERT INTO llm_reads (date, model, market_read, prompt, raw) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (date) DO NOTHING`,
    [date, model, marketRead, prompt, JSON.stringify(raw)],
  );
}

export async function llmRead(date: string): Promise<{ model: string; market_read: string | null; raw: any } | null> {
  const rows = await q(`SELECT model, market_read, raw FROM llm_reads WHERE date = $1`, [date]);
  return (rows[0] as any) ?? null;
}

/** Claim the email slot for a date; false if already claimed. */
export async function claimEmail(date: string, subject: string): Promise<boolean> {
  const rows = await q(`INSERT INTO emails_sent (date, subject) VALUES ($1, $2) ON CONFLICT (date) DO NOTHING RETURNING 1`, [date, subject]);
  return rows.length > 0;
}

export async function setEmailProviderId(date: string, id: string): Promise<void> {
  await q(`UPDATE emails_sent SET provider_id = $2 WHERE date = $1`, [date, id]);
}

export async function releaseEmail(date: string): Promise<void> {
  await q(`DELETE FROM emails_sent WHERE date = $1`, [date]);
}

export async function upsertOutcomes(outcomes: Outcome[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < outcomes.length; i += CHUNK) {
    const c = outcomes.slice(i, i + CHUNK);
    const rows = await q(
      `INSERT INTO outcomes (date, strategy, pl, trades)
       SELECT * FROM unnest($1::date[], $2::text[], $3::float8[], $4::int[])
       ON CONFLICT (date, strategy) DO UPDATE SET pl = excluded.pl, trades = excluded.trades, uploaded_at = now()
       RETURNING 1`,
      [c.map((o) => o.date), c.map((o) => o.strategy), c.map((o) => o.pl), c.map((o) => o.trades)],
    );
    n += rows.length;
  }
  return n;
}

export async function allOutcomes(): Promise<Array<{ date: string; strategy: string; pl: number }>> {
  const rows = await q(`SELECT to_char(date, 'YYYY-MM-DD') AS date, strategy, pl FROM outcomes`);
  return rows.map((r) => ({ date: r.date, strategy: r.strategy, pl: Number(r.pl) }));
}

// ------------------------------------------------------------------- runs

export async function startRun(action: string, minuteEt: string | null): Promise<number> {
  const rows = await q(`INSERT INTO runs (action, status, minute_et) VALUES ($1, 'running', $2) RETURNING id`, [action, minuteEt]);
  return Number(rows[0].id);
}

export async function finishRun(
  id: number,
  r: { status: "ok" | "skipped" | "error"; feed?: string | null; rowsWritten?: Record<string, number>; detail?: string; error?: string },
): Promise<void> {
  await q(
    `UPDATE runs SET finished_at = now(), status = $2, feed = $3, rows_written = $4, detail = $5, error = $6 WHERE id = $1`,
    [id, r.status, r.feed ?? null, JSON.stringify(r.rowsWritten ?? {}), r.detail ?? null, r.error ?? null],
  );
}

export async function lastSuccessfulRun(): Promise<{ started_at: string; finished_at: string; minute_et: string | null; action: string } | null> {
  const rows = await q(`SELECT started_at, finished_at, minute_et, action FROM runs WHERE status = 'ok' ORDER BY finished_at DESC LIMIT 1`);
  return (rows[0] as any) ?? null;
}

export async function recentRuns(limit = 20): Promise<Row[]> {
  return q(`SELECT id, started_at, finished_at, minute_et, action, status, feed, rows_written, detail, error FROM runs ORDER BY id DESC LIMIT $1`, [limit]);
}

// --------------------------------------------------------------- settings

export async function loadSettings(): Promise<Settings> {
  const rows = await q(`SELECT value FROM settings WHERE key = 'app'`);
  return mergeSettings(rows[0]?.value);
}

export async function saveSettings(s: Settings): Promise<void> {
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ('app', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [JSON.stringify(s)],
  );
}

export async function resetSettings(): Promise<void> {
  await q(`DELETE FROM settings WHERE key = 'app'`);
}

export async function settingsUpdatedAt(): Promise<string | null> {
  const rows = await q(`SELECT updated_at FROM settings WHERE key = 'app'`);
  return rows[0]?.updated_at ? new Date(rows[0].updated_at).toISOString() : null;
}

// ----------------------------------------------------------------- export

export async function exportRows(from: string, to: string) {
  const [decisions, reads, features, outcomes] = await Promise.all([
    q(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, strategy, source, call, confidence, reason, created_at
       FROM decisions WHERE date BETWEEN $1 AND $2 ORDER BY date, strategy, source`,
      [from, to],
    ),
    q(`SELECT to_char(date, 'YYYY-MM-DD') AS date, model, market_read FROM llm_reads WHERE date BETWEEN $1 AND $2`, [from, to]),
    q(`SELECT to_char(date, 'YYYY-MM-DD') AS date, minute_et, data FROM features WHERE date BETWEEN $1 AND $2 AND minute_et = $3`, [from, to, "10:50"]),
    q(`SELECT to_char(date, 'YYYY-MM-DD') AS date, strategy, pl, trades FROM outcomes WHERE date BETWEEN $1 AND $2`, [from, to]),
  ]);
  return {
    decisions: decisions as Array<{ date: string; strategy: string; source: string; call: string; confidence: number | null; reason: string; created_at: string }>,
    reads: reads as Array<{ date: string; model: string; market_read: string | null }>,
    features: features as Array<{ date: string; data: Features }>,
    outcomes: outcomes.map((o) => ({ date: o.date as string, strategy: o.strategy as string, pl: Number(o.pl), trades: Number(o.trades) })),
  };
}
