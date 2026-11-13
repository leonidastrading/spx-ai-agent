import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entriesFromExport, loadBookEntries, settingsBotFor, upsertBookEntries, vixAtEntry } from "@/lib/book-entries";
import { setQuerierForTests } from "@/lib/db";
import { at, entry, ooExport } from "./fixtures/ooExport";

const userNames = ["Long", "Short", "8SMA", "5d IC", "VIX>30", "$8 IC", "BWB", "FOMC", "2DTE<20", "VIX-up<20", "2DTE>20", "VIX-up>20", "3Δ 4DTE"];

describe("book entries from oo-trading", () => {
  it("VIX at entry: snapshot within 2 minutes before the fill, else the day's close (flagged), else unknown", () => {
    const snaps = [{ at: "2026-11-11T20:29:10Z", vix: 18.2 }, { at: "2026-11-11T20:31:00Z", vix: 22 }];
    expect(vixAtEntry("2026-11-11T20:30:03Z", snaps, new Map())).toEqual({ vix: 18.2, source: "snapshot" });
    expect(vixAtEntry("2026-11-11T20:50:03Z", snaps, new Map([["2026-11-11", 21.5]]))).toEqual({ vix: 21.5, source: "daily_close" });
    expect(vixAtEntry("2026-10-20T19:30:03Z", snaps, new Map())).toEqual({ vix: null, source: null });
  });

  it("maps oo-trading's bot names onto the user's own bot names, splitting 2DTE / VIX-up at VIX 20", () => {
    expect(settingsBotFor({ rawBot: "8SMA IC", vixAtEntry: null }, userNames)).toEqual({ bot: "8SMA", note: null });
    expect(settingsBotFor({ rawBot: "2DTE", vixAtEntry: 17 }, userNames)).toEqual({ bot: "2DTE<20", note: null });
    expect(settingsBotFor({ rawBot: "VIX-up PS", vixAtEntry: 24 }, userNames)).toEqual({ bot: "VIX-up>20", note: null });
    expect(settingsBotFor({ rawBot: "3 Delta", vixAtEntry: null }, userNames)).toEqual({ bot: "3Δ 4DTE", note: null });
    expect(settingsBotFor({ rawBot: "2DTE", vixAtEntry: null }, userNames).note).toMatch(/VIX at entry unknown/);
    expect(settingsBotFor({ rawBot: null, vixAtEntry: null }, userNames).note).toMatch(/couldn't attribute/);
    expect(settingsBotFor({ rawBot: "FOMC", vixAtEntry: null }, ["Long"]).note).toMatch(/isn't a bot in Settings/);
  });

  describe("stored", () => {
    let pg: PGlite;
    beforeAll(() => {
      pg = new PGlite();
      setQuerierForTests({ query: async (t, p) => (await pg.query(t, p as any[])).rows as any[] });
    });
    afterAll(() => setQuerierForTests(null));

    it("keys entries by entry date, joins P/L when it arrives, keeps a known VIX", async () => {
      const exp = ooExport({ entries: [entry({ id: "e1aaaaaaaaaaaaaaaaaaaaaa", filledAt: at("15:30", 3), bot: "2DTE" })] });
      exp.market.snapshots = [{ at: at("15:29", 40), spx: 5100, vix: 18.5, vix9d: 17 }];
      await upsertBookEntries(entriesFromExport(exp));
      let [row] = await loadBookEntries("2024-01-01");
      expect(row).toMatchObject({ entryDate: "2024-03-11", status: "open", pl: null, vixAtEntry: 18.5, vixSource: "snapshot" });
      // Two days later the fill is closed: the P/L arrives, VIX stays as first known.
      const later = ooExport({ entries: [entry({ id: "e1aaaaaaaaaaaaaaaaaaaaaa", filledAt: at("15:30", 3), bot: "2DTE" })] });
      later.market.snapshots = [];
      later.outcomes = [{ entryId: "e1aaaaaaaaaaaaaaaaaaaaaa", bot: "2DTE", closedAt: "2024-03-13T20:00:00.000Z", pl: -420, how: "stop" }];
      await upsertBookEntries(entriesFromExport(later));
      [row] = await loadBookEntries("2024-01-01");
      expect(row).toMatchObject({ entryDate: "2024-03-11", status: "closed", pl: -420, vixAtEntry: 18.5 });
    });
  });
});
