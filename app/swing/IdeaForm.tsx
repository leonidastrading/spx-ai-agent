"use client";

import { useState } from "react";

export default function IdeaForm({ maxPosition, specLeft }: { maxPosition: number; specLeft: number }) {
  const [f, setF] = useState({ ticker: "", side: "long", thesis: "", catalyst: "news", speculative: false, notional: "5000", exitRule: "target", exitParam: "" });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const set = (k: keyof typeof f, v: string | boolean) => setF({ ...f, [k]: v });
  const paramLabel = f.exitRule === "target" ? "Target price ($)" : f.exitRule === "trailing" ? "Trailing stop (%)" : "Time limit (days)";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirm(`Save ${f.side.toUpperCase()} ${f.ticker.toUpperCase()} and send a paper market order? Saved ideas are locked and can’t be edited or deleted.`)) return;
    setBusy(true);
    setErrors([]);
    const res = await fetch("/api/swing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...f, notional: Number(f.notional), exitParam: Number(f.exitParam) }),
    });
    const body = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (!res.ok || !body.ok) return setErrors(body.errors ?? ["failed"]);
    location.reload();
  }

  return (
    <form onSubmit={submit}>
      <div className="fields">
        <label className="field"><span className="field-label">Ticker</span><input required value={f.ticker} onChange={(e) => set("ticker", e.target.value.toUpperCase())} placeholder="AAPL" /></label>
        <label className="field"><span className="field-label">Direction</span>
          <select value={f.side} onChange={(e) => set("side", e.target.value)}><option value="long">long</option><option value="short">short</option></select></label>
        <label className="field"><span className="field-label">Catalyst</span>
          <select value={f.catalyst} onChange={(e) => set("catalyst", e.target.value)}>
            <option value="news">news</option><option value="panic_dip">panic dip</option><option value="theme">theme</option><option value="earnings">earnings</option>
          </select></label>
        <label className="field"><span className="field-label">Size ($)</span>
          <input type="number" min="1" step="1" required value={f.notional} onChange={(e) => set("notional", e.target.value)} />
          <span className="field-hint">max ${maxPosition.toLocaleString()} per idea</span></label>
        <label className="field"><span className="field-label">Speculative</span>
          <span className="toggle"><input type="checkbox" checked={f.speculative} onChange={(e) => set("speculative", e.target.checked)} /> Speculative</span>
          <span className="field-hint">${specLeft.toLocaleString()} of the speculative cap left</span></label>
        <label className="field"><span className="field-label">Exit rule (fixed at entry)</span>
          <select value={f.exitRule} onChange={(e) => set("exitRule", e.target.value)}>
            <option value="target">price target</option><option value="trailing">trailing stop</option><option value="time">time limit</option>
          </select></label>
        <label className="field"><span className="field-label">{paramLabel}</span>
          <input type="number" min="0" step="any" required value={f.exitParam} onChange={(e) => set("exitParam", e.target.value)} /></label>
      </div>
      <label className="field"><span className="field-label">Thesis</span>
        <textarea required rows={3} value={f.thesis} onChange={(e) => set("thesis", e.target.value)} placeholder="Why, what would prove it wrong, and why now" /></label>
      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
        <button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save idea and enter (paper)"}</button>
        <span className="small secondary">Entry is a market order on the paper account (queued for the open if the market is closed); the entry price is the fill.</span>
      </div>
      {errors.length > 0 && <ul className="call-error small">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
    </form>
  );
}
