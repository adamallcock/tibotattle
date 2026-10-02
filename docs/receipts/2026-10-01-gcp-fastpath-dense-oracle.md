---
title: GCP fast-path dense production-code oracle
date: 2026-10-01
type: receipt
status: snapshot
---

# GCP fast-path dense production-code oracle

This is a 2026-10-01 receipt for branch `claude/gcp-fp-dense-oracle`, built on
`claude/gcp-fastpath-final` at `7ef0e144`. It records **local, synthetic**
evidence only: one macOS arm64 workstation, Node.js 26.2.0 with SQLite 3.53.1,
and content-free corpora. Nothing was pushed or deployed, no GCP or Cloudflare
resource was read or written, and no production data was read. It is not
production, Cloud Run, D1 or real-owner evidence, and it does not prove that
production keeps up with a dense owner under real deadlines.

## What landed

- `apps/worker/scripts/gcp-fastpath-dense-oracle/`: the oracle.
  - `build.mjs` materializes `apps/worker` and `packages` exactly as committed
    at production commit `d43c8f92`, proves every file of the Worker source,
    its test helpers and fixtures, the nine migration directories and the three
    workspace packages against the commit's git blobs (392 files), and bundles
    a re-export entry (`entry.ts`) for Node with esbuild 0.28.1. No production
    file is edited.
  - `oracle.mjs` seeds through d43c8f92's admission helpers exactly as the Q-1
    oracle did, drives the three production scheduled entry points (Tier N),
    captures the public read and per-owner state, records how production's
    graph lane routes every owner's windows, computes or imports the direct
    native references, settles the cache-retention lane and builds the
    per-owner-day cache reference, dumps the source in the Q-1 dump format,
    rebuilds it through the rehearsal loader, and writes the golden.
  - `direct-native.mjs` (with `direct-native-child.mjs` and the standalone
    `direct.mjs`) is the direct native reference; `forced-native.mjs` is the
    budget-sliced forced reference (Tier F); `settled-cache.mjs` and
    `cache-days.mjs` (with `cache-days-child.mjs`) are the cache-retention
    references; `source-digest.mjs` proves source content independently of
    page layout.
  - `runtime.mjs` pins the clock and seeds every random source (Web Crypto,
    `Math.random`, SQLite `randomblob()`/`random()`), so a run reproduces byte
    for byte. `dense-corpus.mjs` and `corpus-summary.mjs` generate and gate the
    dense owner.
- `apps/worker/analytics-v2-test/golden-dense/`: the dense golden.
- `apps/worker/analytics-v2-test/golden-q1-node/`: the Node oracle's
  reproduction of the Q-1 golden (G0), the Q-1 corpus's per-date expectation,
  and its direct and cache-retention references.
- `golden-dense.check.mjs`, wired into `gcp:fastpath:scripts-check`.

## Method

### Running d43c8f92 outside workerd

Only host facilities are substituted, each documented in its file:

- D1 is the HX-4 sealed SQLite adapter (`cloud-run/sealed-sqlite-d1-adapter.mjs`),
  with SQLite's own clock pinned per open.
- `cloudflare:workers` and `cloudflare:test` are Node stand-ins. Migrations
  are applied like vitest-pool-workers' `applyD1Migrations`, but each split
  chunk runs through `exec()` inside one transaction per migration: wrangler's
  splitter leaves multi-statement chunks (the tail of
  `migrations/0012_revisioned_aggregate_rebuild.sql`), which miniflare executes
  in full and `node:sqlite` would truncate to the first statement.
- workerd's `crypto.subtle.timingSafeEqual` comes from `node:crypto`.
- `ANALYZE` runs once on the seeded source (query plans only; `sqlite_*`
  tables are outside the dump).

The topology is Q-1's: the analytics worker with shared features and model
blocks and an external publication lane, the publication worker with shared
features, and the cache-retention builder with shared features, run in that
order each simulated minute, with the long pass every tenth minute. The Q-1
run converges when a progress digest over every analytics table (row counts,
integer sums, text lengths, checkpoint, model-block and shared-feature heads)
stands still for 21 ticks; rotation-only state is excluded (graph scan
position, shared-feature sweep cursor, cache owner cursor, work re-selection
counter, claim tokens).

### The dense run

Production's graph lane needs hours of simulated minutes for the dense owner
e (one native window is 892 to 2,151 single-page steps, and the lane works
one window at a time), so the dense run does not wait for it:

- Cadence: two analytics passes and four publication passes per simulated
  minute, and the clock steps 15 s per minute (`--clock-step-ms 15000`), so
  abandoned 60-second shared-feature claims expire as they do in production.
- Stop rule (`--stop-when daily-published --converge-on daily`): the first
  minute at which every non-conflict corpus day is published and only the two
  conflict-blocked days stay queued. The lease-expiry probe then advances the
  clock two hours in ten-minute steps and checks that no delivery, daily or
  cache-retention output moves; graph-lane tables are outside that scope.
- The scheduled run stops in one process; a second process resumes from its
  databases (`--resume`) with the reference steps below and writes the golden.

### Direct native references

`direct-native.mjs` computes each owner's fits for 2026-10-01 and its 70 model
dates with d43c8f92's own functions, outside the Worker's budget slicing:

- the window is `modelHistoryWindow(day)`; the pin is
  `effectiveHistoryPin(owner, fromDay, day, effectiveHistoryDependency(...))`,
  as `captureStorageGraphScope` computes it;
- `advanceStorageEffectiveAnalysis` is called with the window's `fixedNow`,
  no `preparedQuota`, `preparedUsage` or `preparedUsageReader`, and a budget
  that never runs out, looping on `deferred` with the checkpoint in memory.
  These are exactly the inputs `computeEffective` passes when the owner's
  shared-feature window is refused or shared features are off
  (`STORAGE_V11_PREPARED_FOLD` is false at d43c8f92); `allowQuotaCoverage`
  only matters with prepared inputs. It is also the model-block fallback's
  configuration;
- the result is validated and serialized as the publisher stores it:
  `validCompleteScalarAnalysis` and
  `canonicalJson(selectCommunityAllowanceAnalysisFits(...))` for fits,
  `validCompleteCachedComposition` and `canonicalJson(analysis)` for a model
  date. A thrown production error is a recorded failure.

The dense references came from one `direct.mjs` run (12 child processes) over
a clone of a seeded source whose content digest equals the dense run's. The
golden run imports that file (`--direct-results`), refuses it unless the
digest matches and every owner's fits and 70 dates are present, and
recomputes a sample in its own process (each small owner's fits and its
first, middle and last model dates, and the dense owner's lightest window),
which must equal the file byte for byte.

### Routing record

For every owner and date the golden records what `computeEffective` would do
with shared features enabled: the owner's effective quota and usage inventory
over the window (`readEffectiveTelemetryOwnerDays`), then
`readSharedAnalyticsFeatureWindow` over those days, read-only, on the captured
state. `shared-features` means production passes prepared features; a refusal
means it passes none, which is what the direct references compute.

### Cache-retention references

- `settled-cache.mjs` clears every cache-retention row on a copy of the
  captured analytics database and drives d43c8f92's
  `advanceCacheRetentionDayLane` with the scheduled worker's build
  (`createCacheRetentionDaySourceBuild`), its `maxDays` and `maxWrites`, but
  with the target, source and shared statement allowances and the deadline
  unbounded, until the lane reports `idle`/`complete` or 64 consecutive calls
  build, stage and refuse nothing. It runs with shared features enabled and
  disabled; the public route then reads the settled copy.
- `cache-days.mjs` calls d43c8f92's `createCacheRetentionEffectiveDayBuild`
  for every owner-day with effective usage, on cleared scratch targets, with
  the candidate and carry digests the lane's source build proves (the
  dependency digest of the day and of each of its seven lookback days, empty
  where a lookback day has no source rows). The rows are the aggregate's
  groups and bands as `writeCacheRetentionDay` stores them. Every day the
  settled lane built in the effective layout must equal this reference.

### Tier F and the per-date expectation

Tier F calls `computeStorageGraphResult` with the model-block fallback's
options (prepared fold and prepared effective usage off, no shared features,
result not persisted), re-invoked within production's 1,000-statement
invocation meter until complete, on a scratch copy with every graph cache and
checkpoint cleared and a read-only source.

`per-date-expected.json` is owner decision 2 (per-date model publication with
refused owners excluded and counted) computed entirely by d43c8f92's functions
(`buildCommunityModelCompositionDay`, `projectAdminModelHistoryDay`,
`buildAdminCommunityAllowancePreview`, `projectPublicAllowanceGraph`) over the
per-owner references: the direct result, else the scheduled one, else the
forced one; an owner whose native computation fails is counted as refused.

## Results

### G0: the Node oracle reproduces the workerd Q-1 golden

A Node run over the Q-1 corpus (`--corpus q1 --verify-against
apps/worker/analytics-v2-test/golden`) reproduces the Q-1 workerd golden
(Q-1 branch `9e26237e`) byte for byte: `community-daily-response.json` and
`preview.json`, every `publishedRowDigests` table (daily and model
publications, preview, publication state, cache-retention values and bands),
`sourceDumpShape` (85 tables, 58,048 rows, schema and row-count digests), the
14 withheld model dates, the cache marks and window adjacencies, and the
preview row. Convergence took 321 ticks; the lease-expiry probe moved nothing;
the source was unchanged by analysis. The source dump (`c371aab1…`,
12,535,087 bytes) and its sealed rebuild (`b7ff47a9…`) were byte-identical
across every run, with and without `ANALYZE`, and with the current bundle,
whose entry adds re-exports only.

`golden-q1-node/` was regenerated at the committed oracle (`--resume` from the
converged run, `--forced-native all --direct-native all --settle-cache
both`). On the Q-1 corpus:

- Tier F over all 284 scopes equals every scheduled result it was compared
  with (56, 61, 66 and 64 model dates and each owner's fits).
- The direct native references equal every scheduled result (57, 62, 67 and
  65 scopes for owners a to d, fits included) and every forced result (67,
  71, 71 and 71). Owner a's four conflict-window dates (2026-07-24 to 07-27)
  fail natively with `STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE` in all three.
- Routing: every window is on shared features except owner a's four
  conflict windows (`prepared_day_refused`).
- Cache: the settled lane marks 14 owner-days and then skips every owner;
  the per-owner-day reference builds 671 of 680 owner-days and records owner
  a's 2026-04-17 to 04-25 as `usage_row_refused`; the 8 days the settled lane
  built in the effective layout equal the reference.

### The stepping clock is neutral on the Q-1 corpus

The same corpus run with `--clock-step-ms 15000` (12:00:00Z to 13:21:45Z over
328 ticks) differs from the frozen-clock Q-1 golden, under the rehearsal
comparator, in exactly two fields: `allowanceBreakdowns.generatedAt` and
`preview.generatedAt`. Every daily family, model day and cache count is
equal.

### Owner decision 2 on the Q-1 corpus

`golden-q1-node/per-date-expected.json` equals all 56 model dates production
published, byte for byte. A baseline GCP rehearsal of `7ef0e144` on this
checkout matched every daily family and reported 91 model-day differences
against the Q-1 golden; its stored preview and served `allowanceBreakdowns`
equal `per-date-expected.json`'s `preview` and `allowanceBreakdowns` exactly
(object keys sorted). Those 91 differences are owner decision 2.

### The dense golden

Corpus: owners a to d are the Q-1 corpus; owner e is the `compact` layout of
`dense-corpus.mjs` (`dense-corpus.json`: Q on 2026-04-15, M on 09-10 and
09-18, H on 09-24, X on 09-29, S on the other days of 08-27 to 09-28, L
elsewhere; the current-fits window holds about 230,000 usage rows). Seeding
took 135 s; the seeded source's content digest is
`bdbec7f71134bf4b6455b9562e6c340494f2fe3e31dc9a6d8223a3c065c7804a`.

Scheduled lanes (Tier N), `--clock-step-ms 15000 --analytics-passes 2
--publication-passes 4`:

- The run stopped at tick 184 (185 simulated minutes, analysis clock
  12:00:00Z to 12:46:00Z, 4,819 s) with all 168 non-conflict days published
  and only 2026-04-17/18 queued. Schedule errors: 0.
- The lease-expiry probe (12 steps of 10 minutes to 14:46:00Z) moved no
  delivery, daily or cache-retention output.
- Graph lane at the stop: fits for owners a to d and 30 of their model dates;
  nothing for owner e (its model block still `pending`); no model date or
  preview published (`allowanceState: updating`).
- Determinism: an independent process at the same cadence (started earlier
  from the same corpus) held exactly the same state at tick 150 (162 days
  published, 8 queued, 34 graph results, 91 cache values, 4 model blocks,
  10 checkpoint heads, 56 parts, 867 shared-feature days).

Routing (`manifest.routingEvidence`):

- Shared features refuse owner e's Q, M, H and X days (2026-04-15, 09-10,
  09-18, 09-24, 09-29) and accept its S and L days.
- None of owner e's 70 windows is representable: 66 are refused for
  `window_byte_limit` (more than 8 MiB of features, including windows with
  only L and S days), 1 for `prepared_day_refused`, and 3 still waited at
  capture on 2026-04-17/18 features the shared-feature lane had not yet
  prepared. Today's fits window is refused, so production's graph lane passes
  no prepared input for owner e: the computation the direct references make.
- Owners a to d: shared features, except owner a's four conflict windows
  (refused) and four windows of b, c and d waiting on 2026-04-17/18 features.

Direct native references (`--direct-results`, one `direct.mjs` run):

- Every owner's fits and 70 model dates are complete, except owner a's four
  conflict dates, which fail with `STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE`.
  Owner e's fits and all 70 model compositions are `ready`.
- Owner e's fits window took 2,148 single-page steps; its model windows 892
  to 2,151. The run made 227,110 steps and 3,276,985 statements in 69 minutes
  on 12 processes (13 CPU-hours; per-owner timings in `run-cost.json`).
- The file (`c395b60d…`) was produced over a clone of a source with the same
  content digest; the golden run recomputed 17 scopes in its own process
  (each small owner's fits and its first, middle and last dates, and owner
  e's lightest window, 2026-08-26) and all 17 are byte-identical.
- They equal every scheduled result the replay produced (7, 12, 6 and 9
  scopes for owners a to d; `referenceMismatches` is empty). Owner e has no
  scheduled result to compare.
- Owners a to d's references equal `golden-q1-node`'s, byte for byte except
  `inputFingerprint` (seeding owner e moves the source's global mutation
  epoch, which only that run-specific field carries): 4 fits, 276 model
  dates and the same 4 failures (`golden-dense.check.mjs`).

Per-date expectation (owner decision 2): all 70 dates resolve; owner a is
counted as refused on 2026-07-24 to 07-27; the preview and the served
`allowanceBreakdowns` are computed by d43c8f92's functions over the direct
references. Production published no model date in the replay, so there is no
published date to compare with.

Cache retention:

- The replay's lane stopped building after 91 values: owner e's 2026-04-15
  (the Q day) stayed at progress revision 2 for the rest of the run (132
  `query_budget` deferrals).
- Settled without the per-pass budget, the lane marks 16 owner-days (each
  owner's 2026-04-15/16, and 04-17/18 in the typed-v11 layout for a, b and d),
  then skips every owner on every call (`owner_source_unavailable`, 332
  times), with shared features enabled and disabled alike.
- The per-owner-day reference (`cache-reference.json`) covers all 850
  owner-days (170 per owner): 841 built and owner a's 2026-04-17 to 04-25
  `usage_row_refused`. The 10 days the settled lane built in the effective
  layout equal it.
- `community-daily-response.json` is the replay's read;
  `community-daily-response-settled.json` is the read after settling, and
  differs from it only in `cacheRetention`.

Source:

- Dump in Q-1's format (`usage-monitor-db.json`): 163,950,762 bytes,
  sha256 `1d0bef8ee1dab81bd33533012b8b4cbed673c9ccea22295210f7ec2336d0501a`,
  85 tables, 791,849 rows. It is below V8's string limit, so the rehearsal
  loader (`rebuildOracleSqlite`, the importer chain's first step) reads it.
- Sealed rebuild: 247,812,096 bytes, sha256
  `cb04f41191aff1cba7873011c0a8846818027a52a3e248dd677781c0fb005ad0`,
  `quick_check` ok, seal-ready, 85 populated tables. The dump and the rebuild
  were byte-identical in all three dense processes that wrote them.
- Neither is committed (size). `SOURCE.json` records both digests and the
  commands; the analysis did not change the source.

Importer chain (partial): the Q-2 rehearsal at this checkout
(`gcp-fastpath-rehearsal.mjs`, local PostgreSQL 17 on the private socket)
was started over a golden directory holding this dump. It rebuilt and sealed
the dump and ran T-1 identity, the typed-legacy transfer, the legacy
transport copy and T-2's v1.2 copy: the target held 5 participants and owner
links, 11,183 typed v1.1 records and 364,111 v1.2 typed records (296,491
usage, 62,790 quota), equal to the source's counts. T-2's effective-reader
verification, which pages every v1.2 occurrence through the PostgreSQL
reader, was still running after 50 minutes when this receipt was written, so
the later importers, the refresh and the parity compare have no result here.
That rehearsal's refresh is this checkout's pre-cap-raise build in any case;
the parity gate is the cap-raise branch against this golden.

## Regenerating the dense golden

Three steps, all local, with Node.js 26.2.0
(`~/.nvm/versions/node/v26.2.0/bin/node`) and work directories outside the
repository:

1. The scheduled lanes, to the stop rule:
   `oracle.mjs --work-dir <A> --corpus dense --clock-step-ms 15000
   --analytics-passes 2 --publication-passes 4 --stop-when daily-published
   --converge-on daily --forced-native none` (about 85 minutes here).
2. The direct references over that run's seeded source:
   `direct.mjs --work-dir <B> --source <A>/db/usage-monitor.sqlite
   --expect-source-digest bdbec7f7… --jobs 12` (about 70 minutes).
3. The golden: step 1's flags plus `--resume <A> --direct-results
   <B>/direct-results.json --direct-jobs 12 --settle-cache both --golden-out
   apps/worker/analytics-v2-test/golden-dense` (about 30 minutes).

`--direct-native all` in step 3 replaces step 2 in one process.

## Production findings

These are d43c8f92 behaviours the oracle measured on synthetic data. They are
not production observations.

- **A conflict-blocked daily day stops the cache-retention lane for every
  owner.** The effective day build proves each of its seven lookback days
  against the daily lane's owner rows. A day the daily lane never publishes
  has no owner row, so its recorded digest is empty while the source holds
  rows for it, and every later day of every owner is skipped as
  `owner_source_unavailable` on every pass. On both corpora, whose
  2026-04-17/18 are blocked by owner a's crossed-day conflict, no owner-day
  after 2026-04-18 is built once the daily lane has published (the
  interleaved Q-1 replay built some later days in the typed-v11 layout while
  the daily lane was still behind).
- **A dense owner-day starves the cache lane under the per-pass budget.**
  Owner e's 2026-04-15 never advanced past progress revision 2 in 185 passes;
  with the budget lifted it builds in about 24 s.
- **Shared features represent none of a dense owner's windows.** The 8 MiB
  window limit refuses 66 of owner e's 70 windows, including windows whose
  every day is under the 6,000-row and 4 MiB day bounds; the other four hold
  a refused day or waited on unprepared days. Production's graph lane
  therefore computes such an owner's windows natively.
- **The native effective path costs O(owner records) per page.** The
  effective reader's page query materializes every v1.2 chunk and record of
  the owner and then filters the requested occurrence ids: about 60 to 130 ms
  per page for a 450,000-record owner, 150 to 600 ms here under load. A
  window's native computation is therefore quadratic in owner size.
- **Without planner statistics the dependency query is quadratic in a dense
  day's chunks.** SQLite joins v1.2 records through `(manifest_id, stream)`
  instead of `chunk_id`: 4.6 s against 0.47 s per execution after `ANALYZE`.
  Whether production D1 holds `sqlite_stat1` is not known here.
- **The daily lane folds a dense day 50 records per stream per attempt**, at
  most four attempts per publication pass, so later queued days wait behind
  a dense day for hundreds of passes.
- **A dense day's daily attempt is reported as a failure every pass.** When the
  daily statement allowance runs out inside `readCollectionControls`, the
  budget error is caught and rethrown as `COLLECTION_CONTROL_UNAVAILABLE`, and
  the lane logs `daily_publish` `application` (119 times in the dense run)
  although the fold progressed.
- **Abandoned claims stall dense work until they expire.** Shared-feature day
  builds hold 60-second claims and passes end on their statement meters
  mid-claim; with a frozen clock they never expire, which is why the dense
  run steps the clock.
- **One native computation spans many invocations.** `createD1InvocationBudget`
  refuses more than 1,000 statements, so a forced window of owner e needs
  hundreds of invocations, each reloading its checkpoint.

## Claim boundary

- Synthetic corpora on one workstation; SQLite 3.53.1 under Node, not D1. G0
  is the evidence that this substitution reproduces the workerd Q-1 oracle.
- The dense fits and model references are production's native computation
  outside the Worker's budget. Production would publish them only after its
  graph lane finished, which this run did not wait for; the run shows what
  production computes, not that it keeps up. For owner e, routing shows the
  graph lane takes the native path; whether its model blocks would instead
  prepare owner e's days, and give the same compositions, is not established
  here (equality of the prepared and native paths is established on the
  small owners only).
- The cache-retention reference is production's day build outside the lane.
  Production's lane itself never reaches most of these days on these corpora
  (see the findings); the settled read records what it does publish.
- The topology is Q-1's reading of the deploy plan, not verified live
  configuration.
- Nothing here exercised the GCP fast path's own computation over the dense
  corpus; that comparison (the cap-raise branch against this golden) is the
  next gate. (Run later on 2026-10-01: every family equal; see the
  [dense-owner parity receipt](./2026-10-01-gcp-dense-owner-parity.md).)
