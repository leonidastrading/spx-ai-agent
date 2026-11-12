import Link from "next/link";
import PaperAccount from "@/components/PaperAccount";
import SetupNotice from "@/components/SetupNotice";
import { TRADER } from "@/config/trader";
import * as store from "@/lib/db";
import { versionHash } from "@/lib/trader/prompt";
import * as ts from "@/lib/trader/store";
import { toEt } from "@/lib/time";
import { EconEditor, TraderControls } from "./Controls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const hhmm = (iso: string | null) => (iso ? toEt(new Date(iso)).hhmm : "—");
const money = (x: number | null) => (x === null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`);

export default async function TraderPage() {
  if (!store.hasDatabase()) return <SetupNotice />;
  const today = toEt(new Date()).date;
  const cfg = await ts.loadTraderSettings();
  const model = cfg.model.trim() || TRADER.defaultModel;
  const versions = await ts.listVersions();
  const current = versions.find((v) => v.hash === versionHash(model, cfg.effort)) ?? null;
  const [trades, decisions, alerts, hb, econ, verdict] = await Promise.all([
    ts.tradesForDate(today),
    current ? ts.recentDecisions(120, current.id) : Promise.resolve([]),
    ts.recentAlerts(10),
    ts.lastHeartbeat(),
    ts.econUpcoming(today),
    current ? ts.verdictFor(current.id) : Promise.resolve(null),
  ]);
  const todays = decisions.filter((d) => d.slot.startsWith(today));
  const open = trades.find((t) => ["submitting", "pending", "open", "closing"].includes(t.status));
  const hbAge = hb ? Math.round((Date.now() - Date.parse(hb.ts)) / 60000) : null;
  const costToday = todays.reduce((a, d) => a + (d.cost_usd ?? 0), 0);

  return (
    <>
      <h1>AI day-trader · paper test</h1>
      <section className="card notice small">
        <b>Paper only.</b> Orders go to the Alpaca <b>paper</b> account (paper-api.alpaca.markets) and nowhere else: QQQ shares, ${TRADER.notional.toLocaleString()} per trade, one position,
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
        <p className="small secondary">Alpaca has no economic calendar, so enter releases here (CPI, jobs, FOMC…). Each day’s entries are sent to the model.</p>
        <EconEditor events={econ} />
      </section>
    </>
  );
}
