import { describe, expect, it } from "vitest";
import { SCHEDULE } from "@/config/rules";
import { addDays, cronGate, etToUtc, isEarlyClose, priorSession, sessionOn, toEt } from "@/lib/time";
import { CALENDAR, session } from "./fixtures/sample";

describe("etToUtc / toEt across DST", () => {
  it.each([
    ["2024-03-08", "09:30", "2024-03-08T14:30:00.000Z"], // EST
    ["2024-03-11", "09:30", "2024-03-11T13:30:00.000Z"], // EDT, first day after spring-forward
    ["2024-11-01", "16:00", "2024-11-01T20:00:00.000Z"], // EDT
    ["2024-11-04", "09:30", "2024-11-04T14:30:00.000Z"], // EST, first day after fall-back
    ["2024-11-04", "10:50", "2024-11-04T15:50:00.000Z"],
    ["2024-07-03", "13:00", "2024-07-03T17:00:00.000Z"],
  ])("%s %s ET -> %s", (date, hhmm, iso) => {
    const d = etToUtc(date, hhmm);
    expect(d.toISOString()).toBe(iso);
    expect(toEt(d)).toMatchObject({ date, hhmm });
  });

  it("handles the transition Sundays themselves", () => {
    expect(etToUtc("2024-03-10", "12:00").toISOString()).toBe("2024-03-10T16:00:00.000Z");
    expect(etToUtc("2024-11-03", "12:00").toISOString()).toBe("2024-11-03T17:00:00.000Z");
  });

  it("addDays crosses month/year", () => {
    expect(addDays("2024-12-31", 1)).toBe("2025-01-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
  });
});

describe("calendar", () => {
  it("normalizes HHMM and detects early closes", () => {
    expect(session("2024-11-29")).toEqual({ date: "2024-11-29", open: "09:30", close: "13:00" });
    expect(isEarlyClose(session("2024-11-29"))).toBe(true);
    expect(isEarlyClose(session("2024-07-03"))).toBe(true);
    expect(isEarlyClose(session("2024-11-27"))).toBe(false);
  });

  it("prior session skips weekends and holidays", () => {
    expect(priorSession(CALENDAR, "2024-03-11")?.date).toBe("2024-03-08");
    expect(priorSession(CALENDAR, "2024-07-05")?.date).toBe("2024-07-03");
    expect(priorSession(CALENDAR, "2024-12-02")?.date).toBe("2024-11-29");
  });
});

describe("cronGate", () => {
  const gate = (iso: string) => {
    const now = new Date(iso);
    return cronGate(now, sessionOn(CALENDAR, toEt(now).date), SCHEDULE);
  };

  it("13:30 UTC is 09:30 in EDT (ingest) but 08:30 in EST (skip)", () => {
    expect(gate("2024-03-11T13:30:00Z").action).toBe("ingest");
    expect(gate("2024-03-08T13:30:00Z")).toMatchObject({ action: "skip" });
    expect(gate("2024-11-04T13:30:00Z")).toMatchObject({ action: "skip" });
    expect(gate("2024-11-04T14:30:00Z").action).toBe("ingest");
  });

  it("10:50 ET ingests, 10:51-11:05 decide only, later skips (EST and EDT)", () => {
    expect(gate("2024-11-04T15:50:10Z").action).toBe("ingest");
    expect(gate("2024-11-04T15:51:00Z").action).toBe("decide_only");
    expect(gate("2024-11-04T16:05:00Z").action).toBe("decide_only");
    expect(gate("2024-11-04T16:06:00Z").action).toBe("skip");
    expect(gate("2024-03-11T14:50:00Z").action).toBe("ingest");
    expect(gate("2024-03-11T14:51:00Z").action).toBe("decide_only");
  });

  it("skips weekends and holidays", () => {
    expect(gate("2024-03-09T14:30:00Z")).toMatchObject({ action: "skip", reason: expect.stringContaining("weekend") });
    expect(gate("2024-07-04T14:30:00Z")).toMatchObject({ action: "skip", reason: expect.stringContaining("not a trading day") });
  });

  it("runs on early-close days (window is in the morning)", () => {
    expect(gate("2024-11-29T15:00:00Z").action).toBe("ingest"); // 10:00 EST
  });
});
