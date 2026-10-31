import { envStatus } from "@/lib/settings";

/** Shown instead of data when the database (or other required config) isn't connected yet. */
export default function SetupNotice({ title = "Finish setup" }: { title?: string }) {
  const missing = envStatus().filter((e) => e.required && !e.set);
  return (
    <section className="card">
      <h2>{title}</h2>
      <p>
        The site is deployed, but {missing.length ? "some required settings are missing" : "the database is not reachable"}.
        Add them in Vercel → this project → <b>Settings → Environment Variables</b> (the database comes from
        <b> Storage → Create Database → Neon</b>, which adds <code>DATABASE_URL</code> for you), then redeploy.
      </p>
      {missing.length > 0 && (
        <ul>{missing.map((m) => <li key={m.key}><code>{m.key}</code> <span className="muted small">({m.group})</span></li>)}</ul>
      )}
      <p className="small secondary">See <a href="/settings">Settings</a> for the full status. Tables are created automatically on first use.</p>
    </section>
  );
}
