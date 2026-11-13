/** Build the 10:50 call's volatility and live-book block from oo-trading's export. Pure. */

import type { OoExport } from "./entry/contract";
import type { BookContext } from "./decision";

const pct = (a: number | null, b: number | null | undefined) => (a === null || !b ? null : Math.round((a / b - 1) * 1000) / 10);

/** Values at or before `asOf`: the latest quote snapshot, else the quote itself if it isn't newer. */
export function bookContextFromExport(exp: OoExport, asOf: Date): BookContext {
  const at = asOf.getTime();
  const snap = [...exp.market.snapshots].filter((s) => Date.parse(s.at) <= at).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  const q = (x: { last: number; quoteTime: string } | null) => (x && Date.parse(x.quoteTime) <= at + 60000 ? x.last : null);
  const vix = snap?.vix ?? q(exp.market.vix);
  const vix9d = snap?.vix9d ?? q(exp.market.vix9d);
  const open = exp.book.open
    ? exp.book.open
        .filter((o) => Date.parse(o.filledAt) <= at)
        .map((o) => ({
          bot: o.bot,
          legs: o.legs.map((l) => `${l.putCall}${l.strike} ${l.qty > 0 ? "+" : ""}${l.qty}`).join(" / "),
          expiry: [...new Set(o.legs.map((l) => l.expiration.slice(0, 10)))].join(", "),
          contracts: o.contracts,
          openPl: o.pl,
        }))
    : null;
  return {
    vol:
      vix === null && vix9d === null
        ? null
        : { vix, vixChangePct: pct(vix, exp.market.vix.prevClose), vix9d, vix9dChangePct: pct(vix9d, exp.market.vix9d?.prevClose), asOf: snap?.at ?? exp.asOf },
    open,
    note: exp.book.open ? undefined : "oo-trading's export has no open-position list yet",
  };
}
