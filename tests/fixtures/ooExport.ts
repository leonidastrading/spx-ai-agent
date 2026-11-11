/** A realistic oo-trading export for tests (2024-03-11, EDT). */
import type { OoEntry, OoExport } from "@/lib/entry/contract";
import { etToUtc } from "@/lib/time";

export const D = "2024-03-11";
export const at = (hhmm: string, sec = 0) => new Date(etToUtc(D, hhmm).getTime() + sec * 1000).toISOString();

export function entry(p: Partial<OoEntry> = {}): OoEntry {
  return {
    id: "e5d1c0ffee00112233445566",
    filledAt: at("13:30", 4),
    detectedAt: at("13:30", 9),
    bot: "5d IC",
    candidates: ["5d IC"],
    match: "exact",
    matchConfidence: 0.95,
    matchReason: "IC, 100 wide both sides, 0DTE, 13:30 window",
    structure: "iron condor",
    underlying: "SPX",
    legs: [
      { putCall: "P", strike: 5050, qty: -13, expiration: D },
      { putCall: "P", strike: 4950, qty: 13, expiration: D },
      { putCall: "C", strike: 5200, qty: -13, expiration: D },
      { putCall: "C", strike: 5300, qty: 13, expiration: D },
    ],
    contracts: 13,
    netPrice: 1.85,
    rules: { stop: "2x credit", target: "expire" },
    ...p,
  };
}

const minuteBars = (from: string, to: string, px: (i: number) => number) => {
  const out = [];
  for (let t = Date.parse(at(from)), i = 0; t < Date.parse(at(to)); t += 60000, i++) out.push({ t: new Date(t).toISOString(), o: px(i), h: px(i) + 1, l: px(i) - 1, c: px(i) });
  return out;
};

export function ooExport(p: { entries?: OoEntry[]; asOf?: string } = {}): OoExport {
  return {
    asOf: p.asOf ?? at("13:30", 15),
    schwab: { connected: true, fillsFetchedAt: at("13:30", 12), errors: [] },
    entries: p.entries ?? [entry()],
    outcomes: [],
    book: {
      today: [{ entryId: "earlier0000000000000001", bot: "Short", filledAt: at("11:11"), status: "open", pl: 120 }],
      todayTotal: 120,
      stoppedOutBots: [],
      daily: [{ date: "2024-03-08", pl: -340 }, { date: "2024-03-07", pl: 510 }],
      drawdownFromHigh: 340,
    },
    bots: {
      "5d IC": {
        last10Days: [{ date: "2024-03-08", trades: [{ time: "13:30", pl: 210 }] }, { date: D, trades: [{ time: "13:30", pl: 999 }] }],
        backtest: { byEntryTime: [{ time: "13:30", trades: 400, winRate: 0.86, avgPl: 95 }], byVixBucket: [{ bucket: "15-20", trades: 300, winRate: 0.88, avgPl: 101 }] },
        liveVsBacktest: { days: 10, livePl: 900, backtestPl: 1100, gap: -200 },
      },
    },
    market: {
      spx: { last: 5130, quoteTime: at("13:30", 14), prevClose: 5120 },
      vix: { last: 16.2, quoteTime: at("13:30", 14), prevClose: 15 },
      vix9d: { last: 15.1, quoteTime: at("13:30", 14), prevClose: 14.5 },
      snapshots: [
        { at: at("13:29", 50), spx: 5128, vix: 16.0, vix9d: 15.0 },
        { at: at("13:30", 14), spx: 5131, vix: 16.4, vix9d: 15.2 }, // after the fill: must not be used
      ],
      spxBars1m: minuteBars("09:30", "13:32", (i) => 5100 + i * 0.1), // includes bars after the fill
      spxBars5m5d: [{ t: at("13:25"), o: 5127, h: 5129, l: 5126, c: 5128 }, { t: at("13:30"), o: 5128, h: 5140, l: 5120, c: 5139 }],
      spxDaily60: [{ t: "2024-03-08T05:00:00.000Z", o: 5110, h: 5130, l: 5100, c: 5120 }],
      vixDaily15: [{ t: "2024-03-08T05:00:00.000Z", o: 15, h: 15.5, l: 14.5, c: 15 }],
      vix9dDaily15: [{ t: "2024-03-08T05:00:00.000Z", o: 14, h: 14.8, l: 14, c: 14.5 }],
      gauge: { today: { straddle: 22.5, strike: 5115, capturedAt: at("10:00", 3) }, avgMoveRatio10d: 0.91 },
    },
  };
}
