/**
 * Automatic economic calendar for the day trader (Alpaca has none). Sources, fetched once a trading day before
 * the open and added to econ_events next to anything entered by hand:
 *  - FOMC rate decisions: the Fed's meeting calendar page (www.federalreserve.gov).
 *  - GDP, personal income & outlays (PCE inflation), trade balance: BEA's release-calendar ICS (www.bea.gov).
 *  - CPI, jobs report, PPI, retail sales, JOLTS, jobless claims: FRED's release dates (api.stlouisfed.org), only
 *    when FRED_API_KEY is set. BLS itself refuses automated requests, so it is not used.
 * The parsers are pure; fetchCalendar does the network calls.
 */

import { addDays, toEt } from "./time";

export interface EconRow {
  date: string; // YYYY-MM-DD (ET)
  time_et: string; // HH:MM
  event: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthIndex = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.trim().toLowerCase().slice(0, 3)));
const pad = (n: number) => String(n).padStart(2, "0");

// ---------------------------------------------------------------- FOMC

/**
 * Scheduled FOMC meetings from the Fed's calendar page: the decision (statement 14:00 ET, press conference 14:30)
 * is on the meeting's last day. "Apr/May 30-1" ends on May 1. Notation votes and other non-meeting rows are skipped.
 */
export function parseFomcCalendar(html: string): EconRow[] {
  const out: EconRow[] = [];
  const parts = html.split(/(\d{4}) FOMC Meetings/);
  for (let i = 1; i < parts.length; i += 2) {
    const year = Number(parts[i]);
    const re = /fomc-meeting__month[^>]*>\s*<strong>([^<]*)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]*)</g;
    for (const m of parts[i + 1].matchAll(re)) {
      const days = /^\s*(\d{1,2})(?:-(\d{1,2}))?(\*)?\s*$/.exec(m[2]);
      if (!days) continue;
      const months = m[1].split("/");
      const month = monthIndex(months[months.length - 1]);
      if (month < 0) continue;
      const day = Number(days[2] ?? days[1]);
      out.push({
        date: `${year}-${pad(month + 1)}-${pad(day)}`,
        time_et: "14:00",
        event: `FOMC rate decision${days[3] ? " + projections" : ""} (press conference 14:30)`,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------- BEA

/** Unfold and split an ICS file into its VEVENTs' properties (name → value, parameters dropped). */
function icsEvents(text: string): Array<Record<string, string>> {
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const out: Array<Record<string, string>> = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const props: Record<string, string> = {};
    for (const line of block.split("END:VEVENT")[0].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) props[line.slice(0, i).split(";")[0].toUpperCase()] = line.slice(i + 1).trim();
    }
    out.push(props);
  }
  return out;
}

const icsText = (s: string) => s.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ");

/** An ICS DATE-TIME in UTC ("20261125T133000Z") as an ET date and time. */
function icsUtcToEt(v: string): { date: string; hhmm: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  if (!m) return null;
  const et = toEt(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])));
  return { date: et.date, hhmm: et.hhmm };
}

/** The market-moving BEA releases, with short names; everything else (county GDP, satellite accounts…) is skipped. */
function beaName(summary: string): string | null {
  const gdp = /^GDP \(([^)]+)\)/.exec(summary);
  if (gdp) return `GDP (${gdp[1]})`;
  if (/^Gross Domestic Product(?! by)/i.test(summary)) return "GDP";
  if (/^Personal Income and Outlays/i.test(summary)) return "Personal income & outlays (PCE inflation)";
  if (/^U\.S\. International Trade in Goods and Services/i.test(summary)) return "Trade balance";
  return null;
}

export function parseBeaIcs(text: string): EconRow[] {
  const out: EconRow[] = [];
  for (const e of icsEvents(text)) {
    const name = e.SUMMARY ? beaName(icsText(e.SUMMARY)) : null;
    const at = e.DTSTART ? icsUtcToEt(e.DTSTART) : null;
    if (name && at) out.push({ date: at.date, time_et: at.hhmm, event: name });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.time_et.localeCompare(b.time_et));
}

// ---------------------------------------------------------------- FRED (BLS, Census, DOL releases)

/** FRED release ids for the releases BLS publishes (BLS blocks automated access) plus retail sales and claims. */
export const FRED_RELEASES = [
  { id: 10, event: "CPI", time: "08:30" },
  { id: 50, event: "Jobs report (Employment Situation)", time: "08:30" },
  { id: 46, event: "PPI", time: "08:30" },
  { id: 9, event: "Retail sales", time: "08:30" },
  { id: 192, event: "JOLTS job openings", time: "10:00" },
  { id: 180, event: "Initial jobless claims", time: "08:30" },
] as const;

/** FRED `fred/release/dates` JSON → rows for one release. */
export function parseFredReleaseDates(json: unknown, release: { event: string; time: string }): EconRow[] {
  const dates = (json as { release_dates?: Array<{ date?: unknown }> } | null)?.release_dates ?? [];
  return dates
    .map((d) => d.date)
    .filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .map((date) => ({ date, time_et: release.time, event: release.event }));
}

// ---------------------------------------------------------------- fetch

export interface CalendarFetch {
  rows: Array<EconRow & { source: "fed" | "bea" | "fred" }>;
  errors: string[];
  skipped: string[];
}

const UA = "economic-calendar-sync/1.0";

/** Fetch every source and keep rows dated `from` … `from + days`. One failing source doesn't stop the others. */
export async function fetchCalendar(
  from: string,
  days = 60,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarFetch> {
  const to = addDays(from, days);
  const inRange = (r: EconRow) => r.date >= from && r.date <= to;
  const out: CalendarFetch = { rows: [], errors: [], skipped: [] };
  const get = async (url: string) => {
    const res = await fetchImpl(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };

  try {
    out.rows.push(...parseFomcCalendar(await get("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm")).filter(inRange).map((r) => ({ ...r, source: "fed" as const })));
  } catch (err) {
    out.errors.push(`Fed calendar: ${err instanceof Error ? err.message : err}`);
  }
  try {
    out.rows.push(...parseBeaIcs(await get("https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics")).filter(inRange).map((r) => ({ ...r, source: "bea" as const })));
  } catch (err) {
    out.errors.push(`BEA calendar: ${err instanceof Error ? err.message : err}`);
  }
  const key = env.FRED_API_KEY?.trim();
  if (!key) out.skipped.push("CPI, jobs, PPI, retail sales, JOLTS and claims need FRED_API_KEY (free at fred.stlouisfed.org)");
  else {
    for (const r of FRED_RELEASES) {
      try {
        const q = new URLSearchParams({
          release_id: String(r.id), api_key: key, file_type: "json", include_release_dates_with_no_data: "true",
          realtime_start: from, realtime_end: "9999-12-31", sort_order: "asc", limit: "200",
        });
        out.rows.push(...parseFredReleaseDates(JSON.parse(await get(`https://api.stlouisfed.org/fred/release/dates?${q}`)), r).filter(inRange).map((x) => ({ ...x, source: "fred" as const })));
      } catch (err) {
        out.errors.push(`FRED ${r.event}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return out;
}
