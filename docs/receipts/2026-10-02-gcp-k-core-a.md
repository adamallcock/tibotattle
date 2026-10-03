---
title: GCP engine v2 first block (K-CORE-A)
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP engine v2 first block (K-CORE-A)

This is a 2026-10-02 receipt for stream K-CORE-A on branch
`claude/gcp-fp-k-core-a`. The build (`febbae7f`) was made on
`claude/gcp-fastpath-final` at `fce3572e` (then `2b5c90cd`); the review round
(`b325fc91`, section "Review round" below) fixed its findings, and the branch
then merged the final line at `112d27cc` (`387f6567`) and at `07001c00`
(`2959668b`, D-OPS4's primary 0068). The parity and gate results below
marked "merged tree" ran on those merged trees, as each row says; the K-PGSTAT,
reader A/B and timing-pair measurements ran on the build commit and are not
affected by the review fixes (which change no reader statement; they add one
exclusion read per run).
It covers the first block of the engine v2 build order
(`design/wave5-critic-2026-10-02.json`): K-PGSTAT-local, K-SPLIT, K-STAMP,
K-READ, K-PAR and the analytics use of `community_aggregate_exclusions`
(N-EXCL).

It records **local, synthetic** evidence only: one macOS arm64 workstation
shared with other agents (load average 5 to 10 throughout), and the local
PostgreSQL 17 fan-out cluster (private Unix socket, port 55433). The databases
this stream used were `kcore_a_base`, `kcore_a_work` and (review round)
`kcore_a_spec`, all created by this stream and dropped at the end; the kept dense corpus
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
| K-STAMP | `src/analytics-v2/kernel-registry.json` (append-only; entry 1 is d43c8f92's vendored kernels with this branch's compute closure, `analytics-v2-method-v1`) and `kernel.ts`. The build stamps each bundle with its identity (`cloud-run/analytics-kernel-closure.mjs`: the vendored MANIFEST digest and a digest of every module that decides a stored value, through two esbuild defines; `node cloud-run/build.mjs --kernel-closure` lists them). The Job refuses `ANALYTICS_V2_KERNEL_UNREGISTERED` before any connection; the store registers the kernel row and refuses `ANALYTICS_V2_KERNEL_CONFLICT` and `ANALYTICS_V2_KERNEL_REGRESSION`. Every row a run writes carries `kernel_id smallint` and `manifest_version int` (1, the compiled baseline); run rows carry `compatibility_sha256` (closure, method and the refusal-deciding resource configuration). Staged migration `0911_analytics_v2_run_stamps.sql` (placeholder number) |
| K-READ | The owner scope and the three expansion statements (legacy "direct", v1.2, correction) are named prepared statements, and the expansion loop plans them generically (`plan_cache_mode=force_generic_plan`, transaction-local, restored for a caller's snapshot). New readers: `readOwnerDayFingerprints` (F(o,d)) and `readOwnerWatermarks` (W(o)). Reader outputs unchanged (A/B below) |
| K-PAR | `--workers=<n>` (1..16). With more than one, each admitted owner runs `computeAnalyticsV2Owner` in a `worker_threads` Worker (`dist/analytics-refresh-worker.mjs`; `cloud-run/analytics-refresh-pool.mjs`), longest estimate first; Workers never touch the database (the main thread serves their segment loads, one at a time) and results merge in owner-digest order. The production profile stays **inline** (`--max-old-space-size=12288 dist/analytics-refresh.mjs --mode=full`, unchanged from the base) until MEAS-3; the test-deploy profile `dense-workers` (`--max-old-space-size=3072 ... --workers=4`) is the measurement |
| N-EXCL | `readAnalyticsV2Exclusions` (owners.ts) reads `community_aggregate_exclusions` (D-PT4X, primary 0066) in the run's snapshot, and `exclusions.ts` applies D-PT4X's read contract per analysis day: an owner with an active `community_weekly` row covering day D is left out of D's public daily and the preview's day D. The run row records the digest of every row read (`exclusions_sha256`); a changed digest republishes every published day. F(o,d) and W(o) carry the exclusions. The receipt gains content-free `exclusions` counts |

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
- **The cloud's dominant read cost is v1.2 execution, which this stream
  does not address.** The same post-C-REFRESH snapshot shows the v1.2
  expansion at 1,848 calls, 226.7 s of execution, 122.7 ms a call, with about
  214k shared blocks read (buffer misses), against about 11 ms a call
  locally on a warm cache. The snapshot has no `total_plan_time`, so the
  cloud's planning cost is unmeasured. K-READ's local gain (-14% to -34%)
  comes from the plan cache, which removes only planning; **it is not
  evidence of a cloud read gain.** The v1.2 statement's execution (I/O on
  buffer misses and the per-record completeness count below) is the next
  K-READ target.
- **What the v1.2 expansion still spends.** In the 11 ms: probing the
  participant's 170 ready manifests for the batch's 200 ids (3.6 ms), the
  per-record eligibility lateral, whose chunk-completeness count reruns per
  record (4.1 ms), and the dictionary joins (2 ms). The completeness count
  per distinct chunk, not per record, is the next statement-level target
  (not done here).

### The run ledger (dense rehearsal, build commit `febbae7f`)

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
of the build commit, in one read-only snapshot, every owner and stream over 400-day
ranges back to each owner's first evidence day, and `readOwnerFirstEvidenceDay`):

| Schema | Compared | Equal | Occurrences | Base read time | Build commit |
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
  vendor manifest `97acb9af…`, compute closure `f0df5908…` (160 inputs, after
  the review round and the merge of `112d27cc`), price registry
  `app-official-api-prices-v0.8` (`48119389…`), method
  `analytics-v2-method-v1`. Entry 1 is unreleased (no stored row carries it
  yet), so the review round re-derived its closure digest in place, with its
  pin; from the first stamped run on, entries are append-only.
  `scripts/analytics-v2-kernel-registry.check.mjs` pins each entry, requires
  an entry for the closure `node cloud-run/build.mjs --check` reports (its
  failure lists every closure input), checks it against MANIFEST.json and the
  vendored price registry, proves the closure holds the modules below and no
  I/O plumbing, proves a one-line change to `compute-community.ts`,
  `occurrence-source.ts` or `owners.ts` is a closure no entry names, and
  refuses a stale workspace-package copy instead of hashing it.
- **The closure (review finding 2: it was the Worker entry's only).** It is
  every module of the refresh entry's import graph that decides a stored
  value, minus the I/O plumbing (`ANALYTICS_KERNEL_CLOSURE_PLUMBING`: store,
  snapshot pool, Worker pool, the Job shell). 116 vendored files
  (`apps/worker/vendor/analytics-d43c8f92/`), `npm:runcost@0.2.1`, and:
  - `apps/worker/cloud-run/analytics-refresh-read.mjs`, `analytics-refresh-worker.mjs`;
  - `apps/worker/src/analytics-v2/`: `compute.ts`, `compute-owner.ts`,
    `compute-community.ts`, `contract.ts`, `devices.ts`, `exclusions.ts`,
    `native-path.ts`, `occurrence-source.ts`, `owners.ts`, `pin.ts`,
    `queued-days.ts`, `refusals.ts`, `resources.ts`;
  - `apps/worker/src/`: `canonical-json.ts`, `constants.ts`, `crypto.ts`,
    `errors.ts`, `strict-json.ts`, `telemetry-usage-reconciliation.ts`,
    `telemetry-v1.ts`, `telemetry-v11-compatibility.ts`,
    `telemetry-v12-typed-codec.ts`, `telemetry-validation.ts`,
    `typed-telemetry-codec.ts`;
  - `packages/telemetry-contract/index.js` and `src/`: `admin-model-history.js`,
    `constants.js`, `envelope.js`, `errors.js`, `model-catalog-contract.js`,
    `model-catalog.js`, `performance-histogram.js`, `primitives.js`,
    `telemetry-performance-v1.js`, `telemetry-v0.1.js`, `telemetry-v0.2.js`,
    `telemetry-v1.1-domain.js`, `telemetry-v1.1.js`,
    `telemetry-v1.2-domain.js`, `telemetry-v1.2.js`, `upload.js`.
- **Any change to one of these files (comments included) now needs a new
  registry entry and pin before it merges**, or the Job refuses every run
  with `ANALYTICS_V2_KERNEL_UNREGISTERED`; `gcp:fastpath:scripts-check` fails
  first and prints the digest and the input list. `src/constants.ts` and
  `packages/telemetry-contract` are widely shared, so unrelated streams will
  trip this ratchet.
- **Rows written before the migration are unattributed (review finding 6).**
  The migration seeds no kernel row: a kernel is registered by the first run
  that stamps with it. Earlier rows keep `kernel_id` NULL (their code is in no
  registry entry; it is never inferred), with a `NOT VALID` CHECK that
  requires a kernel on every row inserted or updated afterwards; a later run
  that rewrites such a row stamps it. Their `manifest_version` is 1 (the
  vendored d43c8f92 catalog was the only configuration any run could price
  with: a fact, not an inference) and their run rows keep
  `compatibility_sha256` NULL. Column defaults are used only to avoid an
  UPDATE (0059's forward-only trigger never fires) and are dropped.
- The contract version is `analytics-v2-contract-v0.5`; that string is in the
  private pin fingerprint, which reaches no stored row (the rehearsals hold
  every family byte-equal).
- The spec case proves: every stamped table is stamped; the kernel row is
  registered once; a conflicting entry (other closure, or other id) is
  refused atomically; a newer kernel registers and writes, after which the
  older is refused with nothing changed; the kernel rows are append-only;
  new rows must name a kernel and a manifest version (no default, version 0
  and unregistered ids refused); earlier rows stay unattributed; and every
  run row records its exclusions digest (a missing or malformed one is
  refused). `kernel.spec.ts` feeds malformed registries (gaps, duplicates,
  extra keys, ids out of the smallint range) to the registry reader and
  asserts `ANALYTICS_V2_KERNEL_REGISTRY_INVALID`; `analytics-refresh-read.check.mjs`
  feeds malformed named statements to the snapshot pool and asserts
  `ANALYTICS_V2_REFRESH_SNAPSHOT_STATEMENT_UNSUPPORTED` (review finding 8).
- **Deviation from the cross-check's build order (review finding 9).**
  `design/wave5-critic-2026-10-02.json` runs K-VENDOR (the stable vendor path
  and the export patches, still at d43c8f92) before K-STAMP seeds kernel 1.
  K-VENDOR has not run, so kernel 1 names the current vendor path
  `vendor/analytics-d43c8f92`. K-VENDOR's change of path or patches changes
  the closure and must append kernel 2 with its pin before cutover (or, if it
  merges before any stamped run, re-derive entry 1 in place, as this round
  did).

## K-PAR

- Admission: the Workers' heap limits (estimate plus a 1,024 MiB reserve
  each) together stay within the per-owner budget plus one reserve, so an
  owner as large as the budget runs alone. Task memory of the
  `dense-workers` profile: main heap 3,072 MiB + budget 10,752 MiB + one
  reserve 1,024 MiB = 14,848 MiB of 16 GiB (pinned in the test-deploy and
  refresh checks). The reserve is wide because the memory estimate is not a
  heap bound: owner e (estimate 1,517 MiB) sampled 2,275 MiB of used heap in
  its Worker (the first W = 4 run used a 256 MiB reserve and completed).
- **The production profile stays inline (review finding 3).** A Worker's heap
  limit is its owner's estimate plus a fixed reserve, and an owner that
  outgrows it fails the whole run (nothing written), where inline it computes
  within the 12,288 MiB heap. Until MEAS-3 measures Worker heap peaks on real
  owners (`gcp-fastpath-test-deploy --refresh-profile=dense-workers`),
  `ANALYTICS_REFRESH_PRODUCTION_JOB`, OPS-2's `ANALYTICS_REFRESH_TASK_PROFILE`
  and the test-deploy `dense` profile keep the base args
  `--max-old-space-size=12288 dist/analytics-refresh.mjs --mode=full`, and the
  output-budget projection is the base's (641 days at the high-end estimate,
  238 without the reclaim; the dense-workers partition holds 1,447).
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
- The pins (`gcp-infra.check.mjs`, `gcp-ops-infra-manifest.check.mjs`,
  `gcp-ops-infra-operations.check.mjs`, `gcp-fastpath-test-deploy.check.mjs`)
  hold the inline production args and refuse `--workers` in the production
  render. The committed desired-state files hold no job arguments (OPS-2
  renders them from that profile), so no desired-state file changed.

## N-EXCL: exclusions applied in the analytics (review finding 1)

The build applied the exclusions to no output, matching d43c8f92, where the
table's only reader is the v0.3 weekly snapshot GCP does not compute. The
review held that this does not carry out round 5 ("Port them: add the
PostgreSQL table, the import, and their use in GCP analytics") and
contradicts the read contract D-PT4X merged (its receipt and primary 0066's
header; CUTOVER-CHECKLIST "K-CORE-A (N-EXCL in analytics)"). The review round
implements that contract:

- **Predicate** (`exclusions.ts`): an owner is excluded from the community
  aggregates of analysis day D when a row of its participant has scope
  `community_weekly`, state `active`, `effective_at` before the end of D and
  `expires_at` NULL or after the start of D: d43c8f92's weekly predicate,
  applied per day, at microsecond resolution (PostgreSQL's). Revoked rows
  apply to no day.
- **What it removes**: the owner's values and devices from D's public daily
  fold; from the allowance preview's day D, its fits in the band (combined
  and by plan) and its model result for date D (evaluated or refused). The
  preview's coverage counts are today's. The owner's own rows (owner-day,
  cache bands, fits, model dates) are computed and stored as before, and the
  community cache-retention series is not one of the aggregates the contract
  names. With no exclusion the outputs are exactly the fold without them.
- **Reading** (`owners.ts readAnalyticsV2Exclusions`): every row, in the run's
  snapshot, bounded (100,000). The table is required: a schema without it is
  `ANALYTICS_V2_SOURCE_UNAVAILABLE`, never "no exclusions"; an undefined scope
  or state, a duplicate id or an expiry not after its start is
  `ANALYTICS_V2_SOURCE_CONFLICT`. Only a linked owner of the run's roster can
  be excluded; an unlinked participant is in no aggregate.
- **Change propagation**: the run row records `exclusions_sha256` (every row,
  any state); when the next run reads a different digest it queues every
  published day, so a new, revoked or edited exclusion reaches each day it
  covers or covered (a day whose content is unchanged keeps its revision).
  Runs written before the migration applied none: their NULL reads as the
  digest of no rows. F(o,d) and W(o) (evidence identity v2) include the
  participant's covering exclusions, so a K-INCR memo sees the change too.
- **Receipt**: `exclusions` holds counts only (`rows`, `active`,
  `excludedOwners`, `changed`, `republishedDays`); no id or participant.
- **Declared parity difference**: whenever production holds an active row,
  GCP's daily and preview differ from d43c8f92's (which applies none there).
  The Q-1 and dense corpora hold no exclusion rows, so the rehearsals stay
  byte-identical (below). Specs: `exclusions.spec.ts` (the predicate, an
  owner excluded on one day leaves only that day's daily and preview day, an
  owner excluded on every day equals the cohort without it, malformed input);
  PG17 cases in `analytics-v2-refresh.spec.mjs` (an exclusion leaves its owner
  out of the days it covers, republishes on change and never otherwise; the
  table's absence fails closed) and `analytics-v2-occurrence-source.spec.mjs`
  (the read fails closed; F(o,d) and W(o) move with an exclusion).

## Parity and timings

Every rehearsal imported fresh into `kcore_a_work` with the staged migration
applied through the staged-migrations harness (`--staged-primary`), and ran
both refreshes under Node 22.16.0.

### Merged tree (`2959668b`, after the review round)

The promoted chain now ends at `0068_v12_ready_manifest_ready_at_index.sql`, so
D-PT4X's exclusions table is present and read; the staged
`0911_analytics_v2_run_stamps.sql` is applied on top. Both corpora hold no
exclusion rows (receipt `exclusions`: 0 rows, 0 active, unchanged, 0
republished days).

| Run | Result |
|---|---|
| Q-1, W = 1 | `pass`, every gate true (importers, first refresh, read 200, second run 0 new revisions, parity 0 unexpected, per-date equal, owner parity 0 unexpected: fits 4/4, model dates 280/280, owner-days 672/672, cache owner-days 680/680, refusals 15/15); refresh 16.7 s and 15.8 s |
| Q-1, W = 4 | `pass`, every gate true, the same family counts; refresh 9.2 s and 10.2 s; every run stamped kernel 1, manifest 1 |
| Dense, W = 1 (the production profile) | `pass`, every gate true (owner parity: fits 5/5, model dates 350/350, owner-days 840/840, cache owner-days 850/850, refusals 15/15); refresh 695 s and 692 s, read phase 81.2 s and 86.1 s (load average about 6 to 8). On `387f6567` (before 0068) it also passed: 760 s and 771 s, read 90.5 s and 108.1 s under a load of 10 to 12 |
| Rows against the base commit `fce3572e` | dense: every stored family equal apart from run ids and stamps (owner-day 850, cache bands 22,230, fits 5, model dates 346, refusals 15), the stored preview and the served response byte-identical; Q-1 at W = 1 and W = 4 the same (owner-day 680, cache bands 7,710, fits 4, model dates 276, refusals 15) |

### Build commit (`febbae7f`'s tree, before the review round)


| Run | Result |
|---|---|
| Q-1, W = 1 | `pass`, every gate true (importers, first refresh, read 200, second run 0 new revisions, parity 0 unexpected over 168 days, per-date equal, owner families fits 4/4, model dates 280/280, owner-days 672/672, cache owner-days 680/680, refusals 15/15) |
| Q-1, W = 4 | `pass`, every gate true, the same family counts |
| Dense, W = 4 | `pass`, every gate true (168 days; owner families fits 5/5, model dates 350/350, owner-days 840/840, cache owner-days 850/850, refusals 15/15) |
| Dense, W = 1 | `pass`, every gate true, the same family counts |
| Dense, base commit `fce3572e` (same machine, before the changes) | `pass`, every gate true |
| Dense rows, build commit (W = 4) against the base commit | every analytics_v2 family equal row for row, apart from run ids and stamps: owner-day 850, cache bands 22,230, fits 5, model dates 346, published heads 168 (payloads equal), preview 1, run refusals and publication equal |

### Timings

The machine was shared with other agents (load average 5 to 10), so runs at
different times are not comparable: the inline dense rehearsal of the build commit
took 941 s and 860 s under a load near 10, against the base's 781 s and 765 s
under about 5, with every phase (including the unchanged kernels) slower. The
deltas below therefore come from **pairs run at the same time on the same
machine**: the base commit's dist and the build commit's dist refreshing their own
kept dense imports concurrently (full recompute, same clock), and the two Q-1
rehearsals concurrently.

| Pair (concurrent) | Base `fce3572e`, inline | Build commit `febbae7f` | Delta |
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

### Merged tree (`387f6567`; rows marked 0068 re-ran on `2959668b`)

Local. PostgreSQL 17 fan-out cluster, port 55433, private socket.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (apps/worker) | rc 0 |
| `npm run analytics-v2:check` (Node 22.16.0) | 15 files, 165/165 (new: `exclusions.spec.ts`, `kernel.spec.ts`) |
| PostgreSQL specs: `analytics-v2-refresh`, `analytics-v2-occurrence-source`, `analytics-v2-community-daily-route`, `analytics-v2-interim-public-read`, `online-erasure-absence`, `staged-migrations-harness`, `postgres-admin-console` (`PG_TEST_DATABASE=kcore_a_spec`) | 117/117; 0068: 117/117 |
| `npm run postgres:domain:check` (`PG_TEST_DATABASE=kcore_a_spec`) | vitest 16 files, 111 pass, 1 skipped; node 428: 426 pass, 1 skipped, 1 fail. The failure is `postgres-origin-fastpath.spec.mjs` (e), which pins the default database name `postgres` in a refusal it builds from `PG_TEST_DATABASE`; rerun with `PG_TEST_DATABASE=postgres`, 1/1. An environment choice, not a product failure |
| `cloud-run` `npm run check` (Node 26.2.0) | rc 0, 435 pass, 5 skipped (0068: the same) (includes the pool check, `analytics-refresh-read.check.mjs`, the build with the Worker entry and kernel identity, and the build-context check) |
| `npm run gcp:ops:infra:check` | 206/206 |
| `npm run gcp:fastpath:scripts-check` | rc 0, 84 pass, 3 skipped (the kernel-registry check 5/5) |
| `npm run gcp:production-tooling:local-check` | rc 0, 349 pass, 5 skipped |
| `npm run scripts:check` | 1,084/1,084 (25 runs) |
| `npm run postgres:migrations:check` | rc 0, 13/13 (0068: rc 0); kernel-registry check 0068: 5/5 |
| `node scripts/ci-postgres-suite.mjs --plan` | failures [] |
| `test/hosted-backend-workflow.test.js` | 20/20 |
| Q-1 (W = 1 and 4) and dense (W = 1) rehearsals | `pass` on both merges (above) |
| Root `npm run architecture:check` | passed (959 production files, 4,114 imports, 0 debt edges) |
| Root `npm run test:preflight` | rc 0, 20/20 |

### Build commit (`febbae7f`)

| Gate | Result |
|---|---|
| `npm run analytics-v2:check` | 13 files, 155/155 |
| The affected PostgreSQL specs | 105/105; `postgres-admin-console` 10/10 |
| `npm run postgres:domain:check` | rc 0 (default database): vitest 83 pass, 1 skipped; node 402 pass, 1 skipped |
| `cloud-run` `npm run check` | rc 0: 318 pass, 1 skipped |
| `gcp:ops:infra:check`, `gcp:fastpath:scripts-check`, `gcp:production-tooling:local-check`, `scripts:check` | 197/197; 82 pass, 3 skipped; 316 pass, 5 skipped; 1,084/1,084 |
| Q-1 and dense rehearsals (W = 1 and 4), reader A/B | above |

Not run, on either tree: the EDGE_E2E golden spec (`edge-origin-e2e.spec.mjs`
S9, about 40 minutes; its rehearsal call passes every staged primary file and
was only syntax-checked), the dense rehearsal at W = 4 after the review round
(the production profile is inline; the build commit's W = 4 dense run passed),
root `npm test`, the Worker's `product:worker:check`, and a Docker build.

## Review round (`b325fc91`)

| Finding | Disposition |
|---|---|
| 1 (high) N-EXCL applied to no output | Fixed: D-PT4X's per-day read contract is applied (section N-EXCL); a declared difference from d43c8f92 whenever production holds an active row |
| 2 (medium) the closure left out community, compute, reader and codec modules | Fixed: the closure is every module that decides a stored value (section K-STAMP), with a mutation check |
| 3 (medium) `--workers=4` in production before MEAS-3 | Fixed: production inline at 12,288 MiB; `dense-workers` is the MEAS-3 profile |
| 4 (low) closure inputs under-listed | Fixed: listed above; the check and `build.mjs --kernel-closure` print them |
| 5 (low) the cloud v1.2 figure omitted | Fixed: section K-PGSTAT; the local plan-cache gain is not a cloud claim |
| 6 (low) the backfill claimed kernel 1 for earlier rows | Fixed: earlier rows are unattributed (NULL, NOT VALID CHECK) |
| 7 (low) placeholder 0066 collided; not rebased | Fixed: `0911_analytics_v2_run_stamps.sql`; merged `112d27cc`; rehearsals re-run with the exclusions table present |
| 8 (low) no negative tests for the registry and named statements | Fixed: `kernel.spec.ts`, `analytics-refresh-read.check.mjs` |
| 9 (low) K-STAMP before K-VENDOR undisclosed | Disclosed (section K-STAMP) |

The round also found that the exclusion read accepted negative or
inconsistent counts; it now refuses them (`ANALYTICS_V2_REFRESH_EXCLUSIONS_INVALID`).

## Not covered

- Nothing ran on Cloud Run or Cloud SQL. The cloud half of K-PGSTAT (a
  refresh of an image with this ledger, pg_stat_statements reset before and
  read after, on the test project and the staging plane's dedicated
  instance) is approved but not run here; it decides whether the cloud's
  unattributed read time is client decode or round trips.
- The cloud v1.2 expansion execution (about 123 ms a call) is not addressed;
  it is the next K-READ target.
- W(o) is advisory until K-INCR's mutation proofs through the real intake
  paths; F(o,d) is proven against the reader on the direct-seed fixture only.
- The intra-owner split (K-PAR analysis blocks) is not built; on the dense
  corpus one owner is the critical path. Compute Workers are not in the
  production profile until MEAS-3.
- No corpus holds an exclusion row; the exclusion path is proven by the unit
  and PG17 specs only. The first production run after cutover reads the
  imported table; if it holds any row its digest differs from "none" and
  every published day is requeued once (unchanged days keep their revision).
- The staged migration is numbered 0911 as a placeholder; the integrator
  numbers it.
