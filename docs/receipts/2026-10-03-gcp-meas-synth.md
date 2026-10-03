---
title: GCP production-shaped synthetic refresh measurement (MEAS-SYNTH)
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP production-shaped synthetic refresh measurement (MEAS-SYNTH)

This receipt records one local full-recompute analytics refresh over the
production-shaped synthetic corpus. The run started 2026-10-02 23:40 UTC and
finished 2026-10-03 04:34 UTC, on branch `claude/gcp-fp-meas-synth` (tooling
commit `0798e1ef`, on `claude/gcp-fastpath-final` `f8a8620d`). The analytics
engine is unchanged from `f8a8620d`. `apps/worker/src/analytics-v2` is also
identical to C-REFRESH's `0d3f73c8`, the image the 2026-10-02 dense cloud
rerun measured.

What this proves, and what it does not:

- It proves local PostgreSQL 17 on macOS arm64, Node 22.16.0 for the job,
  synthetic and content-free data only.
- The Cloud Run figures below are projections, not measurements. The cloud
  gate is `apps/worker/scripts/gcp-fastpath-prod-shape/run-cloud-measurement.sh`
  in the TEST project. It has not run. It makes every remote call through
  `apps/worker/scripts/gcp-fastpath-test-deploy.mjs` steps, including
  `refresh-uncapped`, which times the long run.
- Nothing here read production data or touched a remote resource.

This receipt holds three rounds, all on 2026-10-03:

- **Third round** (next section): profiling for the production-tier cloud
  run. It adds the job's opt-in CPU profiler, database statistics snapshots
  and a Cloud Monitoring read, makes one profiled uncapped run the kit's
  default, and measures the profiler's overhead on a 1% slice. It supersedes
  the second round's kit where it says so.
- **Second round**: the same corpus on the K-CORE-A engine
  (`claude/gcp-fastpath-final` `f6cbab90`, merged at `71b3a21b`). It
  supersedes the first round's cloud projection, its K-CORE-A notes and its
  cloud gate. It adds a production-tier cloud kit.
- **First round** (from "Corpus" on): the pre-K-CORE-A engine (`f8a8620d`).
  It is kept unchanged as that day's evidence. Its corpus and import facts
  still hold.

## Third round: profiling the production-tier run

The owner asked (2026-10-03) for the 10 to 13 h production-tier run to be
fully profiled, and for a small slice to show where the time goes. This round
adds the profiling to the kit and checks it locally on a 1% slice. **No cloud
step ran.** Branch `claude/gcp-fp-meas-synth`, on `cfd610f0`.

### What the kit now records

**The job (`apps/worker/cloud-run/analytics-refresh-profile.mjs`):**

- `ANALYTICS_V2_REFRESH_PROFILE=cpu` starts node:inspector's sampling
  profiler in the job's main thread. `ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US`
  sets the interval (default 10,000 us, 1,000 to 100,000).
- Every 30 min (`ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS`), at exit
  (complete, refused, failed, the time guard included) and on SIGTERM (Cloud
  Run's task timeout or a cancel), it writes one JSON line to stderr:
  - the top 40 functions by self time and by total time since the start, the
    top 20 files, and the window's top 15;
  - the run phase and owner progress counts;
  - heap and resident set, GC count and time by kind, CPU time and busy
    cores, and event-loop utilisation.
- It is content-free. A function is `<repository path>:<name>`. The path
  comes from the bundle's own module markers, and any other path is cut to its
  repository or `node_modules` tail. A name that is not identifier-like is
  `(unnamed)`, and a compiled regular expression is `(native):(regexp)`.
- A production target refuses every `ANALYTICS_V2_REFRESH_PROFILE*` variable
  (`ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN`). A staging target accepts the
  mode, interval and period, and nothing else. The test targets, the
  measurement job included, accept them too. Only a local run, outside Cloud
  Run, accepts `ANALYTICS_V2_REFRESH_PROFILE_DIR` for raw `.cpuprofile` files.
- The line has no `status` key. The wrapper's log read keeps the lines apart
  (`profiles` in `refresh.json` and `refresh-uncapped.json`), and they stay in
  Cloud Logging if the run is killed.
- **No raw profile is uploaded from Cloud Run.** The runtime account's only
  bucket write is the fast-path origin bucket's `telemetry/` namespace, which
  the origin reads, and the job image has no storage client. The summary lines
  are the cloud record.
- It profiles the main thread only. K-PAR Workers (`dense-workers`) are
  separate isolates and are not sampled.

**The database (the wrapper):**

- `meas-create` reads `gcloud sql flags list --database-version=POSTGRES_17`
  first and refuses before any write unless the listing names every flag. It
  then creates the instance with production's flags plus
  `pg_stat_statements.track=all` and `track_io_timing=on`.
  `cloudsql.enable_pg_stat_statements=on` is added only when the listing names
  it (this round could not check whether it exists), and the receipt records
  which. Query Insights is on: 5 plans per minute, 4,500-byte query text, no
  client addresses or application tags. Everything is set at creation, so
  nothing restarts mid-run.
  - This is a stated divergence from production, which runs Insights off and
    neither diagnostic flag. Their overhead was not measured.
- `meas-pgstat-enable` (the one write, on the measurement database only, as
  the migrator IAM user): `CREATE EXTENSION IF NOT EXISTS pg_stat_statements`,
  then `pg_stat_statements_reset()` when the role may. If it fails, the run
  goes on without statement statistics.
- `meas-pgstat --label=<name>`: read-only (`BEGIN READ ONLY`, 60 s statement
  timeout), through the connector, as the migrator. It snapshots
  `pg_stat_statements` (query fingerprint, normalized text with every literal
  replaced by `'?'`, the K-PGSTAT family tag), `pg_stat_database`,
  `pg_stat_io`, `pg_stat_wal`, `pg_stat_checkpointer`, the seeded schema's
  table and index I/O, and the sessions by wait event. Roles and application
  names are classed, never named.

**Cloud Run:** `meas-metrics --since --until` reads Cloud Monitoring
(read-only GETs, project `tibotattle` only, the operator's token held in
memory). It reads the measurement job's container CPU and memory utilisation
(per-minute mean and 99th percentile) and received bytes, and the instance's
CPU, memory, disk operations and bytes sent.

**The run shape (`run-prodtier-measurement.sh`):**

- One profiled, **uncapped** run per profile is the default. `refresh
  --no-execute` deploys the job (its `refresh.json` says `executed: false`),
  and `refresh-uncapped` follows it directly.
- The guarded run is optional (`MEAS_GUARDED=1`, default off). Round 17 raises
  the timeout anyway.
- Database snapshots are taken before the run, every 30 min during it (a
  sampler beside the waited child) and after it. Then the metrics are read.
- `summarize-prodtier.mjs` writes `summary.json`. It works on a partial
  directory, so a killed run still shows its last profile line, its database
  delta to the last snapshot and its sessions.
- Teardown is unchanged: the `EXIT` trap, and a signal stops the child and the
  sampler at once (`prod-shape.check.mjs` sends TERM to the script's own
  functions with a sampler running).

### The 1% slice: where the time goes

This was run locally, as a check of the profiler and its overhead:

- The production-shaped generator at scale 0.01: 54 owners and 82,971
  records (usage 68,581, quota 11,642, session 2,748), sealed `c3fed4dc…`.
- Imported once through the reviewed chain (69 migrations), then one template
  copy per run.
- Node 22.16.0 for the job, the `dense` profile, on the PostgreSQL 17 fan-out
  cluster.
- The host was shared and loaded (load 7 to 9). The databases were dropped
  afterwards.

One run at 1 ms sampling (74.8 s wall):

| Phase | Time |
|---|---:|
| Read | 37.6 s: 15,032 statements, 23.7 s in statements, 13.9 s unattributed client work |
| Prepare | 27.6 s |
| Model | 6.9 s |
| Scalar, community, cache, write | 1.2, 0.5, 0.2, 0.4 s |

The profile of the main thread, by share of sampled time:

- 37% idle: waiting on PostgreSQL, in line with the 23.7 s of statements.
- Most of the CPU goes to preparing days.
  `analytics-shared-reducers.ts:prepareSharedAnalyticsDay` holds 27% in total.
  Inside it:
  - `v11-daily-projection-values.ts:foldV11DailyProjectionValues`: 21%
    (validate 14%, merge 11%, normalize 9%; `closed` alone 5% self);
  - telemetry v1.1 parsing and canonical JSON: about 7%;
  - reconciliation (`reconcileGroups`): 7%;
  - pricing (`priceChunkUsageRecord`): 7%.
- GC: about 4% (8,139 minor collections, 2.1 s). Compiled regular expressions:
  about 3%.

**This mix is not the 13 h run's.** At full scale the model phase is 58% of
the local run (8,688 of 15,061 s). Here it is 9%, because it grows with each
owner's analysis rows. So the slice says where read and prepare time goes. It
says little about model time. The cloud run's profile lines answer that.

### Profiler overhead

The same slice was run with the profiler off and at 1, 5 and 10 ms, three
times each, interleaved, on template copies:

| Sampling | Wall time, s (3 runs) | Fastest vs off | Median vs off | Samples |
|---|---|---:|---:|---:|
| off | 74.6, 71.7, 82.4 | | | |
| 1 ms | 74.8, 75.3, 81.8 | +4.3% | +1.0% | about 54,000 |
| 5 ms | 76.1, 75.8, 92.5 | +5.7% | +2.1% | about 12,000 |
| 10 ms | 74.7, 84.2, 85.6 | +4.2% | +12.9% | about 6,500 |

A fixed CPU-bound loop was also timed: five fresh processes per mode,
interleaved, about 2.2 s each. Its medians against off were −0.2% (1 ms),
+2.1% (5 ms) and −1.0% (10 ms).

What these show:

- The profiler's cost is **not separable from this host's noise**. With the
  profiler off, the slice alone spread 15%.
- The differences do not scale with the sampling rate: 1 ms takes about
  eight times the samples of 10 ms at the same cost.
- The defensible statement is: under about 5% on this host at 1 to 10 ms, and
  about 2% or less on pure compute.
- The kit samples at 10 ms. That gives about 180,000 samples per 30-minute
  window, with the smallest footprint.
- The overhead on Cloud Run is not measured.

### Running it

The run script (`apps/worker/scripts/gcp-fastpath-prod-shape/run-prodtier-measurement.sh`)
is the runbook: its header lists every step and setting. Defaults:

- the `dense` profile only;
- no guarded run;
- the CPU profiler at 10 ms;
- database snapshots every 1,800 s;
- an uncapped cap of 172,800 s.

The image must be built from this round's commit. An image of `cfd610f0` has
no profiler: it ignores the setting and runs unprofiled.

| Step | Expected duration |
|---|---|
| Build | about 2 to 15 min |
| `meas-create` (flag listing first) | 10 to 20 min |
| Seed | 2 to 6 h |
| `meas-pgstat-enable`, each `meas-pgstat` | under a minute each |
| Deploy (`refresh --no-execute`) | about a minute |
| Uncapped, profiled `dense` run | 10 to 13 h projected (cap 48 h); about 26 profile lines and 26 snapshots |
| `meas-metrics` | about a minute; rerunnable later, read-only |
| `meas-teardown` | about 5 to 10 min |

If the run is killed:

- The job's last profile lines are in Cloud Logging (filter
  `jsonPayload.profile="analytics-refresh-profile-v1"` on the measurement
  job).
- The snapshots taken so far are in `$OUT/pgstat`, and
  `summarize-prodtier.mjs $OUT dense` summarises them.
- Teardown follows the second round's rules.

### Reproduce (third round)

Local only:

- Generate the slice, then import it once:

  ```
  … seed-source.mjs --work-dir <dir> --scale 0.01
  … measure-local.mjs --corpus <dir> --out <import.json> --import-only
  ```

- One run per mode, each on a template copy:

  ```
  … measure-local.mjs --corpus <dir> --out <report.json> --clone-from meas_synth_<hex> [--cpu-profile 1000|5000|10000] [--cpu-profile-dir <dir>]
  ```

  Each report keeps every profile line (`steps.refresh.profileLines`).

- Checks, all passing on this branch:
  - `apps/worker/cloud-run` `npm run check`, under Node 26;
  - `npm --prefix apps/worker run gcp:fastpath:scripts-check`;
  - `npm --prefix apps/worker run gcp:ops:infra:check`;
  - the refresh spec's "database targets|production target" tests;
  - root `npm run test:preflight` and `npm run architecture:check`.

### Gates this round has not passed

- No gcloud command ran. This affects four things:
  - whether `cloudsql.enable_pg_stat_statements` exists, which the create
    handles either way;
  - whether the migrator may `CREATE EXTENSION`: the IAM users'
    `cloudsqlsuperuser` membership on a fresh instance is still the second
    round's assumption, and a failure leaves the run without statement
    statistics;
  - whether Cloud Monitoring serves container utilisation for a
    `cloud_run_job`: a metric that answers an error is recorded and the rest
    go on;
  - Query Insights' plan sampling on this tier.
- Cloud Logging's retention bounds how long the profile lines can be read
  back. Each line is about 11 KB.

## Second round: K-CORE-A engine

A same-day review corrected this section: the guard's refusal point, the
idle-time attribution, the input-equality claim and the cloud kit's teardown.

What this round ran:

- Branch `claude/gcp-fp-meas-synth` with `claude/gcp-fastpath-final`
  `f6cbab90` (K-CORE-A, and K-STAMP's primary 0069) merged at `71b3a21b`.
- The runs started 2026-10-03 05:16 UTC and ended at 10:34 UTC.
- The same sealed corpus as the first round (`27de2e01…29f6`).
- It was imported through the merged tree's chain into a fresh
  `meas_synth_fba9c0be`, in 1,259 s (69 migrations, 9.14 GB). The two K-CORE-A
  runs (`dense` and `dense-workers`) each read their own template copy of it
  (`CREATE DATABASE … TEMPLATE`), so those two had byte-identical inputs.
- The same-day baseline: `0b8acc40`'s tree (engine `f8a8620d`), exported with
  `git archive`, built under Node 22.16.0. It was imported through its own chain
  into `meas_synth_96baa67c` (67 migrations, run concurrently with the
  first import), and ran directly on that import, not on a template copy.
  - Both imports load the same sealed corpus (`27de2e01…`), but input equality
    across the two engines' imports is not shown. Only output equality is (see
    "Parity" below).
- Kernel: closure `71ac8d24…`, registry entry 1. The build stamps it, and this
  branch leaves it unchanged.
- Run on the local PostgreSQL 17 fan-out cluster (port 55433) on macOS arm64
  (18 cores, 128 GB), with Node 22.16.0 for the job.
- The host was shared with other agents' work (load 4 to 6). The jobs ran at
  nice 5 (zsh's background default).
- Every `meas_synth_*` database was dropped afterwards. The content-free reports
  are in the parity home's `receipts/meas-synth-kcorea-local-20261003/`.

### Production defaults

The K-CORE-A production profile is **inline**. `ANALYTICS_REFRESH_PRODUCTION_JOB`
and the wrapper's `dense` profile run without `--workers`, at a
12,288 MiB heap and a 10,752 MiB budget. K-READ is always on: it uses named
generic-plan expansion statements over the job's four-connection snapshot
pool.

K-PAR's Workers have only the measurement profile `dense-workers` (four
Workers, a 3,072 MiB main heap). The K-CORE-A review kept them out of
production until a measurement of the Workers' heap peaks.

This round measured both profiles. The inline run ran concurrently with the
baseline, which gives a same-conditions A/B. The `dense-workers` run ran alone.

### Results

| | K-CORE-A `dense` (production, inline) | Baseline `f8a8620d` (same day, concurrent) | K-CORE-A `dense-workers` (W = 4) |
|---|---:|---:|---:|
| Exit / state | 0 / `complete` | 0 / `complete` | 1 / `ANALYTICS_V2_REFRESH_WORKER_OUT_OF_MEMORY`, nothing written |
| **Wall time** | **15,061 s (4.18 h)** | **15,443 s (4.29 h)** | failed at 2,214 s |
| CPU, user + sys | 12,972 + 476 s | 12,900 + 466 s | 2,033 + 125 s |
| Read | 3,492 s | 3,931 s | |
| Prepare | 2,638 s | 2,538 s | |
| Scalar | 220 s | 204 s | |
| Model | 8,688 s | 8,750 s | |
| Cache, community, write | 12, 0.7, 8.4 s | 13, 0.6, 5.5 s | |
| Busy cores (process CPU / wall, 5 s `ps` samples) | mean 0.89 of 4. About 1 for 86% of wall, about 0 for 14% | | mean 0.97 of 4. About 0 for 39%, 1 for 32%, 2 for 29%, 3 for 0.2% |
| PostgreSQL backend CPU (15 s `ps` samples) | 2,094 s | 2,541 s | at least 1,327 s |
| **Peak RSS, whole process** | **5,188 MB** (`time -l`); receipt 4,948 MiB | 5,339 MB; receipt 5,092 MiB | **11,342 MB** (`time -l`); sampled 9,813 MiB |
| Largest estimate / heap peak | 5,153 / 4,120 MiB | 5,153 / 4,263 MiB | |
| Output account | 492 MiB | 492 MiB | |

K-CORE-A on the production profile:

- It is **2.5% faster** (−382 s) than the same-day baseline.
- Read is −11% (−439 s), and the database CPU is −18%. That is K-READ.
- Prepare is +4%, scalar +8%, and model −0.7%.
- The baseline repeats the first round's 15,530 s within 0.6%, so running the
  two jobs concurrently did not distort the comparison.

The read phase of the inline run, from its statement ledger (K-PGSTAT):

- 100,699 round trips, 2,140 s in statements and 1,351 s of unattributed
  client work.
- The top families:
  - `occurrences.legacy_sources`: 789 s for 40,817 calls, 4.05 GB received;
  - `occurrences.legacy_candidates`: 430 s;
  - `occurrences.first_evidence`: 415 s for 224 calls;
  - `occurrences.counts`: 411 s for 318 calls;
  - `occurrences.v12_sources`: 78 s.
- `pg_stat_statements` is not installed locally, so the server's share is
  `null`.
- The 14% of the run at about 0 busy cores (about 2,080 s) is the client
  waiting on server statements: 2,140 s in all, led by `legacy_sources` and
  `legacy_candidates`.
- The counts and first-evidence families are 826 s (about 13.8 minutes) of
  that wait. All of it comes before the first owner: the job reads every
  owner's first evidence day and counts before it plans.

**K-PAR at production scale fails closed.** The `dense-workers` run refused
`ANALYTICS_V2_REFRESH_WORKER_OUT_OF_MEMORY` 37 minutes in and wrote nothing (every output
table is empty). This is the risk the K-CORE-A review held the Workers back
for:

- A Worker's heap limit is its owner's estimate plus 1,024 MiB.
- The inline run's per-owner record (`analytics_v2_runs.timings` owners) shows
  37 of the 53 owners peaking above their estimate.
- Four of them peaked above estimate + 1,024 MiB:

  | Estimate | Sampled heap peak |
  |---:|---:|
  | 647 MiB | 4,065 MiB |
  | 328 MiB | 1,442 MiB |
  | 190 MiB | 1,996 MiB |
  | 130 MiB | 3,983 MiB |

- Inline samples include main-heap residue, so they are an upper bound, not a
  Worker measurement.
- The job's error line is content-free and does not name the Worker's owner.

Even before the failure, the Workers barely overlapped:

- The mean was 0.97 busy cores, and never more than about 3.
- The first 13.8 minutes waited on the server's counts and first-evidence
  queries.
- The main thread serves every segment load one at a time.

**Per-Worker RSS is not measurable.** Workers are threads of one process, so
the only RSS is the whole process's (above). The job reports no per-Worker
heap peak for a failed run.

**Parity: the outputs are identical.** Every output table's content digest is
equal between the K-CORE-A inline run and the same-day `f8a8620d` run.

| Table | Rows | Digest |
|---|---:|---|
| `analytics_v2_cache_bands` | 542,650 | `68694230…` |
| `analytics_v2_owner_day` | 10,025 | `440c0271…` |
| `analytics_v2_owner_model_dates` | 3,710 | `0f15aa65…` |
| `analytics_v2_published_daily` | 488 | `1a22fb77…` |
| `analytics_v2_owner_fits` | 53 | `048e6576…` |
| `analytics_v2_preview` | 1 | `a32b8d43…` |
| `analytics_v2_journal_cursor` | 1 | `6335c48a…` |

How the digests are made, and what they compare against:

- `measure-local.mjs` `outputDigests`: sha256 over the sorted md5 of each
  row's JSON. Only the run identity, the kernel stamps and the instants are
  left out (`run_id`, `kernel_id`, `manifest_version`, `released_at`,
  `computed_at`, `started_at`, `finished_at`, `registered_at`, `timings`,
  `compatibility_sha256`).
- The first round stored no digests and dropped its database, so parity is
  shown against the same-day rerun of its engine on the same corpus.
- That rerun also reproduces every first-round figure recorded:
  - 53 owners and 10,025 owner-days;
  - 488 published days;
  - cursor `10289`;
  - the 492 MiB output account;
  - 944,456 published payload bytes, the largest 1,962.

### Revised projection

What each ratio set measured:

- **Both sets were measured against the shared-core test instance**
  (`tibotattle-test-primary-20260922`, db-g1-small: a shared vCPU and
  1.7 GB), from a 4 vCPU / 16 GiB Cloud Run task, on the dense corpus.
- Set A is C-REFRESH's like-for-like rerun. Set B is MEAS-1's, which is
  cross-engine (first round, "Cloud projection").
- In set A:
  - The **compute ratios** (prepare 2.13, scalar 2.63, model 2.51) are
    Cloud Run vCPU against a local core. Those phases do no database work:
    owner loads are booked to read. So they carry over to any database tier.
  - The **read ratio** (5.35) mixes three things: the shared-core database,
    the network and the client's decode work. It is the only figure the
    production-tier instance (db-custom-4-16384, four dedicated vCPUs, 16 GB)
    changes.
- No ratio has been measured against a dedicated-core instance. The cloud kit
  below measures it.

K-CORE-A inline (production profile) on Cloud Run:

| Phase | Local | Shared-core, set A | Shared-core, set B (cross-engine) | Dedicated-core target |
|---|---:|---:|---:|---:|
| Read | 3,492 s | 18,682 s | 31,079 s | 8,830 to 18,682 s |
| Prepare | 2,638 s | 5,619 s | 7,254 s | 5,619 s |
| Scalar | 220 s | 579 s | 671 s | 579 s |
| Model | 8,688 s | 21,807 s | 26,238 s | 21,807 s |
| Other | 21 s | 64 s | 64 s | 64 s |
| **Total** | **15,061 s** | **46,751 s (13.0 h)** | **65,306 s (18.1 h)** | **36,899 to 46,751 s (10.2 to 13.0 h)** |

How the dedicated-core column is built:

- **Compute phases:** set A's compute ratios.
- **Read, upper end:** the shared-core ratio, as if the instance did not
  matter.
- **Read, lower end:** an assumption, not a measurement. Every read is taken
  at about the compute ratio (2.5), as if neither the server nor the client
  were the bottleneck any more, plus about 1 ms of same-region round trip for
  each of the 100,699 statements.

What follows from the table:

- **The 14,400 s production task does not fit on any database tier.**
- The compute phases alone are 28,005 s (7.8 h) on Cloud Run. They are
  single-threaded and inline, so the database instance does not change them.
- The dedicated instance can save at most about 9.9 ks of read time.
- The cadence question is daily (≤ 12 h) or every two days. This projection
  straddles the 12 h line. Only the production-tier measurement decides it.

The time guard still plans 10,998 s, because `ANALYTICS_REFRESH_TIME_MODEL`
did not change. When it refuses depends on the read ratio r, through the
pre-owner counts:

- The plan checkpoint fires only after the counts and first-evidence queries,
  826 s locally, so about 826 × r s on Cloud Run.
- The guard refuses when the elapsed time plus the planned work passes about
  14,220 s (the task timeout less the exit margin and the minimum write). With
  10,998 s planned, that is any r of about 3.9 or more: the plan checkpoint
  refuses before any owner starts.
- Below that, the owners in digest order hold 0.41%, 13.47%, … of the plan.
  At r up to about 3.75, the third owner's checkpoint refuses, after 13.9% of
  the planned work. Between about 3.75 and 3.9, the second owner's does.

| Read ratio r | Refusal checkpoint | About |
|---:|---|---:|
| 2.5 (dedicated, lower end) | third owner | 1.9 h |
| 3.0 to 3.75 | third owner | 2.1 to 2.3 h |
| 3.75 to 3.9 | second owner | 0.9 h |
| 3.9 to 5.35 (5.35: shared-core set A; dedicated, upper end) | plan | 0.9 to 1.2 h |
| 8.9 (shared-core set B) | plan | 2.0 h |

So the guarded run should refuse `ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED`
about 0.9 to 2.3 h in, on either tier. How long it takes and which checkpoint
refuses is itself a reading of the dedicated tier's read ratio. These figures
assume each owner's cloud time is the rest of the projected run in its
planned share. They ignore the output account's small effect on the write
reserve.

Two directions are not measured, and this receipt claims neither:

- K-PAR could shorten the compute phases. Its critical path is at least the
  largest owner, 28.5% of the analysis rows, about 8 ks on Cloud Run. It is
  also bounded by the main thread's serial loads. But it fails at the
  production budget first, and needs a Worker heap bound (or per-Worker
  limits sized from measured peaks) before any measurement.
- K-INCR stays the change that removes the linear-in-history recompute.

### Production-tier cloud kit (not yet run)

This round adds a disposable measurement estate to the wrapper
(`apps/worker/scripts/gcp-fastpath-test-deploy.mjs`), in the test project
`tibotattle` only. The cloud steps are the main session's.

**The instance:**

- It is `tibotattle-meas-prodtier-<YYYYMMDD>`
  (`cloud-run/origin-fastpath-mode.mjs` `FASTPATH_MEASUREMENT_CLOUD_TARGET`).
- `meas-create` creates it with production's shape: PostgreSQL 17 ENTERPRISE
  zonal, db-custom-4-16384, 50 GB SSD with auto-increase, C-INFRA's nine
  logging flags plus `max_connections=100`, and Query Insights off.
- Connectivity is production's: a public address reachable only through the
  connector (connector enforcement `REQUIRED`, no authorized networks).
  - A private-IP-only instance is not possible without a runtime change.
  - The job's connector (`cloud-run/cloud-sql.mjs`) and the seed's
    (`scripts/gcp-fastpath-connection.mjs`) dial `ipType: PUBLIC`.
  - The seed runs on the operator's machine.
- It differs from production only where a disposable instance must: no
  deletion protection, no backups or PITR, and test labels
  (`purpose=meas-prodtier`).
- `meas-create` waits for the create operation and reads the instance back
  against that shape. It then creates `tibotattle_fastpath` and the migrator
  and runtime IAM users if absent.
- It refuses an existing instance of that name that does not carry this
  wrapper's labels.
- The check pins the tier, the storage, the posture and the flags equal to the
  production desired state and to `gcp-ops-infra-manifest.mjs`.

**The refresh job:**

- With `--meas-instance`, `refresh`, `refresh-idle` and `refresh-uncapped`
  deploy and execute `tibotattle-fastpath-meas-analytics-refresh` on that
  instance, for a seeded schema only.
- The job accepts that instance only as that job. The test job never reaches
  it.
- A production or staging target naming any measurement resource is refused:
  the `meas` token, the instance prefix and the job name.
- The infra manifest counts these names among the test estate.
- The uncapped run follows only that instance's guarded run.
- It has its own database and lock, so the shared fast-path job and its lock
  are untouched.

**The seed:** `gcp-fastpath-seed.mjs seed --meas-instance=…`. It dials only a
name that passes the same check.

**The teardown:** `meas-teardown` runs these in order:

1. Cancels the measurement job's running executions and deletes the job.
2. Deletes the instance, but only one that reads back with this wrapper's
   labels. It deletes the instance even if the job's removal failed.
3. Reads both back absent.

It takes presence and absence only from listings of the project
(`gcloud sql instances list`, `gcloud run jobs list`) that succeeded:

- A failed read (expired or reauth-required credentials, a network,
  permission or quota error) is an error, never "absent".
- Every failure ends the step with `FASTPATH_DEPLOY_MEAS_TEARDOWN_INCOMPLETE`.
- It also fails while any measurement instance (label `purpose=meas-prodtier`
  or the name prefix) remains in the project, and names it in
  `remainingMeasurementInstances`. A teardown of a name that never existed
  (for example a `date` evaluated again after midnight) therefore cannot
  report success while the real instance runs.
- `meas-create` reads presence the same way.

**The script:**
`apps/worker/scripts/gcp-fastpath-prod-shape/run-prodtier-measurement.sh`
runs every step in order, with the teardown on an `EXIT` trap. It issues no
`gcloud` command of its own.

- It evaluates the instance name once and writes it to `$OUT/instance`.
- Each long step runs as a background child the script waits on. zsh runs an
  INT, TERM or HUP trap only after a foreground child exits, which could have
  been up to the 48 h cap. A waited child lets the trap stop the child and
  all its descendants at once, and the `EXIT` trap then tears down.
- SIGKILL, a host crash or sleep cannot be trapped. After any of these, run
  `meas-teardown --meas-instance=<the name in $OUT/instance>` by hand. Then
  check `instanceAbsent` and `jobAbsent` are true and
  `remainingMeasurementInstances` is empty.
- Cloud SQL may hold a deleted instance's name for days (up to a week, per its
  documentation; not tested here). A retry after a teardown therefore sets
  `MEAS_INSTANCE` to another unused valid date.

**Durations to expect:**

| Step | Expected duration |
|---|---|
| Build | about 2 to 15 min |
| `meas-create` | 10 to 20 min |
| Seed | 2 to 6 h. The local import took 1,259 s; the dense seed ran at roughly 15 times its local non-v1.2 importers on the shared-core instance |
| Guarded `dense` run | refused about 0.9 to 2.3 h in (see the guard table above) |
| Uncapped run | 10 to 13 h projected (cap 48 h) |
| `meas-teardown` | about 5 to 10 min |

**Gates the kit has not passed:**

- No gcloud command of this kit has run.
- The IAM users' privileges on a fresh instance are assumed to match the test
  instance's: a `cloudsqlsuperuser` member, as the seed spec records. A
  failure there surfaces at the seed, before any refresh, and the trap tears
  down.
- The runtime and migrator accounts' Cloud SQL roles are assumed to be
  project-level, not conditioned to the test instance. A conditioned grant
  would fail the seed's first connection.

### Cadence, after this round

The first round's C3 table and its steps 1, 3 and 5 still apply. Two things
change:

- Production stays on the inline profile. `dense-workers` fails at production
  scale, so it is not a cutover option until its Worker heap limits change.
- The projection for the production instance is 10.2 to 13.0 h. That makes
  every two days the safe schedule, and daily only if the production-tier
  uncapped run measures 12 h or less. Run the production-tier kit before
  PROD-4 instead of `run-cloud-measurement.sh`. That script measures the
  shared-core test instance, which is not the production shape.

### Reproduce (second round)

All of these are local only:

- Import once and keep the database:

  ```
  PG_TEST_SOCKET=… PG_TEST_PORT=55433 node --max-old-space-size=49152 apps/worker/scripts/gcp-fastpath-prod-shape/measure-local.mjs --corpus <dir> --out <import.json> --import-only
  ```

- One run per profile, each on its own template copy:

  ```
  … measure-local.mjs --corpus <dir> --out <report.json> --clone-from meas_synth_<hex> --profile dense|dense-workers [--keep-database]
  ```

  Each report holds:
  - the job's receipt, including its read ledger;
  - the busy-core summary and the peak RSS;
  - the per-owner resource record;
  - the output sizes and the output content digests.

- Checks, all passing on this branch:

  ```
  node --test apps/worker/scripts/gcp-fastpath-test-deploy.check.mjs
  npm --prefix apps/worker run gcp:fastpath:scripts-check
  npm --prefix apps/worker run gcp:ops:infra:check
  node --test --test-name-pattern="database targets|production target" apps/worker/postgres-test/analytics-v2-refresh.spec.mjs
  ```

  Root `npm run test:preflight` and `npm run architecture:check` also pass.

## Corpus

- Generator: `apps/worker/scripts/gcp-fastpath-prod-shape/`. It is seeded
  through `d43c8f92`'s own admission code, like the dense oracle, and sealed
  for the reviewed importer chain.
- Seed `gcp-fastpath-prod-shape-2026-10-02`, scale 1, all owners. Sealed
  SQLite sha256 `27de2e01…29f6`.
- Generation took 4,322 s locally, with a peak resident set of 5.7 GB.

OWN-3 reproduction (every check `true`):

| OWN-3 count | Expected | Corpus |
|---|---:|---:|
| Eligible owners | 54 | 54 |
| Routing v1.1 / v1 / v1.2 / mixed / none | 33 / 16 / 3 / 1 / 1 | 33 / 16 / 3 / 1 / 1 |
| Owners with rows in the 101-day window | 35 | 35 |
| Over 30k / 60k / 120k / 240k / 600k window rows | 17 / 10-11 / 7 / 3 / 1 | 17 / 10-11 / 7 / 3 / 1 |
| Largest owner's window rows | 791,806 | 791,806 |
| Largest owner's all-history records | about 2.52 M | 2,500,708 |
| Correction runtime | active | active |

Totals:

- 8,109,760 records: usage 6,857,851, quota 1,145,502, session 106,407.
- Window usage is 2,885,426 rows. The 170-day analysis horizon holds
  4,032,323 usage rows.
- History runs from 2025-06-01 to 2026-10-01 (488 days).

Import through the reviewed chain (`import-corpus.mjs`) took 1,459 s and
produced a 9.1 GB schema:

- 6,969,515 typed records;
- 6,087,890 v1.1 proofs;
- 881,625 v1 admissions.

The roster, public source owners and owner revisions are all equal, source to
target.

## Local refresh: production task profile

- Command: `cloud-run/dist/analytics-refresh.mjs --mode=full`.
- Profile: heap 12,288 MiB, budget 10,752 MiB, clock `2026-10-01T12:46:00Z`.
- No task timeout, so the run was measured to its end.
- The host was shared with other work (load 6 to 11 on 18 cores). The job is
  single-threaded.

| | Value |
|---|---:|
| Exit / state | 0 / `complete` |
| **Wall time** | **15,530 s (4.31 h)** |
| CPU | 13,035 s user, 463 s system (87% of wall) |
| Read | 3,843 s |
| Prepare | 2,484 s |
| Scalar | 216 s |
| Model | 8,967 s |
| Cache, community, write | 11 s, 0.6 s, 5.7 s |
| Owners computed / refused | 53 / 0 |
| Owner-days | 10,025 |
| Published days | 488 |
| **Peak RSS** | **5,415 MiB** (`time -l`: 5.68 GB) |
| Largest owner estimate / heap peak | 5,153 / 4,817 MiB, against a 10,752 MiB budget |
| Output account | 492 MiB, against an effective 5,950 MiB (base 351 MiB) |
| Largest owner output | 37 MiB |

Output sizes (rows and total relation bytes):

| Table | Rows | Bytes |
|---|---:|---:|
| `analytics_v2_cache_bands` | 542,650 | 197.9 MB |
| `analytics_v2_owner_day` | 10,025 | 14.2 MB |
| `analytics_v2_owner_model_dates` | 3,710 | 3.7 MB |
| `analytics_v2_published_daily` | 488 | 0.74 MB |
| Other analytics tables | 57 | 0.3 MB |
| **All analytics_v2 tables** | | **216.8 MB** |

The published daily payloads total 944,456 bytes. The largest is 1,962
bytes.

The same engine ran the dense corpus locally in 972 s, so this corpus costs
16.0 times as much.

## Cloud projection

Each phase is scaled by its measured cloud-to-local ratio on the dense corpus.
Both ratio sets divide by `f8a8620d`'s local dense run (972 s):

- **Ratio set A**: C-REFRESH's cloud rerun (`0d3f73c8`, receipts
  `gcp-dense-postrefresh-20261002T164129Z`, 2,885 s). It is like-for-like:
  `0d3f73c8` differs from `f8a8620d` only in two lines of the refresh entry
  that do not affect timing (the test HTTP mode set and the identity list).
- **Ratio set B**: MEAS-1 (`afd865a0`, 3,944 s). It is **cross-engine**:
  between `afd865a0` and `f8a8620d`, `apps/worker/src/analytics-v2` and the
  refresh entry changed in 8 files (+2,128/−172 lines, including
  `resources.ts` and `store.ts`). Its ratios therefore mix that engine change
  with the Cloud Run and Cloud SQL slowdown. How much the change moves each
  phase was not measured, so set B is not directly comparable with set A.

| Phase | Local | Ratio A | Cloud A | Ratio B (cross-engine) | Cloud B (cross-engine) |
|---|---:|---:|---:|---:|---:|
| Read | 3,843 s | 5.35 | 20,576 s | 8.90 | 34,221 s |
| Prepare | 2,484 s | 2.13 | 5,301 s | 2.75 | 6,826 s |
| Scalar | 216 s | 2.63 | 569 s | 3.05 | 661 s |
| Model | 8,967 s | 2.51 | 22,504 s | 3.02 | 27,113 s |
| Other | 17 s | | 51 s | | 52 s |
| **Total** | **15,530 s** | | **49,001 s (13.6 h)** | | **68,873 s (19.1 h)** |

**The full run does not fit the 14,400 s task.**

- It needs 3.4 to 4.8 times the timeout on Cloud Run.
- It exceeds the timeout locally as well.
- The read phase alone (20.6 to 34.2 ks on Cloud SQL) exceeds the timeout.
  MEAS-1 showed that phase is latency-bound.

**The time guard does not catch this up front.**

- `ANALYTICS_REFRESH_TIME_MODEL` has these rates per occurrence or per analysis
  usage row:

  | Rate | Model | Local, measured here | Cloud, projected |
  |---|---:|---:|---:|
  | Read + prepare (per occurrence) | 0.66 ms | 0.78 ms | 3.2 to 5.1 ms |
  | Scalar + model (per analysis usage row) | 1.40 ms | 2.28 ms | 5.7 to 6.9 ms |

- For this roster the model plans 10,998 s. That is below the refusal point
  of about 14,220 s. The figure is arithmetic: the model's rates applied to
  the manifest's per-owner records and 170-day usage rows. The job did not
  report it.
- The `--guard-probe` run (`ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS=14400`)
  was not refused in its first 600 s. The job logs no plan-checkpoint marker,
  so the probe does not show that the plan checkpoint had been reached.
- The guard re-projects only at owner checkpoints, and owners run in
  owner-digest order (`compute.ts`). Ordered by the manifest's owner digests,
  the first owner (o21) carries 0.4% of the planned work and the second (o02)
  13.5%. So the first checkpoint that can refuse is the third owner's, after
  13.9% of the planned work. With the cloud running k times the model (k =
  4.46 for ratio A, 6.26 for ratio B), that is about 0.139 × k × 10,998 s:
  - **1.9 h** in, at ratio A;
  - **2.7 h** in, at ratio B.
  This assumes the job's owner digests equal the manifest's, which the seed
  pins.
- On Cloud Run the guard should therefore refuse
  `ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED` about 2 to 3 h into the run, and
  publish nothing.
- A daily production run on this engine and profile would hold the lock for
  about 2 to 3 hours each day and never publish.

**Memory and output fit, with margin:**

- Peak RSS is 5.4 of 16 GiB.
- The largest estimate is 48% of the budget.
- The output account is 8% of its effective budget.

**K-CORE-A** (`febbae7f`, not in `f8a8620d`) does not close the gap on its own:

- K-READ is 14 to 34% faster on reads.
- K-PAR's Workers still have their segment loads served one at a time by the
  main thread.
- The largest owner is about 29% of all compute.
- Applying K-READ's best case to ratio A leaves the read phase at about
  13.6 ks.

K-PAR's per-Worker heap at production scale is also unmeasured: main 3,072 +
budget 10,752 + reserve 1,024 MiB, with a 5,153 MiB largest estimate. Dense
owner e used about 1.5 times its estimate.

## Cadence recommendation (C3)

1. Do not schedule the production refresh with the 14,400 s profile on this
   engine. As above, it would refuse every day and publish nothing.
2. Run `run-cloud-measurement.sh` with `MEAS_UNCAPPED=1`. The guarded run
   should show the refusal. The uncapped run (`refresh-uncapped`, capped at
   172,800 s = 48 h by default) measures the real duration.
   - It refuses to start unless the guarded run deployed and executed this
     image on this schema, the Job reads back as that run's task, and no
     other refresh is running.
   - It writes `uncapped/refresh-uncapped.json` whatever the outcome.
3. Before PROD-4, recalibrate `ANALYTICS_REFRESH_TIME_MODEL` to the cloud
   rates that run measures. Then size the task timeout from that measurement:
   the cloud duration × 1.5 for growth, within the job's 604,800 s bound.
4. Then pick the cadence from the uncapped duration:

   | Uncapped duration | Cadence |
   |---|---|
   | ≤ 12 h | Daily, `15 2 * * *` |
   | ≤ 36 h | Every two days, `15 2 */2 * *` |
   | Over 36 h, measured | Weekly, until K-INCR lands |
   | Not finished by the 48 h cap | Over 48 h, length undetermined: weekly until K-INCR, and no daily or two-day schedule. Rerun with a larger `MEAS_UNCAPPED_TIMEOUT` (at most 604,800 s) only if the timeout itself must be sized before K-INCR |

   The run did not finish by the cap if `refresh-uncapped.json` shows either:
   - outcome `killed-at-task-timeout`; or
   - outcome `failed` with code `ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED` or
     `ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED`. The guard runs at the cap too,
     and its line's `deadline` figures (`elapsedSeconds`, `ownersStarted`,
     `ownersPlanned`) show how far the run got.

   An overlapping trigger exits `LOCK_HELD` (exit 0), so a slow run never
   doubles work. The projection (13.6 to 19.1 h) points to **every two
   days**.
5. Make K-INCR (round 13's first post-cutover change) mandatory, not
   optional. The corpus grows with every upload, and a full recompute is
   linear in history.

## Reproduce

All of these are local only:

- Corpus:

  ```
  node --max-old-space-size=16384 apps/worker/scripts/gcp-fastpath-prod-shape/seed-source.mjs --work-dir <dir> --scale 1
  ```

- Measurement:

  ```
  PG_TEST_SOCKET=… PG_TEST_PORT=55433 node --max-old-space-size=49152 apps/worker/scripts/gcp-fastpath-prod-shape/measure-local.mjs --corpus <dir> --out <report.json> --guard-probe
  ```

- Checks:

  ```
  npm --prefix apps/worker run gcp:fastpath:prod-shape:check
  node --test apps/worker/scripts/gcp-fastpath-test-deploy.check.mjs
  MEAS_SYNTH_CORPUS=<small corpus> node --test apps/worker/scripts/gcp-fastpath-seed.check.mjs
  PG_TEST_SOCKET=… PG_TEST_PORT=55433 node --test apps/worker/postgres-test/postgres-fastpath-identity-copy.spec.mjs
  ```

  The third check passed 2026-10-03 on a scale-0.05 corpus. The last one
  holds the `maxTableRows` bound and its refusals.

The measurement databases were dropped afterwards. The report and manifest are
kept outside the repository, in the parity home's
`receipts/meas-synth-local-20261003/`.

## Cloud run occupancy

The refresh takes a database-wide advisory lock in `tibotattle_fastpath`,
which every seeded schema shares, and there is one fast-path refresh Job.
While the guarded run (2 to 3 h) and the uncapped run (projected 13.6 to
19.1 h, capped at 48 h) are in progress:

- The deploy wrapper with this change refuses another fast-path refresh
  before it deploys (`FASTPATH_DEPLOY_REFRESH_EXECUTION_RUNNING`).
- A wrapper without this change still deploys, which does not alter the
  running execution. Its own execution then exits `LOCK_HELD` having done
  nothing, and that wrapper reports success.
- This wrapper's refresh steps now fail on `LOCK_HELD`
  (`FASTPATH_DEPLOY_REFRESH_LOCK_HELD`) instead of reporting success.
