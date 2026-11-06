"use client";

import { useMemo, useState } from "react";
import type { Settings } from "@/lib/settings";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: string } | { kind: "error"; errors: string[] };

/** Split a textarea into a term list (one per line or comma-separated). */
const toTerms = (s: string) => s.split(/[\n,]/).map((t) => t.trim()).filter(Boolean);

export default function SettingsForm({
  initial,
  defaults,
  updatedAt,
  envModel,
}: {
  initial: Settings;
  defaults: Settings;
  updatedAt: string | null;
  envModel: string;
}) {
  const [s, setS] = useState<Settings>(initial);
  const [saved, setSaved] = useState<Settings>(initial);
  const [status, setStatus] = useState<Status>(updatedAt ? { kind: "saved", at: updatedAt } : { kind: "idle" });
  // OO map as editable rows (object keys can't be edited in place).
  const [ooRows, setOoRows] = useState<Array<[string, string]>>(Object.entries(initial.ooMap));
  // Raw textarea text, so typing commas/newlines isn't reformatted mid-edit.
  const [termText, setTermText] = useState<string[]>(initial.keywords.categories.map((c) => c.terms.join(", ")));
  const [megaCapsText, setMegaCapsText] = useState(initial.keywords.megaCaps.join(", "));
  const [megaNamesText, setMegaNamesText] = useState(initial.keywords.megaCapNames.join(", "));

  const current = useMemo<Settings>(
    () => ({
      ...s,
      ooMap: Object.fromEntries(ooRows.filter(([k]) => k.trim())),
      keywords: {
        categories: s.keywords.categories.map((c, i) => ({ ...c, terms: toTerms(termText[i] ?? "") })),
        megaCaps: toTerms(megaCapsText).map((t) => t.toUpperCase()),
        megaCapNames: toTerms(megaNamesText),
      },
    }),
    [s, ooRows, termText, megaCapsText, megaNamesText],
  );
  const dirty = JSON.stringify(current) !== JSON.stringify(saved);
  const names = s.strategies.map((x) => x.name);
  // Default strategies (and their name mappings) added in code after these settings were saved.
  const newDefaults = defaults.strategies.filter((d) => !names.includes(d.name));
  const newDefaultMaps = Object.entries(defaults.ooMap).filter(
    ([k, v]) => newDefaults.some((d) => d.name === v) && !ooRows.some(([rk]) => rk.trim().toLowerCase() === k),
  );
  const [hideDefaults, setHideDefaults] = useState(false);
  function addNewDefaults() {
    set("strategies", [...s.strategies, ...newDefaults]);
    setOoRows([...ooRows, ...newDefaultMaps]);
  }

  function load(next: Settings) {
    setS(next);
    setOoRows(Object.entries(next.ooMap));
    setTermText(next.keywords.categories.map((c) => c.terms.join(", ")));
    setMegaCapsText(next.keywords.megaCaps.join(", "));
    setMegaNamesText(next.keywords.megaCapNames.join(", "));
  }

  async function save() {
    setStatus({ kind: "saving" });
    const res = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(current) });
    const body = await res.json();
    if (!res.ok) return setStatus({ kind: "error", errors: body.errors ?? [body.error ?? `HTTP ${res.status}`] });
    load(body.settings);
    setSaved(body.settings);
    setStatus({ kind: "saved", at: body.updatedAt });
  }

  async function reset() {
    if (!confirm("Reset every setting to the defaults in config/? This cannot be undone.")) return;
    const res = await fetch("/api/settings", { method: "DELETE" });
    const body = await res.json();
    load(body.settings);
    setSaved(body.settings);
    setStatus({ kind: "idle" });
  }

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));
  const num = (v: string) => (v === "" ? NaN : Number(v));

  return (
    <>
      <div className="savebar">
        <button className="primary" onClick={save} disabled={!dirty || status.kind === "saving"}>
          {status.kind === "saving" ? "Saving…" : "Save changes"}
        </button>
        <button onClick={() => load(saved)} disabled={!dirty}>Discard</button>
        <span className="small secondary" role="status">
          {dirty
            ? "Unsaved changes"
            : status.kind === "saved"
              ? `Saved ${new Date(status.at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`
              : "Using defaults from config/"}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <a className="button" href="/api/settings?download=1">Download JSON</a>
          <button onClick={reset}>Reset to defaults</button>
        </span>
      </div>
      {newDefaults.length > 0 && !hideDefaults && (
        <div className="card notice" role="status">
          <b>New default strategies aren’t in your saved settings:</b> {newDefaults.map((d) => d.name).join(", ")}
          {newDefaultMaps.length > 0 && <> (with {newDefaultMaps.length} Option Omega name mappings)</>}.
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="primary" onClick={addNewDefaults}>Add them</button>
            <button onClick={() => setHideDefaults(true)}>Not now</button>
            <span className="small secondary" style={{ alignSelf: "center" }}>Then review and Save changes.</span>
          </div>
        </div>
      )}
      {status.kind === "error" && (
        <div className="card errorbox" role="alert">
          <b>Not saved:</b>
          <ul>{status.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <section className="card">
        <h2>Rule baseline</h2>
        <p className="small secondary">“reduce” if the 30-min ATR is in the top band of the trailing window, or SPY is down more than the threshold at 10:50 ET; otherwise “run”.</p>
        <div className="fields">
          <Field label="ATR percentile threshold" hint={`0–1, default ${defaults.rules.atrPercentile} (top decile)`}>
            <input type="number" step="0.01" min="0.01" max="0.99" value={s.rules.atrPercentile} onChange={(e) => set("rules", { ...s.rules, atrPercentile: num(e.target.value) })} />
          </Field>
          <Field label="ATR lookback (trading days)" hint={`default ${defaults.rules.atrLookbackDays}`}>
            <input type="number" step="1" min="20" value={s.rules.atrLookbackDays} onChange={(e) => set("rules", { ...s.rules, atrLookbackDays: num(e.target.value) })} />
          </Field>
          <Field label="Min history before ATR leg applies" hint={`days, default ${defaults.rules.atrMinHistoryDays}`}>
            <input type="number" step="1" min="1" value={s.rules.atrMinHistoryDays} onChange={(e) => set("rules", { ...s.rules, atrMinHistoryDays: num(e.target.value) })} />
          </Field>
          <Field label="SPY down threshold (%)" hint={`reduce below −this vs prior close, default ${defaults.rules.spyDownPct}`}>
            <input type="number" step="0.1" min="0" value={s.rules.spyDownPct} onChange={(e) => set("rules", { ...s.rules, spyDownPct: num(e.target.value) })} />
          </Field>
        </div>
      </section>

      <section className="card">
        <h2>LLM call</h2>
        <div className="fields">
          <Field label="Enabled" hint="Off = rule call only">
            <span className="toggle"><input type="checkbox" checked={s.llm.enabled} onChange={(e) => set("llm", { ...s.llm, enabled: e.target.checked })} /> Make the LLM call at 10:50</span>
          </Field>
          <Field label="Model" hint={`Blank = ${envModel}`}>
            <input type="text" placeholder={envModel} value={s.llm.model} onChange={(e) => set("llm", { ...s.llm, model: e.target.value })} />
          </Field>
          <Field label="Effort" hint="Thinking depth vs cost; default high">
            <select value={s.llm.effort} onChange={(e) => set("llm", { ...s.llm, effort: e.target.value as Settings["llm"]["effort"] })}>
              {EFFORTS.map((x) => <option key={x}>{x}</option>)}
            </select>
          </Field>
          <Field label="Headlines sent" hint={`most relevant N since prior close, default ${defaults.llm.maxHeadlines}`}>
            <input type="number" step="1" min="0" max="200" value={s.llm.maxHeadlines} onChange={(e) => set("llm", { ...s.llm, maxHeadlines: num(e.target.value) })} />
          </Field>
        </div>
      </section>

      <section className="card">
        <h2>Email</h2>
        <div className="fields">
          <Field label="Enabled" hint="10:51 ET summary; also needs RESEND_API_KEY">
            <span className="toggle"><input type="checkbox" checked={s.email.enabled} onChange={(e) => set("email", { ...s.email, enabled: e.target.checked })} /> Send the daily email</span>
          </Field>
          <Field label="Recipients" hint="Comma-separated. Blank = ALERT_EMAIL env var">
            <input type="text" placeholder="ALERT_EMAIL" value={s.email.to} onChange={(e) => set("email", { ...s.email, to: e.target.value })} />
          </Field>
        </div>
      </section>

      <section className="card">
        <h2>Strategies</h2>
        <p className="small secondary">The calls are made for these, in this order. Renaming a strategy starts a new history for it on the scoring page.</p>
        <div className="table-wrap">
          <table className="edit">
            <thead><tr><th>Name</th><th>Entry (ET)</th><th>What it is (sent to the LLM)</th><th /></tr></thead>
            <tbody>
              {s.strategies.map((st, i) => (
                <tr key={i}>
                  <td><input aria-label="Strategy name" value={st.name} onChange={(e) => set("strategies", s.strategies.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></td>
                  <td><input aria-label="Entry time" value={st.entryEt} onChange={(e) => set("strategies", s.strategies.map((x, j) => (j === i ? { ...x, entryEt: e.target.value } : x)))} /></td>
                  <td className="wide"><input aria-label="Description" value={st.description} onChange={(e) => set("strategies", s.strategies.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></td>
                  <td><button className="icon" aria-label={`Remove ${st.name}`} onClick={() => set("strategies", s.strategies.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button onClick={() => set("strategies", [...s.strategies, { name: "", entryEt: "", description: "" }])}>+ Add strategy</button>
      </section>

      <section className="card">
        <h2>Option Omega name mapping</h2>
        <p className="small secondary">The <code>Strategy</code> column of your trade log → short name. Case-insensitive. A row matches a name that equals it or contains it as whole words, and the longest matching row wins — so “long straddle” → FOMC beats a shorter row like “long”. Unmatched names fall back to built-in patterns (e.g. “Put BWB 13:50” → BWB), then show up as unmapped on the upload page.</p>
        <div className="table-wrap">
          <table className="edit">
            <thead><tr><th>Option Omega name</th><th>Strategy</th><th /></tr></thead>
            <tbody>
              {ooRows.map(([oo, short], i) => (
                <tr key={i}>
                  <td className="wide"><input aria-label="Option Omega name" value={oo} onChange={(e) => setOoRows(ooRows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} /></td>
                  <td>
                    <select aria-label="Maps to" value={short} onChange={(e) => setOoRows(ooRows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}>
                      {!names.includes(short) && <option value={short}>{short || "—"} (unknown)</option>}
                      {names.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </td>
                  <td><button className="icon" aria-label={`Remove ${oo}`} onClick={() => setOoRows(ooRows.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button onClick={() => setOoRows([...ooRows, ["", names[0] ?? ""]])}>+ Add mapping</button>
      </section>

      <section className="card">
        <h2>Headline keywords</h2>
        <p className="small secondary">Each category becomes a <code>kw_&lt;key&gt;</code> count over headlines since the prior close. Terms are whole words or phrases, comma- or line-separated, case-insensitive. Changing them changes features from now on; past rows keep the counts they were computed with.</p>
        {s.keywords.categories.map((c, i) => (
          <div key={i} className="kwrow">
            <div className="fields">
              <Field label="Key">
                <input value={c.key} onChange={(e) => set("keywords", { ...s.keywords, categories: s.keywords.categories.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
              </Field>
              <Field label="Label">
                <input value={c.label} onChange={(e) => set("keywords", { ...s.keywords, categories: s.keywords.categories.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              </Field>
              <Field label="Mega-cap only" hint="Also needs a mega-cap ticker/name">
                <span className="toggle"><input type="checkbox" checked={!!c.megaCapOnly} onChange={(e) => set("keywords", { ...s.keywords, categories: s.keywords.categories.map((x, j) => (j === i ? { ...x, megaCapOnly: e.target.checked } : x)) })} /> Mega-cap only</span>
              </Field>
              <div style={{ alignSelf: "end" }}>
                <button onClick={() => { set("keywords", { ...s.keywords, categories: s.keywords.categories.filter((_, j) => j !== i) }); setTermText(termText.filter((_, j) => j !== i)); }}>Remove category</button>
              </div>
            </div>
            <Field label="Terms">
              <textarea rows={2} value={termText[i] ?? ""} onChange={(e) => setTermText(termText.map((t, j) => (j === i ? e.target.value : t)))} />
            </Field>
          </div>
        ))}
        <button onClick={() => { set("keywords", { ...s.keywords, categories: [...s.keywords.categories, { key: "", label: "", terms: [] }] }); setTermText([...termText, ""]); }}>+ Add category</button>
        <div className="fields" style={{ marginTop: 16 }}>
          <Field label="Mega-cap tickers">
            <textarea rows={2} value={megaCapsText} onChange={(e) => setMegaCapsText(e.target.value)} />
          </Field>
          <Field label="Mega-cap company names">
            <textarea rows={2} value={megaNamesText} onChange={(e) => setMegaNamesText(e.target.value)} />
          </Field>
        </div>
      </section>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
