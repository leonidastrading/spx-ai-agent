/**
 * Client for oo-trading's read-only export endpoint. GET only; the token comes
 * from OO_EXPORT_TOKEN. Nothing here can reach a broker or Option Omega.
 */

import { exportSchema, type OoExport } from "./contract";

export const EXPORT_PATH = "/api/export/advisor";

export interface ExportConfig {
  baseUrl: string;
  token: string;
  /** oo-trading's Vercel "Protection Bypass for Automation" secret, if its deployment is protected. */
  bypass?: string;
}

export function exportConfigFromEnv(env: Record<string, string | undefined> = process.env): ExportConfig | null {
  const baseUrl = env.OO_EXPORT_URL?.trim().replace(/\/+$/, "");
  const token = env.OO_EXPORT_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  if (!/^https:\/\//.test(baseUrl)) throw new Error("OO_EXPORT_URL must be https");
  const bypass = env.OO_EXPORT_BYPASS?.trim();
  return bypass ? { baseUrl, token, bypass } : { baseUrl, token };
}

export type FetchExport = (since: string) => Promise<OoExport>;

export function makeExportClient(cfg: ExportConfig, fetchImpl: typeof fetch = fetch): FetchExport {
  return async (since) => {
    const url = `${cfg.baseUrl}${EXPORT_PATH}?since=${encodeURIComponent(since)}`;
    const headers: Record<string, string> = { authorization: `Bearer ${cfg.token}`, accept: "application/json" };
    if (cfg.bypass) headers["x-vercel-protection-bypass"] = cfg.bypass;
    const res = await fetchImpl(url, { method: "GET", headers, cache: "no-store" });
    if (!res.ok) throw new Error(`oo-trading export ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const parsed = exportSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error(`oo-trading export doesn't match the contract: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    return parsed.data;
  };
}
