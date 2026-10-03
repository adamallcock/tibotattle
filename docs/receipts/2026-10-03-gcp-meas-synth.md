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
