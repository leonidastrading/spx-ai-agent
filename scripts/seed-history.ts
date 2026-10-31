/**
 * Seed morning_history (trailing ATR window for the rule) from the backfill's
 * morning_features.csv, so the live rule has 250 days of history on day one.
 *   npx tsx scripts/seed-history.ts [data/morning_features.csv]
 * Live rows (source='live') are never overwritten.
 */

import "./env";
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { parseCsvObjects } from "@/lib/csv";

const file = process.argv[2] ?? "data/morning_features.csv";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = neon(url);

const num = (s: string) => (s === "" ? null : Number(s));
const rows = parseCsvObjects(readFileSync(file, "utf8")).filter((r) => r.date);
let written = 0;
for (let i = 0; i < rows.length; i += 1000) {
  const c = rows.slice(i, i + 1000);
  const res = await sql.query(
    `INSERT INTO morning_history (date, atr30_bp, spy_ret_prev_close_pct, source)
     SELECT d, a, r, 'backfill' FROM unnest($1::date[], $2::float8[], $3::float8[]) AS t(d, a, r)
     ON CONFLICT (date) DO UPDATE SET atr30_bp = excluded.atr30_bp, spy_ret_prev_close_pct = excluded.spy_ret_prev_close_pct
       WHERE morning_history.source = 'backfill'
     RETURNING 1`,
    [c.map((r) => r.date), c.map((r) => num(r.atr30_bp)), c.map((r) => num(r.spy_ret_prev_close_pct))],
  );
  written += res.length;
}
console.log(`Seeded ${written} of ${rows.length} days into morning_history.`);
