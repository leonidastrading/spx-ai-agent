import { describe, expect, it } from "vitest";
import { ideaState, sleeveProblems, swingSummary, timeLimitDue, type Idea, type IdeaEvent, type IdeaInput } from "@/lib/swing/rules";

const input = (p: Partial<IdeaInput> = {}): IdeaInput => ({ ticker: "AAPL", side: "long", thesis: "Panic dip on a non-event.", catalyst: "panic_dip", speculative: false, notional: 5000, exitRule: "target", exitParam: 220, ...p });

describe("sleeve limits", () => {
  it("10% per position, 5% speculative total, sleeve cap, blocked tickers", () => {
    expect(sleeveProblems(input(), [], 200)).toEqual([]);
    expect(sleeveProblems(input({ notional: 10001 }), [], 200)[0]).toMatch(/per-position cap/);
    expect(sleeveProblems(input({ speculative: true, notional: 3000 }), [{ notional: 2500, speculative: true }], 200)[0]).toMatch(/speculative ideas would total \$5500/);
    expect(sleeveProblems(input({ notional: 6000 }), Array(10).fill({ notional: 9500, speculative: false }), 200)[0]).toMatch(/sleeve would exceed/);
    expect(sleeveProblems(input({ ticker: "TQQQ" }), [], 50)[0]).toMatch(/not allowed/);
    expect(sleeveProblems(input({ ticker: "QQQ" }), [], 450)[0]).toMatch(/reserved/);
  });
  it("exit rule sanity", () => {
    expect(sleeveProblems(input({ exitParam: 190 }), [], 200)[0]).toMatch(/above the current price/);
    expect(sleeveProblems(input({ side: "short", exitParam: 190 }), [], 200)).toEqual([]);
    expect(sleeveProblems(input({ exitRule: "trailing", exitParam: 40 }), [], 200)[0]).toMatch(/0\.5%–30%/);
    expect(sleeveProblems(input({ exitRule: "time", exitParam: 2.5 }), [], 200)[0]).toMatch(/whole days/);
  });
});

describe("idea lifecycle from append-only events", () => {
  const idea: Idea = { ...input({ exitRule: "time", exitParam: 10 }), id: 1, createdAt: "2026-01-05T15:00:00.000Z", refPrice: 200 };
  const e = (kind: IdeaEvent["kind"], p: Partial<IdeaEvent> = {}): IdeaEvent => ({ ideaId: 1, kind, orderId: null, price: null, qty: null, spyPrice: null, at: "2026-01-05T15:00:00.000Z", detail: null, ...p });
  it("folds events into state", () => {
    expect(ideaState([e("entry_submitted", { orderId: "o1", qty: 25 })])).toMatchObject({ status: "pending_entry", entryOrderId: "o1", qty: 25 });
    const open = ideaState([e("entry_submitted", { orderId: "o1", qty: 25 }), e("entry_filled", { price: 201, qty: 25, spyPrice: 600 })]);
    expect(open).toMatchObject({ status: "open", entryPrice: 201, spyEntry: 600 });
    expect(timeLimitDue(idea, open, new Date("2026-01-15T14:59:00Z"))).toBe(false);
    expect(timeLimitDue(idea, open, new Date("2026-01-15T15:00:00Z"))).toBe(true);
    const closed = ideaState([e("entry_submitted"), e("entry_filled", { price: 200, qty: 25, spyPrice: 600 }), e("exit_submitted", { orderId: "x", detail: "time" }), e("exit_filled", { price: 210, spyPrice: 606, at: "2026-01-15T15:01:00Z" })]);
    expect(closed).toMatchObject({ status: "closed", exitPrice: 210, exitReason: "time" });
  });
  it("summary vs SPY and verdict timing", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      idea: { ...idea, id: i + 1 },
      state: ideaState([e("entry_filled", { price: 100, qty: 50, spyPrice: 500 }), e("exit_filled", { price: i % 3 ? 104 : 98, spyPrice: 505 })]),
      mark: null,
    }));
    const s = swingSummary({ rows, spyNow: 505, firstIdeaAt: idea.createdAt, now: new Date("2026-02-01T00:00:00Z") });
    expect(s.closed).toBe(30);
    expect(s.winRate).toBeCloseTo(20 / 30);
    expect(s.avgExcess!).toBeCloseTo(((20 * 0.04 + 10 * -0.02) / 30) - 0.01, 6);
    expect(s.verdictDue).toBe(true);
    expect(s.realizedPl).toBe(20 * 200 - 10 * 100);
    expect(s.verdict).toBe("beats SPY"); // avg excess +1%, sleeve +3% vs SPY +1%
  });
});
