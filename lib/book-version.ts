/**
 * Book advisor (10:50 call) versions. Everything that shapes the call is hashed: model, effort, prompt, reply
 * schema, strategies, rule settings, keyword/news screening and the input layout. Calls logged before versions
 * existed are v1 ("legacy"); each later spec gets the next number. Results are reported per version.
 */

import { createHash } from "node:crypto";
import { NEWS_SCREEN } from "@/config/keywords";
import { query as q } from "./db";
import { SYSTEM_PROMPT, llmJsonSchema } from "./decision";
import { effectiveModel, strategyNames, type Settings } from "./settings";

/** 2: VIX/VIX9D and open positions from oo-trading; screened headlines; list-shaped reply. */
export const BOOK_INPUT_LAYOUT = 2;

export function bookVersionSpec(cfg: Settings) {
  return {
    model: effectiveModel(cfg),
    effort: cfg.llm.effort,
    system: SYSTEM_PROMPT,
    schema: llmJsonSchema(strategyNames(cfg)),
    strategies: cfg.strategies,
    maxHeadlines: cfg.llm.maxHeadlines,
    rules: cfg.rules,
    keywords: cfg.keywords,
    newsScreen: NEWS_SCREEN,
    inputLayout: BOOK_INPUT_LAYOUT,
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const bookVersionHash = (cfg: Settings) => createHash("sha256").update(canonical(bookVersionSpec(cfg))).digest("hex");

export interface BookVersion {
  id: number;
  number: number;
  hash: string;
  model: string | null;
  createdAt: string;
}

const NUM = `(SELECT count(*) FROM book_versions o WHERE o.id <= book_versions.id) AS number`;
const toVersion = (r: Record<string, any>): BookVersion => ({ id: Number(r.id), number: Number(r.number), hash: r.hash, model: r.model ?? null, createdAt: new Date(r.created_at).toISOString() });

/** The version row for this spec, created on first use (after a "legacy" v1 row for calls made before versions). */
export async function ensureBookVersion(cfg: Settings): Promise<BookVersion> {
  const hash = bookVersionHash(cfg);
  const sel = () => q(`SELECT *, ${NUM} FROM book_versions WHERE hash = $1`, [hash]);
  let rows = await sel();
  if (!rows.length) {
    await q(`INSERT INTO book_versions (hash, model, spec) VALUES ('legacy-v1', NULL, '{"note":"10:50 calls made before versions existed (until Nov 13, 2026)"}') ON CONFLICT (hash) DO NOTHING`);
    await q(`INSERT INTO book_versions (hash, model, spec) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING`, [hash, effectiveModel(cfg), JSON.stringify(bookVersionSpec(cfg))]);
    rows = await sel();
  }
  return toVersion(rows[0]);
}

export async function listBookVersions(): Promise<BookVersion[]> {
  return (await q(`SELECT *, ${NUM} FROM book_versions ORDER BY id`)).map(toVersion);
}
