import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AlpacaClient, DATA_HOST, PAPER_TRADING_HOST, TRADING_HOST, assertReadOnlyEndpoint } from "@/lib/alpaca";

describe("shadow mode: read-only endpoint allowlist", () => {
  it.each([
    [DATA_HOST, "/v2/stocks/bars"],
    [DATA_HOST, "/v1beta1/news"],
    [TRADING_HOST, "/v2/calendar"],
    [TRADING_HOST, "/v2/clock"],
    [PAPER_TRADING_HOST, "/v2/calendar"],
  ])("allows %s%s", (host, p) => expect(() => assertReadOnlyEndpoint(host, p)).not.toThrow());

  it.each([
    [TRADING_HOST, "/v2/orders"],
    [PAPER_TRADING_HOST, "/v2/orders"],
    [TRADING_HOST, "/v2/orders/abc"],
    [TRADING_HOST, "/v2/positions"],
    [TRADING_HOST, "/v2/positions/SPY"],
    [TRADING_HOST, "/v2/account"],
    [TRADING_HOST, "/v2/watchlists"],
    [DATA_HOST, "/v2/orders"],
    ["https://evil.example", "/v2/calendar"],
    [TRADING_HOST, "/v2/calendar/../orders"],
  ])("refuses %s%s", (host, p) => expect(() => assertReadOnlyEndpoint(host, p)).toThrow(/read-only/));

  it("no source file mentions order/position endpoints, non-GET Alpaca calls or Schwab API paths", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        if (["node_modules", ".next", "tests", "data", ".git"].includes(f)) continue;
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    const broker = path.join(root, "lib", "paper-broker.ts");
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // This repo never talks to Schwab directly (oo-trading does, read-only): no Schwab API host or account/order paths.
      expect(src, f).not.toMatch(/schwabapi\.com|\/trader\/v1\//);
      if (f === broker) continue;
      // Only the paper broker may talk to order/position/account endpoints or send non-GET requests to Alpaca.
      expect(src, f).not.toMatch(/\/v2\/(orders|positions|account)\b/);
      if (src.includes("alpaca.markets")) expect(src, f).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    }
    const brokerSrc = readFileSync(broker, "utf8");
    expect(brokerSrc).toContain('"https://paper-api.alpaca.markets"');
    expect(brokerSrc).not.toMatch(/https:\/\/api\.alpaca\.markets/);
  });
});

type Call = { url: URL; method: string };
function mockFetch(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: new URL(url), method: init?.method ?? "GET" });
    const r = responses.shift();
    if (!r) throw new Error("unexpected request");
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { calls, impl };
}

const client = (impl: typeof fetch) =>
  new AlpacaClient({ creds: { keyId: "k", secretKey: "s" }, fetchImpl: impl, sleep: async () => {}, maxPerMinute: 1e9 });

describe("AlpacaClient", () => {
  it("pages through bars with page_token, GET only, feed recorded", async () => {
    const { calls, impl } = mockFetch([
      { body: { bars: { SPY: [{ t: "2024-03-11T13:30:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, next_page_token: "p2" } },
      { body: { bars: { SPY: [{ t: "2024-03-11T13:31:00Z", o: 1.5, h: 2, l: 1, c: 1.8, v: 5 }], QQQ: [{ t: "2024-03-11T13:30:00Z", o: 3, h: 3, l: 3, c: 3, v: 1 }] }, next_page_token: null } },
    ]);
    const bars = await client(impl).getBars({ symbols: ["SPY", "QQQ"], start: new Date("2024-03-11T13:30:00Z"), end: new Date("2024-03-11T13:32:00Z"), feed: "iex" });
    expect(bars).toHaveLength(3);
    expect(bars.every((b) => b.feed === "iex")).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(`${DATA_HOST}/v2/stocks/bars`);
    expect(calls[0].url.searchParams.get("feed")).toBe("iex");
    expect(calls[0].url.searchParams.get("timeframe")).toBe("1Min");
    expect(calls[0].url.searchParams.has("page_token")).toBe(false);
    expect(calls[1].url.searchParams.get("page_token")).toBe("p2");
  });

  it("news: include_content=false, sort=asc, paginates", async () => {
    const item = (id: number) => ({ id, headline: `h${id}`, created_at: "2024-03-11T12:00:00Z", symbols: ["SPY"], source: "benzinga", url: "u" });
    const { calls, impl } = mockFetch([
      { body: { news: [item(1), item(2)], next_page_token: "n2" } },
      { body: { news: [item(3)], next_page_token: null } },
    ]);
    const news = await client(impl).getNews({ start: new Date("2024-03-08T21:00:00Z"), end: new Date("2024-03-11T14:50:00Z") });
    expect(news.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(calls[0].url.pathname).toBe("/v1beta1/news");
    expect(calls[0].url.searchParams.get("include_content")).toBe("false");
    expect(calls[0].url.searchParams.get("sort")).toBe("asc");
    expect(calls[1].url.searchParams.get("page_token")).toBe("n2");
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const { calls, impl } = mockFetch([
      { status: 429, body: "slow down", headers: { "retry-after": "1" } },
      { status: 503, body: "busy" },
      { body: { bars: {}, next_page_token: null } },
    ]);
    const bars = await client(impl).getBars({ symbols: ["SPY"], start: new Date(0), end: new Date(60000), feed: "sip" });
    expect(bars).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("does not retry 4xx other than 429", async () => {
    const { calls, impl } = mockFetch([{ status: 422, body: "bad" }]);
    await expect(client(impl).getBars({ symbols: ["SPY"], start: new Date(0), end: new Date(60000), feed: "sip" })).rejects.toThrow(/422/);
    expect(calls).toHaveLength(1);
  });

  it("resolveFeed falls back to iex when SIP is not permitted", async () => {
    const { impl } = mockFetch([{ status: 403, body: '{"message":"subscription does not permit querying recent SIP data"}' }]);
    expect(await client(impl).resolveFeed()).toBe("iex");
    const ok = mockFetch([{ body: { bars: { SPY: [] } } }]);
    expect(await client(ok.impl).resolveFeed()).toBe("sip");
    expect(await client(mockFetch([]).impl).resolveFeed({ forced: "iex" })).toBe("iex");
  });

  it("calendar uses the reference host and normalizes times", async () => {
    const { calls, impl } = mockFetch([{ body: [{ date: "2024-11-29", open: "09:30", close: "13:00" }] }]);
    const c = new AlpacaClient({ creds: { keyId: "k", secretKey: "s" }, fetchImpl: impl, sleep: async () => {}, referenceHost: PAPER_TRADING_HOST });
    expect(await c.getCalendar("2024-11-29", "2024-11-29")).toEqual([{ date: "2024-11-29", open: "09:30", close: "13:00" }]);
    expect(calls[0].url.origin).toBe(PAPER_TRADING_HOST);
    expect(calls[0].method).toBe("GET");
  });
});
