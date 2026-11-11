import { paperAccountSummary, type BrokerPart } from "@/lib/paper-broker";

/** Which Alpaca paper account this part trades, so it can be checked against the Alpaca dashboard. */
export default async function PaperAccount({ part }: { part: BrokerPart }) {
  const a = await paperAccountSummary(part);
  const label = part === "trader" ? "Day trader" : "Swing sleeve";
  if (!a.configured) {
    return (
      <p className="small call-error" style={{ margin: "6px 0 0" }}>
        {label} paper account: not set up. {a.reason}. Create a separate Alpaca paper account (not the one your news monitor trades), put its keys in Vercel as{" "}
        <code>{part === "trader" ? "TRADER" : "SWING"}_ALPACA_KEY_ID</code> / <code>{part === "trader" ? "TRADER" : "SWING"}_ALPACA_SECRET_KEY</code>, and redeploy.
      </p>
    );
  }
  if ("error" in a) return <p className="small call-error" style={{ margin: "6px 0 0" }}>{label} paper account: could not be reached ({a.error}).</p>;
  return (
    <p className="small secondary" style={{ margin: "6px 0 0" }}>
      {label} trades Alpaca <b>paper</b> account <b>{a.accountNumber}</b> · equity ${a.equity.toLocaleString("en-US", { maximumFractionDigits: 0 })} · {a.status}. Check this number in the
      Alpaca dashboard: it must not be the account any other bot uses.
    </p>
  );
}
