import SetupNotice from "@/components/SetupNotice";
import { SWING } from "@/config/trader";
import { AlpacaClient, credsFromEnv, referenceHostFromEnv } from "@/lib/alpaca";
import * as store from "@/lib/db";
import { statesByIdea } from "@/lib/swing/engine";
import { ideaReturn, swingSummary } from "@/lib/swing/rules";
import * as ts from "@/lib/trader/store";
import { toEt } from "@/lib/time";
import IdeaForm from "./IdeaForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`);
const cls = (x: number | null | undefined) => (x === null || x === undefined ? "" : x >= 0 ? "pos" : "neg");
const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export default async function SwingPage() {
  if (!store.hasDatabase()) return <SetupNotice />;
  const [ideas, events] = await Promise.all([ts.allIdeas(), ts.allIdeaEvents()]);
  const states = statesByIdea(ideas, events);

  // Mark open ideas and SPY at the latest quote (best effort).
  const live = ideas.filter((i) => ["open", "closing"].includes(states.get(i.id)!.status));
  let marks: Record<string, number> = {};
  try {
    const alpaca = new AlpacaClient({ creds: credsFromEnv(), referenceHost: referenceHostFromEnv(), maxRetries: 1 });
    const feed = await alpaca.resolveFeed({ forced: process.env.ALPACA_FEED });
    const quotes = await alpaca.getLatestQuotes([...new Set([...live.map((i) => i.ticker), "SPY"])], feed);
    marks = Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, (q.bid + q.ask) / 2]));
  } catch {
    /* marks stay empty; realized results still show */
  }

  const rows = ideas.map((idea) => ({ idea, state: states.get(idea.id)!, mark: marks[idea.ticker] ?? null }));
  const summary = swingSummary({ rows, spyNow: marks.SPY ?? null, firstIdeaAt: ideas[0]?.createdAt ?? null, now: new Date() });
  const active = rows.filter((r) => ["pending_entry", "open", "closing"].includes(r.state.status));
  const used = active.reduce((a, r) => a + r.idea.notional, 0);
  const specUsed = active.filter((r) => r.idea.speculative).reduce((a, r) => a + r.idea.notional, 0);

  return (
    <>
      <h1>Swing ideas · paper</h1>
      <section className="card notice small">
        Your own ideas, written down with an exit rule before entry, scored against SPY. Paper sleeve {usd(SWING.sleeve)} on the Alpaca paper account; no position above{" "}
        {SWING.maxPositionFraction * 100}% ({usd(SWING.sleeve * SWING.maxPositionFraction)}), speculative ideas at most {SWING.maxSpeculativeFraction * 100}% in total. Ideas are
        locked once saved; exits follow the stated rule automatically. No margin, leverage, leveraged funds or options; QQQ is reserved for the day trader.
      </section>

      <section className="card">
        <h2>Sleeve</h2>
        <div className="grid">
          <div><div className="small secondary">In use</div><b>{usd(used)}</b> <span className="muted small">of {usd(SWING.sleeve)}</span></div>
          <div>
            <div className="small secondary">Sleeve P/L (realized + open)</div>
            <b className={cls(summary.sleeveReturn)}>{usd(summary.realizedPl + summary.unrealizedPl)}</b>{" "}
            <span className={`small ${cls(summary.sleeveReturn)}`}>{pct(summary.sleeveReturn)}</span>
          </div>
          <div><div className="small secondary">SPY over the same period</div><b className={cls(summary.spyReturn)}>{pct(summary.spyReturn)}</b></div>
          <div>
            <div className="small secondary">Closed ideas</div><b>{summary.closed}</b>{" "}
            <span className="muted small">win rate {summary.winRate === null ? "—" : `${Math.round(summary.winRate * 100)}%`}</span>
          </div>
          <div><div className="small secondary">Avg excess return vs SPY</div><b className={cls(summary.avgExcess)}>{pct(summary.avgExcess)}</b></div>
        </div>
        <p className="small secondary" style={{ marginBottom: 0 }}>
          Verdict after {SWING.verdictClosedIdeas} closed ideas or {SWING.verdictMonths} months:{" "}
          {summary.verdict ? <b className={summary.verdict === "beats SPY" ? "call-run" : "call-skip"}>{summary.verdict}</b> : "not yet"} (beats SPY = average excess return above
          zero <i>and</i> the sleeve ahead of SPY over the same period).
        </p>
      </section>

      <section className="card">
        <h2>New idea</h2>
        <IdeaForm maxPosition={SWING.sleeve * SWING.maxPositionFraction} specLeft={Math.max(0, SWING.sleeve * SWING.maxSpeculativeFraction - specUsed)} />
      </section>

      <section className="card">
        <h2>Ideas</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Saved</th><th>Idea</th><th>Exit rule</th><th>Status</th><th className="num">Entry</th><th className="num">Exit / mark</th>
                <th className="num">Return</th><th className="num">SPY</th><th className="num">Excess</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice().reverse().map(({ idea, state, mark }) => {
                const exit = state.exitPrice ?? mark;
                const r = state.entryPrice && exit ? ideaReturn(idea.side, state.entryPrice, exit, state.spyEntry, state.exitPrice ? state.spyExit : (marks.SPY ?? null)) : null;
                const rule = idea.exitRule === "target" ? `target $${idea.exitParam}` : idea.exitRule === "trailing" ? `trailing ${idea.exitParam}%` : `${idea.exitParam} days`;
                return (
                  <tr key={idea.id}>
                    <td>{idea.id}</td>
                    <td className="small">{toEt(new Date(idea.createdAt)).date}</td>
                    <td>
                      <b className={idea.side === "long" ? "call-run" : "call-skip"}>{idea.side}</b> <b>{idea.ticker}</b> {usd(idea.notional)}
                      {idea.speculative && <span className="tag">speculative</span>}
                      <span className="tag">{idea.catalyst.replace("_", " ")}</span>
                      <div className="small secondary">{idea.thesis}</div>
                    </td>
                    <td className="small">{rule}</td>
                    <td className={`small ${state.status === "failed" ? "call-error" : ""}`}>
                      {state.status === "closing" ? (idea.exitRule === "time" ? "closing (time limit)" : "open · exit order working") : state.status.replace("_", " ")}
                      {state.exitReason && state.status === "closed" ? ` (${state.exitReason})` : ""}
                      {state.error ? <div className="muted">{state.error}</div> : null}
                    </td>
                    <td className="num">{state.entryPrice ?? "—"}</td>
                    <td className="num">{exit ? exit.toFixed(2) : "—"}{!state.exitPrice && mark ? <div className="muted small">mark</div> : null}</td>
                    <td className={`num ${cls(r?.ret)}`}>{pct(r?.ret)}</td>
                    <td className="num">{pct(r?.spy)}</td>
                    <td className={`num ${cls(r?.excess)}`}>{pct(r?.excess)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={10} className="muted">No ideas yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
