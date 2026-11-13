import LineChart from "@/components/LineChart";
import SetupNotice from "@/components/SetupNotice";
import { SCHEDULE } from "@/config/rules";
import * as store from "@/lib/db";
import { categorize, DROP_LABELS, screenHeadlines, topHeadlines, type DropReason } from "@/lib/news";
import { toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHARTS: Array<{ key: string; title: string; unit: string; digits?: number }> = [
  { key: "spy_ret_prev_close_pct", title: "SPY vs prior close", unit: "%" },
  { key: "spy_ret_open_pct", title: "SPY vs open", unit: "%" },
  { key: "range_bp", title: "SPY range since 9:30", unit: "bp", digits: 0 },
  { key: "range_pos", title: "Position in day's range (0–1)", unit: "" },
  { key: "qqq_minus_spy_pct", title: "QQQ − SPY", unit: "pp" },
  { key: "iwm_minus_spy_pct", title: "IWM − SPY", unit: "pp" },
  { key: "tlt_ret_pct", title: "TLT vs prior close", unit: "%" },
  { key: "vixy_ret_pct", title: "VIXY vs prior close", unit: "%" },
];

const etHhmm = (iso: string) => toEt(new Date(iso)).hhmm;

function CallCell({ call, confidence }: { call?: string; confidence?: number | null }) {
  if (!call) return <span className="muted">—</span>;
  return (
    <span className={`call call-${call}`}>
      {call}
      {confidence != null && <span className="muted small"> {Math.round(confidence * 100)}%</span>}
    </span>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const sp = await searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? "") ? sp.date! : toEt(new Date()).date;
  if (!store.hasDatabase()) return <SetupNotice />;

  const [cfg, featureRows, decisions, read, history, runs] = await Promise.all([
    store.loadSettings(),
    store.featuresForDate(date),
    store.decisionsForDate(date),
    store.llmRead(date),
    store.allDecisions(),
    store.recentRuns(8),
  ]);
  const latest = featureRows.length ? featureRows[featureRows.length - 1].data : null;
  const news = latest ? await store.loadNews(new Date(latest.prior_close_at), new Date(latest.as_of)) : [];
  const top = topHeadlines(news, 30, cfg.keywords);
  const screened = screenHeadlines(news, cfg.keywords);
  const STRATEGY_NAMES = cfg.strategies.map((s) => s.name);

  const llm = new Map(decisions.filter((d) => d.source === "llm").map((d) => [d.strategy, d]));
  const rule = new Map(decisions.filter((d) => d.source === "rule").map((d) => [d.strategy, d]));
  const llmError = llm.get("*");

  // history pivot: date -> strategy -> {llm, rule}
  const hist = new Map<string, Map<string, { llm?: string; rule?: string }>>();
  for (const d of history) {
    const day = hist.get(d.date) ?? new Map();
    const cell = day.get(d.strategy) ?? {};
    cell[d.source as "llm" | "rule"] = d.call;
    day.set(d.strategy, cell);
    hist.set(d.date, day);
  }

  return (
    <>
      <form className="inline" method="get" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Morning book · {date}</h1>
        <input type="date" name="date" defaultValue={date} aria-label="Date" />
        <button type="submit">Go</button>
        {latest && <span className="muted small">features as of {etHhmm(latest.as_of)} ET · feed {latest.feed} · {latest.bars_used} SPY bars</span>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <a className="button" href={`/api/export?type=features&date=${date}`}>Day's features CSV</a>
          <a className="button" href="/api/export?type=calls">All calls CSV</a>
        </span>
      </form>

      <section className="card">
        <h2>Calls for {date} (decided {SCHEDULE.decisionAt} ET)</h2>
        {llmError ? (
          <p className="call-error">LLM error: {llmError.reason}</p>
        ) : read?.market_read ? (
          <p>{read.market_read}</p>
        ) : (
          <p className="muted">No LLM read yet.</p>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Strategy</th><th>LLM</th><th>LLM reason</th><th>Rule</th></tr>
            </thead>
            <tbody>
              {STRATEGY_NAMES.map((n) => (
                <tr key={n}>
                  <td><b>{n}</b></td>
                  <td><CallCell call={llm.get(n)?.call} confidence={llm.get(n)?.confidence} /></td>
                  <td className="secondary small">{llm.get(n)?.reason}</td>
                  <td><CallCell call={rule.get(n)?.call} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rule.size > 0 && <p className="muted small">Rule: {rule.values().next().value?.reason}</p>}
      </section>

      <section className="card">
        <h2>Features</h2>
        {featureRows.length === 0 ? (
          <p className="muted">No features stored for this date.</p>
        ) : (
          <>
            <div className="grid">
              {CHARTS.map((c) => (
                <LineChart
                  key={c.key}
                  title={c.title}
                  unit={c.unit}
                  digits={c.digits}
                  points={featureRows.map((r) => ({ x: r.minute_et, y: (r.data as any)[c.key] ?? null }))}
                />
              ))}
            </div>
            <details style={{ marginTop: 12 }}>
              <summary className="secondary">All features at {featureRows[featureRows.length - 1].minute_et} ET (table)</summary>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {Object.entries(latest!).map(([k, v]) => (
                      <tr key={k}><td className="secondary">{k}</td><td className="num">{v === null ? "—" : String(v)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </section>

      <section className="card">
        <h2>Headlines since prior close ({screened.kept.length} kept of {news.length}; 30 most relevant shown)</h2>
        <p className="small muted">
          Dropped {news.length - screened.kept.length}:{" "}
          {(Object.keys(screened.dropped) as DropReason[]).map((k) => `${screened.dropped[k]} ${DROP_LABELS[k]}`).join(" · ")}.
          Tags count only when the headline is about the market (or, for the mega-cap tag, a mega-cap).
        </p>
        <ul className="headlines">
          {top.map((h) => (
            <li key={h.id}>
              <time>{etHhmm(h.ts)}</time>
              {h.url ? <a href={h.url} target="_blank" rel="noreferrer">{h.headline}</a> : h.headline}
              {categorize(h, cfg.keywords).map((c) => <span key={c} className="tag">{c}</span>)}
            </li>
          ))}
          {top.length === 0 && <li className="muted">none</li>}
        </ul>
      </section>

      <section className="card">
        <h2>History (LLM / rule)</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th>{STRATEGY_NAMES.map((n) => <th key={n}>{n}</th>)}</tr>
            </thead>
            <tbody>
              {[...hist.entries()].map(([d, day]) => (
                <tr key={d}>
                  <td><a href={`/dashboard?date=${d}`}>{d}</a></td>
                  {day.get("*") ? (
                    <td colSpan={STRATEGY_NAMES.length} className="small">
                      <span className="call call-error">LLM error</span> / rule <CallCell call={day.get(STRATEGY_NAMES[0])?.rule} />
                    </td>
                  ) : (
                    STRATEGY_NAMES.map((n) => (
                      <td key={n} className="small">
                        <CallCell call={day.get(n)?.llm} /> <span className="muted">/</span> <CallCell call={day.get(n)?.rule} />
                      </td>
                    ))
                  )}
                </tr>
              ))}
              {hist.size === 0 && <tr><td colSpan={STRATEGY_NAMES.length + 1} className="muted">No calls yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Recent cron runs</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Started (ET)</th><th>Minute</th><th>Action</th><th>Status</th><th>Rows</th><th>Detail</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="small">{toEt(new Date(r.started_at)).date} {toEt(new Date(r.started_at)).hhmm}</td>
                  <td className="small">{r.minute_et ?? "—"}</td>
                  <td className="small">{r.action}</td>
                  <td className={`small ${r.status === "error" ? "call-error" : ""}`}>{r.status}</td>
                  <td className="small">{Object.entries(r.rows_written ?? {}).map(([k, v]) => `${k}:${v}`).join(" ")}</td>
                  <td className="small secondary">{r.error ?? r.detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
