import { describe, expect, it } from "vitest";
import { exportConfigFromEnv, makeExportClient } from "@/lib/entry/client";
import { ooExport } from "./fixtures/ooExport";

describe("oo-trading export client", () => {
  it("needs both vars and https", () => {
    expect(exportConfigFromEnv({})).toBeNull();
    expect(() => exportConfigFromEnv({ OO_EXPORT_URL: "http://x.example", OO_EXPORT_TOKEN: "t" })).toThrow(/https/);
    expect(exportConfigFromEnv({ OO_EXPORT_URL: "https://oo.example/", OO_EXPORT_TOKEN: "t" })).toEqual({ baseUrl: "https://oo.example", token: "t" });
  });
  it("GET with the bearer token; validates the contract", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const ok = makeExportClient({ baseUrl: "https://oo.example", token: "tok" }, (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(ooExport()));
    }) as typeof fetch);
    const r = await ok("2024-03-11T04:00:00.000Z");
    expect(r.entries).toHaveLength(1);
    expect(seen[0].url).toBe("https://oo.example/api/export/advisor?since=2024-03-11T04%3A00%3A00.000Z");
    expect(seen[0].init.method).toBe("GET");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const bad = makeExportClient({ baseUrl: "https://oo.example", token: "tok" }, (async () => new Response(JSON.stringify({ ...ooExport(), entries: [{ id: "x" }] }))) as unknown as typeof fetch);
    await expect(bad("x")).rejects.toThrow(/doesn't match the contract/);
  });
});
