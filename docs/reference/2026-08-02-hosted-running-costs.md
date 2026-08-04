# Hosted running costs at 100, 1,000, 10,000, and 100,000 users

> Written 2026-08-02 against `main` at `d160b72`. Cloudflare rates were read
> from `developers.cloudflare.com` on 2026-08-01 and are cited inline. This
> document answers one question: **can the owner afford to open the hosted
> side to the public, and what breaks first if he does?**

Every input below is labelled **MEASURED** (read from this repository, with
`file:line`, or produced by running its own code against its own data) or
**ASSUMED** (a number the code cannot supply, stated with the value chosen and
why). No assumption is presented as a measurement. All arithmetic is shown so
the owner can substitute different inputs.

The short answer: **at 100 users the hosted side costs roughly $77/month; at
1,000 users roughly $970/month; at 10,000 users roughly $10,300/month; at
100,000 users roughly $104,000/month.** At every scale the dominant cost is
D1 rows read, and about 87% of that comes from one correlated subquery in the
personal-dashboard contribution list. That same subquery is also the first
thing that breaks: it exceeds D1's 30-second statement limit within roughly
three weeks of running at 100 users, long before any bill becomes painful.
Two bounded code changes remove 93–97% of the projected cost.

---

## 1. What a client actually uploads

### 1.1 Cadence

**MEASURED.** Automatic contribution runs on a fixed six-hour interval, with a
24-hour lookback bound and a fixed one-hour replay overlap:

- `src/contribution/recurrence-policy.js:14` — `AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS = 6`
- `src/contribution/recurrence-policy.js:15` — `AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS = 24`
- `src/contribution/recurrence-policy.js:16` — `AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS = 1`

The interval is not user-configurable: `validatedSettings` rejects any stored
`intervalHours` that is not exactly 6 (`recurrence-policy.js:338`), and
`enableAutomaticContribution` rejects any other value at the API boundary
(`recurrence-policy.js:568`).

**MEASURED.** The schedule only advances while the app is open. There is no
daemon, LaunchAgent, or Login Item; the status projection reports
`foregroundOnly: true, daemonInstalled: false`
(`src/contribution/recurrence-policy.js:511-512`).

**MEASURED.** Contribution is off by default and requires an explicit reviewed
first send before the recurring schedule can be enabled at all
(`recurrence-policy.js:567` — `first_review_required`).

### 1.2 Uploads are incremental, not full re-sends

**MEASURED.** Each run prepares evidence starting from a durable
destination- and schema-bound watermark, `acceptedThrough.coveredThroughAt`,
which advances only on a fully accepted prepared set
(`src/contribution/recurrence-policy.js:729-733`). A partial, retryable,
rejected, or timed-out delivery leaves the watermark where it was
(`recurrence-policy.js:727-728`).

So the wire format is a delta, not a snapshot. **But it is a delta with a
deliberate one-hour re-send.** With a six-hour interval and a one-hour
overlap, each run covers seven hours of evidence, of which one hour was
already uploaded — about **14% of transported records are duplicates**.

The server drops duplicate *records* (`INSERT OR IGNORE INTO telemetry_records`,
`apps/worker/src/telemetry-repository.ts:218`), but it does **not** drop the
duplicate work: the replay-overlap batch is a new contribution with a new
plaintext digest, so it still costs a full Worker request triple, a full R2
PUT, and a full ingest D1 statement batch. The idempotency short-circuit at
`apps/worker/src/index.ts:1248-1267` (envelope digest) and `:1287-1305`
(plaintext digest) only fires when an *entire* envelope or plaintext is
byte-identical to a previous one.

### 1.3 Batching and payload size

**MEASURED** limits on the client projection:

| Limit | Value | Source |
|---|---|---|
| Records per batch | 200 | `src/contribution/telemetry-v01-projection.js:16` |
| Activity markers per batch | 100 | `src/contribution/telemetry-v01-projection.js:17` |
| Batches per prepared set | 100 | `src/contribution/prepared-set-contract.js:18` |
| Hard batch byte ceiling | 1,250,000 | `src/contribution/telemetry-v01-projection.js:272` |
| Upload jobs per sync pass (default) | 25 | `src/application/local-contribution-sync-queue.js:22` |
| Reserved upload bytes per pass (default) | 16 MiB | `src/application/local-contribution-sync-queue.js:25` |
| Server request body ceiling | 2 MiB | `apps/worker/src/constants.ts:1` |
| Server plaintext ceiling | 1,536 KiB | `apps/worker/src/constants.ts:2` |

**MEASURED payload size.** Rather than guess, the repository's own projection
was run against a real captured bundle
(`exports/live-export-set-smoke-20260724T232452Z/chunk-000000.bundle.json`,
449 records covering 2026-07-24T23:00:00Z → 23:24:52Z) using
`buildTelemetryContributionsFromBundle`:

```
batch 1  200 records  153,952 bytes
batch 2  200 records  154,071 bytes
batch 3   49 records   37,935 bytes
total    449 records  345,958 bytes  →  770.5 bytes per record
```

So a full 200-record batch is **≈154 KB of plaintext JSON**. The upload
envelope base64url-encodes the ciphertext
(`src/platform/telemetry-envelope.js:39-59`), a 4/3 expansion, giving
**≈205 KB on the wire per full batch**.

**MEASURED record mix.** Across three independent real bundles the usage /
quota split is almost exactly even, and activity markers are absent:

| Bundle | Window | Usage | Quota | Markers |
|---|---|---|---|---|
| `live-export-set-smoke-…232452Z` | 24m 52s | 222 | 227 | 0 |
| `exports/local-review-2026-07-24.umx.json` | 60m | 463 | 471 | 0 |
| `exports/g1-resource-identity-v3-2026-07-24.umx.json` | 3h 05m | 1,614 | 1,653 | 0 |

Usage events are **49–50%** of all records in every sample. That ratio matters
later, because one of the two dominant D1 queries scans only `record_kind='usage'`.

**MEASURED record rate, owner's own machine.** The same three bundles give
1,078, 934, and 1,060 records per hour of covered window — remarkably
consistent at **≈1,050 records/hour during active multi-agent sessions**. The
raw collector stream agrees that this is sustained use, not a burst:
`.usage-monitor/collector-events.jsonl` holds 345,559 events over five days,
peaking at 127,819 events on 2026-07-25 (308,414 of the total are
`codex_rollout_usage_snapshot`).

That is a power user running several agents in parallel. A single-agent user
will be far lower, which is where the first assumption enters.

---

## 2. Cloudflare resources actually bound and consumed

### 2.1 What is bound

**MEASURED** from `apps/worker/wrangler.jsonc` (production environment,
lines 132-226):

- one Worker on custom domains `tibotattle.com` and `www.tibotattle.com`, plus
  the `workers.dev` origin;
- two D1 databases — `USAGE_MONITOR_DB` and `DELETION_LEDGER`;
- one R2 bucket — `QUARANTINE`;
- static assets served from `apps/web/public` through the `ASSETS` binding;
- one hourly cron trigger, `"0 * * * *"`;
- observability enabled at `head_sampling_rate: 1`;
- two rate-limit namespaces.

There is no KV, no Durable Object, no Queue, no Hyperdrive, and no Logpush
destination.

**MEASURED.** The v0.2 account-scoped contract exists but is switched off:
`TELEMETRY_V02_ENABLED = false` (`apps/worker/src/telemetry-v0.2.ts:16`) and
`ACCOUNT_SCOPED_INGEST_MODE: "disabled"` in production vars. The live wire
format is `telemetry-contribution-v0.1`. The v0.2 schemas under
`schemas/telemetry-contribution-v0.2/` therefore do not affect running cost
today.

### 2.2 Worker requests per contribution

**MEASURED.** Uploading one batch costs exactly three inbound Worker requests
(`src/contribution-device-sync.js`):

1. `GET /api/v1/envelope-key` — line 156. **Zero D1 operations**
   (`apps/worker/src/index.ts:1130-1133` reads only an env secret).
2. `POST /api/v1/device/upload-authorizations` — line 192.
3. `POST /api/v1/contributions` — line 240.

Static asset requests (the marketing site and the web dashboard shell) are
**free and unlimited** — [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
footnote 3, read 2026-08-01.

### 2.3 D1 operations per contribution

**MEASURED** statement counts on the accept path, for a batch of `N` records:

| Stage | Statements | Source |
|---|---|---|
| `assertCollectionControl` (×2, one per POST) | 2 | `index.ts:1060`, `index.ts:1412` |
| device authentication + tombstone check | 3 | `index.ts:1065-1071` |
| create device upload authorization | 1 | `device-auth.ts:500` |
| claim upload authorization (SELECT + UPDATE) | 2 | `device-auth.ts:548`, `:576` |
| participant lookup + deletion tombstone | 2 | `index.ts:1441`, `:1445` |
| envelope-digest replay check | 1 | `index.ts:1248` |
| admission-window check | 1 | `index.ts:1270` → `telemetry-repository.ts:107` |
| plaintext-digest replay check | 1 | `index.ts:1287` |
| register pending quarantine object | 1 | `index.ts:1312` → `quarantine-reconciliation.ts:105` |
| **ingest batch** | **2N + 2** | `telemetry-repository.ts:456-536` |
| record upload receipt | 1 | `device-auth.ts:604` |

For `N = 200` that is **417 statements in one request**, against D1's
documented ceiling of 1,000 queries per Worker invocation on the Paid plan
([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). The
design is at 42% of that ceiling; `MAX_TOTAL_RECORDS` could rise to about 493
before it is hit.

The `2N` comes from every record writing **two** rows: one into
`telemetry_records` and one into `telemetry_contribution_occurrences`
(`telemetry-repository.ts:217-284`, `:373-399`).

**MEASURED rows written per record.** D1 bills index maintenance as extra rows
written — "there are two rows written: one to the table itself, and one to the
index" ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)).
Counting the indexes that actually exist:

- `telemetry_records`: table row + `sqlite_autoindex` on
  `UNIQUE(participant_id, record_kind, occurrence_id)` + `telemetry_records_participant_time`
  + `telemetry_records_aggregate_time` + `telemetry_records_participant_server_price`
  + one of the two `record_kind` partial indexes = **6 rows**
  (`migrations/0002_telemetry_ingest.sql:66-73`, `0006_server_pricing.sql:29`,
  `0007_account_track_v0_2.sql:121-146`).
- `telemetry_contribution_occurrences`: table row + primary-key index +
  `telemetry_contribution_occurrences_record` = **3 rows**. The
  `telemetry_occurrences_account_dataset` index is partial on
  `dataset_id IS NOT NULL` and is never written on the v0.1 path.

**9 rows written per stored record.** Duplicated records from the replay
overlap still write the 3 occurrence rows.

### 2.4 The un-indexed finalize UPDATE

**MEASURED, and this is the single most important finding in this document.**

The last statement of every ingest batch recomputes four server-pricing
aggregates with correlated subqueries filtered on `origin_contribution_id`
(`telemetry-repository.ts:502-534`). **There is no index on
`telemetry_records.origin_contribution_id`** — the five indexes on that table
are listed above and none of them leads with that column.

Building a database from this repository's own migrations and asking SQLite
what it would do:

```
QUERY PLAN
|--SEARCH telemetry_contributions USING INDEX sqlite_autoindex_telemetry_contributions_1 (id=?)
|--CORRELATED SCALAR SUBQUERY 1
|  `--SEARCH telemetry_records USING INDEX telemetry_records_aggregate_time (record_kind=?)
|--CORRELATED SCALAR SUBQUERY 2
|  `--SEARCH telemetry_records USING INDEX telemetry_records_aggregate_time (record_kind=?)
|--CORRELATED SCALAR SUBQUERY 3
|  `--SEARCH telemetry_records USING INDEX telemetry_records_aggregate_time (record_kind=?)
`--CORRELATED SCALAR SUBQUERY 4
   `--SEARCH telemetry_records USING INDEX telemetry_records_aggregate_time (record_kind=?)
```

Each of the four subqueries visits **every `record_kind='usage'` row in the
whole table**. Since usage rows are ~50% of all rows, each accepted
contribution reads roughly `4 × 0.5 × T = 2T` rows, where `T` is the total row
count of `telemetry_records`. This grows without bound: it is a function of
how much data the service has ever accepted, not of the size of the upload.

**MEASURED timing.** Loading 200,000 usage rows (291 MB) into that database
and running the exact UPDATE five times took 0.911 s wall clock —
**≈180 ms per contribution at 200,000 rows**, scaling linearly.

### 2.5 The dashboard contribution list

**MEASURED.** `GET /api/v1/me` calls `listRecentTelemetryContributions` with a
limit of 100 (`index.ts:1497-1501`, `constants.ts:7`,
`constants.ts:3`). That query carries the same shape of correlated subquery,
and this one is not even restricted by `record_kind`:

```sql
SELECT c.*,
    (SELECT COUNT(*) FROM telemetry_records r WHERE r.origin_contribution_id = c.id)
      AS accepted_record_count
  FROM telemetry_contributions c
 WHERE c.participant_id = ?
 ORDER BY created_at DESC, id DESC
 LIMIT ?
```
— `telemetry-repository.ts:572-580`

`EXPLAIN QUERY PLAN` reports `CORRELATED SCALAR SUBQUERY 1 → SCAN r`: a full
table scan, executed once per returned contribution row. **One dashboard load
therefore reads up to `100 × T` rows.**

**MEASURED timing.** The same query against the 200,000-row database, forced
to actually evaluate the subquery, took **3.905 s** — about 20,000,000 row
visits. D1's documented maximum query duration is 30 s.

`listTelemetryContributions` (`telemetry-repository.ts:552-560`, `LIMIT 101`)
has the identical defect.

### 2.6 R2

**MEASURED.** One `PUT` per accepted contribution
(`index.ts:1312` → `quarantine-reconciliation.ts:106`) — a Class A
operation. One `HEAD` per reconciliation row
(`quarantine-reconciliation.ts:401`) and one per `/api/ready`
(`index.ts:1966`) — Class B. Deletes are free
([R2 pricing](https://developers.cloudflare.com/r2/pricing/): "Free operations
include `DeleteObject`, `DeleteBucket` and `AbortMultipartUpload`").

**MEASURED retention.** Quarantine objects are kept 7 days
(`constants.ts:21`) and reclaimed by the hourly cron — but at most
**100 objects per pass** (`retention.ts:10`,
`QUARANTINE_DELETE_BATCH_SIZE = 100`, applied at `retention.ts:226`). That is
a ceiling of **2,400 object deletions per day**.

### 2.7 Scheduled work and snapshot publication

**MEASURED.** The cron fires hourly (`wrangler.jsonc`, `triggers.crons`) —
720 invocations/month. Each pass (`index.ts:2068-2152`) runs:

1. `runBackendLifecycle` — deletion-tombstone replay and quarantine retention.
2. `reconcilePendingQuarantineObjects`.
3. `readCollectionControls`.
4. If everything above is complete and publication is enabled,
   `buildCommunityWeeklySnapshot` then `rebuildPendingCommunityWeeklySnapshots`.

**MEASURED snapshot cadence.** The snapshot period is one UTC week with a
48-hour ingestion cutoff (`constants.ts:11`,
`community-snapshots.ts:126-134`). When the current week's snapshot already
exists at the current mutation epoch the hourly pass early-returns after
three cheap statements (`community-snapshots.ts:222-242`). So in steady state
the expensive aggregation runs **once per week**, not once per hour.

**MEASURED aggregation cost.** `EXPLAIN QUERY PLAN` on the real query
(`community-snapshots.ts:289-393`) shows it is properly indexed: a range scan
of `telemetry_records_aggregate_time` for the week, then ~4 index lookups per
row. Cost is roughly `5 × (rows observed in that week)` — bounded and
predictable.

**MEASURED rebuild amplification, and this is a trap.** Any participant
withdrawal, any contribution status change to `deleting`, and any direct
contribution delete bumps `community_snapshot_mutation_control.mutation_epoch`,
marks **every** published snapshot `withdrawn`, and queues a rebuild row for
each (`migrations/0012_revisioned_aggregate_rebuild.sql:101-202`). Rebuilds are
throttled to 5 per hourly pass (`community-snapshots.ts:522`). At a scale where
deletions arrive faster than 5/hour, the aggregation query runs continuously and
no snapshot ever stays published.

**MEASURED lifecycle scan.** `replayDeletionTombstones`
(`retention.ts:152-195`) returns immediately if there are zero tombstones —
but once *any* participant has ever deleted (tombstones are retained 400 days,
`retention.ts:7`), every hourly pass pages through the **entire** participants
table computing a SHA-256 per row, and throws `LIFECYCLE_BOUNDS_EXCEEDED` past
`MAX_LIFECYCLE_ROWS = 100_000` (`retention.ts:12`, `:178-180`).

### 2.8 Admission cap

**MEASURED.** A participant may have at most **100 accepted contributions per
fixed Monday-anchored UTC week** (`constants.ts:4-6`, enforced by trigger at
`migrations/0014_bounded_contribution_admission.sql:37-56`). The client-side
`MAX_PREPARED_CONTRIBUTION_BATCHES = 100` is deliberately equal
(`prepared-set-contract.js:14-18`).

With 4 runs/day (28/week) and 200 records/batch, the cap binds at
`100 / 28 = 3.57` batches per run, i.e. **about 600 records per run**, i.e.
**about 2,060 records/day**. Measured against the owner's own 1,050 records/hour
rate, a user doing **two hours a day** of parallel-agent work hits the weekly
cap and stops contributing.

---

## 3. Server-side log volume and retention

**MEASURED.** The Worker contains exactly eight `console.*` calls
(`crypto.ts:143,155,159,185`; `index.ts:2044,2045,2134,2149`). Seven are
failure paths; the eighth is the once-per-hour cron summary
(`index.ts:2134`). **A successful API request emits no explicit log line.**

**MEASURED.** `observability.enabled: true` with `head_sampling_rate: 1` in all
three environments. Cloudflare emits one invocation log per invocation
regardless of `console` usage, and each `console.*` call is an additional
billable event
([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
read 2026-08-01). So billable log events ≈ **total Worker invocations**, plus
720/month for the cron summary, plus one per failed request.

**MEASURED retention.** 7 days on Workers Paid, 3 days on Workers Free. Not
configurable. No Logpush destination is configured, so there is no second
meter and no long-term log storage cost.

**MEASURED content.** The failure log carries `requestId`, `method`,
`routeClass`, `code`, `status` (`index.ts:2035-2043`) — no participant
identifier. Log volume is a cost line, not a privacy line.

---

## 4. App update distribution

**MEASURED.** The macOS app is ~145 MB on disk
(`.release-build/macos-production/TiboTattle.app`), of which **144,191,552
bytes is a single bundled Node runtime**
(`Contents/Resources/runtime/bin/node`); everything else totals ~7 MB.

**MEASURED compression.** `gzip -6` of that Node binary produces **43,885,241
bytes**. A UDZO DMG uses zlib, so the shipped DMG is
**≈47 MB** (43.9 MB compressed runtime + ~3 MB for the rest).
*This is a derived figure — the compression was measured, the DMG container
overhead was not.*

**MEASURED: no delta tooling exists.** Searching `scripts/`, `apps/macos/`, and
`.github/` for `BinaryDelta`, `generate_appcast`, and `sparkle:deltas` returns
nothing. The release pipeline emits exactly one `.dmg`
(`scripts/macos-release-core.js:1230`, `:1658`) and declares its delivery mode
as `"sparkle_signed_appcast_with_manual_dmg_fallback"`
(`scripts/macos-release-core.js:899`). **Every update is a full ~47 MB
download.**

**MEASURED distribution channel.** The appcast target is
`https://github.com/adamallcock/app-usagemonitor/releases/latest/download/appcast.xml`
(`docs/runbooks/2026-07-31-v0.1.0-release-resume.md:36`). The generated
`Info.plist` sets `SUEnableAutomaticChecks`, `SUAllowsAutomaticUpdates`,
`SURequireSignedFeed`, and `SUVerifyUpdateBeforeExtraction`, with
`SUAutomaticallyUpdate` true (`scripts/build-macos-app.js:1331-1349`), so a
signed release downloads verified updates by default and installs them when the
app quits. Users can turn that preference off in Settings. It does **not** set
`SUScheduledCheckInterval`, so Sparkle's default applies — one appcast check
per day.

**Bandwidth per release**, assuming every installed copy takes the update:

| Users | Per release | At 1 release/month | At 2 releases/month |
|---:|---:|---:|---:|
| 100 | 4.7 GB | 4.7 GB | 9.4 GB |
| 1,000 | 47 GB | 47 GB | 94 GB |
| 10,000 | 470 GB | 470 GB | 940 GB |
| 100,000 | 4.7 TB | 4.7 TB | 9.4 TB |

Appcast polling itself is negligible: a few KB × one check/day × user count —
about 3 GB/month even at 100,000 users, and it is served by GitHub, not
Cloudflare.

**The risk.** GitHub Releases bandwidth is currently free and unmetered, and
GitHub publishes no quota for it. GitHub's Acceptable Use Policies prohibit
using the service as a content delivery network or for excessive bandwidth,
without defining either. That means:

- there is no number to plan against, and no warning threshold to monitor;
- 4.7 TB/month from one repository at 100,000 users is squarely in the
  territory where a manual review is plausible;
- if GitHub throttles or disables the release assets, **the entire update
  channel goes down at once**. Sparkle would simply stop finding updates, and
  every installed copy would silently stop receiving security fixes. There is
  no fallback host configured.

**The fix is nearly free.** R2 egress is $0
([R2 pricing](https://developers.cloudflare.com/r2/pricing/), footnote 1:
"Egressing directly from R2 … does not incur data transfer (egress) charges and
is free"). Hosting `appcast.xml` and the DMG in R2 would cost, at 100,000
users and one release/month: ~50 MB of storage (free, inside the 10 GB-month
allowance) + 100,000 Class B `GetObject` operations per release (free, inside
the 10-million allowance) + 3M appcast GETs/month (free). **Total: $0.**
Moving update hosting to R2 removes the single largest uncontrolled dependency
in the product for no additional cost.

---

## 5. Assumptions

Each of these is a number the code cannot supply. They are the soft inputs;
substitute freely and re-run the arithmetic in §7.

| # | Assumption | Value chosen | Why |
|---|---|---|---|
| A1 | Share of installed users who enable ongoing contribution | **30%** | Contribution is off by default, requires reading a review screen, sending a first reviewed contribution, and then explicitly choosing "keep it current" (`recurrence-policy.js:567`). Three-step opt-in with a privacy framing; 30% is optimistic-but-plausible. At 10% every cost below falls by two-thirds. |
| A2 | Records produced per contributing user per day | **800** | The owner's measured rate is ~1,050 records/hour of active multi-agent work (§1.3). 800/day corresponds to a single-agent user doing ~3 hours/day at ~250 records/hour, or the owner doing ~45 minutes. Sensitivity band: 200/day (light) to 6,300/day (owner-like, 6 h/day — which exceeds the weekly admission cap). |
| A3 | Contribution runs per day | **4** | The 6-hour interval implies 4 if the app stays open all day. Foreground-only operation (§1.1) means fewer in practice; 4 is the conservative (cost-maximising) choice. |
| A4 | Dashboard loads per installed user per day | **0.6** | Modelled as 30% daily-active × 2 loads. Each load is one `GET /api/v1/me`. |
| A5 | Web API requests per dashboard load | **12** | session, me, stats, insights, community, devices, and their follow-ups. Static assets are excluded because they are free. |
| A6 | Worker CPU per contribution POST | **50 ms** | RSA-OAEP unwrap + AES-GCM decrypt + two SHA-256 digests + parsing 154 KB of JSON + server-repricing 100 usage events + orchestrating a 402-statement batch. D1 wait time is not CPU time. Not measured; if it is 150 ms the CPU line roughly triples, which changes nothing material. |
| A7 | Worker CPU per other API request | **3 ms** | Small handlers, mostly D1 wait. |
| A8 | Worker CPU per cron invocation | **2,000 ms** | Dominated by D1 wait, which is not billed as CPU; 2 s is a deliberate over-estimate. |
| A9 | Releases per month | **1** | Used only for the update-bandwidth table. |
| A10 | Operating point for the D1 cost tables | **`telemetry_records` = 500,000 rows (≈1.05 GB)** | See §7.1. Beyond roughly this size the dashboard query stops completing, so costs above it are hypothetical. |

**Derived from A2 + A3 (arithmetic shown):**

- Records per run = `800 / 24 × (6 + 1) = 233` (six new hours plus the one-hour replay overlap).
- Batches per run = `ceil(233 / 200) = 2`.
- **Batches per day per contributor = 2 × 4 = 8.** The partial final batch of
  each run is what pushes this above the naive `936 / 200 = 4.7`.
- Records transported per day = `800 × 7/6 = 933`; records *stored* = 800.
- Contributions per week = `8 × 7 = 56`, against the cap of 100. Headroom, but
  not much.

---

## 6. Cloudflare rates used

All read from `developers.cloudflare.com` on **2026-08-01**.

| Resource | Free plan | Paid plan | Source |
|---|---|---|---|
| Workers subscription | — | **$5.00/month** minimum | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers requests | 100,000/day | 10M/month included, then **$0.30/million** | ibid. |
| Workers CPU | 10 ms/invocation | 30M CPU-ms/month included, then **$0.02/million CPU-ms** | ibid. |
| Static asset requests | free | **free and unlimited** | ibid., footnote 3 |
| Cron invocations | count as requests | count as requests | ibid., worked Example 3 |
| D1 rows read | 5M/day | 25 **billion**/month included, then **$0.001/million** | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 rows written | 100,000/day | 50M/month included, then **$1.00/million** | ibid. |
| D1 storage | 5 GB total | 5 GB included, then **$0.75/GB-month** | ibid. |
| D1 max database size | 500 MB | **10 GB** | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 max query duration | 30 s | **30 s** | ibid. |
| D1 max queries per Worker invocation | 50 | **1,000** | ibid. |
| D1 max storage per account | 5 GB | **1 TB** | ibid. |
| R2 storage | 10 GB-month/month | **$0.015/GB-month** | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| R2 Class A (incl. `PutObject`) | 1M/month | **$4.50/million** | ibid. |
| R2 Class B (incl. `GetObject`, `HeadObject`) | 10M/month | **$0.36/million** | ibid. |
| R2 deletes | free | **free** | ibid. |
| R2 egress | free | **free** | ibid., footnote 1 |
| Workers Logs | 200,000/day, 3-day retention | 20M/month included, then **$0.60/million**, 7-day retention | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |

Two caveats carried forward from that reading:

- **D1 index amplification is confirmed**, verbatim: "Indexes will add an
  additional written row when writes include the indexed column, as there are
  two rows written: one to the table itself, and one to the index."
- **The rate-limiting binding has no published meter.** Cloudflare's docs are
  silent on whether `ratelimits` is billed separately. This model assumes it is
  bundled into standard Workers pricing, which is **unverified**. Two
  namespaces at 20 requests/60 s are unlikely to be material either way.

### Where each resource crosses from free into paid

**Workers Paid is mandatory from about 43 installed users.** D1's free plan
allows 100,000 rows written per day. At `9 × 800 + 3 × 133 + 20 × 8 ≈ 7,759`
rows written per contributor per day (§2.3), that ceiling is reached at
**12.9 contributors ≈ 43 installed users** at 30% adoption. The free plan's
5M rows read/day is breached even sooner: a single `GET /api/v1/me` reads
`100 × T` rows, so it exceeds 5M once the table holds 50,000 rows — about two
days of operation at 100 users. The free 500 MB per-database ceiling is
reached in ten days at 100 users.

**In short: there is no free-tier configuration of this system.** The $5/month
Workers Paid subscription is a floor, not an option.

---

## 7. The model

### 7.1 Choosing an operating point

D1 read cost is a function of `T`, the number of rows in `telemetry_records`,
which grows monotonically — **nothing in the codebase ever deletes telemetry
rows.** `retention.ts` reclaims R2 objects and replays deletion tombstones; it
does not prune D1. So `T` only goes up.

Two thresholds bound the useful range of `T`:

- **`T ≈ 500,000` (≈1.05 GB)** — the largest table at which the measured
  `/api/v1/me` query (3.905 s at 200,000 rows, linear) plausibly stays inside
  D1's 30-second statement limit: `3.905 × 500/200 = 9.8 s` locally, and D1's
  storage layer is slower than a local SSD. Beyond this the dashboard *fails*
  rather than bills.
- **`T ≈ 4,750,000` (10 GB)** — D1's hard per-database ceiling. Ingest stops.

All cost tables below are stated at **`T = 500,000`**. At the 10 GB ceiling
every D1 read figure is 9.5× larger.

Throughout this document GB means the decimal 10⁹ bytes that Cloudflare bills
in. Using binary GiB instead would move every "days until full" figure up by
about 7%.

Storage per record was **measured**, not assumed: inserting one real 200-record
batch (200 `telemetry_records` rows + 200 `telemetry_contribution_occurrences`
rows, with every index live) grew the database from 109 to 212 pages of 4,096
bytes — `103 × 4096 / 200 = 2,109 bytes per record`. `dbstat` attributes 766 of
those bytes to the `record_json` column alone.

### 7.2 Per-scale workload

With `C = 0.30 × U` contributors (A1) and 8 batches/day/contributor (§5):

| Users `U` | Contributors `C` | Contributions/day | Contributions/month | Stored records/day | Days to `T`=500k | Days to 10 GB |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 30 | 240 | 7,200 | 24,000 | 20.8 | 198 |
| 1,000 | 300 | 2,400 | 72,000 | 240,000 | 2.1 | 19.8 |
| 10,000 | 3,000 | 24,000 | 720,000 | 2,400,000 | 0.21 (5 h) | 2.0 |
| 100,000 | 30,000 | 240,000 | 7,200,000 | 24,000,000 | 0.02 (30 min) | 4.8 h |

### 7.3 The arithmetic

**Worker requests/month** = `3 × contributions + 12 × 0.6 × U × 30 + 720`
= `3 × contributions + 216 × U + 720`.

**D1 rows read/month**
= `contributions × 2T` (finalize UPDATE, §2.4)
+ `0.6 × U × 30 × 100T` (dashboard list, §2.5)
+ `~12 × contributions` (indexed lookups — negligible)
+ cron.
At `T = 500,000`: `1.0M` rows per contribution and `50M` rows per dashboard
load.

**D1 rows written/month** = `30 × C × (9 × 800 + 3 × 133 + 20 × 8)`
= `30 × C × 7,759` = `232,770 × C`.

**D1 storage** = `2,109 bytes × cumulative stored records`, capped at 10 GB.

**R2 storage** = `min(inflow, 2,400 deletions/day)` retained 7 days;
inflow = `0.96 MB/day/contributor` (933 records × 770 B × 4/3).

**R2 Class A** = one PUT per contribution.

**Workers Logs** = one event per Worker invocation + 720 cron summaries.

---

## 8. Cost by scale

All figures are USD per month at `T = 500,000`. `—` means the resource stays
inside its included allowance.

### 8.1 — 100 users (30 contributors)

| Line | Volume | Cost |
|---|---:|---:|
| Workers subscription | — | **$5.00** |
| Workers requests | 43,920 | — |
| Workers CPU | 1.91M ms | — |
| Workers Logs | 43,920 events | — |
| D1 rows read | 7.2B (ingest) + 90B (dashboard) = **97.2B** | **$72.20** |
| D1 rows written | 6.98M | — |
| D1 storage | 1.05 GB | — |
| R2 storage | 202 MB steady state | — |
| R2 Class A | 7,200 PUTs | — |
| **Total** | | **≈ $77/month** |

**Dominant driver:** D1 rows read — and within it, the dashboard contribution
list is 93% (90B of 97.2B).

**First thing that actually breaks:** the `/api/v1/me` contribution list. At
`T = 500,000`, reached on **day 21**, the query needs ~9.8 s locally and more
on D1; the personal dashboard starts timing out. The D1 10 GB ceiling is not
reached until day 198.

### 8.2 — 1,000 users (300 contributors)

| Line | Volume | Cost |
|---|---:|---:|
| Workers subscription | — | **$5.00** |
| Workers requests | 432,720 | — |
| Workers CPU | 6.12M ms | — |
| Workers Logs | 432,720 events | — |
| D1 rows read | 72B (ingest) + 900B (dashboard) = **972B** | **$947.00** |
| D1 rows written | 69.8M (19.8M over) | **$19.80** |
| D1 storage | 1.05 GB at the operating point (reached day 2); 10 GB by day 20 | — (then $3.75) |
| R2 storage | 2.0 GB steady state | — |
| R2 Class A | 72,000 PUTs | — |
| **Total** | | **≈ $972/month** |

The total is stated at the operating point. Once the database passes 5 GB —
day 10 at this scale — add $0.75/GB-month up to the $3.75 ceiling.

**Dominant driver:** D1 rows read, 97% of the bill.

**First thing that actually breaks:** the dashboard list again, on **day 2**.
Immediately behind it, the **R2 quarantine deleter saturates exactly here**:
2,400 contributions/day is precisely the 100-objects-per-hourly-pass ceiling
(`retention.ts:10`). At 1,000 users the 7-day quarantine retention promise is
met with zero margin; at 1,001 users it silently stops being met and the
bucket grows without bound. The D1 10 GB ceiling lands on day 20.

### 8.3 — 10,000 users (3,000 contributors)

| Line | Volume | Cost |
|---|---:|---:|
| Workers subscription | — | **$5.00** |
| Workers requests | 4.32M | — |
| Workers CPU | 48.2M ms (18.2M over) | **$0.36** |
| Workers Logs | 4.32M events | — |
| D1 rows read | 720B (ingest) + 9T (dashboard) = **9.72T** | **$9,695.00** |
| D1 rows written | 698M (648M over) | **$648.00** |
| D1 storage | 10 GB ceiling hit on day 2 | **$3.75** |
| R2 storage | +2.59 GB/day net; ~39 GB month 1 | **$0.44** |
| R2 Class A | 720,000 PUTs | — |
| **Total** | | **≈ $10,350/month** |

**Dominant driver:** D1 rows read, 94% of the bill.

**First thing that actually breaks:** the **D1 10 GB per-database ceiling, on
day 2** — ingest stops entirely with no shard strategy in the code. The
dashboard list has already failed by hour 5. The quarantine deleter is running
at 10% of the required rate, so R2 grows at 2.59 GB/day forever.

### 8.4 — 100,000 users (30,000 contributors)

| Line | Volume | Cost |
|---|---:|---:|
| Workers subscription | — | **$5.00** |
| Workers requests | 43.2M (33.2M over) | **$9.96** |
| Workers CPU | 469M ms (439M over) | **$8.79** |
| Workers Logs | 43.2M events (23.2M over) | **$13.92** |
| D1 rows read | 7.2T (ingest) + 90T (dashboard) = **97.2T** | **$97,175.00** |
| D1 rows written | 6.98B (6.93B over) | **$6,933.00** |
| D1 storage | 10 GB ceiling hit in 4.8 hours | **$3.75** |
| R2 storage | +28.5 GB/day net; ~428 GB month 1, growing ~$13/mo thereafter | **$6.27** |
| R2 Class A | 7.2M PUTs (6.2M over) | **$27.90** |
| **Total** | | **≈ $104,180/month** |

**Dominant driver:** D1 rows read, 93% of the bill.

**First thing that actually breaks:** three things, in this order.

1. **D1's 10 GB per-database ceiling, at 4.8 hours.** Even sharded across
   databases, the account-wide 1 TB D1 ceiling arrives on **day 20** at
   50.4 GB/day of growth.
2. **`MAX_LIFECYCLE_ROWS = 100_000`** (`retention.ts:12`). Once the
   `participants` table exceeds 100,000 rows *and* any participant has ever
   deleted, `replayDeletionTombstones` throws `LIFECYCLE_BOUNDS_EXCEEDED`
   (`retention.ts:178-180`). That aborts the **entire** hourly maintenance
   pass, which means quarantine retention stops, reconciliation stops, and
   snapshot publication stops — all at once, permanently, at exactly this
   scale.
3. **Community snapshot rebuild starvation.** At 30,000 contributors even a
   0.5%/month deletion rate is ~5 deletions/hour, which equals the rebuild
   throttle (`community-snapshots.ts:522`). Every deletion withdraws every
   published snapshot, so community aggregates would spend most of their life
   in the `withdrawn` state.

### 8.5 Summary

| Users | Cloudflare $/month | Dominant driver | First thing that breaks | When |
|---:|---:|---|---|---|
| 100 | **$77** | D1 rows read (93% dashboard) | `/api/v1/me` exceeds D1's 30 s query limit | day 21 |
| 1,000 | **$972** | D1 rows read (93% dashboard) | same, then R2 quarantine deleter saturates exactly at this scale | day 2 |
| 10,000 | **$10,350** | D1 rows read (93% dashboard) | D1 10 GB per-database ceiling — ingest stops | day 2 |
| 100,000 | **$104,180** | D1 rows read (93% dashboard) | D1 10 GB ceiling (4.8 h); then `MAX_LIFECYCLE_ROWS = 100_000` kills all hourly maintenance | hours |

Note what is *not* on this list. Worker requests, Worker CPU, logs, R2 storage,
and R2 operations together cost **$0.00/month at 100 and 1,000 users, $0.80 at
10,000, and $66.84 at 100,000** — 0.06% of the bill at the largest scale. The
hosted side is not expensive because of traffic, bandwidth, compute, or object
storage. It is expensive because of two queries.

---

## 9. Levers, ranked by saving

### Lever 1 — Remove the correlated `accepted_record_count` subquery

`telemetry-repository.ts:552-560` and `:572-580`. The count it computes is
already stored: `telemetry_contributions.declared_record_count` is bound on
insert (`telemetry-repository.ts:485`). If the accepted-after-dedup count is
genuinely needed, `insertTelemetryContribution` already returns
`acceptedRecords` (`:541-545`) and could persist it in a column.

**Saving: `100 × T` rows read per dashboard load, eliminated.**

| Users | Rows saved/month | $ saved/month |
|---:|---:|---:|
| 100 | 90B | **$72** (the whole D1 read bill; the remainder falls inside the 25B allowance) |
| 1,000 | 900B | **$900** |
| 10,000 | 9T | **$9,000** |
| 100,000 | 90T | **$90,000** |

This is ~87–93% of the total bill at every scale, and it also removes the
dashboard timeout that is the system's first failure mode. Cost of the change:
one column and one `UPDATE`, or simply reading the column that already exists.

### Lever 2 — Compute the server-pricing aggregates in the Worker

`telemetry-repository.ts:502-534`. The Worker has already computed
`serverPricing[]` for every usage event in memory
(`telemetry-repository.ts:416`). Summing four numbers in JavaScript and binding
them as literals removes four unbounded table scans per contribution and one
statement from the batch.

**Saving: `2 × T` rows read per contribution, eliminated.**

| Users | Rows saved/month | $ saved/month |
|---:|---:|---:|
| 100 | 7.2B | $0 (falls inside the 25B allowance once Lever 1 lands) |
| 1,000 | 72B | **$47** |
| 10,000 | 720B | **$695** |
| 100,000 | 7.2T | **$7,175** |

Levers 1 and 2 together take the D1 read bill to **zero at every scale** —
what remains is ~86M indexed lookups per month even at 100,000 users, far
inside the 25-billion included allowance. Total cost at 100,000 users falls
from ~$104,000 to **≈$7,000/month**, almost all of which is then D1 rows
*written*.

*(A cheaper-looking alternative — adding an index on
`telemetry_records(origin_contribution_id)` — would also fix the scans, but it
adds a seventh index: +1 row written per record, which at 100,000 users is
+720M rows/month = **+$720/month**. Computing in the Worker is strictly
better.)*

### Lever 3 — Raise `MAX_TOTAL_RECORDS` from 200 to 450

`src/contribution/telemetry-v01-projection.js:16`. Batches per run fall from 2
to 1 for the modelled 233-record run, halving the contribution count from 8 to
4 per contributor per day.

Headroom is verified: the ingest batch is `2N + 2` statements, so `N = 450`
gives 902 plus ~15 request-scoped statements = 917, inside D1's 1,000-query
ceiling. Plaintext would be `450 × 770 = 347 KB`, well inside both the
1,250,000-byte projection cap (`telemetry-v01-projection.js:272`) and the
1,536 KB server ceiling (`constants.ts:2`).

**Saving: ~50% of contribution-proportional costs** — ingest rows read, R2
Class A PUTs, contribution Worker requests, and the ~20 per-contribution
overhead writes. Against **today's** bill that is roughly **$3.60 / $36 /
$360 / $3,600** per month across the four scales. Once Levers 1 and 2 have
landed the cash value is near zero, because the residual bill is D1 rows
*written*, which is per-record and unaffected by batching. Its real value is
then non-financial: it doubles the effective headroom against the 100-per-week
admission cap, from ~2,060 to ~4,600 records/day before a user is throttled.

### Lever 4 — Lengthen the contribution interval from 6 h to 24 h

`src/contribution/recurrence-policy.js:14`. Runs fall from 4/day to 1/day, and
three of the four daily replay overlaps disappear. Batches per contributor per
day fall from 8 to 5 (a single 25-hour run producing 833 records).

**Saving: 37.5% of contribution-proportional costs** — roughly **$2.70 / $27 /
$270 / $2,700** per month against today's bill, plus 37.5% fewer R2 PUTs and
Worker requests, and it removes three of the four daily replay-overlap
re-sends (about 5% of all rows written). Like Lever 3, most of its cash value
disappears once Levers 1 and 2 land.
**Cost:** community aggregates become up to 24 hours staler, and a
user who closes the app before their daily run loses a whole day of coverage
rather than six hours. Given the 48-hour publication cutoff
(`constants.ts:11`), the staleness is invisible in the published product.

### Lever 5 — Stop storing `record_json`

`telemetry-repository.ts:229`, `:276`. **Measured: 766 of the 2,109 bytes per
record — 36% of all D1 storage — is a JSON copy of columns that are already
stored individually.** The only field not otherwise columnised is the
`accounting` sub-object.

**Saving:** D1 storage falls 36%, which extends the runway to the 10 GB
ceiling by 56%: **198 → 310 days at 100 users, 19.8 → 31 days at 1,000, 2 → 3.1
days at 10,000.** Direct cash saving is only ~$1.35/month (D1 storage is
$0.75/GB-month and capped at 10 GB), but the extra runway is the point.

### Lever 6 — Raise `QUARANTINE_DELETE_BATCH_SIZE`

`retention.ts:10`. At 100 objects per hourly pass the deleter tops out at 2,400
objects/day, which is **exactly** the 1,000-user ingest rate. Above 1,000 users
the 7-day quarantine retention stated in `constants.ts:21` silently stops being
honoured and the bucket grows without bound.

**Saving:** small in cash (R2 storage is $0.015/GB-month — $6–13/month at
100,000 users, growing monthly), but this is a **stated-retention correctness
defect**, not a cost item. Raising the batch to 1,000 and/or running the
retention loop until complete would fix it. R2 deletes are free, so there is no
cost objection.

### Lever 7 — Reduce `head_sampling_rate` below 1.0

`apps/worker/wrangler.jsonc`. **Saving: $0 / $0 / $0 / $13.92 per month.** Not
worth doing for cost; keep full-fidelity logs.

### Combined effect

| Users | Today | Levers 1+2 | Levers 1+2+3+4 |
|---:|---:|---:|---:|
| 100 | $77 | **$5** | **$5** |
| 1,000 | $972 | **$25** | **$21** |
| 10,000 | $10,350 | **$657** | **$620** |
| 100,000 | $104,180 | **$7,005** | **$6,585** |

Two bounded changes remove 93–97% of the projected cost at every scale.
Neither changes the privacy contract, the wire format, or the schemas.

Note how little Levers 3 and 4 add once 1 and 2 have landed. That is the
structural point: after the two unbounded scans are gone, the residual bill is
**D1 rows written**, which is proportional to how many records the service
stores, not to how they are batched or how often they arrive. The only way to
reduce it further is to store fewer rows per record — the ingest path writes
**two** rows per record (`telemetry_records` plus
`telemetry_contribution_occurrences`) across nine index entries, and the
occurrence table exists only to attribute a record to the contribution that
carried it.

---

## 10. What could not be determined from the code

These are genuine gaps, not soft numbers. They are listed so nobody mistakes
silence for a value.

1. **Actual adoption of the contribution feature.** Assumption A1 (30%) is a
   guess and is a linear multiplier on every D1 cost line. Nothing in the
   repository can predict it.
2. **Actual records/day for a non-owner user.** The only real telemetry in the
   repository is the owner's own, and he is an extreme outlier (~1,050
   records/hour of parallel-agent work). Assumption A2 (800/day) is a
   judgement, and it is a linear multiplier on storage, writes, and time-to-
   failure.
3. **Worker CPU per request.** Never measured under load; A6–A8 are estimates.
   This does not matter — CPU is under 0.01% of the bill at every scale.
4. **D1's actual row-scan throughput.** The 3.905 s and 180 ms timings in §2.4
   and §2.5 were measured on local SQLite 3.51.0 against a 291 MB database. D1
   runs on a different storage layer and will be slower, so the "first thing
   that breaks" dates are **optimistic** — the dashboard will fail sooner than
   day 21 at 100 users, not later. How much sooner cannot be determined without
   deploying.
5. **Whether D1 bills an index-restricted scan as one row read or two.** The
   `EXPLAIN` output shows the finalize subqueries reaching table rows through
   `telemetry_records_aggregate_time`, so each visited row plausibly costs an
   index row read *and* a table row read. This model counts one. If it is two,
   every D1 read figure above doubles.
6. **Whether the `ratelimits` binding is separately metered.** Cloudflare
   publishes no meter for it. Assumed bundled; unverified.
7. **Whether R2's bulk `delete(keys[])` is billed differently from `DeleteObject`.**
   The R2 pricing page names only the singular form as free. Since deletes
   appear in neither the Class A nor the Class B list, this is assumed free at
   any batch size; unverified.
8. **GitHub's actual fair-use bandwidth threshold for Releases.** Undocumented
   by GitHub. §4 states the risk rather than a number, because there is no
   number to state.
9. **The exact DMG size.** No `.dmg` exists in the working tree. The ~47 MB
   figure is derived from a measured 145 MB app bundle and a measured 43.9 MB
   gzip of its dominant component; DMG container overhead was not measured.

---

## 11. Verdict

The hosted side is affordable at 100 users today — about **$77/month**, of
which $72 is one avoidable query — and it becomes affordable at every scale
modelled here after two bounded code changes.

What is *not* currently safe is opening it to the public, because the system's
failure modes arrive long before its costs do:

- the personal dashboard stops responding within about three weeks at 100
  users;
- the R2 quarantine retention promise stops being honoured above 1,000 users;
- the D1 database fills and ingest stops at 10 GB, which is two days at 10,000
  users;
- and the hourly maintenance pass dies outright at exactly 100,000 participants.

None of those are billing problems. They are bounds baked into the code, and
they should be raised deliberately — with the levers in §9 — before enrollment
is opened, not after.
