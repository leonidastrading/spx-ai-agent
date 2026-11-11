/**
 * Which bot an entry is. oo-trading's export decides first (its structure rules, and from export v2 the Live
 * tab's backtest-profile attribution). When it has no confident match, the entry is compared with how the bots
 * actually fill at Schwab (config LIVE_PROFILES: entry time, lots, credit range, wing widths). Below
 * ENTRY.matchMinConfidence the advisor logs "no opinion". Pure.
 */

import { ENTRY, LIVE_PROFILES, type LiveProfile } from "@/config/entry";
import { hhmmToMinutes, toEt } from "../time";
import type { OoEntry } from "./contract";

export type MatchSource = "rules" | "live_profile" | "local_profile";

export interface BotResolution {
  bot: string | null;
  confidence: number;
  reason: string;
  source: MatchSource | null;
  /** True when the bot is known well enough for the model to be asked. */
  confident: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Iron-condor shape and wing widths from the legs, or null for anything else. */
export function icShape(legs: OoEntry["legs"]): { putWidth: number; callWidth: number } | null {
  const puts = legs.filter((l) => l.putCall === "P").sort((a, b) => a.strike - b.strike);
  const calls = legs.filter((l) => l.putCall === "C").sort((a, b) => a.strike - b.strike);
  if (puts.length !== 2 || calls.length !== 2) return null;
  // Short put above the long put, short call below the long call.
  if (!(puts[0].qty > 0 && puts[1].qty < 0 && calls[0].qty < 0 && calls[1].qty > 0)) return null;
  return { putWidth: puts[1].strike - puts[0].strike, callWidth: calls[1].strike - calls[0].strike };
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const outside = (x: number, [lo, hi]: [number, number]) => (x < lo ? (lo - x) / Math.max(hi - lo, 0.1) : x > hi ? (x - hi) / Math.max(hi - lo, 0.1) : 0);

export interface ProfileFit {
  bot: string;
  confidence: number;
  minutesOff: number;
  detail: string;
  score: number;
}

/** Score an entry against each live profile; best first. */
export function profileFits(entry: OoEntry, profiles: LiveProfile[] = LIVE_PROFILES): ProfileFit[] {
  const et = toEt(new Date(entry.filledAt));
  const shape = icShape(entry.legs);
  const exps = [...new Set(entry.legs.map((l) => l.expiration.slice(0, 10)))];
  if (!shape || exps.length !== 1) return [];
  const dte = dayDiff(et.date, exps[0]);
  const t = hhmmToMinutes(et.hhmm) + et.second / 60;
  const fits: ProfileFit[] = [];
  for (const p of profiles) {
    if (p.dte !== dte) continue;
    const minutesOff = Math.min(...p.times.map((x) => Math.abs(t - hhmmToMinutes(x))));
    if (minutesOff > 30) continue;
    const credit = outside(entry.netPrice, p.credit);
    const lots = outside(entry.contracts, p.contracts);
    const pw = outside(shape.putWidth, p.putWidth);
    const cw = outside(shape.callWidth, p.callWidth);
    let c = 0.9;
    if (minutesOff > 5) c -= 0.15;
    if (minutesOff > 15) c -= 0.15;
    c -= Math.min(0.4, 0.4 * credit);
    if (lots > 0) c -= 0.1;
    if (pw > 0) c -= 0.15;
    if (cw > 0) c -= 0.15;
    fits.push({
      bot: p.bot,
      confidence: r2(Math.max(0, c)),
      minutesOff: r2(minutesOff),
      score: minutesOff + 10 * credit + 5 * (pw + cw) + 2 * lots,
      detail: `${Math.round(minutesOff)} min from ${p.times.join("/")}, credit ${entry.netPrice} vs ${p.credit[0]}–${p.credit[1]}, ${entry.contracts} lots vs ${p.contracts[0]}–${p.contracts[1]}, wings ${shape.putWidth}/${shape.callWidth} vs ${p.putWidth.join("–")}/${p.callWidth.join("–")}`,
    });
  }
  fits.sort((a, b) => a.score - b.score);
  // A close runner-up makes the pick less certain.
  if (fits.length > 1 && fits[1].score - fits[0].score < 2) fits[0] = { ...fits[0], confidence: r2(Math.max(0, fits[0].confidence - 0.2)) };
  return fits;
}

export function resolveBot(entry: OoEntry, min = ENTRY.matchMinConfidence): BotResolution {
  const exportSource = (entry as OoEntry & { matchSource?: MatchSource | null }).matchSource ?? (entry.bot ? "rules" : null);
  if (entry.match === "exact" && entry.bot && entry.matchConfidence >= min) {
    return { bot: entry.bot, confidence: entry.matchConfidence, reason: entry.matchReason, source: exportSource, confident: true };
  }
  const best = profileFits(entry)[0];
  if (best && best.confidence >= min) {
    return { bot: best.bot, confidence: best.confidence, reason: `${entry.matchReason} → ${best.bot} by its live fills (${best.detail})`, source: "local_profile", confident: true };
  }
  if (best && best.confidence > entry.matchConfidence) {
    return { bot: best.bot, confidence: best.confidence, reason: `${entry.matchReason} → best guess ${best.bot} by its live fills (${best.detail}), below ${min}`, source: "local_profile", confident: false };
  }
  return { bot: entry.bot, confidence: entry.matchConfidence, reason: entry.matchReason, source: exportSource, confident: false };
}
