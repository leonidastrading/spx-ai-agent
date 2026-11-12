import Link from "next/link";
import SetupNotice from "@/components/SetupNotice";
import { DAY_TYPE_RULES, ENTRY } from "@/config/entry";
import * as store from "@/lib/db";
import { entryReport } from "@/lib/entry/report";
import type { BookStats, Bucket } from "@/lib/entry/scoring";
import * as es from "@/lib/entry/store";
import { toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const usd = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const signed = (x: number | null | undefined) => <span className={x == null ? "" : x > 0 ? "pos" : x < 0 ? "neg" : ""}>{usd(x)}</span>;
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

function BookRow({ label, s, note }: { label: string; s: BookStats | null; note?: string }) {
  return (
    <tr>
      <td>{label}{note && <div className="muted small">{note}</div>}</td>
      <td className="num">{s?.trades ?? "—"}</td><td className="num">{signed(s?.total)}</td><td className="num">{usd(s?.maxDrawdown)}</td>
      <td className="num">{s?.worstDay ? <>{signed(s.worstDay.pl)} <span className="muted small">{s.worstDay.date}</span></> : "—"}</td>
    </tr>
  );
}

function Buckets({ title, rows }: { title: string; rows: Bucket[] }) {
  return (
    <div className="table-wrap">
      <h3 className="small secondary" style={{ margin: "0 0 4px" }}>{title}</h3>
      <table>
        <thead><tr><th /><th className="num">N</th><th className="num">Avg actual P/L</th><th className="num">Total</th></tr></thead>
        <tbody>
          {rows.map((b) => <tr key={b.key}><td>{b.key}</td><td className="num">{b.n}</td><td className="num">{signed(b.avgPl)}</td><td className="num">{signed(b.totalPl)}</td></tr>)}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">—</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default async function EntryScoring({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  if (!store.hasDatabase()) return <SetupNotice />;
  const versions = await es.listEntryVersions();
  if (!versions.length) return (<><h1>Entry advisor scoring</h1><section className="card muted">No versions yet: the first entry-advisor tick creates one.</section></>);
  const sp = await searchParams;
  const version = versions.find((v) => String(v.id) === sp.v) ?? versions[versions.length - 1];
  const all = await Promise.all(versions.map((v) => (v.id === version.id ? null : entryReport(v))));
  const r = await entryReport(version);
  const reports = versions.map((v, i) => all[i] ?? r);
  const take = r.byVerdict.find((b) => b.key === "take");
  const skip = r.byVerdict.find((b) => b.key === "skip");

  return (
    <>
      <h1>Entry advisor scoring · v{version.id}</h1>
      <form className="inline" method="get" style={{ marginBottom: 12 }}>
        <label className="small secondary">Version{" "}
          <select name="v" defaultValue={String(version.id)}>
            {versions.map((v) => <option key={v.id} value={v.id}>v{v.id} · {v.model} · {v.effort} · from {toEt(new Date(v.createdAt)).date}</option>)}
          </select>
        </label>
        <button type="submit">Show</button>
        <Link href="/entries" className="small">← Entry advisor</Link>
      </form>

      <section className="card">
        <h2>Versions, reported separately</h2>
        <p className="small secondary">Each version is a frozen model, prompt, packet and matching rules; results never mix. v2 adds bot matching by live fills, trimmed (not dropped) over-long replies, and account drawdown from Schwab net liquidation value.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Version</th><th>From</th><th className="num">Logged</th><th className="num">Scored</th><th className="num">No opinion</th><th className="num">Errors</th><th className="num">Trimmed</th><th className="num">As run</th><th className="num">As advised</th><th className="num">Advised − run</th></tr></thead>
          <tbody>
            {reports.map((x) => (
              <tr key={x.version.id} className={x.version.id === version.id ? "today" : ""}>
                <td><Link href={`?v=${x.version.id}`}>v{x.version.id}</Link> <span className="muted small">{x.version.model} · {x.version.effort}</span></td>
                <td>{toEt(new Date(x.version.createdAt)).date}</td>
                <td className="num">{x.counts.logged}</td><td className="num">{x.scored.length}</td><td className="num">{x.counts.noOpinion}</td>
                <td className="num">{x.counts.error}{x.counts.lengthErrors ? <span className="muted small"> ({x.counts.lengthErrors} length)</span> : null}</td>
                <td className="num">{x.counts.trimmed}</td>
                <td className="num">{signed(x.run.total)}</td><td className="num">{signed(x.advised.total)}</td><td className="num">{signed(x.advised.total - x.run.total)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <section className={`card ${r.verdict?.verdict === "fail" ? "errorbox" : "notice"}`}>
        <h2>Decision gate: {r.verdict ? r.verdict.verdict.toUpperCase() : r.gate.ready ? (r.gate.verdict ?? "").toUpperCase() : "not yet"}</h2>
        <p className="small secondary">
          After {ENTRY.gateMinEntries} scored entries <b>and</b> {ENTRY.gateMinTradingDays} trading days: now {r.scored.length} over {r.tradingDays} days. Pass only if all three hold; otherwise Fail and the calls stop.
          A pass switches nothing on: it is evidence for acting on the calls by hand, at reduced size first.
        </p>
        <ul>{r.gate.checks.map((c) => <li key={c.label}><span className={c.ok === null ? "muted" : c.ok ? "call-run" : "call-skip"}>{c.ok === null ? "…" : c.ok ? "✓" : "✕"}</span> {c.label} <span className="muted small">({c.detail})</span></li>)}</ul>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Logged {r.counts.logged} · scored {r.scored.length} · awaiting outcome {r.counts.awaitingOutcome} · no opinion {r.counts.noOpinion} (bot match below {ENTRY.matchMinConfidence}: {r.counts.lowMatch}) · late {r.counts.late} · errors {r.counts.error}
          {r.counts.lengthErrors ? ` (${r.counts.lengthErrors} dropped for length)` : ""}.
          Trimmed to the {ENTRY.maxReasonWords}-word limit and kept: {r.counts.trimmed} of {r.counts.logged} ({r.counts.logged ? ((r.counts.trimmed / r.counts.logged) * 100).toFixed(0) : 0}%).
          Bot named by live fills (not the structure rules): {r.counts.matchedByLiveFills}.
          Only on-time calls with data_ok and a complete packet are scored.
        </p>
      </section>

      <section className="card">
        <h2>Book as run vs as advised</h2>
        <div className="table-wrap"><table>
          <thead><tr><th /><th className="num">Trades</th><th className="num">Total P/L</th><th className="num">Max DD</th><th className="num">Worst day</th></tr></thead>
          <tbody>
            <BookRow label="Book as run" s={r.run} />
            <BookRow label="Book as advised" s={r.advised} note={`take 100% · reduce ${ENTRY.reduceFraction * 100}% · skip 0%`} />
            <BookRow label={`Simple rule: reduce all when VIX up > ${ENTRY.ruleVixUpPct}% on the day`} s={r.rule} />
            <BookRow label="Morning AI call (10:50 run/reduce/skip)" s={r.morning} note="applies to entries after the call was made" />
            <BookRow label="Your pre-open call" s={r.human.stats} note={`${r.human.days} days with a call; scored on those days only`} />
          </tbody>
        </table></div>
        <p>
          <b>Saved</b> (losses avoided by skip/reduce) {signed(r.savedMissed.saved)} · <b>Missed</b> (winners given up) {signed(-r.savedMissed.missed)} · net {signed(r.savedMissed.net)}
        </p>
        <p>
          <b>Random-skip baseline</b> ({ENTRY.randomPermutations} reshuffles of the same verdicts within each bot): the advised book sits at the{" "}
          <b>{r.random.percentile === null ? "—" : `${(r.random.percentile * 100).toFixed(1)}th`}</b> percentile (random mean {usd(r.random.mean)}, 95th percentile {usd(r.random.p95)}).
        </p>
      </section>

      <section className="card">
        <h2>Reduce / skip calls by what drove them</h2>
        <p className="small secondary">
          Each reduce or skip is filed under the category of the reason that decided it (v2: the model’s “primary_category”; v1: its first reason, which it wasn’t told to put first). If cuts based on the bot’s own recent losses don’t avoid more losers than cuts based on price, vol or news, the recent-record reasoning adds nothing.
          Reference: take calls average {signed(r.takeAvgPl)} actual P/L.
        </p>
        <div className="table-wrap"><table>
          <thead><tr><th>Leading reason</th><th className="num">Calls</th><th className="num">Reduce</th><th className="num">Skip</th><th className="num">Avg actual P/L</th><th className="num">Saved</th><th className="num">Missed</th><th className="num">Net</th></tr></thead>
          <tbody>
            {r.byDriver.map((d) => (
              <tr key={d.key}>
                <td>{d.label}</td><td className="num">{d.n}</td><td className="num">{d.reduce}</td><td className="num">{d.skip}</td>
                <td className="num">{signed(d.avgPl)}</td><td className="num">{signed(d.saved)}</td><td className="num">{signed(-d.missed)}</td><td className="num">{signed(d.net)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <section className="card">
        <h2>Where the skill would show</h2>
        <p className="small">
          If the <b>skip</b> bucket’s average actual P/L isn’t clearly worse than the <b>take</b> bucket’s, the advisor has no skill. Now: take {signed(take?.avgPl ?? null)} ({take?.n ?? 0}) vs skip {signed(skip?.avgPl ?? null)} ({skip?.n ?? 0}).
        </p>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
          <Buckets title="By verdict" rows={r.byVerdict} />
          <Buckets title="By confidence" rows={r.byConfidence} />
          <Buckets title="By bot" rows={r.byBot} />
          <Buckets title="By time of day (ET)" rows={r.byHour} />
          <Buckets title="By reason category" rows={r.byReason} />
        </div>
      </section>

      <section className="card">
        <h2>Day-type accuracy</h2>
        <p>{pct(r.dayTypes.accuracy)} of {r.dayTypes.n} calls · {pct(r.dayTypes.accuracyWithoutUnclear)} of {r.dayTypes.nWithoutUnclear} excluding “unclear”.</p>
        <details>
          <summary className="secondary small">Fixed definitions (SPY 1-min bars, VIX closes; first match wins)</summary>
          <ol className="small">
            <li>vol expansion: VIX close ≥ {DAY_TYPE_RULES.volVixUpPct}% above the prior close and range ≥ {DAY_TYPE_RULES.volRangePct}% of the open</li>
            <li>trend up: close ≥ {DAY_TYPE_RULES.trendPct}% above the open, in the top {DAY_TYPE_RULES.trendCloseQuartile * 100}% of the range</li>
            <li>trend down: close ≥ {DAY_TYPE_RULES.trendPct}% below the open, in the bottom {DAY_TYPE_RULES.trendCloseQuartile * 100}% of the range</li>
            <li>reversal: open→{DAY_TYPE_RULES.reversalCheckpoint} move ≥ {DAY_TYPE_RULES.reversalMorningPct}% and the close on the other side of the open</li>
            <li>range: everything else (“unclear” is never correct)</li>
          </ol>
        </details>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Actual</th><th>Called (per entry)</th></tr></thead>
          <tbody>{r.dayTypes.rows.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.actual ?? <span className="muted">incomplete</span>}</td><td className="small">{d.said.join(", ")}</td></tr>)}</tbody>
        </table></div>
      </section>

      <section className="card">
        <h2>Cost and speed</h2>
        <p>LLM cost ${r.cost.total.toFixed(2)} total ·{r.cost.perDay === null ? "—" : `$${r.cost.perDay.toFixed(2)}`} per day · average latency from Schwab fill to logged call {r.cost.avgLatencySec ?? "—"}s · {pct(r.cost.slowShare)} over {ENTRY.targetLatencySeconds}s.</p>
      </section>
    </>
  );
}
