import Link from "next/link";
import SetupNotice from "@/components/SetupNotice";
import { TRADER } from "@/config/trader";
import * as store from "@/lib/db";
import { versionReport } from "@/lib/trader/report";
import type { Stats } from "@/lib/trader/scoring";
import * as ts from "@/lib/trader/store";
import { toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const usd = (x: number | null) => (x === null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
const signed = (x: number | null) => <span className={x === null ? "" : x > 0 ? "pos" : x < 0 ? "neg" : ""}>{usd(x)}</span>;

function StatsRow({ label, s, note }: { label: string; s: Stats; note?: string }) {
  return (
    <tr>
      <td>{label}{note && <div className="muted small">{note}</div>}</td>
      <td className="num">{s.n}</td><td className="num">{pct(s.winRate)}</td>
      <td className="num">{usd(s.avgWin)}</td><td className="num">{usd(s.avgLoss)}</td>
      <td className="num">{signed(s.expectancy)}</td><td className="num">{signed(s.total)}</td><td className="num">{usd(s.maxDrawdown)}</td>
    </tr>
  );
}

const STATS_HEAD = (
  <tr><th /><th className="num">N</th><th className="num">Win rate</th><th className="num">Avg win</th><th className="num">Avg loss</th><th className="num">Expectancy</th><th className="num">Total</th><th className="num">Max DD</th></tr>
);

export default async function TraderScoring({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  if (!store.hasDatabase()) return <SetupNotice />;
  const versions = await ts.listVersions();
  if (!versions.length) return (<><h1>AI trader scoring</h1><section className="card muted">No versions yet: the first trader tick creates one.</section></>);
  const sp = await searchParams;
  const version = versions.find((v) => String(v.id) === sp.v) ?? versions[versions.length - 1];
  const r = await versionReport(version);
  const flagged = r.days.filter((d) => d.newsDown);

  return (
    <>
      <h1>AI trader scoring · v{version.id}</h1>
      <form className="inline" method="get" style={{ marginBottom: 12 }}>
        <label className="small secondary">Version{" "}
          <select name="v" defaultValue={String(version.id)}>
            {versions.map((v) => <option key={v.id} value={v.id}>v{v.id} · {v.model} · {v.effort} · from {toEt(new Date(v.createdAt)).date}</option>)}
          </select>
        </label>
        <button type="submit">Show</button>
        <Link href="/trader" className="small">← Day trader</Link>
      </form>

      <section className={`card ${r.verdict?.verdict === "fail" ? "errorbox" : "notice"}`}>
        <h2>
          Decision gate: {r.verdict ? r.verdict.verdict.toUpperCase() : r.gate.ready ? (r.gate.verdict ?? "").toUpperCase() : "not yet"}
        </h2>
        <p className="small secondary">
          Decided after {TRADER.gateMinTrades} trades <b>and</b> {TRADER.gateMinTradingDays} trading days (whichever comes later): now {r.trades.length} trades over {r.days.length} days.
          Pass only if all three hold; otherwise Fail, and this version stops trading but keeps its record.
        </p>
        <ul>
          {r.gate.checks.map((c) => (
            <li key={c.label}><span className={c.ok === null ? "muted" : c.ok ? "call-run" : "call-skip"}>{c.ok === null ? "…" : c.ok ? "✓" : "✕"}</span> {c.label} <span className="muted small">({c.detail})</span></li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Results (closed trades; net = after ${TRADER.slippagePerShare.toFixed(2)}/share slippage each way)</h2>
        <div className="table-wrap"><table>
          <thead>{STATS_HEAD}</thead>
          <tbody>
            <StatsRow label="AI trader, gross" s={r.gross} />
            <StatsRow label="AI trader, net" s={r.net} />
            <StatsRow label="Buy and hold QQQ, net" s={r.buyHold.net} note={`open→close each of the ${r.buyHold.days} days the version ran, same $${TRADER.notional.toLocaleString()} notional`} />
            <StatsRow label={`${TRADER.hypotheticalMultiple}× hypothetical, net`} s={r.hypothetical3x.net} note="CALCULATION ONLY: the same trades × 3, to show what TQQQ/SQQQ would have amplified. Not traded." />
          </tbody>
        </table></div>
      </section>

      <section className="card">
        <h2>Random-entry baseline</h2>
        <p className="small">
          {TRADER.randomSimsPerTrade} simulated trades per real trade ({r.random.sims} total), same day, random entry time ({TRADER.firstEntry}–{TRADER.lastEntry}) and random direction, with
          that trade’s stop distance, target distance and time limit, on the recorded 1-minute bars, net of slippage.
        </p>
        <p>
          Real net expectancy {signed(r.net.expectancy)} sits at the <b>{r.random.percentile === null ? "—" : `${(r.random.percentile * 100).toFixed(1)}th`}</b> percentile
          of random histories (random mean {usd(r.random.mean)}, 95th percentile {usd(r.random.p95)}).
        </p>
      </section>

      <section className="card">
        <h2>Breakdowns (net)</h2>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
          {Object.entries(r.breakdowns).map(([name, rows]) => (
            <div key={name} className="table-wrap">
              <h3 className="small secondary" style={{ margin: "0 0 4px" }}>{name}</h3>
              <table>
                <thead><tr><th /><th className="num">N</th><th className="num">Win</th><th className="num">Exp.</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {rows.map((b) => <tr key={b.key}><td>{b.key}</td><td className="num">{b.net.n}</td><td className="num">{pct(b.net.winRate)}</td><td className="num">{signed(b.net.expectancy)}</td><td className="num">{signed(b.net.total)}</td></tr>)}
                  {rows.length === 0 && <tr><td colSpan={5} className="muted">—</td></tr>}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>LLM cost</h2>
        <p>Total {usd(r.cost.total)} · per day {usd(r.cost.perDay)} · per trade {usd(r.cost.perTrade)} <span className="muted small">(approximate, from token usage at list prices)</span></p>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th className="num">Calls</th><th className="num">Cost</th></tr></thead>
          <tbody>{r.cost.byDay.slice(-30).reverse().map((d) => <tr key={d.date}><td>{d.date}</td><td className="num">{d.calls}</td><td className="num">{usd(d.cost)}</td></tr>)}</tbody>
        </table></div>
      </section>

      <section className="card">
        <h2>Trades</h2>
        {flagged.length > 0 && <p className="call-reduce small">News feed was down on: {flagged.map((d) => d.date).join(", ")}</p>}
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Side</th><th className="num">Qty</th><th className="num">Entry</th><th className="num">Exit</th><th>Exit</th><th className="num">Conf.</th><th>Catalyst</th><th className="num">Net</th></tr></thead>
          <tbody>
            {r.trades.slice().reverse().map((t) => {
              const net = (t.side === "long" ? 1 : -1) * (t.exitPrice - t.entryPrice) * t.qty - 2 * TRADER.slippagePerShare * t.qty;
              return <tr key={t.id}><td>{t.date}</td><td>{t.side}</td><td className="num">{t.qty}</td><td className="num">{t.entryPrice}</td><td className="num">{t.exitPrice}</td><td>{t.exitReason}</td><td className="num">{t.confidence}</td><td>{t.catalyst}</td><td className="num">{signed(Math.round(net * 100) / 100)}</td></tr>;
            })}
            {r.trades.length === 0 && <tr><td colSpan={9} className="muted">No closed trades yet.</td></tr>}
          </tbody>
        </table></div>
      </section>
    </>
  );
}
