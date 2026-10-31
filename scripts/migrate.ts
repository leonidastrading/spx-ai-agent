/** Apply db/schema.sql to DATABASE_URL. Usage: npx tsx scripts/migrate.ts */
import "./env";
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = neon(url);
const statements = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8")
  .split(/;\s*$/m)
  .map((s) => s.replace(/--.*$/gm, "").trim())
  .filter(Boolean);
for (const st of statements) await sql.query(st);
console.log(`Applied ${statements.length} statements.`);
