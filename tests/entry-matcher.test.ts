import { describe, expect, it } from "vitest";
import { icShape, profileFits, resolveBot } from "@/lib/entry/matcher";
import type { OoEntry } from "@/lib/entry/contract";
import live from "./fixtures/ic-entries-2026-11.json";

const entries = live as unknown as OoEntry[];
const at = (hhmm: string, date = "2026-11-11") => entries.find((e) => e.filledAt.startsWith(date) && new Date(e.filledAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }).startsWith(hhmm))!;

describe("bot matching for live fills", () => {
  it("names Nov 11's 13:30 and 13:35 ICs (puts 55 / calls 50) that the export left as none", () => {
    const sma = at("13:30:03");
    const ic8 = at("13:35:02");
    expect(sma.match).toBe("none");
    expect(icShape(sma.legs)).toEqual({ putWidth: 55, callWidth: 50 });
    const a = resolveBot(sma);
    const b = resolveBot(ic8);
    expect(a).toMatchObject({ bot: "8SMA IC", source: "local_profile", confident: true });
    expect(b).toMatchObject({ bot: "$8 IC", source: "local_profile", confident: true });
    expect(a.confidence).toBeGreaterThanOrEqual(0.6);
    expect(a.reason).toMatch(/live fills/);
  });

  it("keeps the export's own confident match", () => {
    const five = at("13:30:08");
    expect(resolveBot(five)).toMatchObject({ bot: "5d IC", source: "rules", confident: true, confidence: 1 });
  });

  it("agrees with the export on every IC it did match since Nov 4", () => {
    for (const e of entries.filter((x) => x.match === "exact" && /IC$/.test(x.bot ?? ""))) expect(profileFits(e)[0]?.bot).toBe(e.bot);
  });

  it("an IC unlike any live fill stays no opinion, with its best guess and confidence", () => {
    const odd = { ...at("13:30:03"), filledAt: "2026-11-11T19:55:00Z", netPrice: 40, contracts: 100 };
    const r = resolveBot(odd);
    expect(r.confident).toBe(false);
    expect(r.confidence).toBeLessThan(0.6);
  });
});
