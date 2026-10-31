/**
 * End-to-end cron simulation with an in-memory store, a fake Alpaca and
 * stubbed LLM/email: a full morning on a DST day, plus idempotency and
 * catch-up behaviour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STRATEGY_NAMES } from "@/config/strategies";
import type { Bar, NewsItem } from "@/lib/alpaca";
import { etToUtc } from "@/lib/time";
import { flatSession, makeBars, session } from "./fixtures/sample";

// ------------------------------------------------------------- in-memory db
const mem = vi.hoisted(() => ({
  bars: new Map<string, any>(),
  news: new Map<number, any>(),
  features: new Map<string, any>(),
  history: new Map<string, any>(),
  decisions: [] as any[],
  reads: new Map<string, any>(),
  emails: new Map<string, any>(),
  runs: [] as any[],
  settings: null as any,
}));

vi.mock("@/lib/db", async () => ({
  loadSettings: async () => mem.settings ?? (await import("@/lib/settings")).DEFAULT_SETTINGS,
  startRun: async (action: string, minute: string | null) => (mem.runs.push({ action, minute, status: "running" }), mem.runs.length),
  finishRun: async (id: number, r: any) => Object.assign(mem.runs[id - 1], r),
  insertBars: async (bars: Bar[]) => {
    let n = 0;
    for (const b of bars) if (!mem.bars.has(`${b.symbol}|${b.ts}`)) (mem.bars.set(`${b.symbol}|${b.ts}`, b), n++);
    return n;
  },
  insertNews: async (items: NewsItem[]) => {
    let n = 0;
    for (const x of items) if (!mem.news.has(x.id)) (mem.news.set(x.id, x), n++);
    return n;
  },
  lastBarTs: async (since: Date) => {
    const out: Record<string, string> = {};
    for (const b of mem.bars.values()) if (Date.parse(b.ts) >= since.getTime() && (!out[b.symbol] || b.ts > out[b.symbol])) out[b.symbol] = b.ts;
    return out;
  },
  lastNewsTs: async (since: Date) => {
    let m: string | null = null;
    for (const n of mem.news.values()) if (Date.parse(n.ts) >= since.getTime() && (!m || n.ts > m)) m = n.ts;
    return m;
  },
  loadBars: async (from: Date, to: Date) => [...mem.bars.values()].filter((b) => Date.parse(b.ts) >= from.getTime() && Date.parse(b.ts) < to.getTime()),
  loadNews: async (from: Date, to: Date) => [...mem.news.values()].filter((n) => Date.parse(n.ts) >= from.getTime() && Date.parse(n.ts) < to.getTime()),
  upsertFeatures: async (date: string, minute: string, data: any) => void mem.features.set(`${date} ${minute}`, { minute_et: minute, data }),
  featuresForDate: async (date: string) => [...mem.features.entries()].filter(([k]) => k.startsWith(date)).map(([, v]) => v),
  upsertMorningHistory: async (date: string, atr: number | null) => void mem.history.set(date, atr),
  atrHistory: async () => Array.from({ length: 250 }, (_, i) => 1 + i * 0.01), // all far below today's ATR
  hasDecision: async (date: string, source: string) => mem.decisions.some((d) => d.date === date && d.source === source),
  insertDecisions: async (date: string, source: string, calls: any[]) => {
    let n = 0;
    for (const c of calls) {
      if (mem.decisions.some((d) => d.date === date && d.source === source && d.strategy === c.strategy)) continue;
      mem.decisions.push({ date, source, ...c });
      n++;
    }
    return n;
  },
  insertLlmRead: async (date: string, model: string, market_read: string | null, _p: string, raw: unknown) => void mem.reads.set(date, { model, market_read, raw }),
  llmRead: async (date: string) => mem.reads.get(date) ?? null,
  decisionsForDate: async (date: string) => mem.decisions.filter((d) => d.date === date),
  claimEmail: async (date: string, subject: string) => (mem.emails.has(date) ? false : (mem.emails.set(date, { subject }), true)),
  setEmailProviderId: async () => {},
  releaseEmail: async (date: string) => void mem.emails.delete(date),
}));

const llmMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/llm", () => ({ runLlmDecision: (...a: any[]) => llmMock.fn(...a) }));
const emailMock = vi.hoisted(() => ({ sent: [] as any[], fail: false }));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: async (m: any, opts?: { to?: string }) => {
    if (emailMock.fail) throw new Error("resend down");
    emailMock.sent.push({ ...m, to: opts?.to });
    return "id";
  },
}));

// ------------------------------------------------------------- fake Alpaca
const S = session("2024-03-11"); // EDT, prior 2024-03-08 EST
const P = session("2024-03-08");
const ALL_BARS: Bar[] = [
  ...["SPY", "QQQ", "IWM", "TLT", "VIXY"].flatMap((sym) => flatSession(sym, P, 100)),
  // SPY sells off 2% over the morning; others flat
  ...makeBars("SPY", S, 100, Array.from({ length: 120 }, (_, i) => 100 - (i + 1) * 0.0167), 0.05),
  ...["QQQ", "IWM", "TLT", "VIXY"].flatMap((sym) => makeBars(sym, S, 100, Array(120).fill(100))),
];
const ALL_NEWS: NewsItem[] = [
  { id: 1, ts: etToUtc(P.date, "17:00").toISOString(), headline: "Fed's Powell signals patience", summary: "", symbols: ["SPY"], source: "benzinga", url: "" },
  { id: 2, ts: etToUtc(S.date, "09:40").toISOString(), headline: "Tariff threat rattles stocks", summary: "", symbols: [], source: "benzinga", url: "" },
  { id: 3, ts: etToUtc(S.date, "10:20").toISOString(), headline: "Nvidia downgraded at broker", summary: "", symbols: ["NVDA"], source: "benzinga", url: "" },
];
const requests: URL[] = [];

beforeEach(() => {
  for (const [k, v] of Object.entries(mem)) if (k !== "settings") (Array.isArray(v) ? v.splice(0) : (v as Map<any, any>).clear());
  mem.settings = null;
  emailMock.sent.splice(0);
  emailMock.fail = false;
  requests.splice(0);
  process.env.ALPACA_API_KEY_ID = "test";
  process.env.ALPACA_API_SECRET_KEY = "test";
  process.env.ALPACA_FEED = "sip";
  process.env.ALPACA_MAX_RPM = "1000000";
  llmMock.fn.mockReset();
  llmMock.fn.mockResolvedValue({
    model: "test-model",
    attempts: [{ ok: true, text: "{}" }],
    decision: {
      marketRead: "Risk-off morning.",
      calls: STRATEGY_NAMES.map((s, i) => ({ strategy: s, call: i === 0 ? "skip" : "reduce", confidence: 0.6, reason: "selloff" })),
    },
  });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push(url);
    expect(init?.method).toBe("GET");
    const start = Date.parse(url.searchParams.get("start") ?? "1970-01-01");
    const end = Date.parse(url.searchParams.get("end") ?? "2100-01-01");
    if (url.pathname === "/v2/calendar") return Response.json([P, S].map((s) => ({ date: s.date, open: s.open, close: s.close })));
    if (url.pathname === "/v2/stocks/bars") {
      const syms = url.searchParams.get("symbols")!.split(",");
      const bars: Record<string, any[]> = {};
      for (const b of ALL_BARS) {
        const t = Date.parse(b.ts);
        if (syms.includes(b.symbol) && t >= start && t < end) (bars[b.symbol] ??= []).push({ t: b.ts, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      }
      return Response.json({ bars, next_page_token: null });
    }
    if (url.pathname === "/v1beta1/news") {
      const news = ALL_NEWS.filter((n) => Date.parse(n.ts) >= start && Date.parse(n.ts) < end).map((n) => ({ ...n, created_at: n.ts }));
      return Response.json({ news, next_page_token: null });
    }
    throw new Error(`unexpected ${url}`);
  });
});

const at = (hhmm: string, sec = 2) => new Date(etToUtc(S.date, hhmm).getTime() + sec * 1000);

describe("runTick", () => {
  it("skips outside the window and logs the run", async () => {
    const { runTick } = await import("@/lib/agent");
    const r = await runTick(new Date("2024-03-11T13:00:00Z")); // 09:00 EDT
    expect(r.status).toBe("skipped");
    expect(mem.runs).toHaveLength(1);
    expect(mem.runs[0].status).toBe("skipped");
    expect(requests).toEqual([]); // off-hours: no Alpaca request at all
  });

  it("checks the Alpaca calendar inside the window (holidays)", async () => {
    const { runTick } = await import("@/lib/agent");
    const r = await runTick(new Date("2024-07-04T14:00:00Z")); // Thursday 10:00 EDT, Independence Day
    expect(r.status).toBe("skipped");
    expect(r.notes[0]).toMatch(/not a trading day/);
    expect(requests.map((u) => u.pathname)).toEqual(["/v2/calendar"]);
  });

  it("runs a full morning: ingest, features, 10:50 decisions, 10:51 email", async () => {
    const { runTick } = await import("@/lib/agent");
    const first = await runTick(at("09:31"));
    expect(first.status).toBe("ok");
    expect(first.feed).toBe("sip");
    // prior session's last 5 minutes for 5 symbols + the 09:30 bar for 5 symbols
    expect(first.rowsWritten.bars).toBe(5 * 5 + 5);
    expect(first.rowsWritten.news).toBe(1);

    // Re-running the same minute writes nothing new.
    const again = await runTick(at("09:31", 40));
    expect(again.rowsWritten.bars).toBe(0);
    expect(again.rowsWritten.news).toBe(0);

    for (let m = 32; m <= 109; m += 7) await runTick(at(`${String(9 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`));
    const decision = await runTick(at("10:50"));
    expect(decision.status).toBe("ok");
    expect(llmMock.fn).toHaveBeenCalledTimes(1);

    const f = mem.features.get(`${S.date} 10:50`).data;
    expect(f.bars_used).toBe(80);
    expect(f.spy_ret_prev_close_pct).toBeCloseTo(-1.336, 2);
    expect(f.news_since_prior_close).toBe(3);
    expect(f.kw_trade).toBe(1);
    expect(f.kw_megacap_negative).toBe(1);

    const rule = mem.decisions.filter((d) => d.source === "rule");
    const llm = mem.decisions.filter((d) => d.source === "llm");
    expect(rule).toHaveLength(STRATEGY_NAMES.length);
    expect(rule.every((d) => d.call === "reduce")).toBe(true); // SPY < -1% and ATR above history
    expect(llm).toHaveLength(STRATEGY_NAMES.length);
    expect(mem.history.get(S.date)).toBe(f.atr30_bp);

    // LLM gets point-in-time inputs only.
    const prompt = llmMock.fn.mock.calls[0][0];
    expect(prompt.features.as_of).toBe("2024-03-11T14:50:00.000Z");
    expect(prompt.headlines.map((h: any) => h.headline)).toContain("Nvidia downgraded at broker");

    expect(emailMock.sent).toHaveLength(0);
    await runTick(at("10:51"));
    expect(emailMock.sent).toHaveLength(1);
    expect(emailMock.sent[0].subject).toBe("Book advisor 2024-03-11: 1 skip / 6 reduce");

    // Later minutes neither re-decide nor re-send; nothing ingested past 10:50.
    await runTick(at("10:55"));
    expect(llmMock.fn).toHaveBeenCalledTimes(1);
    expect(emailMock.sent).toHaveLength(1);
    expect([...mem.bars.values()].every((b) => Date.parse(b.ts) < etToUtc(S.date, "10:50").getTime())).toBe(true);
    expect(mem.runs.every((r) => r.status !== "error")).toBe(true);
  });

  it("catches up if the 10:50 run was missed", async () => {
    const { runTick } = await import("@/lib/agent");
    const r = await runTick(at("10:53"));
    expect(r.action).toBe("decide_only");
    expect(llmMock.fn).toHaveBeenCalledTimes(1);
    expect(mem.features.get(`${S.date} 10:50`).data.bars_used).toBe(80);
    expect(emailMock.sent).toHaveLength(1);
  });

  it("stores an error row when the LLM output is invalid twice, and still emails", async () => {
    llmMock.fn.mockResolvedValue({ model: "m", decision: null, attempts: [{ ok: false, text: "x", error: "no JSON" }, { ok: false, text: "y", error: "no JSON" }] });
    const { runTick } = await import("@/lib/agent");
    await runTick(at("10:51"));
    const err = mem.decisions.find((d) => d.source === "llm");
    expect(err).toMatchObject({ strategy: "*", call: "error" });
    expect(emailMock.sent[0].subject).toMatch(/LLM error/);
  });

  it("retries the LLM next minute on an API error, error row only at the last catch-up minute", async () => {
    llmMock.fn.mockRejectedValue(new Error("overloaded"));
    const { runTick } = await import("@/lib/agent");
    const r1 = await runTick(at("10:50"));
    expect(r1.status).toBe("error");
    expect(mem.decisions.some((d) => d.source === "llm")).toBe(false);
    expect(mem.decisions.filter((d) => d.source === "rule")).toHaveLength(STRATEGY_NAMES.length);
    await runTick(at("11:04"));
    expect(mem.decisions.find((d) => d.source === "llm")).toMatchObject({ call: "error" });
  });

  it("releases the email claim when sending fails so the next minute retries", async () => {
    const { runTick } = await import("@/lib/agent");
    emailMock.fail = true;
    const r = await runTick(at("10:51"));
    expect(r.status).toBe("error");
    expect(mem.emails.size).toBe(0);
    emailMock.fail = false;
    await runTick(at("10:52"));
    expect(emailMock.sent).toHaveLength(1);
  });

  it("uses saved settings: LLM off, custom threshold and strategies, email recipients", async () => {
    const { DEFAULT_SETTINGS } = await import("@/lib/settings");
    mem.settings = {
      ...DEFAULT_SETTINGS,
      rules: { ...DEFAULT_SETTINGS.rules, spyDownPct: 5, atrLookbackDays: 400, atrMinHistoryDays: 300 },
      llm: { ...DEFAULT_SETTINGS.llm, enabled: false },
      email: { enabled: true, to: "me@example.com" },
      strategies: [{ name: "Only", entryEt: "13:00", description: "test" }],
    };
    const { runTick } = await import("@/lib/agent");
    await runTick(at("10:51"));
    expect(llmMock.fn).not.toHaveBeenCalled();
    const rule = mem.decisions.filter((d) => d.source === "rule");
    expect(rule.map((d) => d.strategy)).toEqual(["Only"]);
    expect(rule[0].call).toBe("run"); // -1.3% is above the -5% threshold; 250 days < 300 needed for the ATR leg
    expect(rule[0].reason).toMatch(/250\/300/);
    expect(emailMock.sent).toHaveLength(1);
    expect(emailMock.sent[0].subject).toBe("Book advisor 2024-03-11: rule run (LLM off)");
    expect(emailMock.sent[0].to).toBe("me@example.com");
  });

  it("email switched off in settings sends nothing", async () => {
    const { DEFAULT_SETTINGS } = await import("@/lib/settings");
    mem.settings = { ...DEFAULT_SETTINGS, email: { enabled: false, to: "" } };
    const { runTick } = await import("@/lib/agent");
    await runTick(at("10:51"));
    expect(llmMock.fn).toHaveBeenCalledTimes(1);
    expect(emailMock.sent).toHaveLength(0);
  });
});
