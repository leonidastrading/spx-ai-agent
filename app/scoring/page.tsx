import * as store from "@/lib/db";
import { coinFlipBaseline, scoreDecisions, withTotals, type ScoredDecision } from "@/lib/scoring";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const signed = (x: number) => <span className={x > 0 ? "pos" : x < 0 ? "neg" : ""}>{usd(x)}</span>;

export default async function ScoringPage() {
  const [decisions, outcomes] = await Promise.all([store.allDecisions(), store.allOutcomes()]);
  const scored = decisions as ScoredDecision[];
  const rows = withTotals(scoreDecisions(scored, outcomes));
  const coin = coinFlipBaseline(scored, outcomes);
  const decidedDays = new Set(decisions.map((d) => d.date)).size;
  const outcomeDays = new Set(outcomes.map((o) => o.date)).size;

  return (
    <>
      <h1>Scoring</h1>
      <section className="card secondary small">
        <p style={{ marginTop: 0 }}>
          {decidedDays} days with calls, {outcomeDays} days with uploaded P/L. A day counts for a strategy only if it has both a call and P/L.
          If the calls had been followed: <b>skip</b> = no trade, <b>reduce</b> = half size, <b>run</b> = unchanged.
          <b> Saved</b> = losses avoided, <b>forgone</b> = profits given up, <b>net</b> = saved − forgone (positive means the calls helped).
          <b> Hit</b> = skip/reduce on a day the strategy lost; compare the hit rate with the base loss rate (what a random pick gets).
        </p>
        <p style={{ marginBottom: 0 }}>
          Decide on the agent getting a say in the real book only from net vs the coin-flip baseline below, over a meaningful sample.
        </p>
      </section>

      <section className="card">
        <h2>Calls vs actual P/L</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th><th>Strategy</th><th className="num">Days</th>
                <th className="num">Skip</th><th className="num">Reduce</th><th className="num">Run</th>
                <th className="num">P/L skip days</th><th className="num">P/L reduce days</th><th className="num">P/L run days</th>
                <th className="num">Hit rate</th><th className="num">Base loss rate</th>
                <th className="num">Saved</th><th className="num">Forgone</th><th className="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.source}|${r.strategy}`} style={r.strategy === "ALL" ? { fontWeight: 600 } : undefined}>
                  <td>{r.source}</td><td>{r.strategy}</td><td className="num">{r.days}</td>
                  <td className="num">{r.skipDays}</td><td className="num">{r.reduceDays}</td><td className="num">{r.runDays}</td>
                  <td className="num">{signed(r.plSkipDays)}</td><td className="num">{signed(r.plReduceDays)}</td><td className="num">{signed(r.plRunDays)}</td>
                  <td className="num">{pct(r.hitRate)}</td><td className="num">{pct(r.baseLossRate)}</td>
                  <td className="num">{usd(r.saved)}</td><td className="num">{usd(r.forgone)}</td><td className="num">{signed(r.net)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={14} className="muted">Nothing to score yet: needs both calls and uploaded P/L for the same days.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Coin-flip baseline (same number of skip and reduce days, placed at random; 2,000 draws)</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Matched to</th><th>Strategy</th><th className="num">Days</th><th className="num">Skip</th><th className="num">Reduce</th>
                <th className="num">Random hit rate</th><th className="num">Random net (mean)</th><th className="num">5th–95th pct</th>
                <th className="num">Actual net</th><th className="num">p (random ≥ actual)</th>
              </tr>
            </thead>
            <tbody>
              {coin.map((c) => (
                <tr key={`${c.source}|${c.strategy}`}>
                  <td>{c.source}</td><td>{c.strategy}</td><td className="num">{c.days}</td>
                  <td className="num">{c.skipDays}</td><td className="num">{c.reduceDays}</td>
                  <td className="num">{pct(c.meanHitRate)}</td><td className="num">{signed(c.meanNet)}</td>
                  <td className="num">{usd(c.p5Net)} – {usd(c.p95Net)}</td>
                  <td className="num">{signed(c.actualNet)}</td><td className="num">{c.pValue.toFixed(2)}</td>
                </tr>
              ))}
              {coin.length === 0 && <tr><td colSpan={10} className="muted">—</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
