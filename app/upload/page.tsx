import SetupNotice from "@/components/SetupNotice";
import * as store from "@/lib/db";
import UploadForm from "./UploadForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function UploadPage() {
  if (!store.hasDatabase()) return <SetupNotice />;
  const cfg = await store.loadSettings();
  const STRATEGY_NAMES = cfg.strategies.map((s) => s.name);
  return (
    <>
      <h1>Upload Option Omega trade log</h1>
      <section className="card">
        <p>
          Export the portfolio trade log from Option Omega as CSV. Required columns: <code>Date Opened</code>, <code>P/L</code>,{" "}
          <code>Strategy</code> (<code>Time Opened</code> and <code>No. of Contracts</code> are read but not needed:
          P/L is already the trade total). Strategy names are mapped to {STRATEGY_NAMES.join(", ")} via the{" "}
          <a href="/settings">Option Omega name mapping in Settings</a>; P/L is summed by date opened and strategy.
        </p>
        <p className="secondary small">
          Re-uploading is safe: each (date, strategy) total is replaced, so upload the full log or a log covering whole days.
        </p>
        <UploadForm />
      </section>
    </>
  );
}
