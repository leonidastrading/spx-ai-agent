import { afterEach, describe, expect, it } from "vitest";
import { query, setQuerierForTests } from "@/lib/db";

afterEach(() => setQuerierForTests(null));

describe("schema setup when crons cold-start together", () => {
  it("retries a statement that hit 'tuple concurrently updated', then runs the query", async () => {
    const failed = new Set<string>();
    let schemaCalls = 0;
    setQuerierForTests({
      query: async (text) => {
        if (text === "SELECT 1 AS ok") return [{ ok: 1 }];
        schemaCalls++;
        if (/CREATE OR REPLACE FUNCTION/.test(text) && !failed.has(text)) {
          failed.add(text);
          throw new Error("tuple concurrently updated");
        }
        return [];
      },
    });
    expect(await query("SELECT 1 AS ok")).toEqual([{ ok: 1 }]);
    expect(failed.size).toBeGreaterThan(0);
    expect(schemaCalls).toBeGreaterThan(failed.size);
  });

  it("other errors still fail", async () => {
    setQuerierForTests({ query: async () => { throw new Error("permission denied for schema public"); } });
    await expect(query("SELECT 1")).rejects.toThrow(/permission denied/);
  });
});
