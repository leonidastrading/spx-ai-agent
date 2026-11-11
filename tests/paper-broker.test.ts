import { describe, expect, it } from "vitest";
import { PAPER_HOST, PaperBroker, assertPaperKeys, assertPaperRequest, brokerConfigured, brokerCredsFromEnv } from "@/lib/paper-broker";

const paperEnv = { ALPACA_PAPER: "true" };
const creds = { keyId: "PKTESTKEY", secretKey: "s" };

describe("paper broker guards", () => {
  it("refuses unless ALPACA_PAPER=true and the key is a paper key", () => {
    expect(() => assertPaperKeys(creds, {})).toThrow(/ALPACA_PAPER/);
    expect(() => assertPaperKeys({ keyId: "AKLIVEKEY", secretKey: "s" }, paperEnv)).toThrow(/paper key/);
    expect(() => assertPaperKeys(creds, paperEnv)).not.toThrow();
    expect(() => new PaperBroker({ keyId: "AKLIVE", secretKey: "s" }, { env: paperEnv })).toThrow();
  });

  it("allowlist: orders and reads only", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    for (const [m, p] of [["POST", "/v2/orders"], ["GET", `/v2/orders/${id}`], ["PATCH", `/v2/orders/${id}`], ["DELETE", `/v2/orders/${id}`], ["GET", "/v2/account"], ["GET", "/v2/positions/QQQ"]]) {
      expect(() => assertPaperRequest(m, p)).not.toThrow();
    }
    for (const [m, p] of [["DELETE", "/v2/orders"], ["DELETE", "/v2/positions"], ["DELETE", "/v2/positions/QQQ"], ["PATCH", "/v2/account/configurations"], ["POST", "/v2/options/orders"], ["GET", "/v1/trading/accounts"]]) {
      expect(() => assertPaperRequest(m, p)).toThrow(/allowlist/);
    }
  });

  it("every request goes to the paper host; bracket order body", async () => {
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ id: "o1", status: "accepted" }), { status: 200 });
    }) as typeof fetch;
    const b = new PaperBroker(creds, { fetchImpl, env: paperEnv });
    await b.submitBracket({ symbol: "QQQ", side: "buy", qty: 20, stop: 498.504, target: 502.006, clientOrderId: "c1" });
    expect(calls[0].url).toBe(`${PAPER_HOST}/v2/orders`);
    expect(calls[0].body).toMatchObject({ symbol: "QQQ", side: "buy", qty: "20", type: "market", time_in_force: "day", order_class: "bracket", take_profit: { limit_price: 502.01 }, stop_loss: { stop_price: 498.5 }, client_order_id: "c1" });
    await expect(b.submitBracket({ symbol: "QQQ", side: "buy", qty: 0.5, stop: 1, target: 2, clientOrderId: "c" })).rejects.toThrow(/qty/);
  });
});

describe("separate paper accounts per part", () => {
  const env = { ALPACA_PAPER: "true", ALPACA_API_KEY_ID: "PKSHARED", ALPACA_API_SECRET_KEY: "s" };
  it("no fallback to the shared ALPACA_API_KEY_ID", () => {
    expect(() => brokerCredsFromEnv("trader", env)).toThrow(/TRADER_ALPACA_KEY_ID/);
    expect(brokerConfigured("swing", env)).toBe(false);
  });
  it("trader and swing must be different accounts", () => {
    const both = { ...env, TRADER_ALPACA_KEY_ID: "PKONE", TRADER_ALPACA_SECRET_KEY: "a", SWING_ALPACA_KEY_ID: "PKONE", SWING_ALPACA_SECRET_KEY: "b" };
    expect(() => brokerCredsFromEnv("trader", both)).toThrow(/different/);
    expect(brokerConfigured("swing", both)).toBe(false);
    const ok = { ...both, SWING_ALPACA_KEY_ID: "PKTWO" };
    expect(brokerCredsFromEnv("trader", ok)).toEqual({ keyId: "PKONE", secretKey: "a" });
    expect(brokerConfigured("swing", ok)).toBe(true);
  });
  it("live keys are refused even when set per part", () => {
    expect(brokerConfigured("trader", { ...env, TRADER_ALPACA_KEY_ID: "AKLIVE", TRADER_ALPACA_SECRET_KEY: "a" })).toBe(false);
    expect(brokerConfigured("trader", { TRADER_ALPACA_KEY_ID: "PKONE", TRADER_ALPACA_SECRET_KEY: "a" })).toBe(false); // ALPACA_PAPER missing
  });
});
