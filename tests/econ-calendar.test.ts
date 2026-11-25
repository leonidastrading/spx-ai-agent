import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchCalendar, FRED_RELEASES, parseBeaIcs, parseFomcCalendar, parseFredReleaseDates } from "@/lib/econ-calendar";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/econ/${name}`, import.meta.url), "utf8");

describe("FOMC calendar (Fed page excerpt, 2026-11-25)", () => {
  const rows = parseFomcCalendar(fixture("fomccalendars.html"));
  it("decision on the meeting's last day at 14:00 ET, projections flagged, 2027 included", () => {
    const y26 = rows.filter((r) => r.date.startsWith("2026"));
    expect(y26.map((r) => r.date)).toEqual(["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"]);
    expect(rows.find((r) => r.date === "2026-12-09")).toEqual({ date: "2026-12-09", time_et: "14:00", event: "FOMC rate decision + projections (press conference 14:30)" });
    expect(rows.find((r) => r.date === "2026-10-28")?.event).toBe("FOMC rate decision (press conference 14:30)");
    expect(rows.filter((r) => r.date.startsWith("2027")).map((r) => r.date)).toEqual(["2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-11-17"]);
  });
  it("cross-month meetings end in the second month; notation votes are skipped", () => {
    expect(rows.map((r) => r.date)).toContain("2024-05-01"); // Apr/May 30-1
    expect(rows.map((r) => r.date)).toContain("2023-11-01"); // Oct/Nov 31-1
    expect(rows.map((r) => r.date)).not.toContain("2025-08-22"); // notation vote
  });
});

describe("BEA release calendar (ICS)", () => {
  const rows = parseBeaIcs(fixture("bea.ics"));
  it("keeps GDP, PCE and trade, in ET; skips minor releases", () => {
    expect(rows.filter((r) => r.date === "2026-11-25")).toEqual([
      { date: "2026-11-25", time_et: "08:30", event: "GDP (Second Estimate)" },
      { date: "2026-11-25", time_et: "08:30", event: "Personal income & outlays (PCE inflation)" },
    ]);
    expect(rows.find((r) => r.date === "2026-12-08")).toEqual({ date: "2026-12-08", time_et: "08:30", event: "Trade balance" });
    expect(rows.some((r) => /County|Outdoor|Multinational/.test(r.event))).toBe(false);
    expect(rows.some((r) => r.date === "2026-11-17")).toBe(false); // "Experimental ... Statistics"
  });
  it("unfolds long SUMMARY lines", () => {
    expect(rows.find((r) => r.date === "2025-01-30")).toEqual({ date: "2025-01-30", time_et: "08:30", event: "GDP" });
  });
});

describe("FRED release dates", () => {
  it("reads documented release_dates JSON", () => {
    const json = { realtime_start: "2026-11-25", release_dates: [{ release_id: 10, date: "2026-12-10" }, { release_id: 10, date: "bad" }, { release_id: 10, date: "2027-01-13" }] };
    expect(parseFredReleaseDates(json, FRED_RELEASES[0])).toEqual([
      { date: "2026-12-10", time_et: "08:30", event: "CPI" },
      { date: "2027-01-13", time_et: "08:30", event: "CPI" },
    ]);
    expect(parseFredReleaseDates(null, FRED_RELEASES[0])).toEqual([]);
  });
});

describe("fetchCalendar", () => {
  const fakeFetch = (fail: string[] = []) =>
    (async (url: string) => {
      if (fail.some((f) => url.includes(f))) return new Response("nope", { status: 403 });
      if (url.includes("federalreserve")) return new Response(fixture("fomccalendars.html"));
      if (url.includes("bea.gov")) return new Response(fixture("bea.ics"));
      const id = Number(new URL(url).searchParams.get("release_id"));
      return new Response(JSON.stringify({ release_dates: [{ release_id: id, date: "2026-12-10" }] }));
    }) as unknown as typeof fetch;

  it("merges sources in the window; FRED only with a key", async () => {
    const r = await fetchCalendar("2026-11-25", 30, {}, fakeFetch());
    expect(r.errors).toEqual([]);
    expect(r.skipped[0]).toMatch(/FRED_API_KEY/);
    expect(r.rows.map((x) => `${x.date} ${x.source} ${x.event}`)).toEqual([
      "2026-12-09 fed FOMC rate decision + projections (press conference 14:30)",
      "2026-11-25 bea GDP (Second Estimate)",
      "2026-11-25 bea Personal income & outlays (PCE inflation)",
      "2026-12-08 bea Trade balance",
      "2026-12-23 bea GDP (Third Estimate)",
      "2026-12-23 bea Personal income & outlays (PCE inflation)",
    ]);
    const withKey = await fetchCalendar("2026-11-25", 30, { FRED_API_KEY: "k" }, fakeFetch());
    expect(withKey.rows.filter((x) => x.source === "fred").map((x) => x.event)).toEqual(FRED_RELEASES.map((x) => x.event));
  });

  it("one failing source doesn't stop the others", async () => {
    const r = await fetchCalendar("2026-11-25", 30, {}, fakeFetch(["federalreserve"]));
    expect(r.errors).toEqual(["Fed calendar: HTTP 403"]);
    expect(r.rows.every((x) => x.source === "bea")).toBe(true);
  });
});
