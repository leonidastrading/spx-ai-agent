"use client";

import { useState } from "react";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function EntryControls(props: { enabled: boolean; model: string; effort: Effort; defaultModel: string }) {
  const [s, setS] = useState({ enabled: props.enabled, model: props.model, effort: props.effort });
  const [msg, setMsg] = useState<string | null>(null);
  const versionChange = s.model !== props.model || s.effort !== props.effort;
  async function save(next = s) {
    if ((next.model !== props.model || next.effort !== props.effort) && !confirm("Changing the model or effort starts a NEW version, scored separately. Continue?")) return;
    const res = await fetch("/api/entries/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    if (!res.ok) return setMsg((await res.json()).error ?? `HTTP ${res.status}`);
    location.reload();
  }
  return (
    <div className="fields">
      <label className="field">
        <span className="field-label">Calls</span>
        <span className="toggle"><input type="checkbox" checked={s.enabled} onChange={(e) => save({ ...s, enabled: e.target.checked })} /> {s.enabled ? "On: every entry gets a call" : "Off"}</span>
      </label>
      <label className="field">
        <span className="field-label">Model</span>
        <input value={s.model} placeholder={props.defaultModel} onChange={(e) => setS({ ...s, model: e.target.value })} />
        <span className="field-hint">Blank = {props.defaultModel}</span>
      </label>
      <label className="field">
        <span className="field-label">Effort</span>
        <select value={s.effort} onChange={(e) => setS({ ...s, effort: e.target.value as Effort })}>{["low", "medium", "high", "xhigh", "max"].map((x) => <option key={x}>{x}</option>)}</select>
        <span className="field-hint">Low keeps replies inside the 60 s target</span>
      </label>
      <div style={{ alignSelf: "end", display: "flex", gap: 8 }}>
        <button className="primary" disabled={!versionChange} onClick={() => save()}>Start new version</button>
        {msg && <span className="call-error small">{msg}</span>}
      </div>
    </div>
  );
}

export function HumanCall({ today, locked, existing }: { today: string; locked: boolean; existing: { call: string; reason: string } | null }) {
  const [call, setCall] = useState("normal");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  if (existing) return <p>Your call for {today}: <b>{existing.call.replace("_", " ")}</b> — {existing.reason} <span className="muted small">(locked)</span></p>;
  if (locked) return <p className="muted">No call made for {today}; calls lock at 09:30 ET.</p>;
  async function save() {
    if (!confirm(`Lock in "${call.replace("_", " ")}" for ${today}? It can't be changed afterwards.`)) return;
    const res = await fetch("/api/entries/human", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ call, reason }) });
    if (!res.ok) return setMsg((await res.json()).error ?? `HTTP ${res.status}`);
    location.reload();
  }
  return (
    <form className="export" onSubmit={(e) => { e.preventDefault(); save(); }}>
      {[["normal", "Normal"], ["half", "Half size"], ["skip_afternoon", "Skip afternoon group"]].map(([v, l]) => (
        <label key={v} className="toggle" style={{ flexDirection: "row" }}><input type="radio" name="call" checked={call === v} onChange={() => setCall(v)} /> {l}</label>
      ))}
      <label style={{ flex: 1, minWidth: 220 }}>Reason (one line)<input required minLength={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <button className="primary" type="submit">Lock in</button>
      {msg && <span className="call-error small">{msg}</span>}
    </form>
  );
}
