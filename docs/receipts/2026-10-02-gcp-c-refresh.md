---
title: GCP refresh job production target, bounded history, output account and time guard (C-REFRESH)
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP refresh job production target, bounded history, output account and time guard (C-REFRESH)

This is a 2026-10-02 receipt for stream C-REFRESH, branch
`claude/gcp-fp-c-refresh`, built on `claude/gcp-fastpath-final` `afd865a0`.
The commits are:

- `32215a26`: the work;
- `216f416a`: the first version of this receipt;
- `6cf24e6f`: a merge of the final line at `9700d167` (C-INFRA, C-MAINT and
  C-CI), with no conflicts, so that the OPS-2 render of the refresh job can
  be pinned to this job's contract;
- `979775e3`: the review fixes (see "Review findings" below);
- `da80c544` and the commit after it, which carry this revision of the
  receipt and a figure correction in a refresh-spec comment (no assertion
  changed).

It records **local, synthetic** evidence only: one macOS arm64 workstation
shared with other agents, and the local PostgreSQL 17 fan-out cluster
(private Unix socket, port 55433). Every database used was created by this
stream and has since been dropped: `c_refresh_q1`, `c_refresh_dense` and
`c_refresh_volume` in the first round, and `c_refresh_dense_a`,
`c_refresh_q1_b`, `c_refresh_dense_b` and `c_refresh_spec` in the review
round. The refresh ran under Node.js 22.16.0 (the image runtime); the
importers and specs ran under Node.js 26.2.0. Every corpus is synthetic and
content-free. Nothing was pushed, deployed, migrated or seeded on GCP or
Cloudflare, and no production data was read. It does not qualify a Cloud Run
image, Cloud SQL, the production or staging plane, or a real owner.

## What changed

| Item | Change |
|---|---|
| (a) Production target | `cloud-run/analytics-refresh.mjs` gains the reviewed production and staging path (below). Without `ANALYTICS_REFRESH_TARGET` the job keeps its test targets unchanged. The OPS-2 render is pinned to it field for field |
| (b) Bounded history | A-2 loads and reduces the days before the analysis horizon in 60-day segments, each released before the next. Memory model v2 charges the larger of the largest segment and the analysis horizon, not the whole history |
| (c) Output account | The fixed 512 MiB reserve is replaced by an output account. Every held output row and the non-effective owners' held occurrences are charged as they are produced. The output budget is the heap the run leaves, plus the part of the per-owner budget its largest admitted owner does not need. One write transaction, unchanged |
| (d) Time guard | A run with a task timeout refuses with a receipt before it. Checkpoints are the plan, each owner, segment, scalar fit and model date, and the write. The rates are the measured dense phase rates |
| (e) Legacy expansion | Measured at volume with a synthetic dense legacy owner, the v1/v1.1 expansion and candidate reads followed the owner, not the batch. Both statements were reshaped with the c0600bc2 method and proven equal |

Files in `32215a26`: `src/analytics-v2/{compute,resources,contract,store,occurrence-source}.ts`,
`cloud-run/analytics-refresh.mjs`, the analytics-v2 specs
(`analytics-v2-test/compute.spec.ts`,
`postgres-test/analytics-v2-refresh.spec.mjs`,
`postgres-test/analytics-v2-occurrence-source.spec.mjs`) and the direct-seed
fixture.

Files in `979775e3`:

- `src/analytics-v2/{compute,resources,contract,store}.ts`;
- `cloud-run/analytics-refresh.mjs`;
- `compute.spec.ts` and `analytics-v2-refresh.spec.mjs`;
- C-INFRA's `scripts/gcp-ops-infra-manifest.check.mjs` (the render pin) and
  a comment in `scripts/gcp-ops-infra-manifest.mjs` (the stale 512 MiB
  reserve);
- the fast-path plan's dense-owner status.

No migration, no vendored kernel, no generated file and no manifest value
changed.

## Review findings (2026-10-02)

A review of `32215a26`/`216f416a` raised five findings. Each was checked
against the code and the evidence before it was acted on.

| Finding | Verified | Disposition |
|---|---|---|
| (medium) The dense profile leaves about 351 MiB of output budget, which cache history and the roster grow into. The reviewer said most of the 10,752 MiB budget is now slack and should be lowered to about 4 to 6 GiB, with a pin against a stated projection | **Partly.** The arithmetic holds: 12,336 − 10,752 − 256 − 977 ≈ 351 MiB. Cache bands grow with history, and an overflow refuses the whole run. **Rejected: "most of the budget is slack".** The 1,517 MiB figure is owner e, the synthetic dense owner, not the largest real owner (about 2.52 million records). That owner's estimate is roughly 4.2 GiB when its records predate the analysis days and roughly 10 GiB when they fall inside them (cap-raise receipt). Memory model v2 bounds only the history *before* the horizon, and still charges the 170 analysis days whole. A 4 to 6 GiB budget would refuse that owner with `memory_budget`, which withholds the preview and every model date | **Fixed differently.** (1) The run reclaims, for its output budget, the part of the per-owner budget that its largest admitted owner's estimate leaves. The plan fixes this before any output is charged (`resources.ts analyticsV2OutputBudget`, compute `reclaimUnusedOwnerBudget`, set by the Job). The heap bound is unchanged, and the admission budget stays 10,752 MiB. (2) A spec pins the profile against a stated roster and history projection (below). (3) The receipt reports `effectiveOutputBudgetMiB` beside `accountMiB` on every run |
| (low) The closed environment does not cover the `PG*` variables node-pg reads (`PGOPTIONS`, `PGSSLMODE`, `PGPASSWORD`, …), although the receipt said platform variables are "not read" | **Yes.** node-pg's `lib/connection-parameters.js` reads `process.env['PG' + key]` (line 15), `PGSSLMODE` (26) and `PGCONNECT_TIMEOUT` (127). `lib/index.js` (41) reads `NODE_PG_FORCE_NATIVE` | **Fixed.** Under a production or staging target, the closed namespace `PG_` widens to `PG`. `ANALYTICS_REFRESH_RUNTIME_FORBIDDEN` refuses `NODE_OPTIONS`, `NODE_PG_FORCE_NATIVE`, `NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_EXTRA_CA_CERTS`. All are `ANALYTICS_V2_REFRESH_ENV_FORBIDDEN`, with 12 negative names, each tried empty and with a value. `NODE_VERSION` and `YARN_VERSION` (set by the node image), `DEPLOYMENT_SOURCE_COMMIT` and the Cloud Run variables are pinned as tolerated. The receipt's sentence is corrected (below) |
| (low) CR-3's refusal policy is copied rather than read through CR-3, and the refresh contract cannot coexist with CR-3's analytics-job profiles | **Yes.** It also showed that this job applies CR-3's fingerprint on both planes; CR-3 applies it to staging only | **Not resolved in code: it needs a decision that is not in the owner-decisions file.** The question is which contract governs the production analytics job: this one, a TypeScript-free CR-3 profile, or retiring CR-3's analytics-job profile. The equality pin against CR-3's exports and the cross-check against `readProductionConfiguration` remain the guard. The code comment now says that the fingerprint applies on both planes. That is stricter than CR-3, and the render pin shows it refuses no committed GCP name |
| (low) The parity evidence came from a dist built before the committed output model, and dense parity was not reproduced on committed code | **Yes.** The first receipt disclosed the pre-calibration dist, but its parity summary did not | **Fixed.** The dense rehearsal was re-run on `32215a26`'s dist (`b76aa67f…`), and both rehearsals on `979775e3`'s dist (`73e87286…`). Results are below. The reviewer's own Q-1 re-run on `32215a26` is recorded as well |
| (low) The time guard's production deadline (14,400 s) is not bound to the rendered timeout. At `afd865a0` the manifest rendered 3,600 s, and no step checkpoint covers the scalar fit | **Yes, at `afd865a0`.** Since then C-INFRA (`f640f68a`) renders 14,400 s from its own `ANALYTICS_REFRESH_TASK_PROFILE` and lifts the deferral, but nothing bound that render to this job | **Fixed.** After the merge, `gcp-ops-infra-manifest.check.mjs` pins `renderJob(desired, "analytics-refresh")` to `ANALYTICS_REFRESH_PRODUCTION_JOB` for both planes: args, entry, heap, CPU, memory, task timeout, retries, task count, parallelism, the env names and the budget value. The entry's production reader must accept the rendered env as one task of that job, and `analyticsRefreshTaskTimeoutMs` must equal the rendered timeout. Ten doctored renders are refused, for example a 3,600 s timeout, 8Gi, 2 vCPU, a 6,144 MiB heap, retries, two tasks, `PGOPTIONS`, a missing variable and a `--schema` flag. The committed staging desired state and the production one, filled with synthetic OWN-5 values, both pass. The guard gains a `scalar` checkpoint projected at `stepFactor × scalarMsPerAnalysisUsage` |

## (a) The production target contract

- Invocation: `node --max-old-space-size=12288 dist/analytics-refresh.mjs --mode=full`
  (`ANALYTICS_REFRESH_PRODUCTION_JOB.args`). `--schema`, `--now` and
  `--revision-seed` are refused (`ANALYTICS_V2_REFRESH_ARGUMENT_FORBIDDEN`,
  usage, exit 2) whenever `ANALYTICS_REFRESH_TARGET` is present. The schema is
  `PRIMARY_SCHEMA`; the clock is real (`clock: "wall"`); revisions follow the
  stored heads.
- Closed environment (`ANALYTICS_REFRESH_PRODUCTION_ENV`), all required:
  - `ANALYTICS_REFRESH_TARGET` (`production` or `staging`);
  - `PRIMARY_INSTANCE_CONNECTION_NAME`;
  - `PRIMARY_DATABASE`;
  - `PRIMARY_SCHEMA`;
  - `POSTGRES_IAM_USER`;
  - `ANALYTICS_V2_MEMORY_BUDGET_MIB`.
- Refused, each with a closed code that names the setting and never its
  value:
  - any other variable in the job's namespaces (`ANALYTICS_`, `PRIMARY_`,
    `POSTGRES_`, `LEDGER_`, and `PG`, which covers the rehearsal seams and
    every libpq-style variable node-pg reads). This covers the other resource
    knobs, the rehearsal seams, a ledger and `PGOPTIONS`-style session
    settings;
  - the Node runtime variables that change the code loaded, the driver or
    TLS trust (`NODE_OPTIONS`, `NODE_PG_FORCE_NATIVE`,
    `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`);
  - `ANALYTICS_V2_TEST_CLOCK`, even empty;
  - every variable and prefix CR-3 refuses in production
    (`PRODUCTION_FORBIDDEN_VARIABLES`,
    `PRODUCTION_FORBIDDEN_VARIABLE_PREFIXES`);
  - `GOOGLE_APPLICATION_CREDENTIALS`;
  - anything but one task of a Cloud Run Job (`CLOUD_RUN_JOB`,
    `CLOUD_RUN_TASK_INDEX=0`, `CLOUD_RUN_TASK_COUNT=1`, no `K_SERVICE`);
  - the IAM test and fast-path test resources, by identity;
  - a test, rehearsal or fast-path name or schema prefix, or a scratch
    rehearsal instance;
  - CR-3's production fingerprint, on both planes;
  - a resource that carries the other plane's marker (CR-3's convention).
- What the contract does not cover: the job's own code reads nothing else
  except the Cloud Run job context. Image and platform variables
  (`NODE_VERSION`, `CLOUD_RUN_EXECUTION`, `K_*`, `PATH`,
  `DEPLOYMENT_SOURCE_COMMIT` and so on) are tolerated. Libraries may read
  variables of their own that this contract does not refuse, for example
  google-auth-library's `GCE_METADATA_HOST` and the proxy variables. Node
  reads `NODE_OPTIONS` before this code runs, so refusing it ends the run but
  cannot undo a preload.
- Through CR-3: the refusal lists, the plane markers and the fingerprint
  values are CR-3's (`postgres-production-configuration.mjs`). They are
  mirrored in `ANALYTICS_REFRESH_CR3_POLICY` and pinned equal to CR-3's
  exports by a spec case. They are mirrored, not imported, for two reasons:
  CR-3 imports Worker TypeScript, and the source entry must answer `--help`
  under plain Node 22; and CR-3 is not in the audited image build context
  (`scripts/cloud-run-build-context.mjs` refused the import with
  `CLOUD_RUN_CONTEXT_IMPORT_OUTSIDE_CONTEXT`). CR-3's `analytics-job`
  profiles are not called, because they require a telemetry namespace, a
  bucket, a source commit and the publication switches, which the closed
  contract excludes. The same spec case runs CR-3's reader on the same
  values. It pins that both accept the same primary resources and refuse the
  same malformed or test values. Which contract governs is open (Review
  findings).
- Task profile: the dense profile (4 vCPU, 16 GiB, heap 12,288 MiB, budget
  10,752 MiB, timeout 14,400 s, one task, no retries) until MEAS-3. C-INFRA's
  render is pinned to it (finding 5).

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
  budget. The analysis horizon itself is still charged whole, so an owner
  dense inside the 170 analysis days keeps a large estimate.
- Equality: the compute spec's segmented and in-memory runs over history
  reaching 400 days back, with evidence on both sides of segment edges, are
  digest-identical, and the compose pins and dense owner pins are unchanged.

## (c) The output account

- `ANALYTICS_V2_OUTPUT_MODEL` (`analytics-v2-output-model-v1`): each held row
  (owner-day, cache band, fits, model date, refusal) costs 128 bytes plus 2
  bytes per JSON character. A non-effective owner's held occurrence costs the
  memory model's held bytes. The account is charged as rows are produced, and
  the run fails with `ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED` the moment it
  exceeds the budget; nothing is written.
- Calibration (Node 22.16.0, `--expose-gc`, about 200,000 unshared copies per
  family from the compose and dense corpora): heap per row 345 to 2,152 bytes
  against 347 to 2,132 JSON characters; the charge is 1.73 to 3.18 times that
  heap (fits lowest). Shared kernel values make the real graph smaller.
- Heap partition (`ANALYTICS_REFRESH_HEAP_RESERVE`): the per-owner budget,
  4 KiB per read-chunk occurrence, a 256 MiB runtime reserve, and the rest as
  the configured output budget, at least 64 MiB. The minimum heap for the
  defaults falls from 6,097 MiB to 5,905 MiB.
- **Reclaim (review fix).** The plan computes every effective owner's
  estimate from its counts before any owner is read. The run's output budget
  is therefore the configured one plus the per-owner budget less the largest
  admitted estimate (`analyticsV2OutputBudget`). Only one owner is held at a
  time, and an owner is admitted only when its estimate is at most the
  budget. So the largest admitted estimate plus the output budget equals the
  budget plus the configured output budget: the heap bound is unchanged. The
  reclaim relies on the estimate as each owner's bound, as admission already
  does. The estimate was 29% to 118% above the smallest heap that completed
  (cap-raise receipt). `timings.account.outputBudgetBytes` records the budget
  the account was held to. The store refuses anything other than the
  configured budget or that plus the budget less the largest admitted
  estimate, and refuses an account above it.
- What the dense profile holds:
  - at the old-space size of 12,288 MiB (V8's limit is about 48 MiB more),
    the configured output budget is 303 MiB;
  - with the largest real owner at the high end of its estimate (10 GiB), the
    run's budget is 815 MiB;
  - with owner e largest (1,517 MiB), it is about 9.3 GiB;
  - with the largest owner exactly at the 10,752 MiB budget, it is 303 MiB,
    the same as before.
- Projection pin (`analytics-v2-refresh.spec.mjs`): a stated planning
  roster, not a measurement, of 4 dense and 60 light owners over 535 days of
  cache history (the 170 analysis days plus a year). The largest owner is at
  10 GiB. The rates are the dense rehearsal's measured account:
  - owner e charged 13,287,040 bytes and the heaviest light owner 2,888,220
    bytes, over 170 days;
  - each owner's whole output is charged per day of history, although only
    the cache bands grow, so the rates err high;
  - the projection is 680 MiB of the 815 MiB budget;
  - that roster fits for 641 days at the high-end estimate, against 238
    without the reclaim. On the old split it would have started refusing
    about 68 days after the history passes 170 days.
  - OWN-3's owner counts and MEAS-3 replace the projection. A longer history
    or a bigger roster at the high end needs incremental refresh (D3,
    revised) or a larger task (OWN-5). The receipt's `accountMiB` and
    `effectiveOutputBudgetMiB` show the headroom on every run; no alert reads
    them yet.
- Measured account: the dense corpus charged 24,355,076 bytes (owner e
  13,287,040; the four light owners 2.64 to 2.89 MB each). That is below the
  reviewer's estimate from stored JSON (18.6 MiB for owner e's cache bands
  alone), because the held rows are smaller than their stored jsonb.
- The write maps each family lazily, one chunk at a time, instead of copying
  it whole. `analytics_v2_runs.timings` gains:
  - `account` (`heldInputBytes`, `accountBytes`, `outputBudgetBytes`);
  - each owner's `outputBytes`;
  - in the configuration, `outputModel` and `outputBudgetBytes`.
  The store validator is closed and pinned.

## (d) The time guard

- A production target takes the profile's 14,400 s, and the OPS-2 render is
  pinned to that same value (finding 5). Elsewhere
  `ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS` (60 to 604,800) may set one;
  it is refused under a production target. Without one the guard is inert.
- Refusal point: the deadline, less 120 s for rollback and receipt, less the
  projected write (60 s plus 1 s per MiB of account). The rates
  (`ANALYTICS_REFRESH_TIME_MODEL`) are the dense-final phases, rounded down:
  read 0.37 ms and prepare 0.29 ms per occurrence; scalar 0.05 ms and model
  1.35 ms per analysis usage row.
- `ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED` when the plan, or the remaining
  admitted owners at an owner checkpoint, cannot finish at the measured
  rates.
- `ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED` when the refusal point has
  passed, or before a step that, projected at five times the rate, could
  cross it. The steps are a segment load, an owner's scalar fit (new) and a
  model date, and the check also runs before the write. The test deploy read
  Cloud SQL about five times slower than locally.
- Both refusals end the run with exit 1, write nothing, release the lock and
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

The committed cost followed the owner. Per 200-id batch, the plans walked
every v1 chunk, admission and record of the owner, and every v1.1 record and
proof. Per candidate call, they joined every v1.1 domain day of the owner
against the range's records, and paid that cost again for each segment. A
2.5-million-record owner would have spent about a day expanding.

The rewrite (`occurrence-source.ts`):

- Sources fence the owner's typed devices (v1) and manifests (v1.1). They
  probe each on its unique `(device_id or manifest_id, stream,
  occurrence_id)` key, and check each match against the unchanged joins in a
  fenced `LATERAL`.
- Candidates fence the owner's records of the stream in the range through
  `typed_telemetry_owner_time`, and do the same.
- Both fences are implied by the joins they precede (0030's foreign keys and
  the observed-day CHECK), so the rows, their multiplicity and the grouping
  are unchanged.

A 400-day owner of this density was not measured: seeding it through the
fixture's per-row writes did not finish on the shared cluster.

A/B: the committed (`afd865a0`) and rewritten readers in one read-only
snapshot. Compared: `readOwnerOccurrences` and `countOwnerOccurrences` for
every listed owner and stream over two 400-day ranges, plus
`readOwnerFirstEvidenceDay`.

| Schema | Compared | Equal | Occurrences | Committed / rewritten time |
|---|---:|---:|---:|---:|
| Dense legacy, small | 65 | 65 | 11,808 | 6.3 s / 5.2 s |
| Dense legacy, medium | 65 | 65 | 70,808 | 92.0 s / 26.3 s |
| Q-1 (this stream's import) | 52 | 52 | 14,831 | 8.1 s / 4.6 s |
| Dense golden (the kept `tibotattle_dense_parity` import, read only) | 65 | 65 | 375,293 | 160.6 s / 120.6 s |

Negative tests: fixture option `legacyScope` (owners lima and mike) stores
one occurrence id with one eligible v1 record and three variants:

- a superseded chunk;
- a chunk that accepted one record fewer than it declares;
- another participant's v1.1 record.

It also stores records at the first and last instant of the fixture's days.
Five mutations of the rewrite each fail the new case:

- the range fence's upper bound off by one;
- its lower bound off by one;
- the expansion `LATERAL` replaced by the fence alone;
- the candidate `LATERAL` replaced by the fence alone;
- the v1 device fence dropped.

## Parity

Every run imported fresh into a database this stream created. The dists were
built with Node 22.16.0 from the commit named.

| Run | Dist | Result |
|---|---|---|
| Q-1 rehearsal (`--per-date-expected`, `--owner-reference golden-q1-node`), first round | built before the output model was calibrated (then 160 bytes plus 3 per character) | `pass`, every gate true. Served body sha256 `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d` (396,337 bytes), response file `04f7a277…`, preview `b3722cc9…`. Owner families: fits 4/4, model dates 280/280, owner-days 672/672, cache owner-days 680/680, refusals 15/15 |
| Dense rehearsal (`--dense`, dense-final dump), first round | the same pre-calibration build | `pass`, every gate true. Served body `8c71e60d…`, response file `36316eca…`, preview `4158041c…`. Refresh 882 s and 809 s |
| Q-1 rehearsal, the reviewer's re-run | `32215a26` | `pass`, every gate true; body `a27aee71…`, response file `04f7a277…`, preview `b3722cc9…`; owner families equal as above (reviewer's database `c_refresh_review_q1`, dropped) |
| **Dense rehearsal on `32215a26`** | `b76aa67fb915fd4396402ec280c7a5719649e66c6fe6d17c6c591306f80bf273` | `pass`, every gate true (importers, first refresh complete, read 200, second run 0 new revisions, parity, per-date and owner parity with zero unexpected). Served body sha256 `8c71e60dae2d0fd491be3f63f565287aa25d2e7c01ae9d6ec5f25f66e757f913` (413,197 bytes), response file `36316eca8e8a1067…`, preview `4158041c0454227b…`, all as dense-final. 168 days; served families equal (daily totals, cells, spend and other 168/168, allowance breakdowns 71/71, model days 141/141, preview 1/1); per-date expectation equal; owner families fits 5/5, model dates 350/350, owner-days 840/840, cache owner-days 850/850, refusals 15/15. T-2 148.3 s. Refresh 884 s and 1,025 s (read 138 s, prepare 167 s, scalar 24 s, model 554 s in the first, on a shared cluster). Owner e estimate 1,517 MiB, heap peak 2,028 MiB, peak RSS 2,462 MiB, account 24 MiB of a 351 MiB output budget |
| **Q-1 rehearsal on `979775e3`** | `73e87286eaa98a203017d649a487a95fd85f38caa1e8d7d7071973f2f7b21e78` | `pass`, every gate true. Served body sha256 `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d` (396,337 bytes), response file `04f7a277a9d8616f…`, preview `b3722cc98b7a82ef…`, all unchanged. 168 days; served families equal (model days 120/120, the 21 OD-12 per-date dates held to the per-date expectation, allowance breakdowns 71/71, preview 1/1); per-date expectation equal; owner families fits 4/4, model dates 280/280, owner-days 672/672, cache owner-days 680/680, refusals 15/15; second run 0 new revisions. Refresh 24 s and 25 s. Account 11 MiB; configured output budget 351 MiB, the run's (reclaimed) budget 4,820 MiB with the largest estimate 140 MiB |
| **Dense rehearsal on `979775e3`** | `73e87286…` (as above) | `pass`, every gate true. Served body sha256 `8c71e60dae2d0fd491be3f63f565287aa25d2e7c01ae9d6ec5f25f66e757f913`, response file `36316eca8e8a1067…`, preview `4158041c0454227b…`, all unchanged. 168 days; served families equal (daily 168/168 in each family, allowance breakdowns 71/71, model days 141/141, preview 1/1); per-date expectation equal; owner families fits 5/5, model dates 350/350, owner-days 840/840, cache owner-days 850/850, refusals 15/15; second run 0 new revisions. T-2 152.1 s. Refresh 906 s and 817 s (read 137 s, prepare 169 s, scalar 25 s, model 574 s in the first). Owner e estimate 1,517 MiB, heap peak 1,685 MiB, peak RSS 2,076 MiB. Account 24,355,076 bytes (24 MiB), byte-identical to the `32215a26` run, owner by owner; configured output budget 351 MiB, the run's (reclaimed) budget 3,442 MiB |

The reclaim changes no output, only the budget the account is held to, so
`979775e3`'s bodies equal `32215a26`'s.

## Gates

Local, on `979775e3` unless stated. PostgreSQL 17 fan-out cluster, port
55433, private socket, in this stream's database `c_refresh_spec`.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (apps/worker) | rc 0 |
| `npm run analytics-v2:check` | 12 files, 124/124 (`compute.spec.ts` 22/22: the reclaim, its validation and the scalar checkpoint are new assertions in existing cases) |
| `postgres-test/analytics-v2-refresh.spec.mjs` with `postgres-test/analytics-v2-occurrence-source.spec.mjs` | 55/55 (44 + 11; the projection pin is new). Without PostgreSQL, 21 pass and 23 skip |
| `npm run gcp:ops:infra:check` (manifest, operations, bucket birth, gcp-infra) | 195/195 (the manifest check holds the render pin) |
| `gcp-fastpath-test-deploy`, `gcp-production-rollout` and both parity-compare checks | 59/59 |
| `npm run gcp:fastpath:scripts-check` (no PostgreSQL environment) | rc 0, 65 pass, 3 skipped |
| `npm run check` in `cloud-run` (Node 26.2.0, socket) | rc 0; 353 tests: 352 pass, 1 skipped (the opt-in A2 real-PostgreSQL case); all build entries, image build-context check included. Under Node 22.16.0 the check stops at `synthetic-v12-smoke.check.mjs`, whose entry imports `../src/constants.ts`; neither file changed since `afd865a0` |
| Q-1 and dense rehearsals | see Parity |
| Root `npm run architecture:check` | passed (928 production files, 3,977 imports, 0 debt edges) |
| Root `npm run test:preflight` | rc 0, 20/20 |

First round, on `32215a26`:

- `analytics-v2:check` 124/124 after one test fix;
- the refresh spec 43/43;
- the occurrence-source spec 11/11;
- the five legacy mutations;
- `cloud-run` check 338 tests (337 pass, 1 skipped);
- script checks 98/98;
- architecture and preflight passed.

## Not covered

- Nothing ran on Cloud Run or Cloud SQL. MEAS-3 remains: the largest real
  owner on Cloud Run with this code. The memory model, output model, time
  rates and the projection's roster are synthetic and local.
- The output projection is a stated planning roster. At the high end of the
  largest real owner's estimate, the dense profile holds that roster for
  about 641 days of history. Past that, a production run refuses with
  `ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED` and publishes nothing. No alert reads
  the receipt's headroom.
- Which contract governs the production analytics job (this one, or CR-3's
  analytics-job profiles) is undecided; the equality pin guards against
  drift.
- The snapshot's xmin hold through compute is unchanged and still disclosed.
- No revision seed exists for the production target: the first production
  run publishes revision 1 above an empty store. Whether GCP revisions must
  continue Cloudflare's published ones at cutover is not decided here.
- Libraries' own environment variables (`GCE_METADATA_HOST`, proxy
  variables) are not refused, and a `NODE_OPTIONS` preload runs before the
  refusal.
- The full `postgres:domain:check`, the Worker's full `check`, root
  `npm test` and a Docker build were not run.
