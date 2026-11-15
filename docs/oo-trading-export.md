# oo-trading → Book advisor: read-only export endpoint

This is the spec for the one endpoint to add to **oo-trading**. The Book advisor's entry advisor polls it every
~10 seconds during market hours. The response is validated against `lib/entry/contract.ts` in spx-ai-agent, so
any field that is missing or misnamed shows up there as an error.

## Hard rules

1. **Read-only.** `GET` only. The handler adds no Schwab paths to `src/lib/schwab/readonly.ts`, and imports no
   order code (there is none). It does not write to Option Omega and does not trigger anything.
2. **Token-protected.** `Authorization: Bearer <OO_EXPORT_TOKEN>`, compared timing-safe, the same way as the
   ingest route. This is a **new** env var, separate from `OO_INGEST_TOKEN` and `CRON_SECRET`. Without the token,
   or with a wrong one, the endpoint returns 401. It is not behind the NextAuth session, so add it to the
   `proxy.ts` allowlist next to `/api/cron/*`.
3. **No account identifiers.** The response must never contain an account number, `hashValue`, account last-4,
   Schwab order ids or activity ids. Entry ids are a sha256 of the order/activity ids, truncated to 24 hex
   characters.
4. **Cached Schwab calls only.** Use the existing cached fetchers and the shared rate limiter. Transactions should
   be at most ~15 s old during market hours, quotes at most ~10 s. A poll every 10 s must not add Schwab load
   beyond the cache.

## Endpoint

`GET /api/export/advisor?since=<ISO timestamp>` (the advisor sends today's 00:00 ET)

Returns `200 application/json`:

| Field | Meaning |
|---|---|
| `asOf` | server time of this response (ISO) |
| `schwab.connected`, `schwab.fillsFetchedAt`, `schwab.errors[]` | connection health |
| `entries[]` | **opening** entries since `since`, oldest first (see below) |
| `outcomes[]` | `{ entryId, bot, closedAt, pl, how }`: realized P/L per entry once fully closed or expired, net of fees; `how` = "stop", "target", "expired", "closed", … |
| `book.today[]` | `{ entryId, bot, filledAt, status: open\|closed\|stopped\|expired, pl }`: every entry today, P/L so far (open = mark) |
| `book.todayTotal`, `book.stoppedOutBots[]`, `book.daily[]` (`{date, pl}` for the last ~15 trading days), `book.drawdownFromHigh` | book state |
| `bots{<bot>}` | per bot: `last10Days[]` (`{date, trades:[{time, pl}]}` live), `backtest.byEntryTime[]` (`{time:"HH:MM", trades, winRate, avgPl}`), `backtest.byVixBucket[]` (`{bucket, trades, winRate, avgPl}`, buckets exactly `"<15" "15-20" "20-25" "25-30" "30+"`, from the stored OO trades' opening VIX), `liveVsBacktest` (`{days, livePl, backtestPl, gap}` from the scorecard, or null) |
| `market.spx`, `market.vix`, `market.vix9d` | `{ last, quoteTime, prevClose }` from `/marketdata/v1/quotes` (`$SPX`, `$VIX`, `$VIX9D`); `vix9d` may be null |
| `market.snapshots[]` | `{ at, spx, vix, vix9d }`: the quote snapshots taken in the last ~10 minutes (keep a small ring buffer in Redis, appended whenever quotes are fetched; `at` = Schwab quote time) |
| `market.spxBars1m[]` | today's `$SPX` 1-minute bars `{t,o,h,l,c}` (t = bar start, ISO) |
| `market.spxBars5m5d[]`, `market.spxDaily60[]`, `market.vixDaily15[]`, `market.vix9dDaily15[]` | from `/marketdata/v1/pricehistory` |
| `market.gauge.today` | `{ straddle, strike, capturedAt }` from today's 10:00 gauge capture (nulls before then); `market.gauge.avgMoveRatio10d` = mean of the last 10 closed days' `ratio` |

### `entries[]`

One element per bot entry (all legs of one opening order, or of fills that belong together):

```json
{
  "id": "3f1c…(24 hex)",
  "filledAt": "2026-11-12T18:30:04.000Z",
  "detectedAt": "2026-11-12T18:30:11.000Z",
  "bot": "5d IC",
  "candidates": ["5d IC"],
  "match": "exact",
  "matchConfidence": 0.95,
  "matchReason": "IC, 100-wide both sides, 0DTE, 13:30 window",
  "structure": "iron condor",
  "underlying": "SPX",
  "legs": [{ "putCall": "P", "strike": 6700, "qty": -13, "expiration": "2026-11-12" }],
  "contracts": 13,
  "netPrice": 1.85,
  "rules": { "stop": "2× credit", "target": "expire" }
}
```

- **`filledAt`** is **Schwab's fill timestamp**: the latest fill among the entry's opening legs. The advisor
  measures its 60/120-second latency from this, so polling delay counts. **`detectedAt`** is when oo-trading
  first saw the fill (null if unknown).
- **Bot matching** uses `classifyBookEntry` (`src/lib/strategyRules.ts`):
  - `match: "exact"` when exactly one strategy fits; `"ambiguous"` when more than one does (list them in
    `candidates`); `"none"` when nothing fits.
  - `matchConfidence` runs from 0 to 1. Suggested: 1.0 when structure, widths, DTE and the time window all
    agree; 0.8 when it matches only outside the time window; lower when it relied on a tie-break.
  - `matchReason` is a short sentence.
  - The advisor records **no_opinion**, and makes no model call, for anything that isn't `exact`.
- **`netPrice`**: positive = credit, negative = debit, per 1-lot, in index points.
- **`rules`**: the bot's stop and target as configured (free text), or nulls.

## v2 additions (all optional; older exports still validate)

Patch: `docs/oo-trading-advisor-v2.patch` (apply on oo-trading's production branch with `git am`; its tests pass, 140/140).

- `entries[].matchSource`: `"rules"` (structure rules) or `"live_profile"`. When the rules don't fit an entry,
  the export now uses the same attribution as the Live tab (`profileMatch` in `scorecard.ts`: leg signature, nearest
  usual entry time from the OO backtests, usual credit range) and sets a confidence: 0.9, less for an entry time
  away from the usual one, a credit outside the usual range or a close runner-up. The advisor gives no opinion
  below 0.6. Example: Nov 11, 2026 13:30 and 13:35 ICs (puts 55 / calls 50 wide) were `none` and now name
  8SMA IC and $8 IC.
- `book.open[]`: entries still open now: `entryId, bot, filledAt, legs, contracts, pl` (open P/L at the marks).
- `account`: `{ netLiq, startNetLiq, asOf, eod: [{ date, netLiq }] }`: Schwab net liquidation value now and at
  each stored end of day. No account number, hash or last four. The advisor stores every reading and measures the
  packet's drawdown as NLV against its high since Oct 19, 2026. (`book.drawdownFromHigh` only sums the last 15 trading days of book P/L, so it understated the account's
  drawdown; the advisor no longer shows it to the model.)

Until the patch is deployed the advisor still names those ICs itself, from how the bots fill at Schwab
(`config/entry.ts` `LIVE_PROFILES`), and the packet says the account drawdown is unavailable.

## Env vars

| Where | Var | Value |
|---|---|---|
| oo-trading | `OO_EXPORT_TOKEN` | a long random string |
| spx-ai-agent (Vercel) | `OO_EXPORT_URL` | `https://<oo-trading domain>` (no path) |
| spx-ai-agent (Vercel) | `OO_EXPORT_TOKEN` | the same string |

If oo-trading's Vercel deployment has Vercel Authentication on, the advisor's requests are turned away before
they reach the token check. Exempt this path, or set up a protection bypass for automation and tell the advisor
side.

## Tests to add in oo-trading

- 401 without the token, and with a wrong one.
- A JSON-dump scan: the response contains no `accountNumber`, `hashValue`, last-4, `orderId` or `activityId`.
- `entries` built from `test/fixtures-live-entries.json` give the expected `bot`/`match`, and an ambiguous
  structure comes back `"ambiguous"`.
- The read-only guard test still passes, unchanged.
