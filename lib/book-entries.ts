/**
 * The book's live Schwab entries (via oo-trading's read-only export), stored for scoring the 10:50 calls on what
 * actually traded. Entries are matched to calls by ENTRY date. P/L is the realized P/L once closed or expired.
 * The settings bot name is derived at read time from oo-trading's bot name and VIX at entry (2DTE and VIX-up
 * run as two variants split at VIX 20).
 */

import { liveBot } from "@/config/bots";
import { STRATEGIES } from "@/config/strategies";
import { query as q } from "./db";
import type { OoExport } from "./entry/contract";
import { settingsBotName } from "./settings";
import { toEt } from "./time";

/** Live scoring starts here: the first day of the book's live Schwab fills. */
export const LIVE_SINCE = "2026-10-19";

export interface BookEntryRow {
  entryId: string;
  entryDate: string;
  filledAt: string;
  rawBot: string | null;
  match: string;
  matchConfidence: number;
  vixAtEntry: number | null;
  vixSource: "snapshot" | "daily_close" | null;
  structure: string;
  legs: unknown;
  contracts: number;
  netPrice: number;
  status: "open" | "closed";
  pl: number | null;
  closedAt: string | null;
  how: string | null;
}

type Snap = { at: string; vix: number | null };

/**
 * VIX at an entry: the latest quote snapshot at most 2 minutes before the fill, else that day's VIX close (an
 * approximation, flagged), else unknown.
 */
export function vixAtEntry(filledAt: string, snaps: Snap[], dailyClose: Map<string, number>): { vix: number | null; source: BookEntryRow["vixSource"] } {
  const t = Date.parse(filledAt);
  const s = snaps.filter((x) => x.vix !== null && Date.parse(x.at) <= t && t - Date.parse(x.at) <= 120000).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (s) return { vix: s.vix, source: "snapshot" };
  const close = dailyClose.get(toEt(new Date(t)).date);
  return close !== undefined ? { vix: close, source: "daily_close" } : { vix: null, source: null };
}

/** Rows for every entry in an export, with outcomes joined. Pure. */
export function entriesFromExport(exp: OoExport, storedSnaps: Snap[] = []): BookEntryRow[] {
  const outcome = new Map(exp.outcomes.map((o) => [o.entryId, o]));
  const snaps = [...storedSnaps, ...exp.market.snapshots];
  const daily = new Map(exp.market.vixDaily15.map((b) => [b.t.slice(0, 10), b.c]));
  return exp.entries.map((e) => {
    const o = outcome.get(e.id);
    const v = vixAtEntry(e.filledAt, snaps, daily);
    return {
      entryId: e.id,
      entryDate: toEt(new Date(e.filledAt)).date,
      filledAt: e.filledAt,
      rawBot: e.bot,
      match: e.match,
      matchConfidence: e.matchConfidence,
      vixAtEntry: v.vix,
      vixSource: v.source,
      structure: e.structure,
      legs: e.legs,
      contracts: e.contracts,
      netPrice: e.netPrice,
      status: o ? "closed" : "open",
      pl: o ? o.pl : null,
      closedAt: o ? o.closedAt : null,
      how: o ? o.how : null,
    };
  });
}

/** Insert or refresh entries (P/L arrives later; a known VIX is never replaced by an unknown one). */
export async function upsertBookEntries(rows: BookEntryRow[]): Promise<number> {
  for (const r of rows) {
    await q(
      `INSERT INTO book_entries (entry_id, entry_date, filled_at, raw_bot, match, match_confidence, vix_at_entry, vix_source, structure, legs, contracts, net_price, status, pl, closed_at, how, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       ON CONFLICT (entry_id) DO UPDATE SET raw_bot = excluded.raw_bot, match = excluded.match, match_confidence = excluded.match_confidence,
         vix_at_entry = COALESCE(book_entries.vix_at_entry, excluded.vix_at_entry), vix_source = COALESCE(book_entries.vix_source, excluded.vix_source),
         status = excluded.status, pl = COALESCE(excluded.pl, book_entries.pl), closed_at = COALESCE(excluded.closed_at, book_entries.closed_at),
         how = COALESCE(excluded.how, book_entries.how), synced_at = now()`,
      [r.entryId, r.entryDate, r.filledAt, r.rawBot, r.match, r.matchConfidence, r.vixAtEntry, r.vixSource, r.structure, JSON.stringify(r.legs), r.contracts, r.netPrice, r.status, r.pl, r.closedAt, r.how],
    );
  }
  return rows.length;
}

export async function loadBookEntries(from = LIVE_SINCE): Promise<BookEntryRow[]> {
  const rows = await q(`SELECT *, to_char(entry_date, 'YYYY-MM-DD') AS d FROM book_entries WHERE entry_date >= $1 ORDER BY filled_at`, [from]);
  return rows.map((r) => ({
    entryId: r.entry_id, entryDate: r.d, filledAt: new Date(r.filled_at).toISOString(), rawBot: r.raw_bot, match: r.match, matchConfidence: Number(r.match_confidence),
    vixAtEntry: r.vix_at_entry === null ? null : Number(r.vix_at_entry), vixSource: r.vix_source, structure: r.structure, legs: r.legs,
    contracts: Number(r.contracts), netPrice: Number(r.net_price), status: r.status, pl: r.pl === null ? null : Number(r.pl),
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null, how: r.how,
  }));
}

/** The settings bot an entry belongs to, or why it has none. */
export function settingsBotFor(e: Pick<BookEntryRow, "rawBot" | "vixAtEntry">, names: string[]): { bot: string; note: null } | { bot: null; note: string } {
  const live = liveBot(e.rawBot, e.vixAtEntry);
  if (!live.bot) return live;
  const name = settingsBotName(live.bot, names);
  if (name) return { bot: name, note: null };
  // A default name the user has no bot for: say so (a name mismatch), naming what was expected.
  const known = STRATEGIES.some((s) => s.name === live.bot);
  return { bot: null, note: `"${e.rawBot}" maps to ${known ? `"${live.bot}"` : live.bot}, which isn't a bot in Settings` };
}

const SYNC_KEY = "book_sync";

/** Last full history sync (ET date), from the settings table. */
export async function lastFullSync(): Promise<string | null> {
  return (await q(`SELECT value FROM settings WHERE key = $1`, [SYNC_KEY]))[0]?.value?.date ?? null;
}

/** Fetch every entry since LIVE_SINCE from the export and store it; once a day is enough. */
export async function syncBookHistory(fetchExport: (since: string) => Promise<OoExport>, now: Date, storedSnaps: Snap[] = []): Promise<number> {
  const exp = await fetchExport(`${LIVE_SINCE}T04:00:00.000Z`);
  const n = await upsertBookEntries(entriesFromExport(exp, storedSnaps));
  await q(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`, [
    SYNC_KEY,
    JSON.stringify({ date: toEt(now).date, at: now.toISOString(), entries: n }),
  ]);
  return n;
}

/** Last ET date whose fills are fully stored: the sync date if it ran after 16:30 ET, else the day before. */
export async function syncedThrough(): Promise<string | null> {
  const v = (await q(`SELECT value FROM settings WHERE key = $1`, [SYNC_KEY]))[0]?.value;
  if (!v?.at) return null;
  const et = toEt(new Date(v.at));
  if (et.minutes >= 16 * 60 + 30) return et.date;
  const d = new Date(`${et.date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
