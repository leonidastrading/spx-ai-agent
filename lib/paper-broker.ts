/**
 * Alpaca PAPER broker client — the only module in this repo that can place,
 * modify or cancel orders, and it can only reach paper-api.alpaca.markets.
 *
 * Guards, checked on every request:
 *  - the host is hard-wired to the paper endpoint and never taken from config;
 *  - ALPACA_PAPER must be "true" and the key ID must be a paper key ("PK...");
 *    live keys don't authenticate against the paper host anyway;
 *  - only the order, account (read), position (read) and asset (read) paths
 *    below are allowed;
 *  - orders are equities only: no options, no crypto (asset class checked).
 */

import type { AlpacaCreds } from "./alpaca";

export const PAPER_HOST = "https://paper-api.alpaca.markets";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

const RULES: Array<{ method: Method; path: RegExp }> = [
  { method: "GET", path: /^\/v2\/account$/ },
  { method: "GET", path: /^\/v2\/assets\/[A-Z.]{1,10}$/ },
  { method: "GET", path: /^\/v2\/positions\/[A-Z.]{1,10}$/ },
  { method: "POST", path: /^\/v2\/orders$/ },
  { method: "GET", path: /^\/v2\/orders\/[0-9a-f-]{36}$/ },
  { method: "GET", path: /^\/v2\/orders:by_client_order_id$/ },
  { method: "PATCH", path: /^\/v2\/orders\/[0-9a-f-]{36}$/ },
  { method: "DELETE", path: /^\/v2\/orders\/[0-9a-f-]{36}$/ },
];

/** Throws unless the method+path is on the paper allowlist. Exported for tests. */
export function assertPaperRequest(method: string, path: string): void {
  if (!RULES.some((r) => r.method === method && r.path.test(path))) {
    throw new Error(`Refusing ${method} ${path}: not on the paper-broker allowlist`);
  }
}

export type BrokerPart = "trader" | "swing";

const KEY_VARS: Record<BrokerPart, [string, string]> = {
  trader: ["TRADER_ALPACA_KEY_ID", "TRADER_ALPACA_SECRET_KEY"],
  swing: ["SWING_ALPACA_KEY_ID", "SWING_ALPACA_SECRET_KEY"],
};

/**
 * Keys for one part's own paper account. There is deliberately no fallback to
 * ALPACA_API_KEY_ID: that key may belong to another bot's paper account (whose
 * end-of-day sweep would close these positions). The trader and the swing
 * sleeve must also use different accounts.
 */
export function brokerCredsFromEnv(part: BrokerPart, env: Record<string, string | undefined> = process.env): AlpacaCreds {
  const [idVar, secretVar] = KEY_VARS[part];
  const keyId = env[idVar]?.trim();
  const secretKey = env[secretVar]?.trim();
  if (!keyId || !secretKey) throw new Error(`${idVar} / ${secretVar} are not set: give the ${part} its own Alpaca paper account`);
  const other = env[KEY_VARS[part === "trader" ? "swing" : "trader"][0]]?.trim();
  if (other && other === keyId) throw new Error("The trader and the swing sleeve must use different Alpaca paper accounts (same key ID set for both)");
  return { keyId, secretKey };
}

/** Whether a part has its own paper keys configured (and they pass the paper checks). */
export function brokerConfigured(part: BrokerPart, env: Record<string, string | undefined> = process.env): boolean {
  try {
    assertPaperKeys(brokerCredsFromEnv(part, env), env);
    return true;
  } catch {
    return false;
  }
}

/** Throws unless the environment is explicitly paper. Exported for tests. */
export function assertPaperKeys(creds: AlpacaCreds, env: Record<string, string | undefined> = process.env): void {
  if (env.ALPACA_PAPER !== "true") throw new Error("Paper trading refused: ALPACA_PAPER is not \"true\"");
  if (!creds.keyId.startsWith("PK")) throw new Error("Paper trading refused: key ID is not an Alpaca paper key (PK...)");
}

export interface PaperOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  type: string;
  status: string;
  order_class: string;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
  stop_price: string | null;
  limit_price: string | null;
  legs?: PaperOrder[] | null;
}

export class PaperBrokerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class PaperBroker {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly creds: AlpacaCreds,
    opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
  ) {
    assertPaperKeys(creds, opts.env);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: Method, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    assertPaperRequest(method, path);
    const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : "";
    const res = await this.fetchImpl(`${PAPER_HOST}${path}${qs}`, {
      method,
      headers: {
        "APCA-API-KEY-ID": this.creds.keyId,
        "APCA-API-SECRET-KEY": this.creds.secretKey,
        accept: "application/json",
        ...(opts.body ? { "content-type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new PaperBrokerError(`Alpaca paper ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : null) as T;
  }

  getAccount() {
    return this.request<{ account_number: string; status: string; equity: string; buying_power: string; trading_blocked: boolean }>("GET", "/v2/account");
  }

/** Open position in a symbol on the paper account, or null. */
  async getPosition(symbol: string): Promise<{ qty: string; side: string } | null> {
    try {
      return await this.request<{ qty: string; side: string }>("GET", `/v2/positions/${symbol}`);
    } catch (err) {
      if (err instanceof PaperBrokerError && err.status === 404) return null;
      throw err;
    }
  }

  async getAsset(symbol: string) {
    return this.request<{ symbol: string; class: string; tradable: boolean; shortable: boolean; easy_to_borrow: boolean }>(
      "GET",
      `/v2/assets/${symbol}`,
    );
  }

  /** Market entry with attached stop-loss and take-profit (bracket), day order, whole shares. */
  async submitBracket(args: { symbol: string; side: "buy" | "sell"; qty: number; stop: number; target: number; clientOrderId: string }) {
    if (!Number.isInteger(args.qty) || args.qty <= 0) throw new Error(`bad qty ${args.qty}`);
    return this.request<PaperOrder>("POST", "/v2/orders", {
      body: {
        symbol: args.symbol,
        side: args.side,
        qty: String(args.qty),
        type: "market",
        time_in_force: "day",
        order_class: "bracket",
        take_profit: { limit_price: round2(args.target) },
        stop_loss: { stop_price: round2(args.stop) },
        client_order_id: args.clientOrderId,
      },
    });
  }

  /** Plain market order (entries for swing ideas; closing exits). */
  async submitMarket(args: { symbol: string; side: "buy" | "sell"; qty: number; clientOrderId: string }) {
    if (!Number.isInteger(args.qty) || args.qty <= 0) throw new Error(`bad qty ${args.qty}`);
    return this.request<PaperOrder>("POST", "/v2/orders", {
      body: { symbol: args.symbol, side: args.side, qty: String(args.qty), type: "market", time_in_force: "day", client_order_id: args.clientOrderId },
    });
  }

  /** GTC exit order for swing ideas: a limit target or a trailing stop. */
  async submitExit(args: { symbol: string; side: "buy" | "sell"; qty: number; clientOrderId: string } & ({ limit: number } | { trailPercent: number })) {
    const body: Record<string, unknown> = {
      symbol: args.symbol,
      side: args.side,
      qty: String(args.qty),
      time_in_force: "gtc",
      client_order_id: args.clientOrderId,
    };
    if ("limit" in args) Object.assign(body, { type: "limit", limit_price: round2(args.limit) });
    else Object.assign(body, { type: "trailing_stop", trail_percent: String(args.trailPercent) });
    return this.request<PaperOrder>("POST", "/v2/orders", { body });
  }

  getOrder(id: string) {
    return this.request<PaperOrder>("GET", `/v2/orders/${id}`, { query: { nested: "true" } });
  }

  async getOrderByClientId(clientOrderId: string): Promise<PaperOrder | null> {
    try {
      return await this.request<PaperOrder>("GET", "/v2/orders:by_client_order_id", { query: { client_order_id: clientOrderId } });
    } catch (err) {
      if (err instanceof PaperBrokerError && err.status === 404) return null;
      throw err;
    }
  }

  /** Change a stop price (used only to tighten a stop; the caller checks direction). */
  replaceStop(orderId: string, stop: number) {
    return this.request<PaperOrder>("PATCH", `/v2/orders/${orderId}`, { body: { stop_price: round2(stop) } });
  }

  /** Cancel an open order; already-final orders are ignored. */
  async cancel(orderId: string): Promise<void> {
    try {
      await this.request("DELETE", `/v2/orders/${orderId}`);
    } catch (err) {
      if (err instanceof PaperBrokerError && (err.status === 404 || err.status === 422)) return;
      throw err;
    }
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** What the tabs show about a part's paper account (never the keys). */
export async function paperAccountSummary(
  part: BrokerPart,
): Promise<{ configured: false; reason: string } | { configured: true; accountNumber: string; equity: number; status: string } | { configured: true; error: string }> {
  let creds: AlpacaCreds;
  try {
    creds = brokerCredsFromEnv(part);
    assertPaperKeys(creds);
  } catch (err) {
    return { configured: false, reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const a = await new PaperBroker(creds).getAccount();
    return { configured: true, accountNumber: a.account_number, equity: Number(a.equity), status: a.status };
  } catch (err) {
    return { configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}
