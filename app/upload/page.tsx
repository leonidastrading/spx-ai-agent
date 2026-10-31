import { STRATEGY_NAMES } from "@/config/strategies";
import UploadForm from "./UploadForm";

export default function UploadPage() {
  return (
    <>
      <h1>Upload Option Omega trade log</h1>
      <section className="card">
        <p>
          Export the portfolio trade log from Option Omega as CSV. Required columns: <code>Date Opened</code>, <code>P/L</code>,{" "}
          <code>Strategy</code> (<code>Time Opened</code> and <code>No. of Contracts</code> are read but not needed:
          P/L is already the trade total). Strategy names are mapped to {STRATEGY_NAMES.join(", ")} via{" "}
          <code>config/strategies.ts</code>; P/L is summed by date opened and strategy.
        </p>
        <p className="secondary small">
          Re-uploading is safe: each (date, strategy) total is replaced, so upload the full log or a log covering whole days.
        </p>
        <UploadForm />
      </section>
    </>
  );
}
