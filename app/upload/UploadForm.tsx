"use client";

import { useState } from "react";

interface Result {
  rows: number;
  outcomes: number;
  written: number;
  dates: [string, string] | null;
  unmapped: Record<string, number>;
  badRows: Array<{ line: number; reason: string }>;
  error?: string;
}

export default function UploadForm() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: new FormData(e.currentTarget), credentials: "same-origin" });
      setResult(await res.json());
    } catch (err) {
      setResult({ error: String(err) } as Result);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="inline" onSubmit={onSubmit}>
        <input type="file" name="file" accept=".csv,text/csv" required />
        <button type="submit" disabled={busy}>{busy ? "Uploading…" : "Upload"}</button>
      </form>
      {result && (
        <div style={{ marginTop: 12 }}>
          {result.error ? (
            <p className="call-error">{result.error}</p>
          ) : (
            <>
              <p>
                {result.rows} trade rows → {result.outcomes} date/strategy totals, {result.written} written
                {result.dates && <> ({result.dates[0]} to {result.dates[1]})</>}.
              </p>
              {Object.keys(result.unmapped).length > 0 && (
                <>
                  <p className="call-reduce">Unmapped Option Omega strategy names (skipped). Add them under <a href="/settings">Settings → Option Omega name mapping</a> and upload again:</p>
                  <ul>{Object.entries(result.unmapped).map(([k, v]) => <li key={k}><code>{k}</code> — {v} rows</li>)}</ul>
                </>
              )}
              {result.badRows.length > 0 && (
                <>
                  <p className="call-error">Rows that could not be parsed:</p>
                  <ul className="small">{result.badRows.map((b) => <li key={b.line}>line {b.line}: {b.reason}</li>)}</ul>
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
