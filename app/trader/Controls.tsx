"use client";

import { useState } from "react";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function TraderControls(props: { enabled: boolean; model: string; effort: Effort; defaultModel: string }) {
  const [s, setS] = useState({ enabled: props.enabled, model: props.model, effort: props.effort });
  const [msg, setMsg] = useState<string | null>(null);
  const versionChange = s.model !== props.model || s.effort !== props.effort;

  async function save(next = s) {
    if (next.enabled && !props.enabled && !confirm("Turn on paper trading? Orders go to the Alpaca PAPER account only.")) return;
    if (next.model !== props.model || next.effort !== props.effort) {
      if (!confirm("Changing the model or effort starts a NEW version. Results are scored per version. Continue?")) return;
    }
    const res = await fetch("/api/trader", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    const body = await res.json();
    if (!res.ok) return setMsg(body.error ?? `HTTP ${res.status}`);
    location.reload();
  }

  return (
    <div className="fields">
      <label className="field">
        <span className="field-label">Paper trading</span>
        <span className="toggle">
          <input type="checkbox" checked={s.enabled} onChange={(e) => save({ ...s, enabled: e.target.checked })} />
          {s.enabled ? "On: entries are sent to the paper account" : "Off: no new entries (decisions are still logged)"}
        </span>
      </label>
      <label className="field">
        <span className="field-label">Model</span>
        <input value={s.model} placeholder={props.defaultModel} onChange={(e) => setS({ ...s, model: e.target.value })} />
        <span className="field-hint">Blank = {props.defaultModel}</span>
      </label>
      <label className="field">
        <span className="field-label">Effort</span>
        <select value={s.effort} onChange={(e) => setS({ ...s, effort: e.target.value as Effort })}>
          {["low", "medium", "high", "xhigh", "max"].map((x) => <option key={x}>{x}</option>)}
        </select>
        <span className="field-hint">Higher = more reasoning, more cost</span>
      </label>
      <div style={{ alignSelf: "end", display: "flex", gap: 8, alignItems: "center" }}>
        <button className="primary" disabled={!versionChange} onClick={() => save()}>Start new version</button>
        {msg && <span className="call-error small">{msg}</span>}
      </div>
    </div>
  );
}

export function EconEditor({ events }: { events: Array<{ id: number; date: string; time_et: string; event: string }> }) {
  const [f, setF] = useState({ date: "", time_et: "08:30", event: "" });
  const [msg, setMsg] = useState<string | null>(null);
  async function add() {
    const res = await fetch("/api/trader/econ", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
    if (!res.ok) return setMsg((await res.json()).error ?? `HTTP ${res.status}`);
    location.reload();
  }
  async function del(id: number) {
    await fetch(`/api/trader/econ?id=${id}`, { method: "DELETE" });
    location.reload();
  }
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Time (ET)</th><th>Release</th><th /></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}><td>{e.date}</td><td>{e.time_et}</td><td>{e.event}</td>
                <td><button className="icon" aria-label={`Remove ${e.event}`} onClick={() => del(e.id)}>✕</button></td></tr>
            ))}
            {events.length === 0 && <tr><td colSpan={4} className="muted">None entered. The model is told no releases are scheduled.</td></tr>}
          </tbody>
        </table>
      </div>
      <form className="export" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label>Date<input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <label>Time ET<input type="time" required value={f.time_et} onChange={(e) => setF({ ...f, time_et: e.target.value })} /></label>
        <label style={{ flex: 1, minWidth: 200 }}>Release<input required placeholder="CPI (Oct)" value={f.event} onChange={(e) => setF({ ...f, event: e.target.value })} /></label>
        <button type="submit">Add</button>
        {msg && <span className="call-error small">{msg}</span>}
      </form>
    </>
  );
}
