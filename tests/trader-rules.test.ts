import { describe, expect, it } from "vitest";
import { TRADER } from "@/config/trader";
import type { Bar } from "@/lib/alpaca";
import { dailyStopHit, dataProblems, decisionSlot, entryBlocked, parseReply, parseReplyChecked, timeExitDue, validateAction, type DayState, type Reply } from "@/lib/trader/rules";
import { etToUtc } from "@/lib/time";

const D = "2024-03-11"; // EDT
const at = (hhmm: string, sec = 5) => new Date(etToUtc(D, hhmm).getTime() + sec * 1000);
const flat: DayState = { open: null, tradesToday: 0, closedToday: [], gateFailed: false, enabled: true };
const reply = (r: Partial<Reply>): Reply => ({ action: "long", confidence: 70, stop: 498.5, target: 502, max_hold_minutes: 60, catalyst: "technical", thesis: "Breakout above VWAP with volume.", ...r });

describe("reply parsing", () => {
  it("accepts strict JSON and enforces the 40-word thesis", () => {
    expect(parseReply(JSON.stringify(reply({}))).action).toBe("long");
    // v2: an over-long thesis is trimmed to 40 words and flagged, not rejected.
    const long = parseReplyChecked(JSON.stringify(reply({ thesis: Array(44).fill("w").join(" ") })));
    expect(long.trimmed).toBe(true);
    expect(long.reply.thesis.split(" ")).toHaveLength(40);
    expect(parseReplyChecked(JSON.stringify(reply({}))).trimmed).toBe(false);
    expect(() => parseReply(JSON.stringify({ ...reply({}), action: "buy" }))).toThrow(/schema/);
    expect(() => parseReply("hold")).toThrow(/no JSON/);
  });
});

describe("validateAction (code-enforced rules)", () => {
  const price = 500;
  it("accepts a valid long and sizes $10k notional", () => {
    const v = validateAction(reply({}), price, at("10:00"), flat);
    expect(v).toMatchObject({ ok: true, kind: "enter", side: "long", qty: 20, stop: 498.5, target: 502 });
  });

  it("stop distance must be 0.15%–0.75% of price", () => {
    expect(validateAction(reply({ stop: 499.5 }), price, at("10:00"), flat)).toMatchObject({ ok: false, reason: expect.stringMatching(/stop distance 0\.100%/) });
    expect(validateAction(reply({ stop: 496, target: 510 }), price, at("10:00"), flat)).toMatchObject({ ok: false, reason: expect.stringMatching(/stop distance 0\.800%/) });
    expect(validateAction(reply({ stop: 499.25, target: 500.75 }), price, at("10:00"), flat)).toMatchObject({ ok: true }); // exactly 0.15% / 1×
  });

  it("target must be at least 1× the stop distance, on the right side", () => {
    expect(validateAction(reply({ stop: 498, target: 501 }), price, at("10:00"), flat)).toMatchObject({ ok: false, reason: expect.stringMatching(/target distance/) });
    expect(validateAction(reply({ action: "short", stop: 498, target: 502 }), price, at("10:00"), flat)).toMatchObject({ ok: false, reason: expect.stringMatching(/wrong side/) });
    expect(validateAction(reply({ action: "short", stop: 502, target: 497 }), price, at("10:00"), flat)).toMatchObject({ ok: true, side: "short" });
  });

  it("time windows use the server clock: no entries before 09:35 or after 15:30", () => {
    expect(validateAction(reply({}), price, at("09:34", 59), flat)).toMatchObject({ ok: false, reason: expect.stringMatching(/before 09:35/) });
    expect(validateAction(reply({}), price, at("15:31"), flat)).toMatchObject({ ok: false, reason: expect.stringMatching(/after 15:30/) });
    expect(validateAction(reply({}), price, at("15:30"), flat)).toMatchObject({ ok: true });
  });

  it("time limit never runs past 15:55", () => {
    const v = validateAction(reply({ max_hold_minutes: 240 }), price, at("15:30"), flat);
    expect(v).toMatchObject({ ok: true, maxHoldMinutes: 25 });
  });

  it("one position, 3 trades a day, daily stop, disabled, gate failed", () => {
    const open = { id: 1, side: "long" as const, qty: 20, entryPrice: 500, entryAt: at("09:40").toISOString(), stop: 498, target: 503, maxHoldMinutes: 60 };
    expect(validateAction(reply({}), price, at("10:00"), { ...flat, open })).toMatchObject({ ok: false, reason: "already in a position" });
    expect(validateAction(reply({}), price, at("10:00"), { ...flat, tradesToday: 3 })).toMatchObject({ ok: false, reason: expect.stringMatching(/3 trades/) });
    const losers = [{ side: "long" as const, pl: -10, exitAt: "a" }, { side: "short" as const, pl: -5, exitAt: "b" }];
    expect(validateAction(reply({}), price, at("10:00"), { ...flat, closedToday: losers, tradesToday: 2 })).toMatchObject({ ok: false, reason: expect.stringMatching(/2 losing trades/) });
    expect(validateAction(reply({}), price, at("10:00"), { ...flat, enabled: false })).toMatchObject({ ok: false, reason: "trading disabled" });
    expect(validateAction(reply({}), price, at("10:00"), { ...flat, gateFailed: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/gate/) });
  });

  it("daily loss of 1.5% of notional stops new entries", () => {
    expect(dailyStopHit([{ side: "long", pl: -149, exitAt: "a" }])).toBeNull();
    expect(dailyStopHit([{ side: "long", pl: 20, exitAt: "a" }, { side: "long", pl: -170, exitAt: "b" }])).toMatch(/daily loss/);
    expect(dailyStopHit([{ side: "long", pl: -10, exitAt: "a" }, { side: "long", pl: 5, exitAt: "b" }, { side: "long", pl: -10, exitAt: "c" }])).toBeNull();
  });

  it("stops may be tightened, never widened; close needs a position", () => {
    const open = { id: 1, side: "long" as const, qty: 20, entryPrice: 500, entryAt: at("09:40").toISOString(), stop: 498, target: 503, maxHoldMinutes: 60 };
    const st = { ...flat, open };
    expect(validateAction(reply({ action: "hold", stop: 499 }), 501, at("10:00"), st)).toEqual({ ok: true, kind: "hold", tightenStop: 499 });
    expect(validateAction(reply({ action: "hold", stop: 497 }), 501, at("10:00"), st)).toEqual({ ok: true, kind: "hold", tightenStop: null });
    expect(validateAction(reply({ action: "hold", stop: 502 }), 501, at("10:00"), st)).toMatchObject({ ok: false });
    expect(validateAction(reply({ action: "close" }), 501, at("10:00"), flat)).toMatchObject({ ok: false });
    expect(validateAction(reply({ action: "close" }), 501, at("10:00"), st)).toEqual({ ok: true, kind: "close" });
  });
});

describe("exits and schedule", () => {
  const open = { id: 1, side: "long" as const, qty: 20, entryPrice: 500, entryAt: at("10:00", 0).toISOString(), stop: 498, target: 503, maxHoldMinutes: 30 };
  it("time limit and 15:55 flat", () => {
    expect(timeExitDue(at("10:29", 59), open)).toBeNull();
    expect(timeExitDue(at("10:30", 0), open)).toBe("time");
    expect(timeExitDue(at("15:55", 0), { ...open, maxHoldMinutes: 999 })).toBe("eod");
  });

  it("decision slots every 5 minutes 09:35–15:30, plus the 09:25 pre-market read (EST and EDT)", () => {
    expect(decisionSlot(at("09:25"))).toEqual({ phase: "premarket", hhmm: "09:25" });
    expect(decisionSlot(at("09:30"))).toBeNull();
    expect(decisionSlot(at("09:35"))).toEqual({ phase: "intraday", hhmm: "09:35" });
    expect(decisionSlot(at("09:36"))).toBeNull();
    expect(decisionSlot(at("15:30"))).toEqual({ phase: "intraday", hhmm: "15:30" });
    expect(decisionSlot(at("15:35"))).toBeNull();
    expect(decisionSlot(new Date("2024-11-04T15:00:03Z"))).toEqual({ phase: "intraday", hhmm: "10:00" }); // EST
    expect(entryBlocked(at("09:35"), flat)).toBeNull();
  });
});

describe("data guards", () => {
  const open = etToUtc(D, "09:30");
  const bars = (from: string, n: number, skip: number[] = []): Bar[] =>
    Array.from({ length: n }, (_, i) => i)
      .filter((i) => !skip.includes(i))
      .map((i) => ({ symbol: "QQQ", ts: new Date(etToUtc(D, from).getTime() + i * 60000).toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1, feed: "iex" as const }));
  const now = at("10:00", 3); // last completed minute: 09:59
  const quote = { ts: new Date(now.getTime() - 2000).toISOString(), bid: 500, ask: 500.02 };

  it("clean data passes", () => {
    expect(dataProblems({ now, quote, bars1m: bars("09:30", 30), sessionOpen: open })).toEqual([]);
  });
  it("stale quote (>10 s)", () => {
    expect(dataProblems({ now, quote: { ...quote, ts: new Date(now.getTime() - 11000).toISOString() }, bars1m: bars("09:30", 30), sessionOpen: open })[0]).toMatch(/quote 11\.0s old/);
  });
  it("missing bar in the last 15 minutes", () => {
    // v2: one gap in the window is tolerated (IEX skips minutes with no trades); two are not.
    expect(dataProblems({ now, quote, bars1m: bars("09:30", 30, [27]), sessionOpen: open })).toEqual([]);
    expect(dataProblems({ now, quote, bars1m: bars("09:30", 30, [22, 27]), sessionOpen: open })[0]).toMatch(/missing 1-min bars at 09:52, 09:57/);
    expect(dataProblems({ now, quote, bars1m: bars("09:30", 29), sessionOpen: open })[0]).toMatch(/09:59/); // latest bar not in yet
  });
  it("timestamps ahead of the server clock by more than 5 s", () => {
    expect(dataProblems({ now, quote: { ...quote, ts: new Date(now.getTime() + 6000).toISOString() }, bars1m: bars("09:30", 30), sessionOpen: open }).join()).toMatch(/ahead of server clock/);
    expect(dataProblems({ now, quote, bars1m: bars("09:30", 32), sessionOpen: open }).join()).toMatch(/bar .* ahead of server clock/);
  });
});
