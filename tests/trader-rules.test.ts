import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/alpaca";
import {
  atr, breakevenStop, dailyStopHit, dataProblems, decisionSlot, entryBlocked, parseReply, parseReplyChecked, positionSize, regularSession, stopBand, timeExitDue,
  validateAction, type DayState, type OpenTrade, type Reply,
} from "@/lib/trader/rules";
import { etToUtc } from "@/lib/time";

const D = "2024-03-11"; // EDT
const at = (hhmm: string, sec = 5) => new Date(etToUtc(D, hhmm).getTime() + sec * 1000);
const flat: DayState = { open: null, tradesToday: 0, closedToday: [], gateFailed: false, enabled: true };
const reply = (r: Partial<Reply>): Reply => ({ action: "long", confidence: 70, stop: 498.5, target: 502, max_hold_minutes: 60, catalyst: "technical", thesis: "Breakout above VWAP with volume.", ...r });
const ATR = 2; // 15-min ATR: at $500 the stop band is $1–$5
const openTrade = (p: Partial<OpenTrade> = {}): OpenTrade => ({ id: 1, side: "long", qty: 33, entryPrice: 500, entryAt: at("09:40").toISOString(), stopInitial: 498.5, stop: 498.5, target: 503, maxHoldMinutes: 60, ...p });

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
  it("v4: confidence may be null (holds and closes)", () => {
    expect(parseReply(JSON.stringify(reply({ action: "hold", confidence: null, stop: null, target: null, max_hold_minutes: null }))).confidence).toBeNull();
  });
});

describe("v4 sizing: ATR stop band, fixed dollar risk", () => {
  it("ATR of true ranges, regular session only", () => {
    const bar = (h: number, l: number, c: number) => ({ h, l, c });
    expect(atr([bar(10, 9, 9.5), bar(11, 9, 10), bar(10.5, 9.5, 10), bar(12, 10, 11), bar(11, 10, 10.5), bar(11, 9, 10)])).toBeCloseTo((2 + 1 + 2 + 1 + 2) / 5, 9);
    expect(atr([bar(1, 0, 1), bar(1, 0, 1)])).toBeNull(); // too few ranges
    const b = (et: string) => ({ ts: etToUtc(D, et).toISOString() });
    expect(regularSession([b("16:00"), b("09:30"), b("09:15"), b("15:45")]).map((x) => x.ts)).toEqual([b("09:30").ts, b("15:45").ts]);
  });
  it("stop band is 0.5–2.5× ATR, floored at 0.1% and capped at 2% of price", () => {
    expect(stopBand(500, 2)).toEqual({ min: 1, max: 5 });
    expect(stopBand(500, 0.2)).toEqual({ min: 0.5, max: 0.5 }); // floor 0.1%
    expect(stopBand(500, 10)).toEqual({ min: 5, max: 10 }); // cap 2%
  });
  it("shares = $50 ÷ stop distance, at most $20,000 of QQQ", () => {
    expect(positionSize(500, 1.5)).toBe(33);
    expect(positionSize(500, 5)).toBe(10); // volatile day: wider stop, fewer shares, same risk
    expect(positionSize(500, 0.5)).toBe(40); // capped at $20,000
    expect(positionSize(500, 0)).toBe(0);
  });
});

describe("validateAction (code-enforced rules)", () => {
  const price = 500;
  it("accepts a valid long and sizes it by risk", () => {
    expect(validateAction(reply({}), price, at("10:00"), flat, ATR)).toMatchObject({ ok: true, kind: "enter", side: "long", qty: 33, stop: 498.5, target: 502 });
  });

  it("stop distance must sit in the ATR band", () => {
    expect(validateAction(reply({ stop: 499.5 }), price, at("10:00"), flat, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/stop distance 0\.50 outside the allowed 1\.00–5\.00/) });
    expect(validateAction(reply({ stop: 494, target: 510 }), price, at("10:00"), flat, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/stop distance 6\.00/) });
    expect(validateAction(reply({ stop: 495, target: 505 }), price, at("10:00"), flat, ATR)).toMatchObject({ ok: true, qty: 10 }); // exactly 2.5× ATR, 1×
    expect(validateAction(reply({}), price, at("10:00"), flat, null)).toMatchObject({ ok: false, reason: expect.stringMatching(/no 15-min ATR/) });
  });

  it("confidence is the chance of target before stop: entries need at least 55", () => {
    expect(validateAction(reply({ confidence: 54 }), price, at("10:00"), flat, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/54% is below 55%/) });
    expect(validateAction(reply({ confidence: null }), price, at("10:00"), flat, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/missing/) });
    expect(validateAction(reply({ confidence: 55 }), price, at("10:00"), flat, ATR)).toMatchObject({ ok: true });
  });

  it("target must be at least 1× the stop distance, on the right side", () => {
    expect(validateAction(reply({ stop: 498, target: 501 }), price, at("10:00"), flat, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/target distance/) });
    expect(validateAction(reply({ action: "short", stop: 498, target: 502 }), price, at("10:00"), flat, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/wrong side/) });
    expect(validateAction(reply({ action: "short", stop: 502, target: 497 }), price, at("10:00"), flat, ATR)).toMatchObject({ ok: true, side: "short", qty: 25 });
  });

  it("time windows use the server clock: no entries before 09:35 or after 15:30", () => {
    expect(validateAction(reply({}), price, at("09:34", 59), flat, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/before 09:35/) });
    expect(validateAction(reply({}), price, at("15:31"), flat, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/after 15:30/) });
    expect(validateAction(reply({}), price, at("15:30"), flat, ATR)).toMatchObject({ ok: true });
  });

  it("time limit never runs past 15:55", () => {
    expect(validateAction(reply({ max_hold_minutes: 240 }), price, at("15:30"), flat, ATR)).toMatchObject({ ok: true, maxHoldMinutes: 25 });
  });

  it("one position, 3 trades a day, daily stop, disabled, gate failed", () => {
    expect(validateAction(reply({}), price, at("10:00"), { ...flat, open: openTrade() }, ATR)).toMatchObject({ ok: false, reason: "already in a position" });
    expect(validateAction(reply({}), price, at("10:00"), { ...flat, tradesToday: 3 }, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/3 trades/) });
    const losers = [{ side: "long" as const, pl: -10, exitAt: "a" }, { side: "short" as const, pl: -5, exitAt: "b" }];
    expect(validateAction(reply({}), price, at("10:00"), { ...flat, closedToday: losers, tradesToday: 2 }, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/2 losing trades/) });
    expect(validateAction(reply({}), price, at("10:00"), { ...flat, enabled: false }, ATR)).toMatchObject({ ok: false, reason: "trading disabled" });
    expect(validateAction(reply({}), price, at("10:00"), { ...flat, gateFailed: true }, ATR)).toMatchObject({ ok: false, reason: expect.stringMatching(/gate/) });
  });

  it("daily loss of $150 stops new entries", () => {
    expect(dailyStopHit([{ side: "long", pl: -149, exitAt: "a" }])).toBeNull();
    expect(dailyStopHit([{ side: "long", pl: 20, exitAt: "a" }, { side: "long", pl: -170, exitAt: "b" }])).toMatch(/daily loss/);
    expect(dailyStopHit([{ side: "long", pl: -10, exitAt: "a" }, { side: "long", pl: 5, exitAt: "b" }, { side: "long", pl: -10, exitAt: "c" }])).toBeNull();
  });

  it("v4: a hold never moves the stop; close needs a position", () => {
    const st = { ...flat, open: openTrade() };
    expect(validateAction(reply({ action: "hold", stop: 499.5 }), 501, at("10:00"), st, ATR)).toEqual({ ok: true, kind: "hold" });
    expect(validateAction(reply({ action: "close" }), 501, at("10:00"), flat, ATR)).toMatchObject({ ok: false });
    expect(validateAction(reply({ action: "close" }), 501, at("10:00"), st, ATR)).toEqual({ ok: true, kind: "close" });
  });
});

describe("v4 breakeven: one move, after the trade is ahead by its risk", () => {
  it("long: stop to entry once the high reaches entry + 1R; never again", () => {
    const t = openTrade(); // risk 1.5
    expect(breakevenStop(t, 501.4, 499)).toBeNull();
    expect(breakevenStop(t, 501.5, 499)).toBe(500);
    expect(breakevenStop({ ...t, stop: 500 }, 503, 499)).toBeNull(); // already moved
  });
  it("short: on the low; not before a fill", () => {
    const t = openTrade({ side: "short", stopInitial: 502, stop: 502 }); // risk 2
    expect(breakevenStop(t, 501, 498.01)).toBeNull();
    expect(breakevenStop(t, 501, 498)).toBe(500);
    expect(breakevenStop({ ...t, entryPrice: null }, 600, 400)).toBeNull();
  });
});

describe("exits and schedule", () => {
  const open = openTrade({ entryAt: at("10:00", 0).toISOString(), maxHoldMinutes: 30 });
  it("time limit and 15:55 flat", () => {
    expect(timeExitDue(at("10:29", 59), open)).toBeNull();
    expect(timeExitDue(at("10:30", 0), open)).toBe("time");
    expect(timeExitDue(at("15:55", 0), { ...open, maxHoldMinutes: 999 })).toBe("eod");
  });

  it("decision slots every 5 minutes 09:35–15:30; v4 has no pre-market read (EST and EDT)", () => {
    expect(decisionSlot(at("09:25"))).toBeNull();
    expect(decisionSlot(at("09:30"))).toBeNull();
    expect(decisionSlot(at("09:35"))).toEqual({ phase: "intraday", hhmm: "09:35" });
    expect(decisionSlot(at("09:36"))).toBeNull();
    expect(decisionSlot(at("15:30"))).toEqual({ phase: "intraday", hhmm: "15:30" });
    expect(decisionSlot(at("15:35"))).toBeNull();
    expect(decisionSlot(new Date("2024-11-04T15:00:03Z"))).toEqual({ phase: "intraday", hhmm: "10:00" }); // EST
    expect(entryBlocked(at("09:35"), flat)).toBeNull();
  });
});

describe("data guards (v4: bars only)", () => {
  const open = etToUtc(D, "09:30");
  const bars = (from: string, n: number, skip: number[] = []): Bar[] =>
    Array.from({ length: n }, (_, i) => i)
      .filter((i) => !skip.includes(i))
      .map((i) => ({ symbol: "QQQ", ts: new Date(etToUtc(D, from).getTime() + i * 60000).toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1, feed: "iex" as const }));
  const now = at("10:00", 3); // last completed minute: 09:59

  it("clean data passes; the quote plays no part", () => {
    expect(dataProblems({ now, bars1m: bars("09:30", 30), sessionOpen: open })).toEqual([]);
  });
  it("missing bar in the last 15 minutes", () => {
    // v2: one gap in the window is tolerated (IEX skips minutes with no trades); two are not.
    expect(dataProblems({ now, bars1m: bars("09:30", 30, [27]), sessionOpen: open })).toEqual([]);
    expect(dataProblems({ now, bars1m: bars("09:30", 30, [22, 27]), sessionOpen: open })[0]).toMatch(/missing 1-min bars at 09:52, 09:57/);
    expect(dataProblems({ now, bars1m: bars("09:30", 29), sessionOpen: open })[0]).toMatch(/09:59/); // latest bar not in yet
  });
  it("bars stamped ahead of the server clock by more than 5 s", () => {
    expect(dataProblems({ now, bars1m: bars("09:30", 32), sessionOpen: open }).join()).toMatch(/bar .* ahead of server clock/);
  });
});
