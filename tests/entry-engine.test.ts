import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import type { OoExport } from "@/lib/entry/contract";
import { runEntryTick, type EntryDeps } from "@/lib/entry/engine";
import { accountDrawdown } from "@/lib/entry/packet";
import { entryReport } from "@/lib/entry/report";
import * as es from "@/lib/entry/store";
import { at, D, entry, ooExport } from "./fixtures/ooExport";

let pg: PGlite;
let now = new Date(at("13:30", 15));
let exp: OoExport = ooExport();
const prompts: string[] = [];
let replyFor: (n: number) => object = () => ({});
let modelDelayMs = 5000;

const reply = (p: object = {}) =>
  JSON.stringify({ verdict: "reduce", confidence: 64, day_type: "range", reasons: [{ category: "vol", text: "VIX up 8% with the move fading." }], main_risk: "Late-day trend.", would_change_mind: "VIX back under 15.", data_ok: true, ...p });

const deps: EntryDeps = {
  fetchExport: async () => exp,
  data: {
    resolveFeed: async () => "iex",
    getNews: async () => [],
    getBars: async ({ symbols, timeframe }) =>
      timeframe === "1Day"
        ? symbols.map((symbol) => ({ symbol, ts: "2024-03-08T05:00:00.000Z", o: 100, h: 100, l: 100, c: 100, v: 1, feed: "iex" as const }))
        : symbols.map((symbol) => ({ symbol, ts: at("13:29"), o: 101, h: 101, l: 101, c: 101, v: 10, feed: "iex" as const })),
  },
  callModel: async ({ user, kind }) => {
    if (kind === "summary") return { text: "Quiet tape; Fed on hold.", stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.001 };
    prompts.push(user);
    now = new Date(now.getTime() + modelDelayMs);
    return { text: reply(replyFor(prompts.length)), stopReason: "end_turn", modelServed: "claude-opus-5-5", usage: { input_tokens: 9000, output_tokens: 300 }, costUsd: 0.04 };
  },
  clock: () => now,
  sleep: async () => {},
  loopSeconds: 0,
};
/** The poll a few seconds before a fill stored the book as it was then. */
const priorPoll = (fill: string) => es.saveBookSnapshot(new Date(Date.parse(fill) - 5000).toISOString(), ooExport().book);
const calls = async () => (await pg.query<any>(`SELECT entry_id, status, status_reason, verdict, latency_ms, packet_hash FROM entry_calls ORDER BY id`)).rows;

beforeAll(async () => {
  pg = new PGlite();
  setQuerierForTests({ query: async (t, p) => (await pg.query(t, p as any[])).rows as any[] });
  // A book snapshot from before the fill (stored by an earlier poll).
  await es.saveBookSnapshot(at("13:29", 58), ooExport().book);
});
afterAll(() => setQuerierForTests(null));

describe("entry advisor engine", () => {
  it("calls on an exactly-matched entry; latency counts from Schwab's fill time", async () => {
    const r = await runEntryTick(deps);
    expect(r.status).toBe("ok");
    const [c] = await calls();
    expect(c).toMatchObject({ entry_id: entry().id, status: "called", verdict: "reduce", status_reason: null });
    expect(c.latency_ms).toBe(15000 - 4000 + 5000); // seen 11 s after the fill + 5 s model
    expect(prompts[0]).not.toContain("5131"); // quote snapshot after the fill
    expect(prompts[0]).toContain('"today_total":120');
  });

  it("does not log the same entry twice", async () => {
    await runEntryTick(deps);
    expect(await calls()).toHaveLength(1);
    expect(prompts).toHaveLength(1);
  });

  it("ambiguous bot match no live profile settles → no_opinion without a model call", async () => {
    const d = at("13:35", 2).slice(0, 10);
    const legs = [{ putCall: "P" as const, strike: 7000, qty: -1, expiration: d }, { putCall: "P" as const, strike: 6950, qty: 1, expiration: d }];
    exp = ooExport({ entries: [entry({ id: "amb000000000000000000001", bot: null, candidates: ["Long", "VIX>30 1DTE"], match: "ambiguous", matchConfidence: 0.5, matchReason: "put spread 50", filledAt: at("13:35", 2), legs })] });
    now = new Date(at("13:35", 12));
    await runEntryTick(deps);
    expect((await calls()).at(-1)).toMatchObject({ status: "no_opinion", verdict: null, status_reason: expect.stringMatching(/below 0.6 \(confidence 0.5\)/) });
    expect(prompts).toHaveLength(1);
  });

  it("first seen > 120 s after the fill → late, no model call", async () => {
    exp = ooExport({ entries: [entry({ id: "late00000000000000000001", filledAt: at("13:50", 0) })] });
    now = new Date(at("13:52", 5));
    await runEntryTick(deps);
    expect((await calls()).at(-1)).toMatchObject({ status: "late", verdict: null, status_reason: "first seen 125s after the fill" });
    expect(prompts).toHaveLength(1);
  });

  it("a slow reply past 120 s is logged late (excluded); 60–120 s is flagged slow but scored", async () => {
    await priorPoll(at("14:20", 0));
    exp = ooExport({ entries: [entry({ id: "slow00000000000000000001", filledAt: at("14:20", 0) })] });
    now = new Date(at("14:20", 30));
    modelDelayMs = 100000;
    await runEntryTick(deps);
    expect((await calls()).at(-1)).toMatchObject({ status: "late", verdict: "reduce", latency_ms: 130000 });
    await priorPoll(at("14:50", 0));
    exp = ooExport({ entries: [entry({ id: "slow00000000000000000002", filledAt: at("14:50", 0) })] });
    now = new Date(at("14:50", 20));
    modelDelayMs = 60000;
    await runEntryTick(deps);
    expect((await calls()).at(-1)).toMatchObject({ status: "called", status_reason: expect.stringMatching(/slow: 80s/) });
    modelDelayMs = 5000;
  });

  it("data_ok = false → no_opinion (code-enforced)", async () => {
    replyFor = () => ({ data_ok: false, verdict: "skip" });
    await priorPoll(at("15:30", 0));
    exp = ooExport({ entries: [entry({ id: "dok000000000000000000001", filledAt: at("15:30", 0) })] });
    now = new Date(at("15:30", 9));
    await runEntryTick(deps);
    expect((await calls()).at(-1)).toMatchObject({ status: "no_opinion", verdict: null, status_reason: "model said data_ok=false" });
    replyFor = () => ({});
  });

  it("outcomes arrive later and are scored; only on-time, data-ok calls count", async () => {
    exp = { ...ooExport({ entries: [] }), outcomes: [
      { entryId: entry().id, bot: "5d IC", closedAt: at("16:00"), pl: -900, how: "stop" },
      { entryId: "slow00000000000000000001", bot: "5d IC", closedAt: at("16:00"), pl: 500, how: "expired" },
      { entryId: "slow00000000000000000002", bot: "5d IC", closedAt: at("16:00"), pl: 300, how: "expired" },
    ] };
    now = new Date(at("16:10"));
    await runEntryTick(deps);
    const [v] = await es.listEntryVersions();
    const r = await entryReport(v);
    expect(r.scored.map((s) => s.entryId).sort()).toEqual([entry().id, "slow00000000000000000002"].sort());
    expect(r.run.total).toBe(-600);
    expect(r.advised.total).toBe(-300); // both "reduce"
    expect(r.savedMissed).toEqual({ saved: 450, missed: 150, net: 300 });
    expect(r.counts).toMatchObject({ noOpinion: 2, late: 2 });
  });

  it("logged calls can't be edited or deleted; the pre-open human call locks", async () => {
    await expect(pg.query(`UPDATE entry_calls SET verdict = 'take'`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`DELETE FROM entry_calls`)).rejects.toThrow(/append-only/);
    expect(await es.saveHumanCall(D, "half", "CPI at 8:30")).toBe(true);
    expect(await es.saveHumanCall(D, "normal", "changed my mind")).toBe(false);
    await expect(pg.query(`UPDATE entry_human_calls SET call = 'normal'`)).rejects.toThrow(/append-only/);
  });

  it("v2: an IC the export left unmatched is named by its live fills; over-long text is trimmed, kept and flagged; NLV drawdown in the packet", async () => {
    const fill = at("13:30", 3);
    const d = fill.slice(0, 10);
    await priorPoll(fill);
    const legs = [
      { putCall: "P" as const, strike: 7590, qty: 12, expiration: d }, { putCall: "P" as const, strike: 7645, qty: -12, expiration: d },
      { putCall: "C" as const, strike: 7660, qty: -12, expiration: d }, { putCall: "C" as const, strike: 7710, qty: 12, expiration: d },
    ];
    exp = ooExport({ entries: [entry({ id: "sma0000000000000000000v2", bot: null, candidates: [], match: "none", matchConfidence: 0, matchReason: "iron condor, puts 55 wide, calls 50 wide", filledAt: fill, legs, contracts: 12, netPrice: 8.05 })] });
    exp.bots["8SMA IC"] = exp.bots["5d IC"];
    now = new Date(at("13:30", 15));
    const long = Array(40).fill("risk").join(" ");
    replyFor = () => ({ main_risk: long });
    const before = prompts.length;
    await runEntryTick(deps);
    replyFor = () => ({});
    const row = (await pg.query<any>(`SELECT * FROM entry_calls WHERE entry_id = 'sma0000000000000000000v2'`)).rows[0];
    expect(row).toMatchObject({ status: "called", bot: "8SMA IC", match_source: "local_profile", trimmed: ["main_risk"] });
    expect(row.status_reason).toMatch(/trimmed: main_risk/);
    expect(row.reply.main_risk.split(" ")).toHaveLength(25);
    expect(prompts.length).toBe(before + 1);
    // The fixture day (2024) is before the drawdown window, so the packet says so rather than show a wrong number.
    expect(row.packet.book.account_drawdown).toMatch(/unavailable/);
    expect(row.packet.book.drawdown_from_high).toBeUndefined();
    // On a 2026 fill: latest NLV at or before the fill against the high since Oct 19, 2026.
    await es.saveNlv({ netLiq: 804_000, startNetLiq: 810_000, asOf: "2026-11-11T18:29:00.000Z", eod: [{ date: "2026-10-20", netLiq: 1_000_000 }, { date: "2026-10-16", netLiq: 1_100_000 }] }, (x) => `${x}T20:00:00.000Z`);
    const nlv = await es.nlvAt("2026-11-11T18:30:03.000Z", "2026-10-19T04:00:00.000Z");
    expect(accountDrawdown(nlv, Date.parse("2026-11-11T18:30:03.000Z"))).toMatchObject({ net_liq: 804000, high: 1000000, high_date: "2026-10-20", drawdown: -196000, drawdown_pct: -19.6 });
  });

    it("a failed gate stops the calls", async () => {
    const [v] = await es.listEntryVersions();
    await es.recordEntryVerdict(v.id, "fail", {});
    exp = ooExport({ entries: [entry({ id: "after0000000000000000001", filledAt: at("15:40", 0) })] });
    now = new Date(at("15:40", 8));
    const n = (await calls()).length;
    await runEntryTick(deps);
    expect(await calls()).toHaveLength(n);
  });
});
