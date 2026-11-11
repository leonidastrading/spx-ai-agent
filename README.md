# Morning book advisor (shadow mode) + AI trader paper test

A Next.js (App Router, TypeScript) app on Vercel with three parts behind one login:

1. **Book advisor (shadow mode, never trades).** It watches the US market from 09:30 to 10:50 ET each trading
   day, then logs a **run / reduce / skip** call for each SPX options strategy that enters later in the day. It
   makes two calls: a mechanical rule baseline and an LLM call. A scoring page measures both against your
   Option Omega P/L.
2. **AI day-trader, paper test** (the "Day trader" tab). A forward test of whether an AI model can day-trade QQQ
   profitably. It trades on the Alpaca **paper** account only and gives a yes/no verdict per frozen version.
3. **Swing ideas log, paper** (the "Swing ideas" tab). You record your own ideas with an exit rule set at entry.
   They run on the paper account and are scored against SPY.

## What can and can't place orders

**No part of this app can place, modify or cancel a live order at any broker.**

- **Book advisor: read-only.** All of its Alpaca HTTP goes through `AlpacaClient.get` in `lib/alpaca.ts`. That
  function only issues `GET`, and only to an allowlist:

  | Host | Endpoint | Used for |
  |---|---|---|
  | `data.alpaca.markets` | `GET /v2/stocks/bars` | 1-minute bars (SPY, QQQ, IWM, TLT, VIXY), feed probe |
  | `data.alpaca.markets` | `GET /v2/stocks/quotes/latest` | latest quotes (trader data guard, swing marks) |
  | `data.alpaca.markets` | `GET /v1beta1/news` | Benzinga headlines (`include_content=false`, `sort=asc`, paged with `page_token`) |
  | `api.alpaca.markets` (or `paper-api.alpaca.markets` with `ALPACA_PAPER=true`) | `GET /v2/calendar` | trading days, early closes |
  | same | `GET /v2/clock` | read-only clock (available, not needed by the cron) |

- **Day trader and swing ideas: paper only.** Orders go only through `lib/paper-broker.ts`, whose host is
  hard-wired to `https://paper-api.alpaca.markets`. Before any request, the client checks all of these:
  - `ALPACA_PAPER=true` is set;
  - the key ID is an Alpaca paper key (`PK…`);
  - the method and path are on a short allowlist: submit/get/replace/cancel orders, and read account, position
    and asset.

  Live keys don't authenticate against the paper host in any case. There are no options, margin borrowing or
  leveraged funds, and no Schwab code exists in the repo.
- **Guard tests.** `tests/alpaca.test.ts` scans every source file. It fails if any file other than
  `lib/paper-broker.ts` mentions an order, position or account endpoint, or sends a non-GET request to Alpaca. It
  also fails if the broker file contains the live trading host, or if any file mentions Schwab.
  `tests/paper-broker.test.ts` tests the paper guards.

Other outbound calls: the Anthropic API, and Resend for email if a key is configured (email is optional).

## How it works

| Time (ET) | What happens |
|---|---|
| 09:30–10:50, every minute | Fetch new 1-minute bars and headlines since the newest stored row. Store them (idempotent). Compute and store a `features` row. |
| 10:50 | Final features (bars that closed before 10:50 and headlines before 10:50). Rule call and LLM call, both stored in `decisions`. |
| 10:51 | Email: the LLM's market read, a table of strategy / LLM call / rule call, and the top 5 headlines. |
| 10:51–11:05 | Catch-up only. If the 10:50 run was missed or failed, the decision and email run late, still before the 11:11 "Short" entry. No more data is ingested. |

**Schedule.** Something has to call `GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every minute
on weekday mornings. Each call converts the time to America/New_York and checks the Alpaca calendar. Outside a
trading day or the 09:30–11:05 ET window it logs a `skipped` run and exits, so calling it more often than
needed is harmless. Pick one of two ways:

- **cron-job.org (works on Vercel Hobby).** Create a job:
  - URL: `https://<your-domain>/api/cron/tick`
  - Schedule: every minute, hours 9, 10 and 11, Monday–Friday, time zone **America/New_York** (cron-job.org
    handles DST).
  - Request method: GET, with timeout set to the maximum.
  - Header `Authorization: Bearer <CRON_SECRET>`.
  - If Vercel Authentication (Deployment Protection) is on for production, also send the header
    `x-vercel-protection-bypass: <bypass secret>`. Create that secret under Project → Settings → Deployment
    Protection → Protection Bypass for Automation.
- **Vercel cron (needs Pro).** Copy `vercel.pro.json` over `vercel.json`. It runs every minute from 13:30 to
  16:00 UTC, Mon–Fri, which covers both EDT and EST. On the Hobby plan Vercel rejects any deployment with a
  more-than-daily cron, which is why the committed `vercel.json` has none.

**Idempotency.** Bars are keyed `(symbol, ts)`, headlines by Alpaca id, and features by `(date, minute)`. Inserts
use `ON CONFLICT DO NOTHING`, so re-running a minute duplicates nothing. Decisions are keyed
`(date, strategy, source)` and the email by date: a second run neither re-decides nor re-sends.

**Feed.** If `ALPACA_FEED` is set, it is used. Otherwise each day starts by probing SIP and falling back to IEX
when the subscription refuses (403). The feed is stored on every bar, every features row and every run.

### Features (per minute; `lib/features.ts`)

All prices are SPY (SPX isn't on Alpaca). "Prior close" is the close of the last regular-session 1-minute bar of
the prior session: 15:59 ET, or 12:59 ET after an early close. Features "as of T" use only bars that started
before T, and headlines created in [prior session close, T).

`spy_ret_prev_close_pct`, `spy_ret_open_pct`, `gap_pct`, `spy_high`/`spy_low`, `range_bp` (bp of the open),
`atr30_bp` (mean 1-min true range over 09:30–09:59, bp of the open; uses fewer bars before 10:00), `range_pos`
(0 = day's low, 1 = day's high), `new_highs`/`new_lows` (bars that set a new running extreme),
`qqq_minus_spy_pct` and `iwm_minus_spy_pct` (return from the prior close minus SPY's), `tlt_ret_pct`,
`vixy_ret_pct`, `news_since_prior_close`, `news_since_open`, and the `kw_*` keyword-category counts.

Keyword lists live in **`config/keywords.ts`**, one editable file read by both the cron and the backfill. The
categories are fed/fomc/powell, cpi/ppi/jobs/payrolls, tariff/trade, war/attack/geopolitical,
downgrade/guidance/miss (only when a headline concerns AAPL MSFT NVDA AMZN GOOGL META TSLA) and halt/outage.

### The two calls

- **Rule** (`lib/decision.ts`, thresholds in `config/rules.ts`): `reduce` if today's `atr30_bp` is at or above
  the 90th percentile of the trailing 250 days, OR SPY is more than 1% below the prior close at 10:50. Otherwise
  `run`. The ATR leg needs at least 60 days in `morning_history`. Seed it from the backfill (below) to have the
  full 250 on day one.
- **LLM** (`lib/llm.ts`, model `CLAUDE_MODEL`, default `claude-opus-5-5`): the call sends the 10:50 features, the
  30 most relevant headlines since the prior close (timestamp + headline only) and the strategy list. It does not
  include the rule's call, so the two sources stay independent for scoring. The request uses structured JSON
  output. The app also validates the result with zod: every strategy, `call` ∈ run/reduce/skip, `confidence` in
  0–1, and a reason. A parse or validation failure triggers one retry. A second failure stores an error row
  (`strategy='*'`, `call='error'`). An API/network error is retried on the next minute until 11:04, when an
  error row is stored. Prompt and raw responses are saved in `llm_reads`. For models that support it, the
  request enables Anthropic's server-side refusal fallback (`fallbacks: "default"`).

Strategy names, entry times and descriptions default to `config/strategies.ts`. Like the thresholds, keywords
and model, you can change them on the Settings page.

## Pages

All pages and APIs except `/api/health` and the cron sit behind HTTP basic auth (`DASHBOARD_USER` /
`DASHBOARD_PASSWORD`). `proxy.ts` enforces it, and the upload, export and settings handlers check again. If
either variable is unset, access is refused. Until a database is connected, the pages show a setup checklist
instead of data.

- `/dashboard` (`?date=YYYY-MM-DD`): feature charts for the day, the headlines, both calls with reasons, a history
  table of past calls (LLM / rule) and recent cron runs.
- `/upload`: upload the Option Omega portfolio trade-log CSV. The app maps the `Strategy` column to the short
  names (`OO_STRATEGY_MAP` / `OO_STRATEGY_PATTERNS` in `config/strategies.ts`), sums `P/L` by `Date Opened` and
  strategy, and upserts the result into `outcomes`. Unmapped names and unparseable rows are listed. OO's `P/L`
  is already the trade total across contracts, so it is summed as is.
- `/scoring`: for each source (rule, llm) and strategy, the table shows:
  - the skip/reduce/run day counts and the P/L on each kind of day;
  - the hit rate (a skip or reduce on a losing day is a hit), next to the base loss rate;
  - saved, forgone and **net = saved − forgone**, as if the calls had been followed (skip = no trade,
    reduce = half size).

  A coin-flip baseline places the same number of skip and reduce days at random (2,000 seeded draws). It shows
  the random net's mean, 5th and 95th percentiles, and the share of draws that matched or beat the actual net.
- `/settings`: every input in one place.
  - **Connections & keys:** whether each env var is set. Values are never shown.
  - **Rule thresholds:** ATR percentile, lookback, minimum history, SPY down %.
  - **LLM:** on/off, model, effort, number of headlines sent.
  - **Email:** on/off, recipients.
  - **Strategies:** names, entry times, descriptions.
  - **Option Omega name mapping.**
  - **Keyword categories and mega-cap lists.**

  Settings are validated, saved in the `settings` table, and take effect on the next cron minute. The config
  files are the defaults, and "Reset to defaults" restores them. "Download JSON" exports the settings for the
  backfill's `--settings` option. The minute schedule comes from cron-job.org or Vercel cron (see "Schedule").
- **CSV export**, from the dashboard and scoring pages:
  - `/api/export?type=calls&from=&to=`: one row per day and strategy. It has the LLM call, confidence and
    reason, the rule call and reason, your P/L, `llm_effect`/`rule_effect` (the P/L change if the call had been
    followed), the model and market read, the 10:50 features and the keyword counts.
  - `/api/export?type=features&date=`: every stored minute of one day.

  Free text is guarded against spreadsheet formula injection.
- `/api/health` (no auth): `{ last_successful_run, last_minute_et, ... }`.

## AI day-trader paper test (Part A)

The goal is an honest yes/no after about three months. It is not a trading system. Every rule below is enforced
by code (`config/trader.ts`, `lib/trader/rules.ts`), never by the model.

- **Limits.** QQQ shares only. $10,000 notional per trade (whole shares). One position at a time, at most 3
  trades a day. No entries before 09:35 or after 15:30 ET, and everything is flat by 15:55. No new entries after 2
  losing trades in a row, or after a day's loss of 1.5% of notional ($150).
- **Loop.** A scheduler calls `GET /api/cron/trader` every minute from 09:00 to 16:00 ET. Each tick does the
  following, in order:
  - takes a lease, so ticks never overlap;
  - ingests bars and headlines;
  - syncs fills with the broker;
  - enforces time exits;
  - on decision minutes, calls the model (a pre-market read at 09:25, then every 5 minutes from 09:35 to
    15:30, all on the server clock);
  - syncs swing ideas;
  - after 15:56, checks the decision gate;
  - writes a heartbeat row.

  If no heartbeat arrives for 3 decision cycles (15 minutes) during the session, the next tick records an alert.
  The alert shows on the tab and is emailed if Resend is configured.
- **What the model sees.**
  - QQQ bars: 1-minute for the last 60 minutes, 5-minute for today, 15-minute for 5 days, daily for 60 days.
  - The day so far: prior close, pre-market high and low, today's open, high and low, VWAP, and position in the
    day's range.
  - QQQ against SPY, IWM, TLT and VIXY today.
  - Headlines since its last call, tagged with the advisor's keyword categories.
  - Today's economic releases, which you enter on the tab, because Alpaca has no economic calendar.
  - Its own open position and today's closed trades.

  If the news fetch fails, the model is told and the day is flagged.
- **Reply.** Strict JSON: `{"action": "long"|"short"|"close"|"hold", "confidence": 0-100, "stop", "target",
  "max_hold_minutes", "catalyst", "thesis" (40 words or fewer)}`. The code rejects and logs any entry whose stop
  is not 0.15%–0.75% from the price, whose target is less than 1× the stop distance, or that is on the wrong side
  of the price.
- **Exits.** Exits are fixed at entry: a bracket order (stop and target at the broker), the time limit, or 15:55.
  The model may tighten a stop. A wider stop is ignored, and the target can't be removed.
- **Logged before orders, never edited.** Every decision is logged before any order is sent: the inputs and their
  sha256 hash, the JSON reply and a server timestamp. Database triggers make decisions, versions, verdicts and
  stop changes append-only: UPDATE, DELETE and TRUNCATE all fail.
- **Data guards.** The code takes no action, and logs "no action: bad data", when:
  - the latest quote is more than 10 s old;
  - any of the last 15 one-minute bars is missing;
  - a bar or quote timestamp is more than 5 s ahead of the server clock.

  Each tick re-fetches the last 16 minutes, so bars that arrive late fill their gaps.
- **Versions.** A version is the sha256 of the model, effort, prompt, reply schema and rules. Changing any of
  them starts a new version, and results are reported per version. Don't tune the prompt on results of the version
  being scored. There's no refusal fallback, because that would silently switch models inside a version.
- **Scoring** (`/trader/scoring`). Per version, gross and net of $0.01/share slippage each way:
  - trades, win rate, average win and loss, expectancy, total and max drawdown;
  - buy and hold, QQQ open to close on the same days;
  - random entries: 20 simulated trades per real trade, with the same stop, target and time limit, on the
    recorded bars; the page shows the percentile of the real result;
  - breakdowns by confidence, time of day, direction, catalyst and exit;
  - a "3× hypothetical" (a calculation only);
  - LLM cost per day and per trade.
- **Decision gate.** After 150 trades **and** 60 trading days, the version gets Pass only if all three hold:
  - net expectancy is above 0;
  - it is above the 95th percentile of random entries;
  - net P/L ÷ max drawdown beats buy and hold's.

  Otherwise it's Fail: the version stops entering trades and keeps its record.
- **Starts off.** Trading is off until you switch it on in the tab. Decisions are logged either way.

### Turning it on

1. **Give each part its own Alpaca paper account.** Create two extra paper accounts in the Alpaca dashboard
   (they're free): one for the trader and one for the swing sleeve. Don't use the account any other bot trades.
   For example, a bot that closes everything at 3:57 PM would close the swing ideas every afternoon. Put the keys
   in Vercel as `TRADER_ALPACA_KEY_ID` / `TRADER_ALPACA_SECRET_KEY` and `SWING_ALPACA_KEY_ID` /
   `SWING_ALPACA_SECRET_KEY`, keep `ALPACA_PAPER=true`, and redeploy. There's no fallback to `ALPACA_API_KEY_ID`,
   which is only used for market data and news. The app refuses if both parts share one key. Each tab shows the
   account number it trades, so check it against the Alpaca dashboard.
2. Add a second cron-job.org job:
   - URL: `https://<your-domain>/api/cron/trader`
   - Schedule: every minute, hours 9–15 plus 16:00, Monday–Friday, America/New_York.
   - Headers: the same `Authorization: Bearer <CRON_SECRET>` and `x-vercel-protection-bypass` as the advisor job.
   - Timeout at its maximum, and **failure emails on**: nothing inside the app can notice if the scheduler
     itself stops.
3. Enter the week's economic releases on the Day trader tab.
4. Run one full day with trading **off**. Look at the decision log, the "no action: bad data" count and the
   LLM cost.
5. Switch on "Paper trading" the day after, if the day looked clean, and check the first live morning around
   09:40 ET.

**Reading the results honestly.**
- **The free IEX feed** carries a small share of QQQ's volume. Some minutes have no bar, and prices can sit
  slightly off the wider market. If "no action: bad data" is frequent, the test needs Alpaca's paid SIP feed
  (`ALPACA_FEED=sip`) to mean anything.
- **Paper fills are generous:** at the quote, with no queue. The $0.01/share slippage covers only part of
  that, so treat a marginal Pass as a Fail.
- **Missed releases:** if you forget to enter a CPI or Fed day, the model trades through it blind.

## Swing ideas log (Part B)

- **Saving an idea.** Each idea has a ticker, direction, thesis, catalyst (news, panic dip, theme or earnings),
  size, a speculative flag, and one exit rule chosen at entry: a price target, a trailing stop (%) or a time limit
  (days). Saving checks the sleeve limits and sends a paper market order. The entry price is the fill. If the
  market is closed, the order is queued for the open.
- **Sleeve limits.** The sleeve is $100,000. No idea may be above $10,000, and speculative ideas may total at most
  $5,000. QQQ, leveraged and inverse funds, and anything Alpaca can't trade (or can't easily borrow, for shorts)
  are refused.
- **Exits.** Exits follow the rule automatically: a GTC limit order for a target, a GTC trailing-stop order, or a
  market order once the time limit passes (checked by the trader tick).
- **Locked.** Ideas and their fill events are append-only, enforced by database triggers.
- **Scoring.** For each idea: its return, SPY over the same holding period, and the excess return. Overall: win
  rate, average excess return, and the sleeve's total against SPY. The verdict comes after 30 closed ideas or 6
  months. It says "beats SPY" only if the average excess return is positive and the sleeve is ahead of SPY.

## Setup

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill in `.env.local` (never commit it; `.env*` is git-ignored except `.env.example`):

| Variable | Required | Notes |
|---|---|---|
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | yes | Market data keys. Never logged. |
| `ALPACA_FEED` | no | `sip` or `iex`; blank = probe SIP, fall back to IEX |
| `ALPACA_PAPER` | no | `true` if your keys are paper keys (calendar/clock then come from paper-api; still read-only) |
| `ALPACA_MAX_RPM` | no | client-side request cap per minute, default 190 |
| `ANTHROPIC_API_KEY` | yes | |
| `CLAUDE_MODEL` | no | default `claude-opus-5-5` |
| `DATABASE_URL` | yes | Neon / Vercel Postgres connection string (`POSTGRES_URL` also accepted) |
| `RESEND_API_KEY`, `ALERT_EMAIL` | no | only for the 10:51 email; without `RESEND_API_KEY` no email is sent. `ALERT_EMAIL` may be a comma-separated list |
| `ALERT_FROM` | no | verified Resend sender, default `Book advisor <onboarding@resend.dev>` |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | yes | basic auth for all pages |
| `CRON_SECRET` | yes | Vercel sends `Authorization: Bearer $CRON_SECRET` to the cron route |
| `TRADER_ALPACA_KEY_ID`, `TRADER_ALPACA_SECRET_KEY` | for the day trader | the trader's **own** Alpaca paper account (paper keys only) |
| `SWING_ALPACA_KEY_ID`, `SWING_ALPACA_SECRET_KEY` | for swing ideas | the swing sleeve's own paper account, different from the trader's |
| `APP_URL` | no | used for the dashboard link in the email (defaults to the Vercel production URL) |

Tables are created automatically the first time the app touches the database. To create them up front
instead (idempotent):

```bash
npx tsx scripts/migrate.ts
```

Run locally, then trigger a tick by hand (outside market hours it logs a skip):

```bash
npm run dev
```

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick
```

Tests and type check:

```bash
npm test
```

```bash
npm run typecheck
```

## Deploy (Vercel)

1. Create a Postgres database: Vercel project → Storage → Create Database → Neon, connected to this project. That
   sets `DATABASE_URL`. Tables are created on first use.
2. Import the repo into Vercel.
3. Add every variable from the table above under Project → Settings → Environment Variables (Production).
4. Deploy, then set up the schedule (cron-job.org, or Vercel cron on Pro; see "Schedule" above).
5. Optional but recommended: run the backfill and seed `morning_history`, so the ATR rule has a full 250-day
   window from the first day:

   ```bash
   npx tsx scripts/seed-history.ts data/morning_features.csv
   ```

The cron route allows up to 300 s (`maxDuration`), which covers the 10:50 run with its LLM call.

## Historical backfill (local, not on Vercel)

```bash
npx tsx scripts/backfill.ts --from 2016-01-01 --to 2026-10-30
```

(The scripts read `.env.local` / `.env` themselves; variables already in your shell take precedence. `--to`
defaults to yesterday, ET.) Options: `--out DIR` (default `data`), `--feed sip|iex`, `--skip-news`, `--rpm N`, `--settings FILE`. The
last takes a JSON file downloaded from the Settings page, so the backfill uses the same thresholds and keyword
lists as the live app.

- The script pulls SPY/QQQ/IWM/TLT/VIXY 1-minute bars and all news headlines, month by month. It throttles to
  `--rpm` requests a minute and retries 429s (honouring `retry-after` / `x-ratelimit-reset`) and 5xx errors with
  backoff.
- **Resume:** each finished month is cached under `DIR/.cache` and recorded in `DIR/.cache/checkpoint.json`.
  Re-running skips finished months. An interrupted month is fetched again from its start. The final CSVs are
  rebuilt from the cache on every run.
- Outputs:
  - `data/bars_<SYMBOL>.csv`: `ts_utc,o,h,l,c,v,feed`, regular-session bars only.
  - `data/news.csv`: `id,ts_utc,headline,symbols,source`, with symbols separated by `|`.
  - `data/morning_features.csv`: one row per session with the step-3 features computed at 10:50 ET by the
    same `computeFeatures` the cron uses. It adds `early_close`, `atr30_pct_rank`, `atr30_history_days` and the
    mechanical `rule_call`.
- **No LLM calls in the backfill.** Historical tagging is keyword counts only. A model may already know how past
  days turned out, and that would fake an edge.
- The free Alpaca plan allows historical SIP data (older than 15 minutes), so the probe usually picks SIP for the
  backfill even when the live cron has to use IEX. Compare the two feeds with care: IEX volumes and ranges are
  smaller.

## Code layout

```
config/keywords.ts     default keyword categories     (overridable on /settings)
config/strategies.ts   default strategies + OO mapping (overridable on /settings)
config/rules.ts        symbols, default thresholds, schedule, default model
lib/settings.ts        settings schema, defaults, validation, env status  (pure)
lib/export.ts          CSV exports                                        (pure)
lib/schema.ts          database schema (auto-applied)
lib/time.ts            ET/DST conversion, calendar helpers, cron gate        (pure)
lib/alpaca.ts          read-only Alpaca client + response parsing            (GET-only, allowlisted)
lib/features.ts        feature computation                                   (pure)
lib/news.ts            keyword tagging, headline relevance                   (pure)
lib/decision.ts        rule baseline, LLM prompt, output validation          (pure)
lib/scoring.ts         scoring + coin-flip baseline                          (pure)
lib/optionomega.ts     trade-log parsing                                     (pure)
lib/backfill.ts        backfill chunking + per-day feature loop              (pure)
lib/llm.ts, email.ts   Anthropic and Resend calls
lib/db.ts              Postgres access, settings storage
lib/agent.ts           one cron tick (ingest → features → decide → email), logged to `runs`
config/trader.ts       AI trader + swing hard limits (not editable in the UI)
lib/paper-broker.ts    the only order-capable client: Alpaca PAPER host only, PK keys only
lib/trader/            rules (pure), prompt + version hash (pure), scoring + simulation (pure),
                       store, model call, report, engine (one tick)
lib/swing/             rules + scoring (pure), engine (entries, exits, fills)
scripts/               backfill.ts, migrate.ts, seed-history.ts
tests/                 vitest on fixed sample data (DST transitions, early closes, a simulated morning)
```
