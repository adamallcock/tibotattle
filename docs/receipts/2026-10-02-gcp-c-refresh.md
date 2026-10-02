---
title: GCP refresh job production target, bounded history, output account and time guard (C-REFRESH)
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP refresh job production target, bounded history, output account and time guard (C-REFRESH)

This is a 2026-10-02 receipt for stream C-REFRESH, branch
`claude/gcp-fp-c-refresh`, built on `claude/gcp-fastpath-final` `afd865a0`.
The work commit is `32215a26`; this receipt is the commit after it. It records **local, synthetic**
evidence only: one macOS arm64 workstation shared with other agents, the local
PostgreSQL 17 fan-out cluster (private Unix socket, port 55433) in databases
this stream created (`c_refresh_q1`, `c_refresh_dense`, `c_refresh_volume`),
the refresh under Node.js 22.16.0 (the image runtime) and the importers and
specs under Node.js 26.2.0. Every corpus is synthetic and content-free.
Nothing was pushed, deployed, migrated or seeded on GCP or Cloudflare, and no
production data was read. It does not qualify a Cloud Run image, Cloud SQL,
the production or staging plane, or a real owner.

## What changed

| Item | Change |
|---|---|
| (a) Production target | `cloud-run/analytics-refresh.mjs` gains the reviewed production and staging path (below). Without `ANALYTICS_REFRESH_TARGET` the job keeps its test targets unchanged |
| (b) Bounded history | A-2 loads and reduces the days before the analysis horizon in 60-day segments, each released before the next; memory model v2 charges the larger of the largest segment and the analysis horizon, not the whole history |
| (c) Output account | The fixed 512 MiB reserve is replaced by an output account: every held output row and the non-effective owners' held occurrences are charged as produced, against an output budget derived from the heap. One write transaction, unchanged |
| (d) Time guard | A run with a task timeout refuses with a receipt before it, at owner, segment and model-date checkpoints, bounded by the measured dense phase rates |
| (e) Legacy expansion | Measured at volume with a synthetic dense legacy owner: the v1/v1.1 expansion and candidate reads followed the owner, not the batch. Both statements were reshaped with the c0600bc2 method and proven equal |

Files: `src/analytics-v2/{compute,resources,contract,store,occurrence-source}.ts`,
`cloud-run/analytics-refresh.mjs`, the analytics-v2 specs
(`analytics-v2-test/compute.spec.ts`,
`postgres-test/analytics-v2-refresh.spec.mjs`,
`postgres-test/analytics-v2-occurrence-source.spec.mjs`) and the direct-seed
fixture. No migration, no vendored kernel, no generated file, no
`gcp-fastpath-*` script and no infrastructure manifest changed.

## (a) The production target contract

- Invocation: `node --max-old-space-size=12288 dist/analytics-refresh.mjs --mode=full`
  (`ANALYTICS_REFRESH_PRODUCTION_JOB.args`). `--schema`, `--now` and
  `--revision-seed` are refused (`ANALYTICS_V2_REFRESH_ARGUMENT_FORBIDDEN`,
  usage, exit 2) whenever `ANALYTICS_REFRESH_TARGET` is present. The schema is
  `PRIMARY_SCHEMA`; the clock is real (`clock: "wall"`); revisions follow the
  stored heads.
- Closed environment (`ANALYTICS_REFRESH_PRODUCTION_ENV`):
  `ANALYTICS_REFRESH_TARGET` (`production` or `staging`),
  `PRIMARY_INSTANCE_CONNECTION_NAME`, `PRIMARY_DATABASE`, `PRIMARY_SCHEMA`,
  `POSTGRES_IAM_USER`, `ANALYTICS_V2_MEMORY_BUDGET_MIB`, all required.
- Refused, each with a closed code naming the setting and never its value:
  any other variable in the job's namespaces (`ANALYTICS_`, `PRIMARY_`,
  `POSTGRES_`, `PG_`, `LEDGER_`), which covers the other resource knobs, the
  rehearsal seams and a ledger; `ANALYTICS_V2_TEST_CLOCK`, even empty; every
  variable and prefix CR-3 refuses in production
  (`PRODUCTION_FORBIDDEN_VARIABLES`, `PRODUCTION_FORBIDDEN_VARIABLE_PREFIXES`);
  `GOOGLE_APPLICATION_CREDENTIALS`; anything but one task of a Cloud Run Job
  (`CLOUD_RUN_JOB`, `CLOUD_RUN_TASK_INDEX=0`, `CLOUD_RUN_TASK_COUNT=1`, no
  `K_SERVICE`); the IAM test and fast-path test resources by identity; a test,
  rehearsal or fast-path name or schema prefix, or a scratch rehearsal
  instance; a resource carrying the other plane's marker (CR-3's convention).
  Platform variables outside these namespaces (`CLOUD_RUN_EXECUTION`, `PATH`,
  `DEPLOYMENT_SOURCE_COMMIT` and so on) are not read.
- Through CR-3: the refusal lists, the plane markers and the production
  fingerprint are CR-3's (`postgres-production-configuration.mjs`), mirrored
  in `ANALYTICS_REFRESH_CR3_POLICY` and pinned equal to CR-3's exports by a
  spec case. They are mirrored, not imported: CR-3 imports Worker TypeScript
  (the source entry must answer `--help` under plain Node 22) and is not in
  the audited image build context (`scripts/cloud-run-build-context.mjs`
  refused the import, `CLOUD_RUN_CONTEXT_IMPORT_OUTSIDE_CONTEXT`). CR-3's
  `analytics-job` profiles are not called: they require a telemetry
  namespace, a bucket, a source commit and, for staging, the plane's identity
  variables, which the closed contract excludes. The same spec case runs
  CR-3's reader on the same values and pins that both accept the same primary
  resources and refuse the same malformed or test values.
- Task profile: the dense profile (4 vCPU, 16 GiB, heap 12,288 MiB, budget
  10,752 MiB, timeout 14,400 s, one task, no retries) until MEAS-3.

## (b) Bounded history and memory model v2

- Segments (`resources.ts analyticsV2HistorySegments`): 60-day spans counted
  back from the day before the analysis start, oldest first, then the analysis
  horizon through the end of the read range. The loader is
  `loadOwnerOccurrences(ownerDigest, range)`; each segment load is checked
  against the owner's counts for that range, and a day outside it is refused.
  Cache views carry across a segment edge, so every cache day keeps its
  seven-day lookback.
- `analytics-v2-memory-model-v2` keeps v1's measured unit costs and charges
  `overhead + largest day + max(analysis horizon, largest history segment)`,
  each with its prepared usage and seven-day cache carry. Pinned: a steady
  owner (1,100 usage, 4,500 quota, 200 session a day) has the same estimate
  after 200 or 2,000 days; v1 refused it after about 500 days at the default
  budget.
- Equality: the compute spec's segmented and in-memory runs over history
  reaching 400 days back, with evidence on both sides of segment edges, are
  digest-identical, and the compose pins and dense owner pins are unchanged.

## (c) The output account

- `ANALYTICS_V2_OUTPUT_MODEL` (`analytics-v2-output-model-v1`): 128 bytes plus
  2 bytes per JSON character of each held row (owner-day, cache band, fits,
  model date, refusal); a non-effective owner's held occurrence costs the
  memory model's held bytes. The account is charged as rows are produced and
  the run fails `ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED` the moment it exceeds
  the budget; nothing is written.
- Calibration (Node 22.16.0, `--expose-gc`, about 200,000 unshared copies per
  family from the compose and dense corpora): heap per row 345 to 2,152 bytes
  against 347 to 2,132 JSON characters; the charge is 1.73 to 3.18 times that
  heap (fits lowest). Shared kernel values make the real graph smaller.
- Heap partition (`ANALYTICS_REFRESH_HEAP_RESERVE`): the per-owner budget,
  4 KiB per read-chunk occurrence, a 256 MiB runtime reserve, and the rest is
  the output budget, at least 64 MiB. The standard heap (6,192 MiB limit)
  leaves 351 MiB; the dense profile about 351 MiB as well (12,336 MiB less
  10,752, 256 and 977). The minimum heap for the defaults falls from
  6,097 MiB to 5,905 MiB.
- The write now maps each family lazily, one chunk at a time, instead of
  copying it whole. `analytics_v2_runs.timings` gains `account` and each
  owner's `outputBytes`; the configuration gains `outputModel` and
  `outputBudgetBytes` (store validator closed and pinned).

## (d) The time guard

- A production target takes the profile's 14,400 s; elsewhere
  `ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS` (60 to 604,800) may set one,
  and it is refused under a production target. Without one the guard is inert.
- Refusal point: deadline less 120 s for rollback and receipt, less the
  projected write (60 s plus 1 s per MiB of account). Rates
  (`ANALYTICS_REFRESH_TIME_MODEL`) are the dense-final phases rounded down:
  read 0.37 ms and prepare 0.29 ms per occurrence, scalar 0.05 ms and model
  1.35 ms per analysis usage row.
- `ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED` when the plan, or the remaining
  admitted owners at an owner checkpoint, cannot finish at the measured rates;
  `ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED` past the refusal point, or before a
  segment load or model date projected at five times the rate (the test
  deploy read Cloud SQL about five times slower) could cross it, and before
  the write. Both end the run with exit 1, write nothing, release the lock and
  print `deadline` (content-free seconds and owner counts).
- Not covered: a single step longer than its five-fold projection plus the
  margins, and the write itself (one transaction, statement timeout 300 s).
  The rates are local and synthetic; MEAS-3 recalibrates them.

## (e) The legacy expansion at volume

A synthetic dense legacy owner (fixture option `denseLegacy`, owner kilo:
1,000 v1.1 and 200 v1 usage records a day; every tenth v1 record repeats a
v1.1 occurrence) read over the same ten days (11,800 candidates):

| Owner size | Committed: batch mean / candidates | Rewritten: batch mean / candidates |
|---|---:|---:|
| 12,010 records (10 days) | 31.8 ms / 463 ms | 23.8 ms / 680 ms |
| 72,010 records (60 days) | 199.7 ms / 1,203 ms | 21.4 ms / 563 ms |

The committed cost followed the owner: the plans walked every v1 chunk,
admission and record and every v1.1 record and proof of the owner per 200-id
batch, and joined every v1.1 domain day of the owner against the range's
records per candidate call, a cost paid again for each segment. A 2.5-million
record owner would have spent about a day expanding. The rewrite
(`occurrence-source.ts`): sources fence the owner's typed devices (v1) and
manifests (v1.1), probe each on its unique `(device_id or manifest_id, stream,
occurrence_id)` key, and check each match against the unchanged joins in a
fenced `LATERAL`; candidates fence the owner's records of the stream in the
range through `typed_telemetry_owner_time` and do the same. Both fences are
implied by the joins they precede (0030's foreign keys and the observed-day
CHECK), so the rows, their multiplicity and the grouping are unchanged. A 400
day owner of this density was not measured: seeding it through the fixture's
per-row writes did not finish on the shared cluster.

A/B, the committed (`afd865a0`) and rewritten readers in one read-only
snapshot, `readOwnerOccurrences` and `countOwnerOccurrences` for every listed
owner, stream and two 400-day ranges, plus `readOwnerFirstEvidenceDay`:

| Schema | Compared | Equal | Occurrences | Committed / rewritten time |
|---|---:|---:|---:|---:|
| Dense legacy, small | 65 | 65 | 11,808 | 6.3 s / 5.2 s |
| Dense legacy, medium | 65 | 65 | 70,808 | 92.0 s / 26.3 s |
| Q-1 (this stream's import) | 52 | 52 | 14,831 | 8.1 s / 4.6 s |
| Dense golden (the kept `tibotattle_dense_parity` import, read only) | 65 | 65 | 375,293 | 160.6 s / 120.6 s |

Negative tests: fixture option `legacyScope` (owners lima and mike) stores one
occurrence id with one eligible v1 record and three variants (a superseded
chunk, a chunk that accepted one record fewer than it declares, another
participant's v1.1 record), plus records at the first and last instant of the
fixture's days. Five mutations of the rewrite each fail the new case: the
range fence's upper or lower bound off by one, the expansion or candidate
`LATERAL` replaced by the fence alone, and the v1 device fence dropped.

## Parity

| Run | Result |
|---|---|
| Q-1 rehearsal (`--per-date-expected`, `--owner-reference golden-q1-node`) | `pass`, every gate true. Served body sha256 `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d` (396,337 bytes), response file `04f7a277…`, preview `b3722cc9…`; 168 days, 2026-04-17/18 blocked, second run 0 new revisions; owner families fits 4/4, model dates 280/280, owner-days 672/672, cache owner-days 680/680, refusals 15/15 |
| Dense rehearsal (`--dense`, the dense-final dump, `--refresh-timeout-minutes 360`) | `pass`, every gate true. Served body sha256 `8c71e60dae2d0fd491be3f63f565287aa25d2e7c01ae9d6ec5f25f66e757f913` (413,197 bytes), response file `36316eca…`, preview `4158041c…` (both as dense-final); 168 days, second run 0 new revisions; served families all equal (allowance breakdowns 71/71, model days 141/141, preview 1/1; `cache-counts` informational as before); per-date expectation equal; owner families fits 5/5, model dates 350/350, owner-days 840/840, cache owner-days 850/850, refusals 15/15. T-2 147.8 s. Refresh 882 s and 809 s (read 138 s, prepare 151 s, model 571 s; the cluster was shared with this stream's A/B runs and other agents), owner e estimate 1,517 MiB (unchanged: its history lies inside the analysis horizon), heap peak 2,213 MiB, peak RSS 2,650 MiB, account 35 MiB of a 351 MiB output budget |

Both rehearsals imported fresh into this stream's databases. The `dist` they
ran was built before the output model was calibrated (then 160 bytes plus 3
per character); the account changes no output, so their bodies and rows hold
for the committed model, and the specs below ran on the committed code.

## Gates

Local, on `32215a26` unless stated. PostgreSQL 17 fan-out cluster, port 55433, private socket.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (apps/worker) | rc 0 |
| `npm run analytics-v2:check` | 12 files: 123/124 at the pre-commit state; the one failure was the new output-account case after the output model's recalibration (its corpus held under 1 MiB); fixed in the test, `compute.spec.ts` then 22/22 |
| `postgres-test/analytics-v2-refresh.spec.mjs` | 43/43 in this stream's database. In the shared `postgres` database 41/43: the two failures were `LOCK_HELD` from another agent's refresh holding the advisory lock (contention, both pass in isolation) |
| `postgres-test/analytics-v2-occurrence-source.spec.mjs` | 11/11 |
| Mutations of the legacy rewrite (5) | each fails the new legacy case |
| `npm run check` in `cloud-run` | rc 0; 338 tests: 337 pass, 1 skipped (the opt-in A2 real-PostgreSQL case); all build entries, image build context check included |
| Fast-path and infrastructure script checks (`gcp-fastpath-test-deploy`, `gcp-ops-infra-manifest`, `gcp-infra`, `gcp-ops-infra-operations`, both parity compares, `gcp-fastpath-rehearsal`) | 98/98 |
| `npm run gcp:fastpath:scripts-check` (no PostgreSQL environment) | rc 0, 65 pass, 3 skipped |
| Q-1 rehearsal, dense rehearsal | exit 0 (Parity above) |
| Bundled entry under Node 22.16.0, production and staging refusals | closed codes, exit 1 or 2, no connection |
| Root `npm run architecture:check` | passed (926 production files, 3,961 imports, 0 debt edges) |
| Root `npm run test:preflight` | rc 0, 20/20 |

## Not covered

- Nothing ran on Cloud Run or Cloud SQL. MEAS-3 (the largest real owner on
  Cloud Run with this code) remains; the memory model, output model and time
  rates are synthetic and local.
- C-INFRA must render `ANALYTICS_REFRESH_PRODUCTION_JOB` (args, the six env
  names, profile) and remove the manifest's `DEFERRED_JOBS` entry and its pin;
  until then the rendered job lacks `ANALYTICS_REFRESH_TARGET` and is refused
  exactly as before. The manifest comment describing the refusal is now
  stale; it is not this stream's file.
- The snapshot's xmin hold through compute is unchanged and still disclosed.
- No revision seed exists for the production target: the first production
  run publishes revision 1 above an empty store. Whether GCP revisions must
  continue Cloudflare's published ones at cutover is not decided here.
- The CR-3 `analytics-job` profiles stay unused by this job; a dedicated CR-3
  profile would be a change to CR-3, outside this stream.
- The full `postgres:domain:check`, the Worker's full `check`, root
  `npm test` and a Docker build were not run.
