/** 10:51 ET summary email. buildSummaryEmail is pure; sendEmail calls Resend. */

import { STRATEGY_NAMES } from "@/config/strategies";
import type { StrategyCall } from "./decision";

export interface SummaryInput {
  date: string;
  marketRead: string | null;
  llmError: string | null;
  llm: StrategyCall[];
  rule: StrategyCall[];
  headlines: Array<{ ts: string; headline: string; url?: string }>;
  dashboardUrl?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function etTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function buildSummaryEmail(s: SummaryInput): { subject: string; html: string; text: string } {
  const llm = new Map(s.llm.map((c) => [c.strategy, c]));
  const rule = new Map(s.rule.map((c) => [c.strategy, c]));
  const skips = s.llm.filter((c) => c.call === "skip").length;
  const reduces = s.llm.filter((c) => c.call === "reduce").length;
  const subject = s.llmError
    ? `Book advisor ${s.date}: LLM error / rule ${s.rule[0]?.call ?? "n/a"}`
    : `Book advisor ${s.date}: ${skips} skip / ${reduces} reduce`;

  const color = (c?: string) => (c === "skip" ? "#b42318" : c === "reduce" ? "#b54708" : "#067647");
  const rows = STRATEGY_NAMES.map((n) => {
    const l = llm.get(n);
    const r = rule.get(n);
    const conf = l?.confidence != null ? ` (${Math.round(l.confidence * 100)}%)` : "";
    return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee"><b>${esc(n)}</b></td>
<td style="padding:4px 8px;border-bottom:1px solid #eee;color:${color(l?.call)}"><b>${esc(l?.call ?? "—")}</b>${conf}<br><span style="color:#555;font-size:12px">${esc(l?.reason ?? "")}</span></td>
<td style="padding:4px 8px;border-bottom:1px solid #eee;color:${color(r?.call)}">${esc(r?.call ?? "—")}</td></tr>`;
  }).join("\n");
  const heads = s.headlines
    .slice(0, 5)
    .map((h) => `<li>${etTime(h.ts)} — ${h.url ? `<a href="${esc(h.url)}">${esc(h.headline)}</a>` : esc(h.headline)}</li>`)
    .join("\n");

  const read = s.llmError ? `<p style="color:#b42318"><b>LLM call failed:</b> ${esc(s.llmError)}</p>` : `<p>${esc(s.marketRead ?? "")}</p>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;max-width:640px">
<p style="color:#555;font-size:12px;margin:0 0 8px">SHADOW MODE — advisory only, no orders are placed.</p>
${read}
<table style="border-collapse:collapse;width:100%;margin:8px 0">
<tr style="text-align:left;color:#555;font-size:12px"><th style="padding:4px 8px">Strategy</th><th style="padding:4px 8px">LLM</th><th style="padding:4px 8px">Rule</th></tr>
${rows}
</table>
<p style="margin:4px 0 0;font-size:12px;color:#555">Rule: ${esc(s.rule[0]?.reason ?? "")}</p>
<h4 style="margin:12px 0 4px">Top headlines</h4>
<ol style="margin:0;padding-left:20px">${heads || "<li>none</li>"}</ol>
${s.dashboardUrl ? `<p style="font-size:12px"><a href="${esc(s.dashboardUrl)}">Dashboard</a></p>` : ""}
</div>`;

  const text = [
    "SHADOW MODE — advisory only, no orders are placed.",
    "",
    s.llmError ? `LLM call failed: ${s.llmError}` : s.marketRead ?? "",
    "",
    ...STRATEGY_NAMES.map((n) => `${n.padEnd(8)} LLM ${(llm.get(n)?.call ?? "-").padEnd(7)} rule ${rule.get(n)?.call ?? "-"}`),
    "",
    "Top headlines:",
    ...s.headlines.slice(0, 5).map((h, i) => `${i + 1}. ${etTime(h.ts)} ${h.headline}`),
  ].join("\n");

  return { subject, html, text };
}

export async function sendEmail(msg: { subject: string; html: string; text: string }, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const key = env.RESEND_API_KEY;
  const to = env.ALERT_EMAIL;
  if (!key || !to) throw new Error("RESEND_API_KEY / ALERT_EMAIL are not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.ALERT_FROM || "Book advisor <onboarding@resend.dev>",
      to: to.split(",").map((s) => s.trim()),
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  return (JSON.parse(body) as { id?: string }).id ?? "";
}
