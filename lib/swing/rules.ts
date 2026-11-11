/** Swing ideas log (Part B): validation, state from append-only events, scoring vs SPY. Pure. */

import { z } from "zod";
import { SWING } from "@/config/trader";

export const SWING_CATALYSTS = ["news", "panic_dip", "theme", "earnings"] as const;
export const EXIT_RULES = ["target", "trailing", "time"] as const;

export const ideaInputSchema = z.object({
  ticker: z.string().trim().toUpperCase().regex(/^[A-Z]{1,5}(\.[A-Z])?$/, "1–5 letters"),
  side: z.enum(["long", "short"]),
  thesis: z.string().trim().min(5).max(1000),
  catalyst: z.enum(SWING_CATALYSTS),
  speculative: z.boolean(),
  notional: z.number().positive(),
  exitRule: z.enum(EXIT_RULES),
  /** target: price; trailing: percent; time: calendar days */
  exitParam: z.number().positive(),
});
export type IdeaInput = z.infer<typeof ideaInputSchema>;

export interface Idea extends IdeaInput {
  id: number;
  createdAt: string;
  /** quote mid when saved; the actual entry is the fill price */
  refPrice: number;
}

export interface IdeaEvent {
  ideaId: number;
  kind: "entry_submitted" | "entry_filled" | "entry_failed" | "exit_submitted" | "exit_filled" | "exit_failed";
  orderId: string | null;
  price: number | null;
  qty: number | null;
  spyPrice: number | null;
  at: string;
  detail: string | null;
}

export interface IdeaState {
  status: "pending_entry" | "open" | "closing" | "closed" | "failed";
  entryOrderId: string | null;
  exitOrderId: string | null;
  qty: number | null;
  entryPrice: number | null;
  entryAt: string | null;
  spyEntry: number | null;
  exitPrice: number | null;
  exitAt: string | null;
  spyExit: number | null;
  exitReason: string | null;
  error: string | null;
}

/** Fold an idea's events (in insertion order) into its current state. */
export function ideaState(events: IdeaEvent[]): IdeaState {
  const s: IdeaState = {
    status: "pending_entry", entryOrderId: null, exitOrderId: null, qty: null, entryPrice: null, entryAt: null,
    spyEntry: null, exitPrice: null, exitAt: null, spyExit: null, exitReason: null, error: null,
  };
  for (const e of events) {
    switch (e.kind) {
      case "entry_submitted": s.entryOrderId = e.orderId; s.qty = e.qty; break;
      case "entry_filled": s.status = "open"; s.entryPrice = e.price; s.qty = e.qty ?? s.qty; s.entryAt = e.at; s.spyEntry = e.spyPrice; break;
      case "entry_failed": s.status = "failed"; s.error = e.detail; break;
      case "exit_submitted": s.exitOrderId = e.orderId; if (s.status === "open") s.status = "closing"; s.exitReason = e.detail ?? s.exitReason; break;
      case "exit_filled": s.status = "closed"; s.exitPrice = e.price; s.exitAt = e.at; s.spyExit = e.spyPrice; s.exitReason = e.detail ?? s.exitReason; break;
      case "exit_failed": s.error = e.detail; break;
    }
  }
  return s;
}

/** Sleeve limits for a new idea against the ideas still holding (or reserving) capital. */
export function sleeveProblems(input: IdeaInput, active: Array<{ notional: number; speculative: boolean }>, refPrice: number): string[] {
  const out: string[] = [];
  if (SWING.blockedTickers.includes(input.ticker)) out.push(`${input.ticker} is not allowed (reserved for the day trader, or a leveraged/inverse fund)`);
  const maxPos = SWING.sleeve * SWING.maxPositionFraction;
  if (input.notional > maxPos) out.push(`size $${input.notional} is above the per-position cap of $${maxPos}`);
  const used = active.reduce((a, i) => a + i.notional, 0);
  if (used + input.notional > SWING.sleeve) out.push(`sleeve would exceed $${SWING.sleeve} (in use: $${used})`);
  if (input.speculative) {
    const spec = active.filter((i) => i.speculative).reduce((a, i) => a + i.notional, 0);
    const cap = SWING.sleeve * SWING.maxSpeculativeFraction;
    if (spec + input.notional > cap) out.push(`speculative ideas would total $${spec + input.notional}, above the $${cap} cap`);
  }
  if (Math.floor(input.notional / refPrice) < 1) out.push(`size is less than one share at ~$${refPrice}`);
  if (input.exitRule === "target") {
    const ok = input.side === "long" ? input.exitParam > refPrice : input.exitParam < refPrice;
    if (!ok) out.push(`target $${input.exitParam} must be ${input.side === "long" ? "above" : "below"} the current price ~$${refPrice.toFixed(2)}`);
  }
  if (input.exitRule === "trailing" && (input.exitParam < 0.5 || input.exitParam > 30)) out.push("trailing stop must be 0.5%–30%");
  if (input.exitRule === "time" && (input.exitParam < 1 || input.exitParam > 365 || !Number.isInteger(input.exitParam))) out.push("time limit must be 1–365 whole days");
  return out;
}

/** Return of one closed (or marked) idea, and SPY over the same period. */
export function ideaReturn(side: "long" | "short", entry: number, exit: number, spyEntry: number | null, spyExit: number | null) {
  const ret = (side === "long" ? 1 : -1) * (exit / entry - 1);
  const spy = spyEntry && spyExit ? spyExit / spyEntry - 1 : null;
  return { ret, spy, excess: spy === null ? null : ret - spy };
}

export interface SwingSummary {
  closed: number;
  open: number;
  winRate: number | null;
  avgReturn: number | null;
  avgExcess: number | null;
  realizedPl: number;
  unrealizedPl: number;
  sleeveReturn: number;
  spyReturn: number | null;
  verdictDue: boolean;
  verdict: "beats SPY" | "does not beat SPY" | null;
}

export function swingSummary(args: {
  rows: Array<{ idea: Idea; state: IdeaState; mark: number | null }>;
  spyNow: number | null;
  firstIdeaAt: string | null;
  now: Date;
}): SwingSummary {
  const closed = args.rows.filter((r) => r.state.status === "closed" && r.state.entryPrice && r.state.exitPrice);
  const open = args.rows.filter((r) => r.state.status === "open" || r.state.status === "closing");
  const rets = closed.map((r) => ideaReturn(r.idea.side, r.state.entryPrice!, r.state.exitPrice!, r.state.spyEntry, r.state.spyExit));
  const pl = (side: "long" | "short", qty: number, a: number, b: number) => (side === "long" ? 1 : -1) * (b - a) * qty;
  const realized = closed.reduce((a, r) => a + pl(r.idea.side, r.state.qty ?? 0, r.state.entryPrice!, r.state.exitPrice!), 0);
  const unrealized = open.reduce((a, r) => a + (r.mark && r.state.entryPrice ? pl(r.idea.side, r.state.qty ?? 0, r.state.entryPrice, r.mark) : 0), 0);
  const firstSpy = args.rows.map((r) => r.state).filter((s) => s.entryAt && s.spyEntry).sort((a, b) => a.entryAt!.localeCompare(b.entryAt!))[0]?.spyEntry ?? null;
  const excess = rets.map((r) => r.excess).filter((x): x is number => x !== null);
  const months = args.firstIdeaAt ? (args.now.getTime() - Date.parse(args.firstIdeaAt)) / (30.44 * 86400000) : 0;
  const verdictDue = closed.length >= SWING.verdictClosedIdeas || months >= SWING.verdictMonths;
  const sleeveReturn = (realized + unrealized) / SWING.sleeve;
  const spyReturn = firstSpy && args.spyNow ? args.spyNow / firstSpy - 1 : null;
  const avgExcess = excess.length ? excess.reduce((a, b) => a + b, 0) / excess.length : null;
  return {
    closed: closed.length,
    open: open.length,
    winRate: rets.length ? rets.filter((r) => r.ret > 0).length / rets.length : null,
    avgReturn: rets.length ? rets.reduce((a, r) => a + r.ret, 0) / rets.length : null,
    avgExcess,
    realizedPl: Math.round(realized * 100) / 100,
    unrealizedPl: Math.round(unrealized * 100) / 100,
    sleeveReturn,
    spyReturn,
    verdictDue,
    verdict: verdictDue ? ((avgExcess ?? -1) > 0 && spyReturn !== null && sleeveReturn > spyReturn ? "beats SPY" : "does not beat SPY") : null,
  };
}

/** Time-limit exit due? (calendar days after the entry fill) */
export const timeLimitDue = (idea: Idea, s: IdeaState, now: Date) =>
  idea.exitRule === "time" && s.status === "open" && !!s.entryAt && now.getTime() >= Date.parse(s.entryAt) + idea.exitParam * 86400000;
