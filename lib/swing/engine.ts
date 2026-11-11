/** Swing ideas (Part B): entries, automatic exits and fill tracking on the Alpaca paper account. */

import type { Feed } from "../alpaca";
import type { Broker, DataClient } from "../trader/engine";
import * as ts from "../trader/store";
import { hhmmToMinutes, toEt, type Session } from "../time";
import { ideaInputSchema, ideaState, sleeveProblems, timeLimitDue, type Idea, type IdeaEvent, type IdeaState } from "./rules";

const FINAL_BAD = new Set(["canceled", "expired", "rejected", "suspended"]);

/** SPY price at (or just before) a timestamp, from 1-min bars; null if none found. */
async function spyAt(data: DataClient, feed: Feed, at: string): Promise<number | null> {
  const t = Date.parse(at);
  const bars = await data.getBars({ symbols: ["SPY"], start: new Date(t - 3 * 86400000), end: new Date(t + 60000), feed });
  const before = bars.filter((b) => Date.parse(b.ts) <= t);
  return before.length ? before[before.length - 1].c : null;
}

export function statesByIdea(ideas: Idea[], events: IdeaEvent[]): Map<number, IdeaState> {
  return new Map(ideas.map((i) => [i.id, ideaState(events.filter((e) => e.ideaId === i.id))]));
}

/** Validate and save a new idea, then send its entry order. Entries are locked once saved. */
export async function submitIdea(raw: unknown, deps: { data: DataClient; broker: () => Broker; feed: Feed }): Promise<{ ok: true; idea: Idea } | { ok: false; errors: string[] }> {
  const parsed = ideaInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const input = parsed.data;

  const asset = await deps.broker().getAsset(input.ticker).catch(() => null);
  if (!asset || asset.class !== "us_equity" || !asset.tradable) return { ok: false, errors: [`${input.ticker} is not a tradable US stock/ETF on Alpaca`] };
  if (input.side === "short" && !(asset.shortable && asset.easy_to_borrow)) return { ok: false, errors: [`${input.ticker} is not easy to borrow for a short`] };

  const q = (await deps.data.getLatestQuotes([input.ticker], deps.feed))[input.ticker];
  const ref = q && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q?.ask || q?.bid || 0;
  if (!ref) return { ok: false, errors: [`no current quote for ${input.ticker}`] };

  const [ideas, events] = await Promise.all([ts.allIdeas(), ts.allIdeaEvents()]);
  const states = statesByIdea(ideas, events);
  const active = ideas.filter((i) => ["pending_entry", "open", "closing"].includes(states.get(i.id)!.status));
  const problems = sleeveProblems(input, active, ref);
  if (problems.length) return { ok: false, errors: problems };
  // The sleeve's account should only hold what this log opened.
  if (!active.some((i) => i.ticker === input.ticker)) {
    const pos = await deps.broker().getPosition(input.ticker);
    if (pos && Number(pos.qty) !== 0) return { ok: false, errors: [`the swing paper account already holds ${pos.qty} ${input.ticker} that this log didn't open`] };
  } else {
    return { ok: false, errors: [`${input.ticker} already has a live idea; one idea per ticker at a time`] };
  }

  const idea = await ts.addIdea(input, Math.round(ref * 100) / 100);
  const qty = Math.floor(input.notional / ref);
  try {
    const o = await deps.broker().submitMarket({ symbol: idea.ticker, side: idea.side === "long" ? "buy" : "sell", qty, clientOrderId: `swing-${idea.id}-entry` });
    await ts.addIdeaEvent({ ideaId: idea.id, kind: "entry_submitted", orderId: o.id, price: null, qty, spyPrice: null, detail: null });
  } catch (err) {
    await ts.addIdeaEvent({ ideaId: idea.id, kind: "entry_failed", orderId: null, price: null, qty: null, spyPrice: null, detail: err instanceof Error ? err.message : String(err) });
  }
  return { ok: true, idea };
}

/** Exit order for the stated rule (target / trailing stop); time limits are handled in syncSwing. */
async function placeRuleExit(idea: Idea, qty: number, broker: Broker, suffix: string) {
  const side = idea.side === "long" ? "sell" : "buy";
  const clientOrderId = `swing-${idea.id}-exit${suffix}`;
  if (idea.exitRule === "target") return broker.submitExit({ symbol: idea.ticker, side, qty, clientOrderId, limit: idea.exitParam });
  if (idea.exitRule === "trailing") return broker.submitExit({ symbol: idea.ticker, side, qty, clientOrderId, trailPercent: idea.exitParam });
  return null;
}

/** Sync entries and exits for all live ideas. Runs on each trader tick. */
export async function syncSwing(now: Date, session: Session, deps: { data: DataClient; broker: () => Broker }, feed: Feed, notes: string[]) {
  const [ideas, events] = await Promise.all([ts.allIdeas(), ts.allIdeaEvents()]);
  const states = statesByIdea(ideas, events);
  const m = toEt(now).minutes;
  const marketOpen = toEt(now).date === session.date && m >= hhmmToMinutes(session.open) && m < hhmmToMinutes(session.close) - 5;
  const broker = deps.broker;

  for (const idea of ideas) {
    const s = states.get(idea.id)!;
    const ev = (e: Omit<IdeaEvent, "ideaId" | "at"> & { at?: string }) => ts.addIdeaEvent({ ideaId: idea.id, ...e });

    if (s.status === "pending_entry" && s.entryOrderId) {
      const o = await broker().getOrder(s.entryOrderId);
      if (o.status === "filled") {
        const qty = Math.round(Number(o.filled_qty));
        await ev({ kind: "entry_filled", orderId: o.id, price: Number(o.filled_avg_price), qty, spyPrice: await spyAt(deps.data, feed, o.filled_at!), at: o.filled_at!, detail: null });
        const x = await placeRuleExit(idea, qty, broker(), "");
        if (x) await ev({ kind: "exit_submitted", orderId: x.id, price: null, qty, spyPrice: null, detail: idea.exitRule });
        notes.push(`swing #${idea.id} entered`);
      } else if (FINAL_BAD.has(o.status)) {
        await ev({ kind: "entry_failed", orderId: o.id, price: null, qty: null, spyPrice: null, detail: `entry ${o.status}` });
      }
      continue;
    }

    if ((s.status === "open" || s.status === "closing") && s.exitOrderId) {
      const o = await broker().getOrder(s.exitOrderId);
      if (o.status === "filled") {
        await ev({ kind: "exit_filled", orderId: o.id, price: Number(o.filled_avg_price), qty: Math.round(Number(o.filled_qty)), spyPrice: await spyAt(deps.data, feed, o.filled_at!), at: o.filled_at!, detail: s.exitReason });
        notes.push(`swing #${idea.id} exited`);
        continue;
      }
      if (FINAL_BAD.has(o.status) && s.status === "closing" && idea.exitRule !== "time") {
        // GTC exit orders can expire (Alpaca cancels GTC after ~90 days): re-place the same rule.
        await ev({ kind: "exit_failed", orderId: o.id, price: null, qty: null, spyPrice: null, detail: `exit order ${o.status}; re-placed` });
        const x = await placeRuleExit(idea, s.qty!, broker(), `-${Date.now() % 1e6}`);
        if (x) await ev({ kind: "exit_submitted", orderId: x.id, price: null, qty: s.qty, spyPrice: null, detail: idea.exitRule });
        continue;
      }
    }

    if (marketOpen && timeLimitDue(idea, s, now) && !s.exitOrderId) {
      const o = await broker().submitMarket({ symbol: idea.ticker, side: idea.side === "long" ? "sell" : "buy", qty: s.qty!, clientOrderId: `swing-${idea.id}-exit-time` });
      await ev({ kind: "exit_submitted", orderId: o.id, price: null, qty: s.qty, spyPrice: null, detail: "time" });
      notes.push(`swing #${idea.id} time exit`);
    }
  }
}
