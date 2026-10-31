/**
 * Database schema. Idempotent (CREATE ... IF NOT EXISTS): applied automatically
 * on first use by lib/db.ts, and by `npx tsx scripts/migrate.ts`.
 */
export const SCHEMA_SQL = `-- Morning book advisor schema. Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS bars (
  symbol text NOT NULL,
  ts timestamptz NOT NULL,           -- bar start (UTC)
  o double precision NOT NULL,
  h double precision NOT NULL,
  l double precision NOT NULL,
  c double precision NOT NULL,
  v bigint NOT NULL,
  feed text NOT NULL,                -- 'sip' | 'iex'
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE IF NOT EXISTS news (
  id bigint PRIMARY KEY,             -- Alpaca/Benzinga news id
  ts timestamptz NOT NULL,           -- created_at (UTC)
  headline text NOT NULL,
  summary text NOT NULL DEFAULT '',
  symbols text[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS news_ts_idx ON news (ts);

-- One row per processed minute (ET wall time); data holds the Features object.
CREATE TABLE IF NOT EXISTS features (
  date date NOT NULL,
  minute_et text NOT NULL,           -- 'HH:MM' as-of time
  as_of timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (date, minute_et)
);

-- Daily 10:50 snapshot used for the trailing ATR percentile. Filled by the
-- cron at decision time and seedable from data/morning_features.csv.
CREATE TABLE IF NOT EXISTS morning_history (
  date date PRIMARY KEY,
  atr30_bp double precision,
  spy_ret_prev_close_pct double precision,
  source text NOT NULL DEFAULT 'live'  -- 'live' | 'backfill'
);

CREATE TABLE IF NOT EXISTS decisions (
  date date NOT NULL,
  strategy text NOT NULL,            -- strategy short name, or '*' for an error row
  source text NOT NULL CHECK (source IN ('rule', 'llm')),
  call text NOT NULL CHECK (call IN ('run', 'reduce', 'skip', 'error')),
  confidence double precision,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, strategy, source)
);

-- The LLM's market read and raw output, one row per day.
CREATE TABLE IF NOT EXISTS llm_reads (
  date date PRIMARY KEY,
  model text NOT NULL,
  market_read text,
  prompt text NOT NULL,
  raw jsonb NOT NULL,                -- attempts: [{ok, text, error}]
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS emails_sent (
  date date PRIMARY KEY,
  subject text NOT NULL,
  provider_id text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outcomes (
  date date NOT NULL,
  strategy text NOT NULL,
  pl double precision NOT NULL,
  trades integer NOT NULL DEFAULT 0,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, strategy)
);

CREATE TABLE IF NOT EXISTS runs (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  minute_et text,                    -- 'YYYY-MM-DD HH:MM' processed, null when skipped
  action text NOT NULL,              -- skip | ingest | decide_only
  status text NOT NULL,              -- running | ok | skipped | error
  feed text,
  rows_written jsonb NOT NULL DEFAULT '{}',
  detail text,
  error text
);
CREATE INDEX IF NOT EXISTS runs_started_idx ON runs (started_at DESC);

-- Editable inputs from the Settings page (one row, key 'app'). Defaults live in config/.
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

/** Split into single statements (the HTTP driver runs one statement per query). */
export function schemaStatements(): string[] {
  return SCHEMA_SQL.split(/;\s*$/m)
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean);
}
