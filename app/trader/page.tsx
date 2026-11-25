import Link from "next/link";
import PaperAccount from "@/components/PaperAccount";
import SetupNotice from "@/components/SetupNotice";
import { TRADER } from "@/config/trader";
import * as store from "@/lib/db";
import { dailyResults } from "@/lib/trader/daily";
import { versionHash } from "@/lib/trader/prompt";
import * as ts from "@/lib/trader/store";
import { toEt } from "@/lib/time";
import { EconEditor, TraderControls } from "./Controls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const hhmm = (iso: string | null) => (iso ? toEt(new Date(iso)).hhmm : "—");
const money = (x: number | null) => (x === null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`);
const plCls = (x: number | null) => (x === null || x === 0 ? "" : x > 0 ? "pos" : "neg");

export default async function TraderPage() {
  if (!store.hasDatabase()) return <SetupNotice />;
  const today = toEt(new Date()).date;
  const cfg = await ts.loadTraderSettings();
  const model = cfg.model.trim() || TRADER.defaultModel;
  const versions = await ts.listVersions();
  const current = versions.find((v) => v.hash === versionHash(model, cfg.effort)) ?? null;
  const [trades, decisions, alerts, hb, econ, verdict, everyTrade, costs] = await Promise.all([
    ts.tradesForDate(today),
    current ? ts.recentDecisions(120, current.id) : Promise.resolve([]),
    ts.recentAlerts(10),
    ts.lastHeartbeat(),
    ts.econUpcoming(today),
    current ? ts.verdictFor(current.id) : Promise.resolve(null),
    ts.allTrades(),
    ts.costByDayAllVersions(),
  ]);
  const history = dailyResults(everyTrade, costs);
  const vNum = new Map(versions.map((v) => [v.id, v.number]));
  const vLabel = (ids: number[]) => ids.map((id) => `v${vNum.get(id) ?? "?"}`).join(", ");
  const todays = decisions.filter((d) => d.slot.startsWith(today));
  const open = trades.find((t) => ["submitting", "pending", "open", "closing"].includes(t.status));
  const hbAge = hb ? Math.round((Date.now() - Date.parse(hb.ts)) / 60000) : null;
  const costToday = todays.reduce((a, d) => a + (d.cost_usd ?? 0), 0);

  return (
    <>
      <h1>AI day-trader · paper test</h1>
      <section className="card notice small">
        <b>Paper only.</b> Orders go to the Alpaca <b>paper</b> account (paper-api.alpaca.markets) and nowhere else: QQQ shares, ${TRADER.riskPerTrade} risk per trade (up to ${TRADER.maxNotional.toLocaleString()}), one position,
        at most {TRADER.maxTradesPerDay} trades a day, entries {TRADER.firstEntry}–{TRADER.lastEntry} ET, flat by {TRADER.flatBy}. The question is a yes/no on forward results; nothing here is back-tested.
        {" "}<Link href="/trader/scoring">Scoring and decision gate →</Link>
        <PaperAccount part="trader" />
      </section>

      {verdict && (
        <section className={`card ${verdict.verdict === "fail" ? "errorbox" : "notice"}`}>
          <h2>Decision gate: {verdict.verdict.toUpperCase()}</h2>
          <p className="small">{verdict.verdict === "fail" ? "This version no longer trades. Its record is kept." : "Passed."} Decided {verdict.decidedAt.slice(0, 10)}.</p>
        </section>
      )}

      <section className="card">
        <h2>Version {current ? `v${current.number}` : "(created on the next tick)"}: {model}, effort {cfg.effort}</h2>
        <p className="small secondary">
          The model, prompt, reply schema and rules are frozen per version ({current ? <code>{current.hash.slice(0, 12)}</code> : "hash pending"}). Any change starts a new version, scored separately.
          Don’t tune the prompt on results of the version being scored.
        </p>
        <TraderControls enabled={cfg.enabled} model={cfg.model} effort={cfg.effort} defaultModel={TRADER.defaultModel} />
        <p className="small secondary" style={{ marginBottom: 0 }}>
          Last heartbeat: {hb ? `${toEt(new Date(hb.ts)).date} ${hhmm(hb.ts)} ET (${hbAge} min ago, ${hb.status})` : "none yet"} · LLM cost today ${costToday.toFixed(2)}
        </p>
      </section>

      {alerts.length > 0 && (
        <section className="card">
          <h2>Alerts</h2>
          <ul className="headlines">
            {alerts.map((a) => <li key={a.id}><time>{a.ts ? toEt(new Date(a.ts)).date : ""} {hhmm(a.ts)}</time><b>{a.kind}</b> — {a.message}{a.emailed ? " (emailed)" : ""}</li>)}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Today ({today})</h2>
        {open ? (
          <p>
            <b className={open.side === "long" ? "call-run" : "call-skip"}>{open.side.toUpperCase()}</b> {open.qty} QQQ · entry {open.entryPrice ?? "pending"} at {hhmm(open.entryAt)} ·
            stop {open.stop}{open.stop !== open.stopInitial && <span className="muted"> (was {open.stopInitial})</span>} · target {open.target} · max hold {open.maxHoldMinutes} min · {open.status}
          </p>
        ) : (
          <p className="muted">Flat.</p>
        )}
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Side</th><th className="num">Qty</th><th>Entry</th><th>Exit</th><th>Reason</th><th className="num">P/L (gross)</th><th>Status</th></tr></thead>
            <tbody>
              {trades.map((t) => {
                const pl = t.entryPrice !== null && t.exitPrice !== null ? (t.side === "long" ? 1 : -1) * (t.exitPrice - t.entryPrice) * t.qty : null;
                return (
                  <tr key={t.id}>
                    <td>{t.id}</td><td>{t.side}</td><td className="num">{t.qty}</td>
                    <td>{t.entryPrice ?? "—"} <span className="muted small">{hhmm(t.entryAt)}</span></td>
                    <td>{t.exitPrice ?? "—"} <span className="muted small">{hhmm(t.exitAt)}</span></td>
                    <td>{t.exitReason ?? ""}</td>
                    <td className={`num ${pl === null ? "" : pl >= 0 ? "pos" : "neg"}`}>{money(pl)}</td>
                    <td className={t.status === "failed" ? "call-error" : ""}>{t.status}{t.error ? `: ${t.error}` : ""}</td>
                  </tr>
                );
              })}
              {trades.length === 0 && <tr><td colSpan={8} className="muted">No trades today.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>All days</h2>
        <p className="small secondary">
          Every day of every version, newest first. Net is after ${TRADER.slippagePerShare.toFixed(2)}/share slippage each way, as on the scoring page; P/L counts closed trades only.
          LLM cost is shown beside it, not subtracted.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Date (ET)</th><th>Version</th><th className="num">Trades</th><th className="num">W / L</th><th className="num">P/L (gross)</th><th className="num">P/L (net)</th><th className="num">LLM cost</th></tr>
            </thead>
            <tbody>
              {history.days.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}{d.date === today ? <span className="muted small"> today, so far</span> : null}</td>
                  <td className="small">{vLabel(d.versionIds)}</td>
                  <td className="num">{d.closed}{d.filled > d.closed ? <span className="muted small"> +{d.filled - d.closed} open</span> : null}</td>
                  <td className="num">{d.wins} / {d.losses}</td>
                  <td className={`num ${plCls(d.gross)}`}>{money(d.gross)}</td>
                  <td className={`num ${plCls(d.net)}`}>{money(d.net)}</td>
                  <td className="num small">{money(d.llmCost)}</td>
                </tr>
              ))}
              {history.days.length === 0 && <tr><td colSpan={7} className="muted">No trading days yet.</td></tr>}
            </tbody>
            {history.days.length > 0 && (
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th className="small">{history.totals.tradingDays} trading days</th>
                  <th className="num">{history.totals.closed}</th>
                  <th className="num">
                    {history.totals.wins} / {history.totals.losses}
                    {history.totals.winRate !== null ? <span className="muted small"> ({Math.round(history.totals.winRate * 100)}%)</span> : null}
                  </th>
                  <th className={`num ${plCls(history.totals.gross)}`}>{money(history.totals.gross)}</th>
                  <th className={`num ${plCls(history.totals.net)}`}>{money(history.totals.net)}</th>
                  <th className="num small">{money(history.totals.llmCost)}</th>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {history.totals.bestDay && history.totals.worstDay && (
          <p className="small secondary" style={{ marginBottom: 0 }}>
            Best day {history.totals.bestDay.date} <span className={plCls(history.totals.bestDay.net)}>{money(history.totals.bestDay.net)}</span> · worst day{" "}
            {history.totals.worstDay.date} <span className={plCls(history.totals.worstDay.net)}>{money(history.totals.worstDay.net)}</span> (net)
          </p>
        )}
        {history.days.filter((d) => d.trades.length > 0).map((d) => (
          <details key={d.date}>
            <summary className="small">{d.date}: {d.trades.length} trade{d.trades.length === 1 ? "" : "s"}, <span className={plCls(d.net)}>{money(d.net)}</span> net</summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Version</th><th>Side</th><th className="num">Qty</th><th>Entry</th><th>Exit</th><th>Reason</th><th className="num">P/L (gross)</th><th>Status</th></tr></thead>
                <tbody>
                  {everyTrade.filter((t) => t.date === d.date).map((t) => {
                    const pl = t.entryPrice !== null && t.exitPrice !== null ? (t.side === "long" ? 1 : -1) * (t.exitPrice - t.entryPrice) * t.qty : null;
                    return (
                      <tr key={t.id}>
                        <td>{t.id}</td><td className="small">v{vNum.get(t.versionId) ?? "?"}</td><td>{t.side}</td><td className="num">{t.qty}</td>
                        <td>{t.entryPrice ?? "—"} <span className="muted small">{hhmm(t.entryAt)}</span></td>
                        <td>{t.exitPrice ?? "—"} <span className="muted small">{hhmm(t.exitAt)}</span></td>
                        <td>{t.exitReason ?? ""}</td>
                        <td className={`num ${plCls(pl)}`}>{money(pl)}</td>
                        <td className={t.status === "failed" ? "call-error" : ""}>{t.status}{t.error ? `: ${t.error}` : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </section>

      <section className="card">
        <h2>Decision log (this version, newest first)</h2>
        <p className="small secondary">Logged before any order is sent; never edited or deleted.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Slot (ET)</th><th>Status</th><th>Action</th><th className="num">Conf.</th><th>Catalyst</th><th>Thesis / reason</th><th className="num">Cost</th><th /></tr></thead>
            <tbody>
              {decisions.map((d) => {
                const r = d.reply as { action?: string; confidence?: number; catalyst?: string; thesis?: string; stop?: number; target?: number } | null;
                return (
                  <tr key={d.id}>
                    <td className="small">{d.slot}{d.phase === "premarket" ? " (pre)" : ""}{d.news_ok === false ? " ⚠ news down" : ""}</td>
                    <td className={`small ${d.status === "accepted" ? "call-run" : d.status === "rejected" || d.status === "error" ? "call-error" : d.status === "no_action" ? "call-reduce" : ""}`}>{d.status}</td>
                    <td className="small">{r?.action ?? ""}{r?.stop ? <span className="muted"> stop {r.stop}{r.target ? ` · target ${r.target}` : ""}</span> : null}</td>
                    <td className="num small">{r?.confidence ?? ""}</td>
                    <td className="small">{r?.catalyst ?? ""}</td>
                    <td className="small secondary">{r?.thesis}{d.reason ? <div className="muted">{d.reason}</div> : null}</td>
                    <td className="num small">{d.cost_usd !== null ? `$${d.cost_usd.toFixed(3)}` : ""}</td>
                    <td className="small">{d.inputs_hash ? <a href={`/api/trader/decision?id=${d.id}`} title={d.inputs_hash}>inputs</a> : ""}</td>
                  </tr>
                );
              })}
              {decisions.length === 0 && <tr><td colSpan={8} className="muted">No decisions yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Scheduled economic releases</h2>
        <p className="small secondary">
          Filled automatically before the open each trading day: FOMC decisions from the Fed, GDP and PCE from BEA, and CPI, jobs, PPI, retail sales,
          JOLTS and jobless claims from FRED{process.env.FRED_API_KEY?.trim() ? "" : <b> once FRED_API_KEY is set (free at fred.stlouisfed.org; BLS blocks automated access)</b>}.
          Add anything else here. Each day’s entries are sent to the model.
        </p>
        <EconEditor events={econ} />
      </section>
    </>
  );
}
