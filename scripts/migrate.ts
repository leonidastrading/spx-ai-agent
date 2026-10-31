/** Apply the schema to DATABASE_URL. Usage: npx tsx scripts/migrate.ts (the app also does this on first use). */
import "./env";
import { neon } from "@neondatabase/serverless";
import { schemaStatements } from "@/lib/schema";

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = neon(url);
const statements = schemaStatements();
for (const st of statements) await sql.query(st);
console.log(`Applied ${statements.length} statements.`);
