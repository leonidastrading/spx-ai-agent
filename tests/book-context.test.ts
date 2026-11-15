import { describe, expect, it } from "vitest";
import { bookContextFromExport } from "@/lib/book-context";
import { renderBook } from "@/lib/decision";
import { at, ooExport } from "./fixtures/ooExport";

describe("10:50 volatility and live book from oo-trading", () => {
  it("uses the VIX / VIX9D snapshot at or before 10:50 and their change vs the prior close", () => {
    const exp = ooExport();
    exp.market.snapshots = [
      { at: at("10:49", 50), spx: 5100, vix: 16.5, vix9d: 15.8 },
      { at: at("10:51", 5), spx: 5101, vix: 19, vix9d: 19 }, // after 10:50: not used
    ];
    const b = bookContextFromExport(exp, new Date(at("10:50")));
    expect(b.vol).toMatchObject({ vix: 16.5, vix9d: 15.8, vixChangePct: 10 }); // prevClose 15
    expect(b.open).toBeNull(); // the fixture export has no open-position list
    expect(renderBook(b)).toMatch(/VIX 16\.50 \(\+10\.0% vs prior close\), VIX9D 15\.80/);
    expect(renderBook(b)).toMatch(/not provided/);
  });

  it("lists open positions (bot, strikes, expiry, size, open P/L) opened before 10:50", () => {
    const exp = ooExport();
    exp.book.open = [
      { entryId: "a", bot: "3 Delta", filledAt: at("09:32"), legs: [{ putCall: "P", strike: 6690, qty: 22, expiration: "2024-03-15" }, { putCall: "P", strike: 6890, qty: -22, expiration: "2024-03-15" }], contracts: 22, pl: 1234.5 },
      { entryId: "b", bot: "Long", filledAt: at("11:02"), legs: [{ putCall: "P", strike: 5000, qty: -1, expiration: "2024-03-11" }], contracts: 1, pl: 0 },
    ];
    const b = bookContextFromExport(exp, new Date(at("10:50")));
    expect(b.open).toHaveLength(1);
    expect(renderBook(b)).toMatch(/- 3 Delta: P6690 \+22 \/ P6890 -22, exp 2024-03-15, 22 lots, open P\/L \$1,235/);
    expect(renderBook(undefined)).toMatch(/unavailable/);
  });
});
