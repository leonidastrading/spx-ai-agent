import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { mapStrategy, normalizeDate, parseMoney, parseTradeLog } from "@/lib/optionomega";

const CSV = `Date Opened,Time Opened,Opening Price,Legs,Premium,Closing Price,Date Closed,Time Closed,Avg. Closing Cost,Reason For Close,P/L,No. of Contracts,Funds at Close,Margin Req.,Strategy,Opening Commissions + Fees
2024-03-11,13:30:00,5110.2,"5050 P STO 2.10 | 5045 P BTO 1.20",90,5120,2024-03-11,16:00:00,0,Expired,"$1,250.00",5,100000,2500,8SMA,6.5
2024-03-11,13:35:00,5111,"x",80,5120,2024-03-11,16:00:00,0,Expired,-300,2,100000,1600,$8 IC,2.6
2024-03-11,14:30:00,5115,"x",50,5120,2024-03-11,16:00:00,0,Expired,(150.5),2,100000,1600,5d IC (14:30),2.6
2024-03-11,13:30:00,5110,"x",50,5120,2024-03-11,16:00:00,0,Expired,100,2,100000,1600,5d IC (13:30),2.6
3/12/2024,13:50:00,5100,"x",50,5120,3/12/2024,16:00:00,0,Stop Loss,-75,1,100000,1600,Put BWB 13:50,1
2024-03-12,13:50:00,5100,"x",50,5120,2024-03-12,16:00:00,0,Stop Loss,-75,1,100000,1600,Mystery Strategy,1
2024-03-12,13:50:00,5100,"x",50,5120,2024-03-12,16:00:00,0,Stop Loss,n/a,1,100000,1600,BWB,1
`;

describe("Option Omega trade log", () => {
  it("parses quoted fields with commas and pipes", () => {
    const rows = parseCsv(CSV);
    expect(rows[1][3]).toBe("5050 P STO 2.10 | 5045 P BTO 1.20");
    expect(rows[1][10]).toBe("$1,250.00");
  });

  it("money, dates, names", () => {
    expect(parseMoney("$1,250.00")).toBe(1250);
    expect(parseMoney("(150.5)")).toBe(-150.5);
    expect(parseMoney("-300")).toBe(-300);
    expect(parseMoney("n/a")).toBeNull();
    expect(normalizeDate("3/12/2024")).toBe("2024-03-12");
    expect(normalizeDate("2024-03-12")).toBe("2024-03-12");
    expect(mapStrategy("$8 IC")).toBe("$8 IC");
    expect(mapStrategy("5d IC (14:30)")).toBe("5d IC");
    expect(mapStrategy("VIX up 1DTE")).toBe("VIX-up");
    expect(mapStrategy("Mystery Strategy")).toBeNull();
  });

  it("sums P/L by date and strategy, reports unmapped and bad rows", () => {
    const r = parseTradeLog(CSV);
    expect(r.rows).toBe(7);
    expect(r.outcomes).toEqual([
      { date: "2024-03-11", strategy: "$8 IC", pl: -300, trades: 1 },
      { date: "2024-03-11", strategy: "5d IC", pl: -50.5, trades: 2 },
      { date: "2024-03-11", strategy: "8SMA", pl: 1250, trades: 1 },
      { date: "2024-03-12", strategy: "BWB", pl: -75, trades: 1 },
    ]);
    expect(r.unmapped).toEqual({ "Mystery Strategy": 1 });
    expect(r.badRows).toEqual([{ line: 8, reason: 'bad P/L "n/a"' }]);
  });
});

describe("strategy name mapping: contains-match, longest wins", () => {
  it.each([
    ["SPX Long (sell puts) 32d ORB", "Long"],
    ["Long (Sell Puts)", "Long"],
    ["FOMC long straddle 14:35", "FOMC"],
    ["Long Straddle", "FOMC"],
    ["VIX>30 1DTE 10d PS", "VIX>30"],
    ["VIX > 30 put spread", "VIX>30"],
    ["2DTE put spread VIX<20", "2DTE"],
    ["2DTE put spread VIX>20", "2DTE"],
    ["VIX up 1DTE VIX<20", "VIX-up"],
    ["VIX-up VIX>20", "VIX-up"],
    ["$8 IC", "$8 IC"],
    ["Put BWB 13:50", "BWB"],
  ])("%s -> %s", (name, want) => expect(mapStrategy(name)).toBe(want));

  it("plain 'long' never catches the straddle, and whole words only", () => {
    expect(mapStrategy("Long straddle", { long: "Long", "long straddle": "FOMC" })).toBe("FOMC");
    expect(mapStrategy("Longshot bot", { long: "Long" }, ["Long"])).toBeNull();
    expect(mapStrategy("VIX>300 test", {}, ["VIX>30"])).toBeNull();
  });

  it("pattern fallback only targets strategies you have", () => {
    expect(mapStrategy("FOMC straddle", {}, ["Short"])).toBeNull();
    expect(mapStrategy("FOMC straddle", {}, ["FOMC"])).toBe("FOMC");
  });
});
