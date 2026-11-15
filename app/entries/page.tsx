import Link from "next/link";
import SetupNotice from "@/components/SetupNotice";
import { ENTRY } from "@/config/entry";
import * as store from "@/lib/db";
import { exportConfigFromEnv } from "@/lib/entry/client";
import { entryVersionHash } from "@/lib/entry/prompt";
import * as es from "@/lib/entry/store";
import { toEt } from "@/lib/time";
import { EntryControls, HumanCall } from "./Controls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const hhmmss = (iso: string) => { const e = toEt(new Date(iso)); return `${e.hhmm}:${String(e.second).padStart(2, "0")}`; };

export default async function EntriesPage() {
  if (!store.hasDatabase()) return <SetupNotice />;
  const now = toEt(new Date());
  const cfg = await es.loadEntrySettings();
  const model = cfg.model.trim() || ENTRY.defaultModel;
  const versions = await es.listEntryVersions();
  const current = versions.find((v) => v.hash === entryVersionHash(model, cfg.effort)) ?? null;
  const [calls, humans, verdict] = await Promise.all([es.recentCalls(150), es.humanCalls(), current ? es.entryVerdict(current.id) : Promise.resolve(null)]);
  let exportOk: string | null = null;
  try {
    exportOk = exportConfigFromEnv() ? null : "OO_EXPORT_URL / OO_EXPORT_TOKEN not set";
  } catch (err) {
    exportOk = err instanceof Error ? err.message : String(err);
  }
  const today = calls.filter((c) => toEt(new Date(c.filledAt)).date === now.date);

  return (
    <>
      <h1>Entry advisor · shadow mode</h1>
      <section className="card notice small">
        A call on every bot entry as it fills, logged before the outcome is known, then scored against what the book actually did. <b>Advice only:</b> it never places, changes or blocks a trade,
        and nothing it says reaches Option Omega or Schwab. Entries come from oo-trading’s read-only view of Schwab fills. <Link href="/entries/scoring">Scoring and decision gate →</Link>
        {exportOk && <p className="call-error" style={{ margin: "6px 0 0" }}>Not connected: {exportOk}. See README → Entry advisor.</p>}
      </section>

      {verdict && <section className={`card ${verdict.verdict === "fail" ? "errorbox" : "notice"}`}><h2>Decision gate: {verdict.verdict.toUpperCase()}</h2><p className="small">{verdict.verdict === "fail" ? "Calls have stopped for this version; the record is kept." : "Passed. This switches nothing on; it is evidence for acting by hand, at reduced size first."}</p></section>}

      <section className="card">
        <h2>Your pre-open call</h2>
        <HumanCall today={now.date} locked={now.minutes >= 9 * 60 + 30} existing={humans.get(now.date) ?? null} />
      </section>

      <section className="card">
        <h2>Version {current ? `v${current.number}` : "(created on the next tick)"}: {model}, effort {cfg.effort}</h2>
        <p className="small secondary">Model, prompt, reply schema, packet layout and rules are frozen per version ({current ? <code>{current.hash.slice(0, 12)}</code> : "hash pending"}). Don’t tune the prompt on results of the version being scored. The model never sees its own earlier calls.</p>
        <EntryControls enabled={cfg.enabled} model={cfg.model} effort={cfg.effort} defaultModel={ENTRY.defaultModel} />
      </section>

      <section className="card">
        <h2>Calls today ({today.length})</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Filled (ET)</th><th>Bot</th><th className="num">Latency</th><th>Status</th><th>Verdict</th><th className="num">Conf.</th><th>Day type</th><th>Reasons</th><th /></tr></thead>
            <tbody>
              {today.map((c) => (
                <tr key={c.id}>
                  <td className="small">{hhmmss(c.filledAt)}</td>
                  <td className="small">{c.bot ?? "?"}<div className="muted">match {c.matchConfidence.toFixed(2)}{c.match !== "exact" ? ` · ${c.match}` : ""}{c.matchSource === "local_profile" || c.matchSource === "live_profile" ? " · by live fills" : ""}</div>{c.trimmed?.length ? <div className="muted">trimmed</div> : null}</td>
                  <td className={`num small ${c.latencyMs > ENTRY.lateAfterSeconds * 1000 ? "call-error" : c.latencyMs > ENTRY.targetLatencySeconds * 1000 ? "call-reduce" : ""}`}>{Math.round(c.latencyMs / 1000)}s</td>
                  <td className={`small ${c.status === "called" ? "" : c.status === "error" || c.status === "late" ? "call-error" : "call-reduce"}`}>{c.status.replace("_", " ")}{c.statusReason && <div className="muted">{c.statusReason}</div>}</td>
                  <td className={`small call call-${c.verdict === "take" ? "run" : c.verdict ?? ""}`}>{c.verdict ?? (c.reply?.verdict ? <span className="muted">({c.reply.verdict})</span> : "")}</td>
                  <td className="num small">{c.confidence ?? ""}</td>
                  <td className="small">{c.dayType?.replace("_", " ") ?? ""}</td>
                  <td className="small secondary">{(c.reply?.reasons ?? []).map((r: { category: string; text: string }, i: number) => <div key={i}><span className="tag">{r.category}</span> {r.text}</div>)}{c.reply?.main_risk && <div className="muted">Risk: {c.reply.main_risk}</div>}</td>
                  <td className="small">{c.packetHash ? <a href={`/api/entries/packet?id=${c.id}`} title={c.packetHash}>packet</a> : ""}</td>
                </tr>
              ))}
              {today.length === 0 && <tr><td colSpan={9} className="muted">No entries yet today.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
