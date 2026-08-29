# vast-monitor

`vast-monitor` is a Node.js service for monitoring a Vast.ai host fleet.

It polls your hosted machines from Vast, enriches them with datacenter metadata, stores current state and history in SQLite, emits alerts, and serves a lightweight dashboard over Express.

## Raw market archive extension

This fork contains an optional append-only PostgreSQL raw-response archive. It is
off by default. Enable it only with both `RAW_ARCHIVE_ENABLED=true` and
`PLUGIN_MODULES=src/plugins/raw-market/index.js`, plus a writer `DATABASE_URL`
and `VAST_API_KEY_PATH`. Before enabling it, apply the explicit owner-only,
non-destructive migration: `OWNER_DATABASE_URL=... node scripts/migrate-raw-market.js`.
Normal monitor startup never migrates the raw PostgreSQL schema. The extension
archives exact response bytes only; it does not normalize offers or conduct
market/pricing analysis. Its health is at `/api/extensions/raw-market/health`.

The maintained local deployment contract is [`compose.yml`](compose.yml). It
connects the monitor to an externally provisioned PostgreSQL archive so an
existing raw history can be retained. Before the owner-only migration, create
the least-privilege writer login once with
`psql -v writer_password='...' -f scripts/bootstrap-raw-market-roles.sql`.
Pass only that writer DSN to the monitor, preferably through
`DATABASE_URL_FILE`; do not put it in the image or a tracked Compose file.

For the existing Threadripper deployment, use
[`compose.threadripper.example.yml`](compose.threadripper.example.yml) as the
site override. It deliberately bind-mounts the existing SQLite directory and
writer-DSN secret, rather than creating a new history volume. Release images
are published by GitHub Actions and the workflow summary prints the immutable
`VAST_MONITOR_IMAGE=ghcr.io/...@sha256:...` value to use for that override.

## Vast observatory collector

The image also contains a standalone passive collector, launched with
`npm run start:observatory`. It does not start the dashboard, poll SQLite, inspect
renter processes, or call any Vast mutation command. Its authenticated CLI surface is
fixed to `show machines --raw`, `show instances --raw`, and `show earnings --raw`.

Each five-minute run archives the returned bytes and writes queryable PostgreSQL
observations from:

- the official Vast GPU catalog and all-GPU current market metrics;
- the complete response published by each 500.farm `/machines`, `/offers`, `/hosts`,
  `/gpu-stats`, and `/gpu-stats/v2` feed; and
- the authenticated account machine, instance, and earnings reads above.

Apply the owner migration first with
`OWNER_DATABASE_URL=... npm run migrate:observatory`. Runtime accepts only the writer
`DATABASE_URL` or `DATABASE_URL_FILE`; the API key can be supplied as `VAST_API_KEY` or by mounting
`VAST_API_KEY_PATH`. `npm run start:observatory -- --once` performs one immediately
verifiable run. The collector records its source-contract version, Git revision, image
digest, raw response hashes, source-declared counts, normalized rows, and failures in the
fresh `vast_observatory` database. Its schemas are `ops`, `raw`, `market`, `host`, and
`derived`.

## Features

- Polls `vast show machines --raw` on a schedule
- Enriches machines with Vast datacenter metadata from the Vast API
- Tracks listed vs unlisted machines and maintenance windows
- Excludes machines that have been offline for more than 24 hours from fleet totals and trend charts while keeping them visible in the machine list
- Captures machine-level error messages from Vast machine state
- Tracks current machine state, machine snapshots including `listed_gpu_cost` and `listed_min_gpu_count` history, fleet snapshots, alerts, and events in SQLite
- Detects host up/down transitions and rental activity changes
- Emits warning alerts when the same hostname appears multiple times in a single poll
- Computes rolling uptime for `24h`, `7d`, and `30d`
- Shows fleet health, listed-only utilisation, earnings, trends, hoverable chart values, and datacenter tags in a browser dashboard
- Adds local browser settings for dashboard mode, table density, and frontend-only alert thresholds
- Persists machine table filters, dedicated GPU-type filters, and the active/archive machine tab with a hybrid URL + local browser storage approach
- Lets you click GPU names in `GPU Type Breakdown` to toggle exact GPU-type filters in the machine table
- Adds current Vast-wide GPU utilisation benchmarks from `500.farm/vastai-exporter/gpu-stats` to matched GPU rows in `GPU Type Breakdown`
- Shows a custom hover card on `Vast Util` with platform-wide GPU counts and pricing percentiles for matched GPU rows
- Persists matched Vast-wide benchmark snapshots so the utilisation chart can compare your fleet history against historical market benchmarks
- Highlights average listed GPU prices against the current Vast median in `GPU Type Breakdown`
- Exposes JSON endpoints for status, health, history, alerts, fleet trends, and hourly earnings

## Requirements

- Node.js 20+ recommended
- A working Vast CLI install
- A valid Vast API key file
- Python 3 environment used by the Vast CLI must have `python-dateutil >= 2.7`

Default assumptions:

- Vast CLI: `~/Desktop/dev/vast/vast`
- Vast API key: `~/.config/vastai/vast_api_key`

Live machine earnings in this app depend on the Vast CLI `show earnings` command. If the CLI is using an old `python-dateutil` release such as `2.6.1`, that command can fail under newer Python versions. A known-good fix is:

```bash
python3 -m pip install --user --break-system-packages --upgrade python-dateutil
```

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

Then open `http://localhost:3000`.

Startup validates the configured Vast CLI path and API key file before the service begins listening. If either is missing, unreadable, or not executable where required, the process exits with a direct error.

Startup also prints a warning if the detected `python-dateutil` version in the local `python3` environment is too old for live Vast earnings.

On startup, managed SQLite schema migrations are applied automatically via a `schema_migrations` table. Missing `fleet_snapshots` are backfilled from `machine_snapshots` so historical fleet charts stay populated without forcing a full rebuild on every launch. A small internal metadata version also lets the app intentionally rebuild all derived fleet snapshots when aggregation rules change in the future.

## Configuration

Environment variables:

- `POLL_INTERVAL_MS`: poll interval in milliseconds, default `300000`
- `VAST_CLI_PATH`: path to the Vast CLI binary
- `VAST_API_URL`: Vast API base URL, default `https://console.vast.ai/api/v0`
- `VAST_API_KEY_PATH`: path to the Vast API key file
- `ALERT_TEMP_THRESHOLD`: GPU temperature alert threshold, default `85`
- `ALERT_IDLE_HOURS`: idle alert threshold in hours, default `6`
- `ALERT_COOLDOWN_MINUTES`: cooldown for repeated noisy alerts such as `new_reports`, `high_temp`, and `idle`, default `60`
- `ALERT_HOSTNAME_COLLISION_COOLDOWN_MINUTES`: longer cooldown for repeated hostname-collision alerts, default `360`
- `ADMIN_API_TOKEN`: optional shared secret required for `/api/admin/*`; when unset, admin routes are disabled
- `PORT`: HTTP port, default `3000`
- `DB_PATH`: SQLite database path, default `./data/vast-monitor.db`
- `DB_SNAPSHOT_RETENTION_DAYS`: optional retention window for raw `machine_snapshots`, `polls`, and derived `fleet_snapshots`; older machine snapshots, fleet snapshots, GPU-type utilization history, and GPU-type price history are first compacted into hourly rollups used for long-range history reads; `0` disables pruning
- `DB_SNAPSHOT_RETENTION_DAYS` also compacts persisted external Vast benchmark snapshots into hourly rollups before deleting old raw benchmark rows, so historical benchmark comparison lines survive retention in reduced hourly resolution
- `DB_ALERT_RETENTION_DAYS`: optional retention window for `alerts`; `0` disables pruning
- `DB_EVENT_RETENTION_DAYS`: optional retention window for `events`; `0` disables pruning
- `PLUGIN_MODULES`: optional comma-separated plugin module paths relative to the project root or absolute paths

## Plugins

This project supports optional runtime plugins so company-specific features can live outside the public core.

Plugin modules are loaded from `PLUGIN_MODULES`, for example:

```bash
PLUGIN_MODULES=./plugins/company-plugin.js
```

A plugin can optionally provide:

- `enrichMachine({ machine, previous, config, db, monitor })`
- `decorateStatusMachine({ machine, config, db, monitor })`
- `buildAlerts({ previous, current, timestamp, config, db, monitor })`
- `registerRoutes({ app, config, db, monitor })`
- `clientAssets`

`clientAssets` supports:

- `publicDir`: local directory to serve at `/plugins/<plugin-slug>/`
- `scripts`: browser script paths, usually relative to that `publicDir`
- `styles`: browser stylesheet paths, usually relative to that `publicDir`

With no plugins configured, the app behaves exactly as before.

### Example Plugin

A copyable starter plugin lives at:

- [examples/company-plugin/company-plugin.js](/Users/josephcheung/Desktop/dev/vast-monitor/examples/company-plugin/company-plugin.js)
- [examples/company-plugin/owner-team-map.json](/Users/josephcheung/Desktop/dev/vast-monitor/examples/company-plugin/owner-team-map.json)
- [examples/company-plugin/public/company-app.js](/Users/josephcheung/Desktop/dev/vast-monitor/examples/company-plugin/public/company-app.js)
- [examples/company-plugin/public/company.css](/Users/josephcheung/Desktop/dev/vast-monitor/examples/company-plugin/public/company.css)

This is intentionally generic sample code. A private repo can copy it and replace the example route, annotations, rules, and frontend panel with company-specific behavior.

## Private Repo Shape

Recommended private companion repo:

```text
vast-monitor-company/
  .env
  src/
    company-plugin.js
  config/
    owner-team-map.json
  public/
    company-app.js
    company.css
```

The simplest practical setup today is:

```bash
PLUGIN_MODULES=./src/company-plugin.js
```

Then run the core app from the private repo workspace with the plugin file and plugin public assets present there.

Inside `company-plugin.js`, start from the example plugin in this repo and replace:

- `company_annotations` with your own machine metadata
- the example alert with your internal rule logic
- `/api/company/example` with internal-only routes
- the example browser panel with your company dashboard additions

For an operator-focused walkthrough, see [docs/private-repo-setup.md](/Users/josephcheung/Desktop/dev/vast-monitor/docs/private-repo-setup.md).

## Startup

Startup is intentionally verbose so you can see progress during the initial poll. Typical output:

```text
[startup] Loading configuration
[startup] Database ready at ...
[startup] Database maintenance: ...
[startup] Starting HTTP server on port 3000
[startup] Starting fleet monitor
[monitor] Running initial poll
[monitor] Poll started at ...
vast-monitor listening on http://localhost:3000
```

The HTTP server starts before the initial poll finishes, so the process becomes visibly healthy earlier.

Startup now also prints a concise database maintenance summary so operators can see whether the app deduped fleet snapshots, backfilled/rebuilt derived fleet history, or pruned old rows via retention settings.

If the initial Vast poll fails, the server stays up and keeps retrying on the normal poll interval. The dashboard and `/api/health` will show stale state until a poll succeeds.

Vast API enrichment and Vast CLI subprocess calls are also bounded by timeouts so transient network hangs do not leave polling stuck indefinitely. After a timeout or failure, the service retries on the normal poll interval.

Any needed fleet snapshot backfill happens before polling starts. On older or larger databases, startup may take a little longer only when historical fleet trend rows actually need to be filled in.

## Dashboard

The dashboard includes:

- Fleet summary cards
- Header health badge (`Healthy`, `Polling`, `Stale`, `Degraded`)
- Header health badge can also show `Degraded` when stored poll data is fresh but live Vast-dependent operations are unhealthy
- Header `Refresh` button for manual dashboard reloads
- Header `Settings` button for local browser preferences
- Optional dashboard carousel mode that alternates every 10 seconds between a full-width `Fleet Summary` / `GPU Type Breakdown` / `Hourly Earnings Overview` block and a full-width `Fleet Trends` block
- Carousel mode keeps both rotating blocks at a matched height so lower sections do not shift during transitions
- Dashboard shows a visible notice when one or more API-backed sections fail to refresh, instead of collapsing the whole page into a generic failure state
- Stale-data warning banner when polls are too old
- GPU type breakdown with clickable GPU names that toggle exact GPU-type filters in the machine table
- GPU type breakdown now also shows current Vast-wide utilisation benchmarks when the fleet GPU label safely matches the external benchmark source
- Hovering `Vast Util` opens a custom tooltip card with current platform stats such as total GPUs, available/rented GPUs, machines available, and median/minimum/10th/90th percentile prices
- Hovering `Avg Price` opens a custom tooltip card comparing the fleet's current average listed price against the current Vast median for safely matched GPU types
- Fleet trends for `24h`, `7d`, and `30d`
- Fleet utilisation chart with a GPU selector; default view is total fleet utilisation, and it now prefers historical Vast benchmark lines for persisted matched GPU snapshots when available
- When historical Vast benchmark data starts later than the visible fleet-history window, the chart backfills the leading gap with the first available benchmark value so the comparison line starts at the beginning of the visible range
- When no historical Vast benchmark data exists for the selected series, the chart falls back to a dashed synthetic benchmark line derived from the current benchmark value across the visible range
- GPU-type pricing trends using listed-only weighted averages
- `Hourly Earnings Overview` with previous/next day navigation, rolling total anchored to the latest stored daily total, and average hourly earnings
- Per-section source/freshness labels for summary, breakdown, hourly earnings, fleet trends, alerts, and poll monitor
- Sortable machine table
- Machine table split into `Main View` and `Archived` tabs, where archived machines are offline for more than 24 hours
- Compact single-row machine filter bar for search, status, listing, datacenter, dedicated GPU-type filters, errors, reports, and maintenance
- Min rental machine filter for 8+ GPU machines whose minimum rentable group is below 8 GPUs
- Inline machine filter summary showing visible machines plus the currently active filter terms
- Active GPU-type filter chips with one-click removal and a result count summary
- Machine filter reset button shows the number of active filters
- Machine table density toggle (`Comfort` / `Compact`)
- Responsive machine table that hides lower-priority columns on narrower screens to reduce horizontal overload
- Datacenter `DC` indicator column
- Listed status and maintenance columns
- Bright orange highlighting for machines with active error messages
- Configurable frontend highlighting thresholds for low reliability and high temperature
- Recent alerts
- Compact poll monitor panel with latest poll timings and counts
- Dedicated `DB Admin` dashboard panel that uses the optional admin token from Settings to show database size, row counts, retention state, derived-state version info, recent maintenance history, per-route timing metrics, and a retention dry-run preview
- `DB Admin` also surfaces external benchmark snapshot counts plus current benchmark health/freshness so operators can see whether Vast comparison data is live, cached, or unavailable
- `DB Admin` also supports safe operator actions such as `Analyze`, `Vacuum`, retention dry-run preview, daily earnings patches, daily earnings history materialization, and on-demand derived-state rebuilds, with explicit confirmation for destructive actions, diagnostics copy/download, and background execution for heavier maintenance
- daily earnings history materialization replays the selected UTC-day override into fleet snapshots and hourly rollups so historical charts can be recalculated when needed
- recent maintenance history in `DB Admin` now includes expandable result/error details for troubleshooting
- `DB Admin` also shows inline warnings for disabled retention, large DB size, and active maintenance
- Per-machine history modal with tabbed `Charts` and `Recent Events` views
- Clicking a machine row opens the machine history modal
- Report badges support `Ctrl`/`Cmd`-click on desktop and long-press on touch devices to open the reports modal
- Machine modal header shows the machine ID plus compact context badges/labels such as `DC`, GPU label, and clickable IP address
- Machine modal commercial summary includes a `Min GPUs` card derived from the machine's `listed_min_gpu_count`
- Machine modal machine ID and IP address support click-to-copy
- Copy actions now show a small transient copied confirmation
- Machine modal charts for historical earnings, renter activity, reliability, GPU rental price, and GPU count
- Machine modal operational summary includes a combined `Renter Total / Rentals` card, where `Renter Total` equals the starting renter count plus all positive renter-count increases across the selected history window
- Machine modal commercial summary includes realized previous/current calendar month machine earnings when live Vast CLI earnings are available
- Machine modal includes a compact live-earnings status panel showing source, health, and effective comparison windows
- Machine and reports modals now show explicit loading states while live data is being fetched
- Machine and reports modals keep clearer degraded/failure details visible when live requests fail
- Machine modal earnings chart prefers the machine's own stored `earn_day` history and falls back to Vast daily earnings only when local history is unavailable
- Machine modal suppresses live earnings warnings when local `earn_day` history is available and already powering the chart
- Cursor hover inspection for fleet trend charts and machine modal charts
- Resize-aware chart redraw for fleet and modal charts

For an implementation map of the market-benchmark feature, see [docs/benchmark-architecture.md](./docs/benchmark-architecture.md).

Local browser settings currently control:

- dashboard mode (`Normal` / `Carousel`)
- machine table density
- low reliability highlight threshold
- high temperature highlight threshold
- stale poll age threshold for the dashboard badge/warning
- selected GPU type for the fleet utilisation chart
- current Vast-wide utilisation benchmarks are intentionally strict-match only; generic internal labels such as `H100` or `A100` are left unmatched when the external source only exposes variant-specific entries like `h100 pcie` or `a100 sxm4`
- persisted benchmark history follows the same strict-match rule, so generic `H100` / `A100` fleet labels will not synthesize a historical line from variant-specific external entries
- machine table filters, dedicated GPU-type filters, and the selected `Main View` / `Archived` tab when those values are not explicitly set in the URL

## Datacenter Tagging

Vast does not expose the datacenter tag directly in the host `show machines` payload used by this app.

This project derives it from Vast bundle metadata using:

- `hosting_type === 1` -> machine is treated as datacenter-tagged
- `host_id` -> stored as the datacenter ID internally
- unresolved bundle lookups are retried per machine when batch responses are incomplete

In the dashboard, datacenter machines are shown with a blue `DC` pill.

## Listed vs Unlisted Capacity

Vast can hide GPU occupancy details for unlisted machines even when those machines still have active rentals.

To avoid misleading utilisation numbers:

- `Listed GPUs` and `Unlisted GPUs` are tracked separately
- `Occupied GPUs` and `Utilisation` are calculated against listed capacity only
- machines that have been offline for more than 24 hours are removed from fleet totals and fleet trend charts
- those long-offline machines are still retained in the machine list for reference
- fleet trend charts follow the same rule

## Machine Errors

The Vast machine payload can include machine-level error text such as:

```text
failed to inject CDI devices: unresolvable CDI devices
```

This project stores that message in machine state when present and uses it in the UI:

- machine rows with an error are highlighted in bright orange
- clicking the machine opens the modal with the error message displayed near the top

The app currently prefers `error_description` and falls back to `vm_error_msg` if needed.

## API

### `GET /api/status`

Returns:

- latest poll time
- health status for the current dashboard state
- summary metrics
- GPU type breakdown
- current machine list
- per-machine listing fields such as `listed_gpu_cost` and `listed_min_gpu_count`

### `GET /api/health`

Returns service and poll health details including:

- whether the latest successful poll is considered stale
- poll age and stale threshold
- whether live Vast-dependent operations are currently degraded
- dependency-level readiness for the Vast CLI and API key file
- current poll activity
- last poll success/failure timestamps
- last poll error, if any
- current external Vast benchmark status, freshness, source, and any benchmark fetch error
- in-process endpoint timing metrics for key API routes such as status, health, fleet history, GPU price history, and hourly earnings

### `GET /api/admin/db-health`

Internal operator-oriented database status endpoint.

Auth:

- requires `ADMIN_API_TOKEN` to be configured
- send either:
  - `Authorization: Bearer <token>`
  - or `X-Admin-Token: <token>`
- if `ADMIN_API_TOKEN` is unset, `/api/admin/*` routes are disabled

Returns:

- database path and file size
- row counts for `polls`, raw `fleet_snapshots`, hourly fleet rollups, raw `machine_snapshots`, hourly machine rollups, hourly GPU-utilization rollups, hourly GPU-price rollups, raw benchmark snapshots, hourly benchmark rollups, `alerts`, and `events`
- configured retention windows
- derived-state metadata such as the current fleet snapshot version
- recent maintenance runs and in-progress maintenance state
- external Vast benchmark status, freshness, source, and last error (if any)
- recent in-process route timing metrics for operator troubleshooting

Admin maintenance actions now use a database-backed maintenance lock so overlapping `ANALYZE`, `VACUUM`, or derived rebuild runs are rejected even when multiple service processes point at the same SQLite database.

### `GET /api/admin/retention-preview`

Internal operator dry-run endpoint.

Returns:

- effective retention cutoffs
- counts of rows that would be deleted
- counts of hourly rollups that would be upserted, including persisted Vast benchmark rollups

This endpoint does not mutate the database.

### `POST /api/admin/analyze`

Internal operator maintenance endpoint.

Runs SQLite `ANALYZE` and returns:

- completion timestamp
- analyze duration in milliseconds

This route can also be queued in background mode via `?async=1`.

### `POST /api/admin/vacuum`

Internal operator maintenance endpoint.

Runs SQLite `VACUUM` and returns:

- completion timestamp
- vacuum duration in milliseconds
- resulting database file size

This is heavier than `ANALYZE` and is best run during lower-traffic periods.
This route can also be queued in background mode via `?async=1`.

### `POST /api/admin/rebuild-derived`

Internal operator maintenance endpoint.

Rebuilds derived fleet snapshots and rollup tables from the currently retained raw snapshot history and returns:

- completion timestamp
- rebuild duration in milliseconds
- deleted derived-row counts
- rebuilt derived-row counts

This route can also be queued in background mode via `?async=1`.

### `GET /api/history?machine_id=49697&hours=24`

Returns historical snapshots for one machine.

Snapshot fields include:

- machine status and occupancy
- GPU count
- renter count
- reliability
- GPU temperature
- `listed_gpu_cost`
- daily earnings

Validation:

- `machine_id` must be numeric
- `hours` must be a positive number

### `GET /api/alerts?limit=50`

Returns recent alerts.

Validation:

- `limit` must be a positive number
- maximum `limit` is `500`

### `GET /api/earnings/hourly?date=YYYY-MM-DD`

Returns hourly earnings buckets for a UTC date, scaled to the latest stored daily total for that date so the overview matches the daily earnings snapshot. If a DB Admin daily-earnings override exists for that UTC day, the override takes precedence.

### `GET /api/earnings/machine?machine_id=49697&hours=168`

Returns machine earnings data from Vast for the requested window.

This endpoint also supports explicit ISO datetime ranges:

### `GET /api/earnings/machine?machine_id=49697&start=2026-03-01T00:00:00.000Z&end=2026-03-15T00:00:00.000Z`

Response also includes a `dependency` object so the UI can distinguish local-history availability from live Vast CLI failures.

In the UI, the machine modal currently prefers locally stored per-machine `earn_day` snapshot history for the chart because Vast daily earnings responses may not always be machine-specific in practice.

For machine modal commercial month cards, the app instead queries full calendar-month ranges and uses the machine-specific `per_machine` total for each month.

Important behavior:

- monthly summary cards use `per_machine` totals only
- they do not fall back to Vast `per_day`, because `per_day` may reflect fleet-level totals in practice
- previous month uses `previous_month_start -> current_month_start`
- current month uses `current_month_start -> now`
- current month hover comparison uses the same elapsed period from the previous month, capped at the previous month end
- for example, March 15 compares against February 1-15; March 31 compares against February 1-28 or February 1-29 in leap years
- comparison labels in the machine modal are intentionally shortened to keep the hover state readable
- machine modal earnings cards use compact labels for readability, e.g. month labels like `Mar 26`, source badges `Real.` / `Est.`, and rolling labels like `7D EARN`
- machine modal commercial fields are compacted, e.g. GPU count/type is shown in the header and bandwidth earnings are merged into `BW Up/Down`
- if a machine has no realized total for a month yet, the summary should remain blank rather than showing fleet earnings

Validation:

- `machine_id` must be numeric
- either `hours` must be a positive number, or `start` and `end` must both be valid ISO datetimes with `end > start`

### `GET /api/earnings/machine/monthly-summary?machine_id=49697`

Returns realized previous/current calendar month totals for one machine.

Implementation detail:

- the server runs machine-scoped Vast earnings range queries and uses the matching `per_machine` total from each response
- previous month is compared against the month before it
- current month is compared against the same calendar-day span from the previous month, capped at the previous month end

Validation:

- `machine_id` must be numeric

### `GET /api/fleet/history?hours=168`

Returns fleet-wide trend points for the requested time window, plus GPU-type utilisation series used by the utilisation selector.

Validation:

- `hours` must be a positive number

### `GET /api/gpu-type/price-history?hours=168&top=6`

Returns bucketed, listed-only GPU-weighted average price history for the top GPU types in the requested window.

Validation:

- `hours` must be a positive number
- `top` must be a positive number

## Tests

Run:

```bash
npm test
```

Current automated coverage includes:

- config/runtime validation
- Vast payload normalization and earnings-day parsing
- monitor transition, dedupe, and alert helper behavior
- datacenter metadata batching
- SQLite-backed DB aggregation flows
- HTTP API response shapes for status, health, fleet history, and live dependency failures
- poll observability metrics in monitor health snapshots and API responses
- frontend machine-table filtering, sorting, archive classification, and markup behavior
- frontend URL/local-storage UI state loading and persistence behavior
- frontend delegated interaction wiring and clipboard fallback behavior
- frontend dashboard loader partial-failure handling
- frontend dashboard controller refresh/timer behavior and open-modal refresh handling
- frontend machine and reports modal controller loading/failure flows

## Notes

- Live Vast CLI earnings calls may fail independently of stored history. The UI should only surface that failure in the machine modal when no local `earn_day` history is available for the selected window.

## Database

SQLite is used through `better-sqlite3`.

Main tables:

- `machine_registry`
- `machine_state`
- `polls`
- `fleet_snapshots`
- `machine_snapshots`
- `events`
- `alerts`

### Automatic Schema Patching

If you pull a newer version of this repo onto another machine and start it against an older database, the app patches known additive schema changes automatically on startup.

Current startup migrations cover missing columns including:

- `public_ipaddr`
- `listed`
- `error_message`
- `machine_maintenance`
- `host_id`
- `hosting_type`
- `is_datacenter`
- `datacenter_id`

As long as the process can write to the SQLite file, an existing DB should upgrade in place.

## Alerts

Alerts are currently delivered to the console through the channel abstraction in [`src/alerts`](./src/alerts).

That makes it easy to add Telegram, webhook, or other delivery backends later.

To reduce alert spam, console delivery applies cooldown-based dedupe for repeated noisy alerts:

- `new_reports`
- `high_temp`
- `idle`
- `hostname_collision`

`host_up` and `host_down` alerts are not cooldown-suppressed, so real state transitions still notify immediately.

## Repo Layout

```text
src/
  index.js          startup
  config.js         environment and defaults
  vast-client.js    Vast CLI + Vast API data collection
  monitor.js        polling loop and change detection
  db.js             SQLite schema, queries, and migrations
  server.js         Express API + static file server
  alerts/           alert channel abstraction

public/
  index.html        dashboard shell
  app.js            dashboard orchestration
  app/              frontend modules for charts, tables, modal controllers, UI state, and event wiring
  styles.css        dashboard styling

data/
  vast-monitor.db   SQLite database
```

## Troubleshooting

- If startup stalls after the monitor begins polling, check that the Vast CLI path is correct and the API key file exists.
- If datacenter pills are missing, verify the app can read `VAST_API_KEY_PATH` and reach `VAST_API_URL`.
- If the header shows `Stale`, check `/api/health` and confirm the Vast CLI can still reach Vast.
- If you move the repo to another machine, confirm the SQLite path in `DB_PATH` is writable.

## Notes

- `vast show machines --raw` is still the primary fleet source of truth.
- Datacenter tagging requires both Vast CLI access and Vast API access.
- Uptime accuracy improves as more polling history accumulates.
- The frontend is static HTML/CSS/JS with no build step.
