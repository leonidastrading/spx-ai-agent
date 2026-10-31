import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/alpaca";
import { computeFeatures, priorClose, sessionBars } from "@/lib/features";
import type { Headline } from "@/lib/news";
import { etToUtc } from "@/lib/time";
import { flatSession, makeBars, session } from "./fixtures/sample";

/**
 * 2024-03-11: first session after spring-forward (EDT), prior 2024-03-08 (EST).
 * SPY prior close 500. Opens 505 (gap +1%). First 4 minutes: 506, 507, 504, 503.
 * Then flat at 503 through 10:49. A bar at 10:50 (should be excluded) spikes to 600.
 */
function fixture() {
  const s = session("2024-03-11");
  const prior = session("2024-03-08");
  const closes = [506, 507, 504, 503, ...Array(76).fill(503)]; // 09:30 .. 10:49 = 80 bars
  const spy = makeBars("SPY", s, 505, closes, 0);
  const spike: Bar = { symbol: "SPY", ts: etToUtc(s.date, "10:50").toISOString(), o: 503, h: 600, l: 503, c: 600, v: 1, feed: "sip" };
  const afterHoursPrior: Bar = { symbol: "SPY", ts: etToUtc(prior.date, "16:05").toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1, feed: "sip" };
  const bars: Bar[] = [
    ...flatSession("SPY", prior, 500),
    afterHoursPrior,
    ...spy,
    spike,
    ...flatSession("QQQ", prior, 400),
    ...makeBars("QQQ", s, 404, Array(80).fill(408)), // +2%
    ...flatSession("IWM", prior, 200),
    ...makeBars("IWM", s, 200, Array(80).fill(199)), // -0.5%
    ...flatSession("TLT", prior, 90),
    ...makeBars("TLT", s, 90, Array(80).fill(90.9)), // +1%
    ...flatSession("VIXY", prior, 20),
    ...makeBars("VIXY", s, 20, Array(80).fill(21)), // +5%
  ];
  const h = (id: number, et: string, date: string, headline: string, symbols: string[] = []): Headline => ({
    id, ts: etToUtc(date, et).toISOString(), headline, symbols,
  });
  const news: Headline[] = [
    h(1, "15:59", prior.date, "Before the prior close — excluded"),
    h(2, "16:00", prior.date, "Powell says the Fed is patient"),
    h(3, "08:30", s.date, "CPI comes in hot; payrolls revised"),
    h(4, "09:45", s.date, "Analyst downgrades Apple on weak iPhone demand", ["AAPL"]),
    h(5, "10:00", s.date, "Downgrade of small regional bank", ["XYZ"]),
    h(6, "10:49", s.date, "NYSE trading halt in several names"),
    h(7, "10:50", s.date, "Missile attack reported — after as-of, excluded"),
  ];
  return { s, prior, bars, news, asOf: etToUtc(s.date, "10:50") };
}

describe("computeFeatures (DST day, point-in-time)", () => {
  const { s, prior, bars, news, asOf } = fixture();
  const f = computeFeatures({ session: s, prior, asOf, bars, news, feed: "sip" });

  it("uses the 09:30 EDT bar as the open and the 15:59 EST bar as the prior close", () => {
    expect(sessionBars(bars, "SPY", s)[0].ts).toBe("2024-03-11T13:30:00.000Z");
    expect(f.spy_prior_close).toBe(500);
    expect(f.spy_open).toBe(505);
    expect(f.prior_close_at).toBe("2024-03-08T21:00:00.000Z");
  });

  it("excludes the 10:50 bar and after-hours bars", () => {
    expect(f.bars_used).toBe(80);
    expect(f.spy_last).toBe(503);
    expect(f.spy_high).toBe(507);
  });

  it("returns, gap, range, position", () => {
    expect(f.gap_pct).toBeCloseTo(1, 6);
    expect(f.spy_ret_prev_close_pct).toBeCloseTo(0.6, 6);
    expect(f.spy_ret_open_pct).toBeCloseTo((503 / 505 - 1) * 100, 4);
    expect(f.spy_low).toBe(503);
    expect(f.range_bp).toBeCloseTo(((507 - 503) / 505) * 1e4, 2);
    expect(f.range_pos).toBe(0);
  });

  it("counts new highs/lows after the first bar", () => {
    // bar0 h=506 l=505; bar1 h=507 (new high); bar2 l=504 (new low); bar3 l=503 (new low)
    expect(f.new_highs).toBe(1);
    expect(f.new_lows).toBe(2);
  });

  it("30-minute ATR in bp of the open", () => {
    // TRs: bar0 h-l=1; bar1 507-506=1; bar2 507-504=3; bar3 504-503=1; 26 flat bars 0
    expect(f.atr30_minutes).toBe(30);
    expect(f.atr30_bp).toBeCloseTo((6 / 30 / 505) * 1e4, 3);
  });

  it("relative moves and context ETFs", () => {
    expect(f.qqq_ret_pct).toBeCloseTo(2, 6);
    expect(f.qqq_minus_spy_pct).toBeCloseTo(1.4, 6);
    expect(f.iwm_minus_spy_pct).toBeCloseTo(-1.1, 6);
    expect(f.tlt_ret_pct).toBeCloseTo(1, 6);
    expect(f.vixy_ret_pct).toBeCloseTo(5, 6);
  });

  it("headline counts and keyword categories over [prior close, as-of)", () => {
    expect(f.news_since_prior_close).toBe(5);
    expect(f.news_since_open).toBe(3);
    expect(f.kw_fed).toBe(1);
    expect(f.kw_macro_data).toBe(1);
    expect(f.kw_megacap_negative).toBe(1); // the regional-bank downgrade is not a mega-cap
    expect(f.kw_halt_outage).toBe(1);
    expect(f.kw_geopolitical).toBe(0); // the attack headline is after the as-of time
  });

  it("is idempotent and order-independent", () => {
    const g = computeFeatures({ session: s, prior, asOf, bars: [...bars].reverse(), news: [...news].reverse(), feed: "sip" });
    expect(g).toEqual(f);
  });

  it("handles early minutes (fewer than 30 bars for ATR)", () => {
    const early = computeFeatures({ session: s, prior, asOf: etToUtc(s.date, "09:33"), bars, news, feed: "sip" });
    expect(early.bars_used).toBe(3);
    expect(early.atr30_minutes).toBe(3);
    expect(early.atr30_bp).toBeCloseTo((5 / 3 / 505) * 1e4, 3);
  });

  it("before the first bar closes, price features are null", () => {
    const none = computeFeatures({ session: s, prior, asOf: etToUtc(s.date, "09:30"), bars, news, feed: "sip" });
    expect(none.bars_used).toBe(0);
    expect(none.spy_ret_prev_close_pct).toBeNull();
    expect(none.atr30_bp).toBeNull();
  });
});

describe("early-close prior session", () => {
  it("prior close is the 12:59 bar on a 13:00 close, not an after-hours print", () => {
    const prior = session("2024-11-29");
    const bars: Bar[] = [
      ...makeBars("SPY", prior, 600, [...Array(209).fill(600), 601]), // 09:30..12:59, last closes 601
      { symbol: "SPY", ts: etToUtc(prior.date, "13:30").toISOString(), o: 590, h: 590, l: 590, c: 590, v: 1, feed: "sip" },
      { symbol: "SPY", ts: etToUtc(prior.date, "15:59").toISOString(), o: 580, h: 580, l: 580, c: 580, v: 1, feed: "sip" },
    ];
    expect(etToUtc(prior.date, "12:59").toISOString()).toBe("2024-11-29T17:59:00.000Z");
    expect(priorClose(bars, "SPY", prior)).toBe(601);

    const s = session("2024-12-02");
    const f = computeFeatures({ session: s, prior, asOf: etToUtc(s.date, "10:50"), bars: [...bars, ...makeBars("SPY", s, 601, Array(80).fill(595))], news: [], feed: "iex" });
    expect(f.spy_prior_close).toBe(601);
    expect(f.prior_close_at).toBe("2024-11-29T18:00:00.000Z");
    expect(f.spy_ret_prev_close_pct).toBeCloseTo((595 / 601 - 1) * 100, 4);
    expect(f.feed).toBe("iex");
  });

  it("fall-back DST: 2024-11-04 (EST) after 2024-11-01 (EDT)", () => {
    const prior = session("2024-11-01");
    const s = session("2024-11-04");
    const bars = [...flatSession("SPY", prior, 570), ...makeBars("SPY", s, 571, Array(80).fill(565.3))];
    const f = computeFeatures({ session: s, prior, asOf: etToUtc(s.date, "10:50"), bars, news: [], feed: "sip" });
    expect(sessionBars(bars, "SPY", s)[0].ts).toBe("2024-11-04T14:30:00.000Z");
    expect(f.prior_close_at).toBe("2024-11-01T20:00:00.000Z");
    expect(f.spy_ret_prev_close_pct).toBeCloseTo(-0.8246, 3);
    expect(f.bars_used).toBe(80);
  });
});
