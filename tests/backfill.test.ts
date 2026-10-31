import { describe, expect, it } from "vitest";
import { chunkBounds, monthChunks, morningRows, regularSessionOnly, MORNING_COLUMNS } from "@/lib/backfill";
import { etToUtc } from "@/lib/time";
import { CALENDAR, flatSession, makeBars, session } from "./fixtures/sample";

describe("backfill helpers", () => {
  it("month chunks clip both ends", () => {
    expect(monthChunks("2024-01-15", "2024-03-03")).toEqual([
      { key: "2024-01", from: "2024-01-15", to: "2024-01-31" },
      { key: "2024-02", from: "2024-02-01", to: "2024-02-29" },
      { key: "2024-03", from: "2024-03-01", to: "2024-03-03" },
    ]);
  });

  it("chunk bounds are ET midnights (DST-aware)", () => {
    const b = chunkBounds({ from: "2024-03-01", to: "2024-03-31" });
    expect(b.start.toISOString()).toBe("2024-03-01T05:00:00.000Z");
    expect(b.end.toISOString()).toBe("2024-04-01T04:00:00.000Z");
  });

  it("keeps only regular-session bars, honouring early closes", () => {
    const s = session("2024-07-03");
    const inside = makeBars("SPY", s, 1, [1, 1]);
    const pre = { ...inside[0], ts: etToUtc(s.date, "09:29").toISOString() };
    const afterEarly = { ...inside[0], ts: etToUtc(s.date, "13:00").toISOString() };
    expect(regularSessionOnly([pre, ...inside, afterEarly], CALENDAR)).toEqual(inside);
  });

  it("morning rows: 10:50 features, rule call and trailing ATR history", () => {
    const sessions = [session("2024-11-01"), session("2024-11-04")];
    const bars = [
      ...flatSession("SPY", sessions[0], 570),
      ...makeBars("SPY", sessions[1], 570, Array(90).fill(560)), // -1.75% at 10:50
    ];
    const atrHistory: number[] = [];
    const rows = morningRows({ sessions: [sessions[1]], allSessions: CALENDAR, bars, news: [], feed: "sip", atrHistory });
    expect(rows).toHaveLength(1);
    expect(rows[0].as_of).toBe("2024-11-04T15:50:00.000Z");
    expect(rows[0].bars_used).toBe(80);
    expect(rows[0].rule_call).toBe("reduce");
    expect(rows[0].early_close).toBe(false);
    expect(atrHistory).toHaveLength(1);
    for (const col of MORNING_COLUMNS) expect(col in rows[0]).toBe(true);
  });
});
