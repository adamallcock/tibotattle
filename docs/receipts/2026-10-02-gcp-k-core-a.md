---
title: GCP engine v2 first block (K-CORE-A)
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP engine v2 first block (K-CORE-A)

This is a 2026-10-02 receipt for stream K-CORE-A on branch
`claude/gcp-fp-k-core-a`, built on `claude/gcp-fastpath-final` at `fce3572e`.
It covers the first block of the engine v2 build order
(`design/wave5-critic-2026-10-02.json`): K-PGSTAT-local, K-SPLIT, K-STAMP,
K-READ, K-PAR and the analytics use of `community_aggregate_exclusions`
(N-EXCL).

It records **local, synthetic** evidence only: one macOS arm64 workstation
shared with other agents (load average 5 to 10 throughout), and the local
PostgreSQL 17 fan-out cluster (private Unix socket, port 55433). The databases
this stream used were `kcore_a_base` and `kcore_a_work`, both created by this
stream and dropped at the end; the kept dense corpus
`tibotattle_dense_parity` was only read, in read-only transactions. The refresh
ran under Node.js 22.16.0 (the image runtime); importers, specs and scripts
under Node.js 26.2.0. Every corpus is synthetic and content-free. Nothing was
pushed, deployed, migrated or seeded on GCP or Cloudflare, and no production
data was read. It does not qualify a Cloud Run image, Cloud SQL, the staging
or production plane, or a real owner.

## What changed

| Item | Change |
|---|---|
| K-PGSTAT | Every A-1 reader statement starts with a closed family tag (`/* analytics_v2:<family> */`, `owners.ts ANALYTICS_V2_STATEMENT_FAMILIES`). The Job's snapshot read pool keeps a per-family ledger (calls, client wall time, rows, protocol bytes received) and the receipt gains `reads`: the read phase's wall time, the statement wall time per family, the unattributed remainder, and, when `pg_stat_statements` is readable, the server's execution and planning time per family (delta of two snapshots taken on their own connection; `null` when the view is absent) |
| K-SPLIT | `store.ts` is the write transaction and facade over `store-run.ts` (validation, lock and cursor, run row, prior state), `store-derived.ts` (owner-scoped families) and `store-publication.ts` (heads, preview). `compute.ts` plans and merges over `compute-owner.ts` (one admitted owner) and `compute-community.ts` (daily candidates, preview). The Job's read side moved to `cloud-run/analytics-refresh-read.mjs`. Public names are re-exported from the old modules |
| K-STAMP | `src/analytics-v2/kernel-registry.json` (append-only; entry 1 is d43c8f92's vendored kernels with this commit's compute closure, `analytics-v2-method-v1`) and `kernel.ts`. The build stamps each bundle with its identity (`cloud-run/analytics-kernel-closure.mjs`: the vendored MANIFEST digest and a digest of every input of the compute Worker's closure, through two esbuild defines). The Job refuses `ANALYTICS_V2_KERNEL_UNREGISTERED` before any connection; the store registers the kernel row and refuses `ANALYTICS_V2_KERNEL_CONFLICT` and `ANALYTICS_V2_KERNEL_REGRESSION`. Every row carries `kernel_id smallint` and `manifest_version int` (1, the compiled baseline); run rows carry `compatibility_sha256` (closure, method and the refusal-deciding resource configuration). Staged migration `0066_analytics_v2_kernel_stamps.sql` |
| K-READ | The owner scope and the three expansion statements (legacy "direct", v1.2, correction) are named prepared statements, and the expansion loop plans them generically (`plan_cache_mode=force_generic_plan`, transaction-local, restored for a caller's snapshot). New readers: `readOwnerDayFingerprints` (F(o,d)) and `readOwnerWatermarks` (W(o)). Reader outputs unchanged (A/B below) |
| K-PAR | `--workers=<n>` (1..16). With more than one, each admitted owner runs `computeAnalyticsV2Owner` in a `worker_threads` Worker (`dist/analytics-refresh-worker.mjs`; `cloud-run/analytics-refresh-pool.mjs`), longest estimate first; Workers never touch the database (the main thread serves their segment loads, one at a time) and results merge in owner-digest order. The production and dense measurement profiles are now `--max-old-space-size=3072 dist/analytics-refresh.mjs --mode=full --workers=4` |
| N-EXCL | `readAnalyticsV2ExclusionScopes` reads the table D-PT4X adds (absent on this line, reported as such), counts rows per scope, refuses a scope d43c8f92 does not define, and applies the exclusions to no output, as production does (below). The receipt gains `exclusions` |

## K-PGSTAT-local: where the read time goes

### Statement plans (EXPLAIN (ANALYZE, BUFFERS), dense corpus, one 200-id batch)

On `tibotattle_dense_parity` (read-only), at the base commit's SQL.

| Statement | Planning | Execution | Shared hits | Wall, unnamed | Wall, named (auto) | Wall, named and generic |
|---|---:|---:|---:|---:|---:|---:|
| v1.2 expansion, usage (owner e, 360,462 records, 170 ready manifests) | 10.3-10.6 ms | 11.1-11.6 ms | 7,566 | 19.6-31.4 ms | 11.3-11.4 ms | generic execution 9.9 ms |
| v1.2 expansion, quota | 9.2 ms | 9.2 ms (generic) | | 24.8 ms | 12.2 ms | |
| v1.2 expansion, session | 10.2 ms | 13.0 ms (custom), 7.3 ms (generic) | | 15.5 ms | 15.4 ms (auto kept custom plans) | |
| Legacy "direct" expansion (7,672-record owner) | 8.7-11.8 ms | 8.5-14.0 ms | 22,792-22,909 | 14.0-16.2 ms | 8.9-11.2 ms | 6.9-8.1 ms |
| Legacy "direct" expansion (3,662 and 7,370-record owners) | 8.2-8.4 ms | 12.3-12.8 ms | 22,452-22,826 | 15.4-15.7 ms | 9.8-9.9 ms | |

Findings:

- **The "direct" reader no longer scans the owner.** Its execution time is the
  same for owners of 3,662 and 7,672 records: C-REFRESH's rewrite (e), with the
  c0600bc2 method, already made it follow the batch. The cloud figure in the
  task (1,886 calls at 230 ms) is the pre-C-REFRESH image; the post-C-REFRESH
  cloud snapshot (`receipts/gcp-dense-postrefresh-20261002T164129Z`) shows it
  at 1.2 ms a call. No further rewrite was needed; it gains the plan cache.
- **Planning is half of a call.** Each expansion statement plans in 8-12 ms
  locally (the cloud estimate is 25-45 ms) and executes in 9-14 ms. A named
  statement under PostgreSQL's default `auto` mode stops re-planning only when
  its generic plan looks no costlier than its custom plans, which for the
  session stream it never does. Forcing the generic plan for the expansion
  loop is safe because the fences (MATERIALIZED CTEs, OFFSET 0 laterals) fix
  the plan shape: the generic plans executed in the same or less time for
  every family and stream measured.
- **What the v1.2 expansion still spends.** In the 11 ms: probing the
  participant's 170 ready manifests for the batch's 200 ids (3.6 ms), the
  per-record eligibility lateral, whose chunk-completeness count reruns per
  record (4.1 ms), and the dictionary joins (2 ms). The completeness count
  per distinct chunk, not per record, is the next statement-level target
  (not done here).

### The run ledger (dense rehearsal, this commit)

From the receipt's `reads` (first refresh of the W = 4 dense rehearsal;
pg_stat_statements is not loaded on the local cluster, so `server` is null):

| Family | Calls | Client wall | Rows | Bytes received |
|---|---:|---:|---:|---:|
| `occurrences.v12_sources` | 1,848 | 15.7 s (8.5 ms a call) | 364,111 | 220 MB |
| `occurrences.legacy_sources` ("direct") | 1,885 | 1.1 s | 11,183 | 8.4 MB |
| `occurrences.correction_sources` | 1,521 | 0.5 s | 0 | 3.0 MB |
| `occurrences.counts` | 15 | 0.8 s | | |
| `occurrences.first_evidence` | 26 | 0.8 s | | |
| `occurrences.v12_candidates` | 13 | 0.7 s | 364,111 | 38 MB |
| `snapshot.control` (BEGIN, SET TRANSACTION SNAPSHOT, SET LOCAL, COMMIT) | 275 | 26 ms | | |
| Every family | 5,768 | 20.1 s | | |
| **Read phase wall** | | **84.1 s** | | |
| **Unattributed** (phase wall minus every round trip) | | **64.0 s (76%)** | | |

The second refresh ran under heavier machine load: 157.7 s of read phase,
34.7 s of round trips, 123.0 s unattributed.

Locally, then, **three quarters of the read phase is client work between
round trips**: decoding, re-hashing each record against its canonical digest
and reconciling occurrences, all on the main thread (the compute Workers do
not read). That is the local answer to the "about 50% unattributed" question;
whether the cloud's ~700 s of non-execution read time is the same client work
on a slower core, or round trips, is what this ledger will say on the
authorised cloud run (it reports both sides there, with pg_stat_statements).
Moving decode into the compute Workers is a candidate if it is the former.

## K-READ: reader A/B and evidence identity

A/B (`readOwnerOccurrences` and `countOwnerOccurrences` of the base commit and
of this commit, in one read-only snapshot, every owner and stream over 400-day
ranges back to each owner's first evidence day, and `readOwnerFirstEvidenceDay`):

| Schema | Compared | Equal | Occurrences | Base read time | This commit |
|---|---:|---:|---:|---:|---:|
| `tibotattle_dense_parity` (kept dense import) | 35 | 35 | 375,293 | 145.6 s | 98.4 s |
| the same, reverse call order | 35 | 35 | 375,293 | 140.5 s | 120.7 s |
| the base dense rehearsal's own import | 35 | 35 | 375,293 | 134.8 s | 89.5 s |

- F(o,d) (`readOwnerDayFingerprints`) runs exactly the reader's candidate and
  prepared expansion statements and digests the scope, the day's candidates
  and every selected source row instead of decoding them, so an unchanged
  F(o,d) means unchanged reader output. Specs: F names exactly the reader's
  evidence days for every fixture owner at both correction runtimes; it is
  stable and unaffected by other owners' evidence; and a mutation proof over
  the correction runtime and a v1.2 chunk made incomplete shows every day
  whose output changed also changed F.
- W(o) (`readOwnerWatermarks`) is one statement over every requested owner: the
  journal head in `storage_owner_revisions`, the owner link and participant
  state, the reader's retained v1.2 authorization rows at the pinned clock,
  the v1.2 head and the runtime states. It is **advisory**: nothing reads it to
  skip work. K-INCR may rely on it only after mutation tests prove that every
  intake, correction, generation replacement and link change moves one of its
  inputs; this stream proved only the journal head, the scope and the
  correction runtime move it, and that another schema with the same evidence
  has the same W.

## K-STAMP

- Kernel 1: production commit `d43c8f92a059d9c577776f7eca8a331eb305b8a6`,
  vendor manifest `97acb9af…`, compute closure `687e74b3…` (129 inputs),
  price registry `app-official-api-prices-v0.8` (`48119389…`), method
  `analytics-v2-method-v1`. `scripts/analytics-v2-kernel-registry.check.mjs`
  pins each entry, requires an entry for the closure `node cloud-run/build.mjs
  --check` reports, checks it against MANIFEST.json and the vendored price
  registry, and checks the staged migration seeds exactly entry 1.
- **Any change to a compute-closure file (comments included) now needs a new
  registry entry before it merges**; the check names the digest to register.
  The closure is the Worker entry's: `compute-owner.ts`, `native-path.ts`,
  `pin.ts`, `refusals.ts`, `resources.ts`, `contract.ts`, the vendored tree,
  `canonical-json.ts`, `crypto.ts`, the Worker shell and `runcost@0.2.1`
  (named by package and version, not install path).
- Backfill: rows that exist before the migration become kernel 1, manifest 1,
  without an UPDATE (0059's forward-only trigger never fires); run rows keep
  `compatibility_sha256` NULL (not recorded, never inferred). Kernel 1 claims
  them because this stream's refactor is proven output-identical to the code
  that wrote them (the parity below). The contract version moves to
  `analytics-v2-contract-v0.5`; that string is in the private pin
  fingerprint, which reaches no stored row (the rehearsals hold every family
  byte-equal).
- The spec case proves: every stamped table is stamped; the kernel row is
  registered once; a conflicting entry (other closure, or other id) is
  refused atomically; a newer kernel registers and writes, after which the
  older is refused with nothing changed; the kernel rows are append-only;
  the stamp columns have no default, refuse manifest version 0 and an
  unregistered kernel id; and the backfill.

## K-PAR

- Admission: the Workers' heap limits (estimate plus a 1,024 MiB reserve
  each) together stay within the per-owner budget plus one reserve, so an
  owner as large as the budget runs alone. Task memory of the production
  profile: main heap 3,072 MiB + budget 10,752 MiB + one reserve 1,024 MiB =
  14,848 MiB of 16 GiB (pinned in the ops-manifest, test-deploy and refresh
  checks). The reserve is wide because the memory estimate is not a heap
  bound: owner e (estimate 1,517 MiB) sampled 2,275 MiB of used heap in its
  Worker (the first W = 4 run used a 256 MiB reserve and completed).
- Without a pool (`--workers=1`, the default), owners are computed inline
  exactly as before, including the output account's refusal point and the
  reclaim of the unused per-owner budget. With a pool, finished owners'
  outputs are held to the output budget as they arrive; the main heap's output
  budget is its own (no reclaim). The time guard divides the remaining owners'
  projection by the worker count (no faster than the largest owner alone).
- Determinism: owners share no state; the specs hold W = 1, 2 and 4 to the
  same stored rows over the direct-seed corpus, and the rehearsals hold
  W = 1 and W = 4 to the goldens.
- **Measured: on the dense corpus one owner is the whole critical path.**
  Owner e (294,198 analysis usage rows of about 304,000) is about 96% of the
  compute, so four Workers do not shorten the dense run (table below), while
  Q-1's four similar owners run 2.6 times faster. The owner's decision (round
  7: split one owner across cores only if measurement shows it dominates) now
  has that measurement locally; the intra-owner split (analysis blocks) is not
  built here and should wait for the cloud measurement of real owners.
- Production and dense measurement profiles are pinned to the new args in
  `ANALYTICS_REFRESH_PRODUCTION_JOB`, `gcp-ops-infra-manifest.mjs`
  `ANALYTICS_REFRESH_TASK_PROFILE` and its render, `gcp-fastpath-test-deploy.mjs`
  `REFRESH_JOB_PROFILES.dense` and their checks (`gcp-infra.check.mjs`,
  `gcp-ops-infra-manifest.check.mjs`, `gcp-fastpath-test-deploy.check.mjs`).
  The committed desired-state files hold no job arguments (OPS-2 renders them
  from that profile), so no desired-state file changed.

## N-EXCL: what production does with exclusions

At d43c8f92, `community_aggregate_exclusions` (scope `community_weekly` only,
D1 0023) has exactly one reader, the v0.3 weekly community snapshot
(`community-snapshots.ts buildCommunityWeeklySnapshot`), which GCP does not
compute. The storage community daily, graph, cache-retention and allowance
lanes that analytics_v2 ports never read the table; an exclusion change only
bumps their policy revision (ingestion-isolation 0001: "without falsely
treating a weekly exclusion as opt-out"), which re-runs the same pure
computation. So **matching production means the exclusions remove no owner
from any analytics_v2 output**. This stream reads them in the run's snapshot,
reports content-free counts, and refuses a scope production does not define
(`ANALYTICS_V2_SOURCE_CONFLICT`), so a new scope can never be silently
ignored. If the owner meant round 5's "their use in GCP analytics" to remove
excluded owners from the GCP daily or graph, that is a new product decision
and a disclosed divergence from production, not parity.

## Parity and timings

Every rehearsal imported fresh into `kcore_a_work` with the staged migration
applied through the staged-migrations harness (`--staged-primary`), and ran
both refreshes under Node 22.16.0.

| Run | Result |
|---|---|
| Q-1, W = 1 | `pass`, every gate true (importers, first refresh, read 200, second run 0 new revisions, parity 0 unexpected over 168 days, per-date equal, owner families fits 4/4, model dates 280/280, owner-days 672/672, cache owner-days 680/680, refusals 15/15) |
| Q-1, W = 4 | `pass`, every gate true, the same family counts |
| Dense, W = 4 | `pass`, every gate true (168 days; owner families fits 5/5, model dates 350/350, owner-days 840/840, cache owner-days 850/850, refusals 15/15) |
| Dense, W = 1 | `pass`, every gate true, the same family counts |
| Dense, base commit `fce3572e` (same machine, before the changes) | `pass`, every gate true |
| Dense rows, this commit (W = 4) against the base commit | every analytics_v2 family equal row for row, apart from run ids and stamps: owner-day 850, cache bands 22,230, fits 5, model dates 346, published heads 168 (payloads equal), preview 1, run refusals and publication equal |

### Timings

The machine was shared with other agents (load average 5 to 10), so runs at
different times are not comparable: the inline dense rehearsal of this commit
took 941 s and 860 s under a load near 10, against the base's 781 s and 765 s
under about 5, with every phase (including the unchanged kernels) slower. The
deltas below therefore come from **pairs run at the same time on the same
machine**: the base commit's dist and this commit's dist refreshing their own
kept dense imports concurrently (full recompute, same clock), and the two Q-1
rehearsals concurrently.

| Pair (concurrent) | Base `fce3572e`, inline | This commit | Delta |
|---|---:|---:|---:|
| Dense, inline: refresh wall | 799 s | 756 s | -5% |
| Dense, inline: read phase | 130.7 s | 95.9 s | **-27%** |
| Dense, inline: prepare / scalar / model | 131.5 / 19.9 / 515.5 s | 127.1 / 19.7 / 512.6 s | equal (the split costs nothing) |
| Dense, W = 4: refresh wall | 809 s | 752 s | -7% |
| Q-1, W = 4: refresh wall, first / second run | 20.5 / 17.8 s | 11.7 / 11.1 s | -43% / -38% |

- The read phase gains come from the plan cache (the reader A/B above shows
  the same, -14% to -34%).
- **Dense gains almost nothing from Workers**: owner e is the critical path
  (above). With W = 4 the main thread's read phase was 93.3 s of client wall
  time; the receipt's summed `read` (269 s) also counts each Worker's waits
  for the main thread's loads.
- Q-1's four similar owners run in parallel: 2.6 times faster than inline
  when the two ran back to back (17.8 s against 6.8 s).
- Peak resident set: dense W = 4 2.8-3.2 GiB (each Worker its own heap)
  against 1.7-2.2 GiB inline; Q-1 W = 4 about 480 MiB against 290-360 MiB.

## Gates

Local, on this commit's tree. PostgreSQL 17 fan-out cluster, port 55433,
private socket.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (apps/worker) | rc 0 |
| `npm run analytics-v2:check` (Node 22.16.0) | 13 files, 155/155 (`compute.spec.ts`'s checkpoint case now also pins `workers`, `ownerDone` and each event's owner) |
| PostgreSQL specs: `analytics-v2-refresh`, `analytics-v2-occurrence-source`, `analytics-v2-community-daily-route`, `analytics-v2-interim-public-read`, `online-erasure-absence`, `staged-migrations-harness` | 105/105 (the occurrence-source and online-erasure specs refuse a socket path in `PG_TEST_HOST`; rerun without it, 17/17). New cases: K-STAMP (stamps, conflict, regression, append-only, backfill), K-PAR (W = 1, 2 and 4 write the same rows over the real readers and kernels; a Worker that exits fails the run with nothing written), the parallel time guard, K-READ (tags and prepared statements, F(o,d) stability and locality, the F(o,d) mutation proof, W(o)), N-EXCL |
| `postgres-admin-console.spec.mjs` | 10/10 |
| `npm run postgres:domain:check` | rc 0 on the default database: vitest 14 files, 83 pass and 1 skipped; node 403 tests, 402 pass, 1 skipped, 0 fail |
| `cloud-run` `npm run check` (Node 26.2.0) | rc 0: 318 pass, 1 skipped (A2, retired); includes the new pool check (6/6), the build with the Worker entry and kernel identity, `host.check.mjs` and the build-context check |
| `npm run gcp:ops:infra:check` | 197/197 |
| `npm run gcp:fastpath:scripts-check` (no PostgreSQL environment) | rc 0, 82 pass, 3 skipped; includes the kernel-registry check (3/3) and the rehearsal option checks |
| `npm run gcp:production-tooling:local-check` | rc 0, 316 pass, 5 skipped |
| `npm run scripts:check` | 1,084/1,084 (25 runs) |
| `npm run postgres:migrations:check` | rc 0 |
| `node scripts/ci-postgres-suite.mjs --plan` | failures [] (80 files) |
| `test/hosted-backend-workflow.test.js` | 20/20 |
| Q-1 and dense rehearsals, reader A/B | see above |
| Root `npm run architecture:check` | passed (942 production files, 4,013 imports, 0 debt edges) |
| Root `npm run test:preflight` | rc 0, 20/20 |

Not run: the EDGE_E2E golden spec (`edge-origin-e2e.spec.mjs` S9, about 40
minutes; its rehearsal call now passes every staged primary file and was only
syntax-checked), root `npm test`, the Worker's `product:worker:check`, and a
Docker build.

## Not covered

- Nothing ran on Cloud Run or Cloud SQL. The cloud half of K-PGSTAT (a
  refresh of an image with this ledger, pg_stat_statements reset before and
  read after, on the test project and the staging plane's dedicated
  instance) is approved but not run here; it decides whether the cloud's
  unattributed read time is client decode or round trips.
- W(o) is advisory until K-INCR's mutation proofs through the real intake
  paths; F(o,d) is proven against the reader on the direct-seed fixture only.
- The intra-owner split (K-PAR analysis blocks) is not built; on the dense
  corpus one owner is the critical path.
- N-EXCL is built against D-PT4X's declared contract (D1 0023's columns; it
  reads `scope` and `state` only); D-PT4X has not merged. While the table is
  absent the receipt says `table: "absent"`.
- The staged migration is numbered 0066 as a placeholder; the integrator
  numbers it. Specs that write analytics_v2 rows by hand give the stamp columns
  a schema-local default once the migration is in their schema
  (`defaultAnalyticsV2FixtureStamps`), so they pass before and after
  promotion; the E2E S9 rehearsal applies every staged primary file.
