import SetupNotice from "@/components/SetupNotice";
import * as store from "@/lib/db";
import Link from "next/link";
import { listBookVersions } from "@/lib/book-version";
import { loadBookEntries, LIVE_SINCE, syncedThrough } from "@/lib/book-entries";
import { buildLiveScore, MAX_P, MIN_ENTRIES } from "@/lib/live-scoring";
import { coinFlipBaseline, scoreDecisions, withTotals, type ScoredDecision } from "@/lib/scoring";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const signed = (x: number) => <span className={x > 0 ? "pos" : x < 0 ? "neg" : ""}>{usd(x)}</span>;

/** The old view: calls against uploaded Option Omega P/L. Kept apart from the live score and labelled "backtest". */
async function BacktestView() {
  const [all, outcomes, cfg] = await Promise.all([store.allDecisions(), store.allOutcomes(), store.loadSettings()]);
  // Legacy strategies (e.g. "2DTE", "VIX-up") are not bots in Settings any more: left out.
  const names = cfg.strategies.map((x) => x.name);
  const decisions = all.filter((d) => names.includes(d.strategy) || d.strategy === "*");
  const scored = decisions as ScoredDecision[];
  const rows = withTotals(scoreDecisions(scored, outcomes));
  const coin = coinFlipBaseline(scored, outcomes);
  const decidedDays = new Set(decisions.map((d) => d.date)).size;
  const outcomeDays = new Set(outcomes.map((o) => o.date)).size;

  return (
    <>
      <section className="card notice">
        <h2>Backtest view: uploaded Option Omega P/L</h2>
        <p className="small" style={{ marginBottom: 0 }}>
          P/L here comes from the CSVs uploaded on the Upload page (backtest or exported trade logs), not from Schwab fills, and is never mixed into the
          live score. Days are the uploaded trade dates.
        </p>
      </section>
      <section className="card">
        <h2>Export calls with P/L</h2>
        <form className="export" method="get" action="/api/export">
          <input type="hidden" name="type" value="calls" />
          <label>From<input type="date" name="from" /></label>
          <label>To<input type="date" name="to" /></label>
          <button type="submit">Download CSV</button>
          <span className="small muted">One row per day and strategy: both calls and reasons, the market read, 10:50 features, your P/L, and the P/L change if each call had been followed. Blank dates = all history.</span>
        </form>
      </section>
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

export default async function ScoringPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (!store.hasDatabase()) return <SetupNotice />;
  const view = (await searchParams).view === "backtest" ? "backtest" : "live";
  return (
    <>
      <h1>Scoring</h1>
      <p className="small">
        {view === "live" ? <b>Live: Schwab fills since {LIVE_SINCE}</b> : <Link href="/scoring">Live: Schwab fills since {LIVE_SINCE}</Link>}
        {" · "}
        {view === "backtest" ? <b>Backtest: uploaded Option Omega P/L</b> : <Link href="/scoring?view=backtest">Backtest: uploaded Option Omega P/L</Link>}
      </p>
      {view === "live" ? await LiveView() : await BacktestView()}
    </>
  );
}

async function LiveView() {
  const [calls, entries, cfg, versions, through] = await Promise.all([
    store.allDecisions(),
    loadBookEntries(),
    store.loadSettings(),
    listBookVersions().catch(() => []),
    syncedThrough(),
  ]);
  const names = cfg.strategies.map((x) => x.name);
  const versionNumber = (id: number | null) => (id === null ? 1 : (versions.find((v) => v.id === id)?.number ?? 1));
  const s = buildLiveScore({ calls, entries, names, versionNumber, syncedThrough: through });
  const callDays = new Set(calls.filter((c) => c.date >= LIVE_SINCE).map((c) => c.date)).size;
  const entryDays = new Set(entries.map((e) => e.entryDate)).size;

  return (
    <>
      <section className="card secondary small">
        <p style={{ marginTop: 0 }}>
          Each 10:50 call is matched to that bot&apos;s <b>Schwab fills on the same entry date</b>, filled at or after 10:50 ET; the day&apos;s P/L is their realized
          P/L once all are closed (a 2DTE entry that closes two days later still counts on its entry day). A bot that didn&apos;t enter is
          <b> n/a – no entry</b> and counts nowhere. LLM calls are scored per version; the rule baseline only on days it had its 60 days of ATR history.
        </p>
        <p style={{ marginBottom: 0 }}>
          {callDays} days with calls since {LIVE_SINCE} · {entries.length} fills on {entryDays} days · {s.scoredEntries} fills scored ·
          fills stored through {through ?? "— (first sync runs after the close)"}.
          Net is greyed out unless the coin-flip p ≤ {MAX_P} and at least {MIN_ENTRIES} fills are scored.
        </p>
      </section>

      <section className="card">
        <h2>Calls vs live P/L</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th><th>Bot</th><th className="num">Days</th>
                <th className="num">Skip</th><th className="num">Reduce</th><th className="num">Run</th>
                <th className="num">P/L skip days</th><th className="num">P/L reduce days</th><th className="num">P/L run days</th>
                <th className="num">Hit rate</th><th className="num">Base loss rate</th>
                <th className="num">Saved</th><th className="num">Forgone</th><th className="num">Net</th><th className="num">p (coin flip)</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => {
                const all = r.strategy === "ALL" ? s.all[r.source] : null;
                const coin = s.coin.find((c) => c.source === r.source && c.strategy === r.strategy);
                const p = all ? all.pValue : (coin?.skipDays ?? 0) + (coin?.reduceDays ?? 0) > 0 ? coin!.pValue : null;
                return (
                  <tr key={`${r.source}|${r.strategy}`} style={r.strategy === "ALL" ? { fontWeight: 600 } : undefined}>
                    <td>{r.source}</td><td>{r.strategy}</td><td className="num">{r.days}</td>
                    <td className="num">{r.skipDays}</td><td className="num">{r.reduceDays}</td><td className="num">{r.runDays}</td>
                    <td className="num">{signed(r.plSkipDays)}</td><td className="num">{signed(r.plReduceDays)}</td><td className="num">{signed(r.plRunDays)}</td>
                    <td className="num">{pct(r.hitRate)}</td><td className="num">{pct(r.baseLossRate)}</td>
                    <td className="num">{usd(r.saved)}</td><td className="num">{usd(r.forgone)}</td>
                    <td className="num">
                      {all && !all.reliable ? (
                        <span className="muted" title={`not yet evidence: p ${all.pValue === null ? "n/a" : all.pValue.toFixed(2)}, ${all.entries} fills (needs p ≤ ${MAX_P} and ≥ ${MIN_ENTRIES})`}>{usd(r.net)}</span>
                      ) : (
                        signed(r.net)
                      )}
                    </td>
                    <td className="num">{p === null ? "—" : p.toFixed(2)}{all ? <span className="muted small"> · {all.entries} fills</span> : null}</td>
                  </tr>
                );
              })}
              {s.rows.length === 0 && <tr><td colSpan={15} className="muted">Nothing scored yet: needs a 10:50 call and that bot&apos;s closed Schwab fills on the same day.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>p = share of 2,000 random placements of the same number of skip and reduce days with a net at least as good (lower is better). ALL pools every bot-day of that source.</p>
      </section>

      <section className="card">
        <h2>Call days without a score, by bot</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Bot</th><th className="num">Call days</th><th className="num">Scored</th><th>Not scored: why</th><th>Examples</th></tr></thead>
            <tbody>
              {s.diagnostics.map((d) => (
                <tr key={d.bot}>
                  <td>{d.bot}</td><td className="num">{d.callDays}</td><td className="num">{d.scoredDays}</td>
                  <td className="small">{Object.entries(d.reasons).map(([k, v]) => `${v} ${k}`).join(" · ") || "—"}</td>
                  <td className="small muted">{d.examples.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {s.unmapped.length > 0 && (
          <details>
            <summary className="small">{s.unmapped.length} fills matched no bot in Settings</summary>
            <ul className="small">{s.unmapped.slice(0, 50).map((u, i) => <li key={i}>{u.date} · {u.rawBot ?? "unattributed"}: {u.note}</li>)}</ul>
          </details>
        )}
      </section>
    </>
  );
}
