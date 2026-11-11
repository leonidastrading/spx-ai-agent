import { describe, expect, it } from "vitest";
import { DEFAULT_KEYWORDS } from "@/lib/news";
import { buildPacket, expirationsOn, packetHash, type PacketInput } from "@/lib/entry/packet";
import { parseEntryReply, entryVersionHash } from "@/lib/entry/prompt";
import { at, entry, ooExport } from "./fixtures/ooExport";

const base = (p: Partial<PacketInput> = {}): PacketInput => {
  const exp = ooExport();
  return {
    entry: exp.entries[0],
    exp,
    bookSnapshots: [{ asOf: at("13:29", 55), book: exp.book }, { asOf: at("13:30", 20), book: { ...exp.book, todayTotal: 9999 } }],
    rel: { daily: { SPY: [{ t: "2024-03-08T05:00:00Z", o: 1, h: 1, l: 1, c: 500 }] }, intraday: { SPY: [{ t: at("13:29"), o: 501, h: 501, l: 501, c: 502, v: 10 }, { t: at("13:31"), o: 600, h: 600, l: 600, c: 600, v: 10 }] } },
    headlines: [
      { id: 1, ts: at("13:20"), headline: "Powell says rates stay high", symbols: ["SPY"] },
      { id: 2, ts: at("13:30", 30), headline: "AFTER THE FILL", symbols: [] },
    ],
    headlinesSince: at("11:11"),
    newsFeedOk: true,
    newsSummary10d: { text: "CPI cooler; Fed patient.", asOf: at("09:05") },
    econToday: [{ time_et: "10:00", event: "ISM Services" }, { time_et: "14:00", event: "FOMC minutes" }],
    nextFed: "2024-03-20 14:00 FOMC decision",
    morningCall: { call: "reduce", reason: "ATR high", decidedAt: at("10:50", 30) },
    keywords: DEFAULT_KEYWORDS,
    ...p,
  };
};

describe("packet: nothing after the entry", () => {
  const { packet, complete } = buildPacket(base());
  const json = JSON.stringify(packet);
  it("is complete and hashes stably", () => {
    expect(complete).toBe(true);
    expect(packetHash(packet)).toBe(packetHash(buildPacket(base()).packet));
    expect(packet.entry_time_et).toBe("2024-03-11 13:30:04");
  });
  it("uses only bars that had closed before the fill", () => {
    const spx = (packet.market as any).spx;
    expect(spx.bars_1m_today.at(-1)[0]).toBe("13:29");
    expect(spx.bars_5m_5d.map((b: any[]) => b[0])).toEqual(["03-11 13:25"]);
    expect((packet.market as any).relative.SPY.today_pct).toBeCloseTo(0.4, 6); // 502 vs 500, not the 13:31 bar
  });
  it("uses the latest quote snapshot at or before the fill, and reports its age", () => {
    expect((packet.market as any).vol.vix).toBe(16.0);
    expect((packet.trade as any).short_strikes_from_spot[0]).toMatchObject({ strike: 5050, points: -78 });
    expect(packet.health.quote_age_s).toBe(14);
    expect(packet.health.notes.join()).not.toMatch(/old/); // 14 s is inside the 15 s limit
    const e = ooExport();
    const stale = buildPacket(base({ exp: { ...e, market: { ...e.market, snapshots: [{ at: at("13:29", 40), spx: 5128, vix: 16, vix9d: 15 }] } } }));
    expect(stale.packet.health.notes.join()).toMatch(/24s old \(limit 15s\)/);
  });
  it("uses the book snapshot from before the fill and drops this entry", () => {
    expect((packet.book as any).today_total).toBe(120);
  });
  it("drops headlines after the fill, today's bot results, and the after-fill gauge", () => {
    expect(json).not.toContain("AFTER THE FILL");
    expect((packet.bot_record as any).last_10_days.map((d: any) => d.date)).toEqual(["2024-03-08"]);
    const late = buildPacket(base({ exp: { ...ooExport(), market: { ...ooExport().market, gauge: { today: { straddle: 20, strike: 5100, capturedAt: at("13:31") }, avgMoveRatio10d: 1 } } } })).packet;
    expect((late.market as any).vol.straddle_10am).toMatch(/not captured/);
  });
  it("marks calendar events as happened by the entry time; flags missing sources", () => {
    expect((packet.calendar as any).econ_today).toEqual([
      { time_et: "10:00", event: "ISM Services", happened: true },
      { time_et: "14:00", event: "FOMC minutes", happened: false },
    ]);
    expect(packet.sentiment).toMatch(/MISSING/);
    expect((packet.calendar as any).megacap_earnings).toMatch(/MISSING/);
    expect(packet.morning_call).toMatchObject({ call: "reduce" });
  });
  it("is incomplete when a required block is missing", () => {
    const noBot = buildPacket(base({ entry: entry({ bot: "Unknown" }) }));
    expect(noBot.complete).toBe(false);
    expect(noBot.packet.health.missing).toContain("bot_record");
    const noBook = buildPacket(base({ bookSnapshots: [] }));
    expect(noBook.packet.health.missing).toContain("book");
  });
  it("index option expirations", () => {
    expect(expirationsOn("2024-03-15")).toContain("SPX monthly (AM-settled, third Friday)");
    expect(expirationsOn("2024-06-28")).toContain("quarter-end SPX (PM)"); // last weekday of June
    expect(expirationsOn("2024-06-27")).not.toContain("quarter-end SPX (PM)");
    expect(expirationsOn("2024-03-11")).toEqual(["SPXW 0DTE (daily)"]);
  });
});

describe("reply rules", () => {
  const ok = { verdict: "skip", confidence: 70, day_type: "trend_down", reasons: [{ category: "price", text: "Broke the opening range low on volume." }], main_risk: "Afternoon squeeze.", would_change_mind: "Reclaim of VWAP.", data_ok: true };
  it("accepts a valid reply", () => expect(parseEntryReply(JSON.stringify(ok)).reply.verdict).toBe("skip"));
  it("at least one reason, enums enforced", () => {
    expect(() => parseEntryReply(JSON.stringify({ ...ok, reasons: [] }))).toThrow();
    expect(() => parseEntryReply(JSON.stringify({ ...ok, verdict: "half" }))).toThrow();
  });

  it("trims over-long text to 25 words and keeps the call (flagged), never drops it for length", () => {
    const long = Array(40).fill("w").join(" ");
    const r = parseEntryReply(JSON.stringify({ ...ok, main_risk: long, reasons: Array(4).fill({ ...ok.reasons[0], text: long }) }));
    expect(r.reply.verdict).toBe("skip");
    expect(r.reply.main_risk.split(" ")).toHaveLength(25);
    expect(r.reply.main_risk.endsWith("…")).toBe(true);
    expect(r.reply.reasons).toHaveLength(3);
    expect(r.trimmed).toEqual(expect.arrayContaining(["main_risk", "reasons[0]", "reasons (4 → 3)"]));
    expect(parseEntryReply(JSON.stringify(ok)).trimmed).toEqual([]);
  });
  it("model and effort are part of the version", () => {
    expect(entryVersionHash("claude-opus-5-5", "low")).not.toBe(entryVersionHash("claude-opus-5-5", "medium"));
  });
});
