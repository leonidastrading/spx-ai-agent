import { describe, expect, it } from "vitest";
import type { BookEntryRow } from "@/lib/book-entries";
import { buildLiveScore, type CallRow } from "@/lib/live-scoring";
import { etToUtc } from "@/lib/time";

const names = ["Long", "BWB", "2DTE<20"];
const call = (date: string, strategy: string, c: string, source = "llm", version_id: number | null = null, reason = "x"): CallRow => ({ date, strategy, source, call: c, reason, version_id });
let n = 0;
const fill = (date: string, hhmm: string, rawBot: string, pl: number | null, vix: number | null = 15): BookEntryRow => ({
  entryId: `e${++n}`, entryDate: date, filledAt: etToUtc(date, hhmm).toISOString(), rawBot, match: "exact", matchConfidence: 1, vixAtEntry: vix, vixSource: "snapshot",
  structure: "x", legs: [], contracts: 1, netPrice: 1, status: pl === null ? "open" : "closed", pl, closedAt: null, how: null,
});
const vn = (id: number | null) => (id === null ? 1 : id);

describe("live scoring on Schwab fills", () => {
  it("scores only bots that entered after 10:50 by ENTRY date; the rest say why", () => {
    const s = buildLiveScore({
      calls: [
        call("2026-10-20", "Long", "skip"), call("2026-10-20", "BWB", "reduce"), call("2026-10-20", "2DTE<20", "run"),
        call("2026-10-21", "Long", "run"), call("2026-10-21", "BWB", "skip"),
        call("2026-10-21", "2DTE", "skip"), // legacy name: dropped
        call("2026-10-16", "Long", "skip"), // before live fills: dropped
        call("2026-10-21", "*", "error"),
      ],
      entries: [
        fill("2026-10-20", "11:15", "Long", -500),
        fill("2026-10-20", "13:50", "BWB", 200), fill("2026-10-20", "14:20", "BWB", -100),
        fill("2026-10-20", "15:30", "2DTE", -300), // closed 2 days later: still the 10-20 entry
        fill("2026-10-21", "09:45", "Long", 400), // before the call
        fill("2026-10-21", "13:50", "BWB", null), // still open
        fill("2026-10-21", "15:50", "VIX-up PS", 50, null), // VIX unknown: unmapped
      ],
      names,
      versionNumber: vn,
      syncedThrough: "2026-10-21",
      sims: 200,
    });
    expect(s.status.get("2026-10-20")!.get("BWB")).toEqual({ kind: "scored", pl: 100, entries: 2 });
    expect(s.status.get("2026-10-20")!.get("2DTE<20")).toEqual({ kind: "scored", pl: -300, entries: 1 });
    expect(s.status.get("2026-10-21")!.get("Long")).toEqual({ kind: "before_call", entries: 1 });
    expect(s.status.get("2026-10-21")!.get("BWB")).toMatchObject({ kind: "awaiting_pl" });
    const all = s.rows.find((r) => r.source === "LLM v1" && r.strategy === "ALL")!;
    expect(all.days).toBe(3); // Long, BWB, 2DTE<20 on 10-20
    expect(all.saved).toBe(500); // skip Long −500
    expect(all.forgone).toBe(50); // reduce BWB +100
    expect(s.scoredEntries).toBe(4);
    expect(s.unmapped).toEqual([expect.objectContaining({ date: "2026-10-21", rawBot: "VIX-up PS", note: expect.stringMatching(/VIX at entry unknown/) })]);
    const long = s.diagnostics.find((d) => d.bot === "Long")!;
    expect(long).toMatchObject({ callDays: 2, scoredDays: 1, reasons: { "entered before the 10:50 call": 1 } });
    // Too few entries: the ALL row is flagged unreliable whatever the p-value.
    expect(s.all["LLM v1"].reliable).toBe(false);
    expect(s.all["LLM v1"].entries).toBe(4);
  });

  it("a bot with no fill is n/a – no entry once the day is synced; versions and an inactive rule are kept apart", () => {
    const s = buildLiveScore({
      calls: [
        call("2026-11-12", "Long", "skip", "llm", 7), call("2026-11-12", "BWB", "run", "llm", 7),
        call("2026-11-12", "Long", "run", "rule", 7, "ATR leg skipped (8/60 days of history)"),
        call("2026-11-13", "Long", "run", "llm", 7),
      ],
      entries: [fill("2026-11-12", "13:50", "BWB", -40)],
      names,
      versionNumber: (id) => (id === 7 ? 2 : 1),
      syncedThrough: "2026-11-12",
      sims: 100,
    });
    expect(s.status.get("2026-11-12")!.get("Long")).toEqual({ kind: "no_entry" });
    expect(s.status.get("2026-11-13")!.get("Long")).toEqual({ kind: "not_synced" });
    expect(s.sources).toEqual(["LLM v2"]); // inactive rule rows are not scored
    expect(s.rows.filter((r) => r.strategy !== "ALL").map((r) => r.strategy)).toEqual(["BWB"]);
  });
});
