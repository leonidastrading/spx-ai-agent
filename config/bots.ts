/**
 * oo-trading names the bot behind each Schwab entry by its structure (legs,
 * wing widths, DTE, time). This maps those names to the 13 live bots. The
 * 2DTE and VIX-up bots run in two variants chosen by VIX at entry, which the
 * structure can't tell apart, so they're split on VIX at entry.
 */

export const VIX_SPLIT = 20;

const DIRECT: Record<string, string> = {
  Long: "Long",
  Short: "Short",
  "3 Delta": "3 Delta",
  "8SMA IC": "8SMA",
  "5d IC": "5d IC",
  "VIX>30 1DTE": "VIX>30",
  "$8 IC": "$8 IC",
  BWB: "BWB",
  FOMC: "FOMC",
};

const SPLIT: Record<string, [string, string]> = {
  "2DTE": ["2DTE VIX<20", "2DTE VIX>20"],
  "VIX-up PS": ["VIX-up VIX<20", "VIX-up VIX>20"],
};

export type BotMatch = { bot: string; note: null } | { bot: null; note: string };

/** Live-bot name for an oo-trading bot name, given VIX at entry when known. */
export function liveBot(ooBot: string | null, vixAtEntry: number | null): BotMatch {
  if (!ooBot) return { bot: null, note: "oo-trading couldn't attribute the fill to one bot" };
  if (ooBot in DIRECT) return { bot: DIRECT[ooBot], note: null };
  const split = SPLIT[ooBot];
  if (split) {
    if (vixAtEntry === null) return { bot: null, note: `${ooBot}: VIX at entry unknown, so the <${VIX_SPLIT} / >${VIX_SPLIT} variant can't be told` };
    return { bot: vixAtEntry < VIX_SPLIT ? split[0] : split[1], note: null };
  }
  return { bot: null, note: `no live bot named "${ooBot}"` };
}
