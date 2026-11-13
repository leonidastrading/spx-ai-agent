/**
 * Read-only Alpaca client: market data, news, calendar and clock.
 *
 * SHADOW MODE: this module can only issue HTTP GET requests, and only to
 *   - https://data.alpaca.markets  (/v2/stocks/bars, /v1beta1/news)
 *   - https://api.alpaca.markets or https://paper-api.alpaca.markets
 *       (/v2/calendar, /v2/clock only — read-only reference data)
 * Anything else (orders, positions, account, any POST/PATCH/DELETE) throws
 * before a request is made. There is no code path that places, modifies or
 * cancels an order.
 */

import { parseCalendar, type Session } from "./time";

export const DATA_HOST = "https://data.alpaca.markets";
export const TRADING_HOST = "https://api.alpaca.markets";
export const PAPER_TRADING_HOST = "https://paper-api.alpaca.markets";

const REFERENCE_PATHS = [/^\/v2\/calendar$/, /^\/v2\/clock$/];
const ALLOWED: Record<string, RegExp[]> = {
  [DATA_HOST]: [/^\/v2\/stocks\/bars$/, /^\/v1beta1\/news$/, /^\/v2\/stocks\/quotes\/latest$/],
  [TRADING_HOST]: REFERENCE_PATHS,
  [PAPER_TRADING_HOST]: REFERENCE_PATHS,
};

export type Feed = "sip" | "iex";

export interface AlpacaCreds {
  keyId: string;
  secretKey: string;
}

export interface AlpacaClientOptions {
  creds: AlpacaCreds;
  /** Host for calendar/clock. Paper keys only authenticate against paper-api. */
  referenceHost?: string;
  fetchImpl?: typeof fetch;
  /** Max requests per minute (client-side throttle). Alpaca's basic plan allows 200. */
  maxPerMinute?: number;
  /** Retries for 429 / 5xx / network errors. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export class AlpacaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export function credsFromEnv(env: NodeJS.ProcessEnv = process.env): AlpacaCreds {
  const keyId = env.ALPACA_API_KEY_ID;
  const secretKey = env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set");
  return { keyId, secretKey };
}

/** ALPACA_PAPER=true selects paper-api for the calendar/clock (paper keys). */
export function referenceHostFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALPACA_PAPER === "true" ? PAPER_TRADING_HOST : TRADING_HOST;
}

/** Throws unless host+path is on the read-only allowlist. Exported for tests. */
export function assertReadOnlyEndpoint(host: string, path: string): void {
  const rules = ALLOWED[host];
  if (!rules || !rules.some((re) => re.test(path))) {
    throw new Error(`Refusing non-allowlisted Alpaca endpoint ${host}${path} (shadow mode: read-only)`);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AlpacaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly referenceHost: string;
  private lastRequestAt = 0;

  constructor(private readonly opts: AlpacaClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.log = opts.log ?? (() => {});
    this.minIntervalMs = 60000 / (opts.maxPerMinute ?? 190);
    this.maxRetries = opts.maxRetries ?? 6;
    this.referenceHost = opts.referenceHost ?? TRADING_HOST;
  }

  /** The only network primitive in this module: GET with allowlist, throttle and retries. */
  async get<T>(host: string, path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
    assertReadOnlyEndpoint(host, path);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${host}${path}?${qs.toString()}`;

    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            "APCA-API-KEY-ID": this.opts.creds.keyId,
            "APCA-API-SECRET-KEY": this.opts.creds.secretKey,
            accept: "application/json",
          },
        });
      } catch (err) {
        if (attempt >= this.maxRetries) throw err;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) return (await res.json()) as T;

      const body = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        // Never include credentials in errors; the URL carries none.
        throw new AlpacaError(`Alpaca ${res.status} on ${path}: ${body.slice(0, 300)}`, res.status, body);
      }
      let delay = backoffMs(attempt);
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (res.status === 429 && reset > 0) delay = Math.max(delay, reset * 1000 - Date.now() + 250);
      const retryAfter = Number(res.headers.get("retry-after"));
      if (retryAfter > 0) delay = Math.max(delay, retryAfter * 1000);
      this.log(`Alpaca ${res.status} on ${path}; retrying in ${Math.round(delay)}ms`);
      await this.sleep(Math.min(delay, 65000));
    }
  }

  // ------------------------------------------------------------------ bars

  /** All 1-minute (or other timeframe) bars for symbols in [start, end), following page_token. */
  async getBars(args: {
    symbols: readonly string[];
    start: Date;
    end: Date;
    feed: Feed;
    timeframe?: string;
  }): Promise<Bar[]> {
    const out: Bar[] = [];
    let pageToken: string | undefined;
    do {
      const resp = await this.get<RawBarsResponse>(DATA_HOST, "/v2/stocks/bars", {
        symbols: args.symbols.join(","),
        timeframe: args.timeframe ?? "1Min",
        start: args.start.toISOString(),
        end: args.end.toISOString(),
        feed: args.feed,
        adjustment: "raw",
        sort: "asc",
        limit: 10000,
        page_token: pageToken,
      });
      out.push(...parseBarsResponse(resp, args.feed));
      pageToken = resp.next_page_token ?? undefined;
    } while (pageToken);
    return out;
  }

  /**
   * Pick the feed: honour `forced` if set, otherwise probe SIP over the last
   * few minutes (the subscription check that fails on the free plan) and fall
   * back to IEX. `historicalOnly` probes a window older than 15 minutes, which
   * the free plan allows on SIP — used by the backfill.
   */
  async resolveFeed(opts: { forced?: string; now?: Date; historicalOnly?: boolean } = {}): Promise<Feed> {
    if (opts.forced === "sip" || opts.forced === "iex") return opts.forced;
    const now = opts.now ?? new Date();
    const end = new Date(now.getTime() - (opts.historicalOnly ? 20 * 60000 : 0));
    const start = new Date(end.getTime() - 5 * 24 * 3600000);
    try {
      await this.get<RawBarsResponse>(DATA_HOST, "/v2/stocks/bars", {
        symbols: "SPY",
        timeframe: "1Day",
        start: start.toISOString(),
        end: end.toISOString(),
        feed: "sip",
        limit: 1,
      });
      return "sip";
    } catch (err) {
      if (err instanceof AlpacaError && (err.status === 403 || err.status === 422)) return "iex";
      throw err;
    }
  }

  // ------------------------------------------------------------------ news

  /** All headlines in [start, end), ascending, following page_token. */
  async getNews(args: { start: Date; end: Date; symbols?: string[] }): Promise<NewsItem[]> {
    const out: NewsItem[] = [];
    let pageToken: string | undefined;
    do {
      const resp = await this.get<RawNewsResponse>(DATA_HOST, "/v1beta1/news", {
        start: args.start.toISOString(),
        end: args.end.toISOString(),
        symbols: args.symbols?.join(","),
        sort: "asc",
        include_content: false,
        exclude_contentless: false,
        limit: 50,
        page_token: pageToken,
      });
      out.push(...parseNewsResponse(resp));
      pageToken = resp.next_page_token ?? undefined;
    } while (pageToken);
    return out;
  }

  /** Latest NBBO quote per symbol (bid/ask/timestamp). */
  async getLatestQuotes(symbols: readonly string[], feed: Feed): Promise<Record<string, Quote>> {
    const resp = await this.get<{ quotes: Record<string, { t: string; bp: number; ap: number; bs: number; as: number }> }>(
      DATA_HOST,
      "/v2/stocks/quotes/latest",
      { symbols: symbols.join(","), feed },
    );
    const out: Record<string, Quote> = {};
    for (const [sym, q] of Object.entries(resp.quotes ?? {})) out[sym] = { ts: new Date(q.t).toISOString(), bid: q.bp, ask: q.ap };
    return out;
  }

  // ------------------------------------------------------------- calendar

  async getCalendar(start: string, end: string): Promise<Session[]> {
    const rows = await this.get<Array<{ date: string; open: string; close: string }>>(this.referenceHost, "/v2/calendar", {
      start,
      end,
    });
    return parseCalendar(rows);
  }

  async getClock(): Promise<{ timestamp: string; is_open: boolean; next_open: string; next_close: string }> {
    return this.get(this.referenceHost, "/v2/clock", {});
  }
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30000) + Math.floor(Math.random() * 250);
}

// ---------------------------------------------------------------------------
// Pure response parsing
// ---------------------------------------------------------------------------

export interface Bar {
  symbol: string;
  /** bar start, ISO UTC */
  ts: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  feed: Feed;
}

export interface RawBarsResponse {
  bars: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> | null;
  next_page_token?: string | null;
}

export function parseBarsResponse(resp: RawBarsResponse, feed: Feed): Bar[] {
  const out: Bar[] = [];
  for (const [symbol, rows] of Object.entries(resp.bars ?? {})) {
    for (const r of rows ?? []) {
      out.push({ symbol, ts: new Date(r.t).toISOString(), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, feed });
    }
  }
  return out;
}

export interface Quote {
  ts: string;
  bid: number;
  ask: number;
}

export interface NewsItem {
  id: number;
  /** created_at, ISO UTC */
  ts: string;
  headline: string;
  summary: string;
  symbols: string[];
  source: string;
  url: string;
  /** Who wrote/distributed it (e.g. "Benzinga Newsdesk", "Business Wire"): press-release wires are screened out. */
  author?: string;
}

export interface RawNewsResponse {
  news: Array<{
    id: number;
    headline: string;
    summary?: string;
    created_at: string;
    updated_at?: string;
    symbols?: string[];
    source?: string;
    url?: string;
    author?: string;
  }> | null;
  next_page_token?: string | null;
}

export function parseNewsResponse(resp: RawNewsResponse): NewsItem[] {
  return (resp.news ?? []).map((n) => ({
    id: n.id,
    ts: new Date(n.created_at).toISOString(),
    headline: n.headline ?? "",
    summary: n.summary ?? "",
    symbols: n.symbols ?? [],
    source: n.source ?? "",
    url: n.url ?? "",
    author: n.author ?? "",
  }));
}
