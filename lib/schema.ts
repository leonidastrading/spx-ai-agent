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

-- ===================== AI day-trader paper test (Part A) =====================

-- Append-only guard: logged decisions, versions, verdicts and ideas are never edited or deleted.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME; END $fn$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS trader_versions (
  id serial PRIMARY KEY,
  hash text NOT NULL UNIQUE,         -- sha256 of model + effort + prompt + schema + rules
  model text NOT NULL,
  effort text NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER trader_versions_ro BEFORE UPDATE OR DELETE ON trader_versions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER trader_versions_rot BEFORE TRUNCATE ON trader_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE TABLE IF NOT EXISTS trader_decisions (
  id bigserial PRIMARY KEY,
  version_id int NOT NULL REFERENCES trader_versions(id),
  slot text NOT NULL,                -- 'YYYY-MM-DD HH:MM' ET (server clock)
  phase text NOT NULL,               -- premarket | intraday
  server_ts timestamptz NOT NULL,    -- server clock when logged
  inputs_hash text,
  inputs jsonb,
  reply jsonb,
  reply_text text,
  status text NOT NULL,              -- accepted | rejected | hold | no_action | error
  reason text,
  model_served text,
  usage jsonb,
  cost_usd double precision,
  data_ok boolean,
  news_ok boolean,
  UNIQUE (version_id, slot)
);
CREATE OR REPLACE TRIGGER trader_decisions_ro BEFORE UPDATE OR DELETE ON trader_decisions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER trader_decisions_rot BEFORE TRUNCATE ON trader_decisions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Execution records (order ids, fills, exits) for accepted entries.
CREATE TABLE IF NOT EXISTS trader_trades (
  id bigserial PRIMARY KEY,
  version_id int NOT NULL REFERENCES trader_versions(id),
  decision_id bigint NOT NULL UNIQUE REFERENCES trader_decisions(id),
  date date NOT NULL,
  side text NOT NULL,                -- long | short
  qty integer NOT NULL,
  ref_price double precision NOT NULL,
  stop_initial double precision NOT NULL,
  stop double precision NOT NULL,
  target double precision NOT NULL,
  max_hold_minutes integer NOT NULL,
  confidence double precision NOT NULL,
  catalyst text NOT NULL,
  client_order_id text NOT NULL UNIQUE,
  entry_order_id text,
  stop_order_id text,
  target_order_id text,
  close_order_id text,
  entry_price double precision,
  entry_at timestamptz,
  exit_price double precision,
  exit_at timestamptz,
  exit_reason text,                  -- stop | target | time | eod | model
  status text NOT NULL,              -- submitting | pending | open | closing | closed | failed
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trader_trades_date_idx ON trader_trades (date);

CREATE TABLE IF NOT EXISTS trader_stop_changes (
  id bigserial PRIMARY KEY,
  trade_id bigint NOT NULL REFERENCES trader_trades(id),
  decision_id bigint NOT NULL REFERENCES trader_decisions(id),
  old_stop double precision NOT NULL,
  new_stop double precision NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER trader_stop_changes_ro BEFORE UPDATE OR DELETE ON trader_stop_changes FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE IF NOT EXISTS trader_heartbeats (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  minute_et text NOT NULL,
  status text NOT NULL,              -- ok | skipped | error
  detail text
);
CREATE INDEX IF NOT EXISTS trader_heartbeats_ts_idx ON trader_heartbeats (ts DESC);

CREATE TABLE IF NOT EXISTS trader_alerts (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  message text NOT NULL,
  emailed boolean NOT NULL DEFAULT false
);

-- Day flags (e.g. the news feed was down at some point that day).
CREATE TABLE IF NOT EXISTS trader_days (
  date date NOT NULL,
  version_id int NOT NULL REFERENCES trader_versions(id),
  news_down boolean NOT NULL DEFAULT false,
  notes text,
  PRIMARY KEY (date, version_id)
);

CREATE TABLE IF NOT EXISTS trader_verdicts (
  version_id int PRIMARY KEY REFERENCES trader_versions(id),
  verdict text NOT NULL,             -- pass | fail
  decided_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL
);
CREATE OR REPLACE TRIGGER trader_verdicts_ro BEFORE UPDATE OR DELETE ON trader_verdicts FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Scheduled economic releases (entered on the Day trader tab; Alpaca has no calendar for these).
CREATE TABLE IF NOT EXISTS econ_events (
  id bigserial PRIMARY KEY,
  date date NOT NULL,
  time_et text NOT NULL,
  event text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lease so overlapping cron ticks don't act twice.
CREATE TABLE IF NOT EXISTS trader_lock (
  key text PRIMARY KEY,
  until timestamptz NOT NULL
);

-- ===================== Swing ideas log (Part B) =====================

CREATE TABLE IF NOT EXISTS swing_ideas (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  ticker text NOT NULL,
  side text NOT NULL,
  thesis text NOT NULL,
  catalyst text NOT NULL,
  speculative boolean NOT NULL,
  notional double precision NOT NULL,
  exit_rule text NOT NULL,           -- target | trailing | time
  exit_param double precision NOT NULL,
  ref_price double precision NOT NULL
);
CREATE OR REPLACE TRIGGER swing_ideas_ro BEFORE UPDATE OR DELETE ON swing_ideas FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER swing_ideas_rot BEFORE TRUNCATE ON swing_ideas FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE TABLE IF NOT EXISTS swing_events (
  id bigserial PRIMARY KEY,
  idea_id bigint NOT NULL REFERENCES swing_ideas(id),
  kind text NOT NULL,
  order_id text,
  price double precision,
  qty integer,
  spy_price double precision,
  at timestamptz NOT NULL DEFAULT now(),
  detail text
);
CREATE OR REPLACE TRIGGER swing_events_ro BEFORE UPDATE OR DELETE ON swing_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER swing_events_rot BEFORE TRUNCATE ON swing_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ===================== Entry advisor (shadow mode) =====================

CREATE TABLE IF NOT EXISTS entry_versions (
  id serial PRIMARY KEY,
  hash text NOT NULL UNIQUE,         -- sha256 of model + effort + prompt + reply schema + packet layout + rules
  model text NOT NULL,
  effort text NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER entry_versions_ro BEFORE UPDATE OR DELETE ON entry_versions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER entry_versions_rot BEFORE TRUNCATE ON entry_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- One logged call per bot entry per version, written before the trade's outcome is known.
CREATE TABLE IF NOT EXISTS entry_calls (
  id bigserial PRIMARY KEY,
  version_id int NOT NULL REFERENCES entry_versions(id),
  entry_id text NOT NULL,
  bot text,
  match text NOT NULL,               -- exact | ambiguous | none
  match_confidence double precision NOT NULL,
  match_reason text,
  filled_at timestamptz NOT NULL,    -- Schwab fill time: latency is measured from here
  detected_at timestamptz NOT NULL,  -- when this app first saw the entry
  logged_at timestamptz NOT NULL,
  latency_ms integer NOT NULL,       -- logged_at - filled_at
  status text NOT NULL,              -- called | no_opinion | late | error
  status_reason text,
  verdict text,                      -- take | reduce | skip (null unless the model answered)
  confidence double precision,
  day_type text,
  reply jsonb,
  reply_text text,
  data_ok boolean,
  packet_complete boolean,
  packet_hash text,
  packet jsonb,
  model_served text,
  usage jsonb,
  cost_usd double precision,
  vix_change_pct double precision,
  UNIQUE (version_id, entry_id)
);
CREATE INDEX IF NOT EXISTS entry_calls_filled_idx ON entry_calls (filled_at);
CREATE OR REPLACE TRIGGER entry_calls_ro BEFORE UPDATE OR DELETE ON entry_calls FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER entry_calls_rot BEFORE TRUNCATE ON entry_calls FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Actual P/L per entry (from oo-trading's Schwab fills), filled in after the trade closes.
CREATE TABLE IF NOT EXISTS entry_outcomes (
  entry_id text PRIMARY KEY,
  bot text,
  date date NOT NULL,
  pl double precision NOT NULL,
  closed_at timestamptz NOT NULL,
  how text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The book as oo-trading reported it on each poll, so a packet can use the state at or before a fill.
CREATE TABLE IF NOT EXISTS entry_book_snapshots (
  id bigserial PRIMARY KEY,
  as_of timestamptz NOT NULL,
  book jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS entry_book_snapshots_idx ON entry_book_snapshots (as_of DESC);

-- Quote snapshots (SPX / VIX / VIX9D) seen on polls, for "value at or before the fill".
CREATE TABLE IF NOT EXISTS entry_quote_snapshots (
  at timestamptz PRIMARY KEY,
  spx double precision NOT NULL,
  vix double precision,
  vix9d double precision
);

-- VIX closes per day, for day-type definitions.
CREATE TABLE IF NOT EXISTS entry_market_days (
  date date PRIMARY KEY,
  vix_close double precision,
  vix_prev_close double precision,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Daily pre-open summary of the last 10 days of market-moving news (an input, never edited).
CREATE TABLE IF NOT EXISTS entry_news_summaries (
  date date PRIMARY KEY,
  as_of timestamptz NOT NULL,
  text text NOT NULL,
  model text NOT NULL,
  cost_usd double precision
);
CREATE OR REPLACE TRIGGER entry_news_summaries_ro BEFORE UPDATE OR DELETE ON entry_news_summaries FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Vadim's own pre-open call, locked once saved (and only accepted before 09:30 ET).
CREATE TABLE IF NOT EXISTS entry_human_calls (
  date date PRIMARY KEY,
  call text NOT NULL CHECK (call IN ('normal', 'half', 'skip_afternoon')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER entry_human_calls_ro BEFORE UPDATE OR DELETE ON entry_human_calls FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE IF NOT EXISTS entry_verdicts (
  version_id int PRIMARY KEY REFERENCES entry_versions(id),
  verdict text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL
);
CREATE OR REPLACE TRIGGER entry_verdicts_ro BEFORE UPDATE OR DELETE ON entry_verdicts FOR EACH ROW EXECUTE FUNCTION forbid_change();
`;

/** Split into single statements (the HTTP driver runs one statement per query). */
export function schemaStatements(): string[] {
  return SCHEMA_SQL.split(/;\s*$/m)
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean);
}
