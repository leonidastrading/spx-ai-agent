import SetupNotice from "@/components/SetupNotice";
import { SCHEDULE } from "@/config/rules";
import * as store from "@/lib/db";
import { DEFAULT_SETTINGS, effectiveModel, envStatus } from "@/lib/settings";
import { toEt } from "@/lib/time";
import SettingsForm from "./SettingsForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SettingsPage() {
  const env = envStatus();
  let data: { settings: typeof DEFAULT_SETTINGS; updatedAt: string | null; lastRun: Awaited<ReturnType<typeof store.lastSuccessfulRun>> } | null = null;
  let dbError: string | null = null;
  if (store.hasDatabase()) {
    try {
      const [settings, updatedAt, lastRun] = await Promise.all([store.loadSettings(), store.settingsUpdatedAt(), store.lastSuccessfulRun()]);
      data = { settings, updatedAt, lastRun };
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }
  }
  const groups = [...new Set(env.map((e) => e.group))];

  return (
    <>
      <h1>Settings</h1>

      <section className="card">
        <h2>Connections &amp; keys</h2>
        <p className="small secondary">
          Secrets are never stored in the app or shown here — only whether each one is set. Change them in Vercel → Project → Settings →
          Environment Variables, then redeploy.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Area</th><th>Variable</th><th>Status</th></tr></thead>
            <tbody>
              {groups.flatMap((g) =>
                env.filter((e) => e.group === g).map((e, i) => (
                  <tr key={e.key}>
                    <td className="secondary">{i === 0 ? g : ""}</td>
                    <td><code>{e.key}</code>{!e.required && <span className="muted small"> optional</span>}</td>
                    <td>
                      {e.set ? <span className="call-run">✓ set</span> : e.required ? <span className="call-error">✕ missing</span> : <span className="muted">not set</span>}
                      {"value" in e && e.value && <span className="muted small"> · {e.value}</span>}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
        <p className="small secondary" style={{ marginBottom: 0 }}>
          Last successful cron run:{" "}
          {data?.lastRun ? `${toEt(new Date(data.lastRun.finished_at)).date} ${toEt(new Date(data.lastRun.finished_at)).hhmm} ET (${data.lastRun.action})` : "none yet"}.
          {" "}Schedule (fixed in <code>vercel.json</code>): collect {SCHEDULE.windowStart}–{SCHEDULE.windowEnd} ET, decide {SCHEDULE.decisionAt}, email {SCHEDULE.emailAt}, catch-up until {SCHEDULE.catchUpUntil}.
        </p>
      </section>

      {data ? (
        <SettingsForm initial={data.settings} defaults={DEFAULT_SETTINGS} updatedAt={data.updatedAt} envModel={effectiveModel({ ...data.settings, llm: { ...data.settings.llm, model: "" } })} />
      ) : dbError ? (
        <section className="card"><h2>Database error</h2><p className="call-error">{dbError}</p></section>
      ) : (
        <SetupNotice title="Connect a database to edit settings" />
      )}
    </>
  );
}
