/** Load .env.local / .env for local scripts (existing environment variables win). */
import { existsSync } from "node:fs";

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
