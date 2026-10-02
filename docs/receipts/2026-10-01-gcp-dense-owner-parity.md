---
title: GCP fast-path dense-owner parity and per-date model publication
date: 2026-10-01
type: receipt
status: snapshot
---

# GCP fast-path dense-owner parity and per-date model publication

This is a 2026-10-01 receipt (runs from 19:15 EDT on 2026-10-01 to 00:50 EDT
on 2026-10-02) for branch `claude/gcp-fastpath-dense`, built on
`claude/gcp-fastpath-final` `7ef0e144`. It records **local, synthetic**
evidence only: one macOS arm64 workstation (18 cores, 128 GiB), a local
PostgreSQL 17 cluster on a private Unix socket, the refresh under Node.js
22.16.0 (the image runtime) and the importers under Node.js 26.2.0. Every
corpus is the content-free synthetic corpus of the d43c8f92 production-code
oracles. Nothing was pushed, deployed or seeded; no GCP or Cloudflare resource
was read or written; no production data was read. It does not qualify a Cloud
Run image, the GCP test project, the edge, production volumes or a real
owner.

## What landed

| Commit | Change |
|---|---|
| `0fee435d` | Merge of `claude/gcp-fp-caps` (`b2b52c01`, the cap raise and native path; [receipt](./2026-10-01-gcp-fastpath-caps.md)) |
| `57df6927` | Merge of `claude/gcp-fp-dense-oracle` (`2df12565`, the dense production-code golden; [receipt](./2026-10-01-gcp-fastpath-dense-oracle.md)) |
| `95ff08f0` | The parity compare accepts only the oracle's withheld model dates (OD-12); the rehearsal gains the dense mode, owner references, an external pinned dump, a refresh timeout, schema reuse, and fails a `LOCK_HELD` refresh |
| `c0600bc2` | The v1.2 occurrence expansion's cost follows the batch, not the owner |
| `77203a3d` | The refresh receipt reports the process's peak resident set (`memory.peakRssMiB`) |
| `11f1a0b8` | The seed and the test deploy select the dense corpus (`--corpus=dense`, `--dump`) and size the refresh Job (`--refresh-profile`) |
| `e8b00f28` | Decision D7, this receipt, the plan and dated notes on the receipts that called OD-12 open |
| review fixes (2026-10-02) | The verified findings of the branch review; see [Review fixes](#review-fixes-2026-10-02) |

No vendored file changed (`vendor:kernels:check` 10/10). No migration was
added.

## Per-date model publication (OD-12)

The owner accepted per-date model publication in chat on 2026-10-01. It is now
recorded as D7 in the
[append-only contributions decision](../decisions/2026-09-26-append-only-contributions.md#d7-model-dates-publish-per-date-with-refused-owners-counted).

`scripts/analytics-v2-parity-compare.mjs` (report `analytics-v2-parity-report-v2`)
holds model dates to that decision and to nothing wider:

- A date the golden manifest lists in `modelPublications.missing` may be
  published by the fast path, and only by being published: the oracle side
  must be unpublished (`allowanceBreakdowns.days[].models` empty, the date
  absent from `preview.models.days`). Those publications are counted in the
  new family `model-days-per-date`, which is expected.
- Every model date both sides publish stays in `model-days` and must be
  byte-equal. A published date outside the withheld set, a dropped date, a
  `null` model list, a changed `combined` or `byPlanType` on a withheld date,
  or any other field fails.
- The exact values on the accepted dates are held separately to the oracle's
  per-date expectation (`--per-date-expected`), which d43c8f92's own
  publishers compute over its per-owner references.
- Seven new unit cases in `analytics-v2-parity-compare.check.mjs` pin each
  rule (11/11).

(Corrected on 2026-10-02. At `e8b00f28` the compare accepted any non-empty
value on an accepted date, and neither the plan's command nor
`npm run gcp:fastpath:rehearsal` passed `--per-date-expected`, so the 21
accepted publications in the table below were held to their values only by
the separate per-date run. The compare now requires those values to equal the
per-date expectation and fails closed without one; see
[Review fixes](#review-fixes-2026-10-02).)

The Q-1 rehearsal now exits 0. At `11f1a0b8`, with the plan's command
(`--golden apps/worker/analytics-v2-test/golden`, database
`tibotattle_q1_parity` on port 55433):

| Family | Compared | Equal | Differences |
|---|---:|---:|---:|
| envelope, daily-days | 1 each | 1 each | 0 |
| daily-totals, daily-cells, spend, daily-other | 168 each | 168 each | 0 |
| allowance-breakdowns | 71 | 71 | 0 |
| model-days | 120 | 120 | 0 |
| model-days-per-date (accepted) | 21 | 0 | 21: the 14 withheld dates 2026-07-24 to 08-06 in the preview, and model values on the 7 allowance days 2026-07-29 to 08-04 |
| preview, cache-structure | 1 each | 1 each | 0 |
| cache-counts (informational) | 1 | 0 | 395 |

Status `pass`, every gate true, second run 0 new revisions, 168 days
published, 2026-04-17/18 blocked, 15 refusals. The served response file
(`04f7a277…`) and stored preview (`b3722cc9…`) are byte-identical to
`7ef0e144`'s and `b2b52c01`'s. With
`--per-date-expected apps/worker/analytics-v2-test/golden-q1-node/per-date-expected.json
--owner-reference apps/worker/analytics-v2-test/golden-q1-node` the run also
passes: the preview and allowance breakdowns equal the per-date expectation
exactly, and every owner family (defined below) is equal: fits 4/4, model
dates 280/280, owner-days 672/672, cache owner-days 680/680, refusals 15/15.

## Dense-owner parity

### Method

```sh
PG_TEST_DATABASE=tibotattle_dense_parity \
PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket PG_TEST_PORT=55433 \
  node --max-old-space-size=8192 apps/worker/scripts/gcp-fastpath-rehearsal.mjs \
  --golden apps/worker/analytics-v2-test/golden-dense --dense \
  --dump <dense oracle work dir>/dump/usage-monitor-db.json --refresh-timeout-minutes 360
```

- The dump is the dense oracle's (163,950,762 bytes); the rehearsal refuses it
  unless its sha256 equals the golden manifest's `sourceDump.jsonSha256`
  (`1d0bef8e…`). It is rebuilt into the sealed SQLite (`cb04f411…`, the same
  bytes as the oracle's) and loaded through the importer chain: T-1, the
  typed-legacy transfer, the legacy transport, T-2 (364,111 v1.2 records;
  its effective-reader verification matched all 364,111), the event sources,
  usage corrections and the ingestion journal. The owner roster (5 of 5),
  public source owners and owner revisions equal the source.
- `analytics-refresh` runs at the golden's clock (`2026-10-01T12:46:00Z`) with
  the raised caps and the default resources (budget 4,608 MiB, heap
  6,144 MiB). The fits and model computations use each window's own
  `fixedNow`, as production's do, so the direct references taken at 12:00Z
  apply.
- Served read: the dense golden's own read was captured before production's
  graph lane published, so its daily families are held to
  `community-daily-response.json` and its allowance and preview families to
  `per-date-expected.json`, with production's published read state
  (`ready`, `confirmed`).
- Owner families (`scripts/analytics-v2-owner-parity-compare.mjs`): every
  stored row against the oracle's direct native references
  (`owner-results.json`, production's `advanceStorageEffectiveAnalysis` with
  no prepared inputs) and its per-owner-day cache build (`cache-reference.json`).
  Exact comparison, objects key-sorted, numbers by value; only the
  reference's run-specific `inputFingerprint` is dropped, because
  analytics_v2 never stores it. Six unit cases pin the rules.
- Refusals: the set of (owner, day, family) refusals must equal the
  reference failures, with closed reasons per family.

Owner e is the dense owner: 360,462 occurrences (294,198 usage, 62,100
quota, 4,164 session), its heaviest day 39,435 occurrences (2026-09-29), its
current fits window about 230,000 usage rows. Its days over 20,000
occurrences, its quota day over the quota preparation bound (2026-04-15,
13,854 quota rows) and its windows over 120,000 usage rows are exactly where
the vendored shared reducers refuse by construction, so the fast path
computed them on `native-path.ts`. The references are production's native
computation for every window. The oracle's routing record shows production's
shared features refusing 67 of e's 70 windows (66 over the 8 MiB window
limit, 1 on a refused day); the other 3 were still waiting on unprepared
days at capture.

### Results

Identical in all four dense runs: `dense1` (fresh import, the merged
reader), `dense2` (the same import, the rewritten reader), the minimum-heap
probe below and `dense-final` (fresh import at `11f1a0b8`).

| Family | Compared | Equal |
|---|---:|---:|
| Served: envelope, daily-days, cache-structure | 1 each | 1 each |
| Served: daily-totals, daily-cells, spend, daily-other | 168 each | 168 each |
| Served: allowance-breakdowns (against the per-date expectation) | 71 | 71 |
| Served: model-days (against the per-date expectation) | 141 | 141 |
| Served: preview | 1 | 1 |
| Per-date expectation: preview and allowanceBreakdowns | 2 | 2 |
| Owner fits for 2026-10-01 | 5 | 5 |
| Owner model dates (70 per owner) | 350 | 350 |
| Owner-day daily values | 840 | 840 |
| Owner-day cache bands (841 built, 9 refused) | 850 | 850 |
| Refusals | 15 | 15 |

- Owner e: its fits (5 fits, all `pro`) and all 70 model compositions
  (`ready`) equal production's native computation called directly
  (`advanceStorageEffectiveAnalysis` without prepared inputs, outside the
  Worker's budget), and it has no refusal in any family. Every e owner-day's
  daily values and cache bands equal production's. (Qualified on 2026-10-02:
  for owner e that direct call is the only reference. The golden holds no
  scheduled (Tier N) or budget-sliced checkpointed (Tier F) result for e and
  no published model date (`referenceAgreement.e`: 0 compared each;
  `forcedNative` null; graph progress for e: no fits, 0 model dates), so the
  equality does not cover production's checkpoint persistence, its
  per-invocation meter, or whether its model blocks
  (`STORAGE_ANALYTICS_MODEL_BLOCKS`) would prepare e's days and give the
  same compositions. The dense-oracle receipt's claim boundary states the
  same; prepared-equals-native is established on the small owners only.)
- Owner a's four conflict-window model dates (2026-07-24 to 07-27), which
  production fails with `STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE`, are
  `model:incomplete_window` refusals here; its conflict days 2026-04-17/18 are
  `daily:source_conflict_or_order`; and the nine cache owner-days production
  refuses as `usage_row_refused` (2026-04-17 to 04-25) are 2
  `incomplete_cache_day` and 7 `incomplete_cache_lookback`. Nothing else is
  refused.
- Ten owner-days are unreferenced by construction: every owner's 2026-04-17
  and 04-18, which production's daily lane never completes because owner a's
  crossed-day conflict blocks those community days. The fast path also
  blocks both days (no publication). (Clarified on 2026-10-02: owner a's two
  are checked as its daily refusals; the other eight, owners b to e on those
  days, have no production value, so their stored daily values are not
  compared. The owner-parity report now lists them as
  `uncomparedOwnerDays`.)
- The published read: 168 days, 2026-04-17/18 blocked, second run 0 new
  revisions. Served `cacheRetention` counts differ from the replay's read
  (543 leaf differences) and from the settled read (536); production's cache
  lane never reaches most owner-days on this corpus (dense-oracle finding 1),
  so the per-owner-day cache family above is the exact cache basis.
- `dense2`'s and `dense-final`'s stored owner rows equal `dense1`'s apart
  from their run ids, and the served response and stored preview are
  byte-identical in all three (response file `36316eca…`, preview
  `4158041c…`).

No difference needed a fix: the cap-raise branch already matched
production's native path on this corpus.

## A quadratic read, fixed

`dense1`'s refresh spent 2,731 s of its 3,260 s reading owner e. Each
200-occurrence v1.2 expansion batch took about 1.7 s. `EXPLAIN ANALYZE` on
the imported schema (statistics present, `ANALYZE` by autovacuum) showed why:
no index leads with `occurrence_id`, and the planner's estimate of the
chunk-completeness chain (the correlated `record_count` check and the
participant joins) collapses to one row, so it walked all 294,198 of the
owner's usage records and rejected 58,839,400 joined rows per batch. The read
was therefore quadratic in owner size. Production's D1 reader has the same
shape (dense-oracle finding "The native effective path costs O(owner
records) per page").

`c0600bc2` fences the participant's ready manifests, probes each once on the
existing unique `(manifest_id, stream, occurrence_id)` key for the batch's
ids, and checks each matched record against the same joins in a fenced
`LATERAL`. The manifest filter is implied by the joins it precedes, so the
rows, their multiplicity and the grouping are unchanged. Evidence:

- The captured batch: 1,685 ms to 15 ms, the same 200 rows (digest equal).
- An A/B of the committed and rewritten readers in one read-only snapshot:
  42 comparisons, 128,871 occurrences, all byte-identical. Q-1 schema: every
  owner and stream over 2026-04-01 to 10-01 (12 comparisons). Dense schema:
  the same for owners a to d, and owner e on its Q, L, S, M, H and X days with
  their neighbours (18 comparisons, 99,209 occurrences: 720.6 s with the old
  reader, 35.4 s with the new).
- End to end, `dense2` reproduced `dense1` exactly (above), and the PostgreSQL
  specs pass (`postgres:domain:check` below).

The legacy v1/v1.1 expansion has a similar join and was not measured at
volume: the corpus has no dense legacy owner.

## Measurement (Node.js 22.16.0)

### Phases

Refresh phases are the job's own receipt timings. The importers run before
the refresh, under Node.js 26.2.0. `dense1` and `dense2` shared the
workstation with this work's other gates and probes; none ran during
`dense-final`'s refreshes.

| Phase | dense1 (merged reader) | dense2 (rewritten) | dense-final (`11f1a0b8`) |
|---|---:|---:|---:|
| Sealed SQLite rebuild | 4.1 s | (reused) | 3.9 s |
| Importers except T-2 | 3.8 s | (reused) | 3.7 s |
| T-2 v1.2 transfer and its reader verification | 3,007 s | (reused) | 2,904 s |
| Refresh wall | 3,260 s | 675 s | 657 s |
| read (counts, journal, owner loads) | 2,731 s | 134 s | 134 s |
| prepare | 114.5 s | 113.4 s | 107.5 s |
| scalar fits | 16.0 s | 17.9 s | 15.1 s |
| model (70 dates per owner) | 396.8 s | 409.4 s | 399.3 s |
| cache, community, write | under 1 s | under 1 s | under 1 s |
| Second refresh wall | 3,383 s | 660 s | 715 s |

The model phase now dominates: about 5.6 s per owner-e date over windows of
up to about 230,000 usage rows, single-threaded. The T-2 importer's reader
verification is the remaining quadratic cost (finding 2).

### Memory

| Run | Heap limit | Budget | Owner e estimate | Sampled heap peak | Peak RSS |
|---|---:|---:|---:|---:|---:|
| dense1, first / second refresh | 6,192 MiB | 4,608 MiB | 1,517 MiB | 1,316 / 2,152 MiB | 1,683 / 2,408 MiB |
| dense2, first / second refresh | 6,192 MiB | 4,608 MiB | 1,517 MiB | 2,137 / 1,819 MiB | 2,511 / 2,188 MiB |
| Minimum-heap probe | 2,148 MiB | 1,536 MiB | 1,517 MiB | 1,308 MiB | 1,891 MiB (`/usr/bin/time`: 1,982,316,544 bytes) |
| dense-final, first / second refresh | 6,192 MiB | 4,608 MiB | 1,517 MiB | 2,160 / 2,149 MiB | 2,529 / 2,436 MiB |

- The minimum-heap probe ran the refresh directly on `dense2`'s schema with
  `ANALYTICS_V2_MEMORY_BUDGET_MIB=1536` (the smallest budget that admits
  owner e) and `ANALYTICS_V2_READ_CHUNK_OCCURRENCES=10000`, so the job's
  start-up guard accepted a 2,100 MiB old space. It completed in 649 s
  (579.6 s user CPU) with every owner family above equal. The memory model is
  therefore sufficient for this owner at its tightest admissible heap.
- Under the default 6 GiB heap the sampled heap peak exceeds the estimate
  (up to 2,160 against 1,517 MiB): V8 collects lazily when the limit is far
  away, so this is uncollected garbage, not the live set. Peak RSS ran 374 MiB
  above the estimate at the tightest heap, and 256 to 583 MiB above the
  sampled heap peak across these runs.

### Cloud Run recommendation

- **The dense corpus** fits the standard profile (2 vCPU, 8 GiB,
  `--max-old-space-size=6144`, budget 4,608 MiB, 2 h): peak RSS at most
  2.5 GiB, so more than 3x headroom, and about 11 minutes locally. Cloud SQL
  round trips will lengthen the read; the earlier test deploy read the Q-1
  corpus about 5x slower than locally.
- **The cutover** needs the dense profile (4 vCPU, 16 GiB,
  `--max-old-space-size=12288`, budget 10,752 MiB, 4 h) for the largest real
  owner (about 2.52 million records). Its estimate is roughly 4.2 GiB if
  almost all of its records predate the 170 analysis days and roughly
  10 GiB if almost all fall within them (cap-raise receipt); at the high end
  only the dense profile admits it. The 12,288 MiB old space caps the heap,
  and owner e's peak RSS ran at most about 0.6 GiB above its sampled heap
  peak, so a 16 GiB task holds the high end. Cloud Run requires 4 vCPU for
  16 GiB. Compute is single-threaded, so the extra vCPUs only serve the
  garbage collector and the driver.
- **Time** for that owner, scaled linearly from owner e's per-record costs
  (read about 0.36 ms per occurrence, prepare about 0.38 ms per analysis
  usage row, about 5.6 s per model date at 230,000-row windows): roughly one
  hour. This is an estimate, not a measurement; the 4-hour task timeout
  leaves margin for Cloud SQL latency.
- Recalibrate both on the Cloud SQL seed; every figure here is synthetic.

## Cloud measurement, prepared (dry run only)

```sh
node apps/worker/scripts/gcp-fastpath-test-deploy.mjs all --commit=HEAD --dry-run \
  --corpus=dense --dump=<dense oracle work dir>/dump/usage-monitor-db.json --out=<dir>
```

At `11f1a0b8` this printed 30 dry-run commands and ran none. The seed plan is
`run` with all 7 stages present, the dump digest matches
(`1d0bef8e…`), and refresh and origin take the seeded schema
`typed_legacy_transfer_rehearsal_target_fastpath_f199731d` at
`2026-10-01T12:46:00.000Z`. The refresh Job is deployed with the dense
profile: `--cpu=4 --memory=16Gi --task-timeout=14400s`,
`--args=--max-old-space-size=12288,dist/analytics-refresh.mjs,--mode=full,…`
and `ANALYTICS_V2_MEMORY_BUDGET_MIB=10752`. `--refresh-profile=standard`
measures the default Job instead. Running it for real needs the owner's
authorization for the test project (OD-7 covers the Q-1 seed), Node 26 on the
operator workstation and the regenerated dense dump.

## Gates

Local, on this branch's final code (`11f1a0b8`; the documentation commit
changes no code). PostgreSQL 17 on port 55433.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (apps/worker) | rc 0 |
| `npm run analytics-v2:check` | 12 files, 118/118 under Node 26.2.0 (278 s) and Node 22.16.0 (336 s) |
| `npm run vendor:kernels:check` | 10/10 |
| `npm run postgres:domain:check` (socket and TCP) | rc 0. Vitest 12 files 76/76; node:test 336: 334 pass, 0 fail, 2 skipped (ledger-authority by design; T-2's opt-in Q-1-dump case), after the reader rewrite |
| `npm run gcp:fastpath:scripts-check` (socket and TCP) | rc 0, 53/53 |
| `npm run scripts:check` | rc 0, 967/967 |
| `npm run check` in `cloud-run` (socket) | rc 0; 225 tests: 224 pass, 1 skipped (the opt-in A2 real-PostgreSQL case); all 16 build entries |
| Q-1 rehearsal | exit 0 (above) |
| Dense rehearsal | exit 0 (above) |
| Root `npm run architecture:check` | passed (919 production files, 3,911 imports, 0 debt edges) |
| Root `npm run test:preflight` | rc 0, 20/20 |
| Root `npm run docs:check` | valid (303 Markdown files, 1,610 source and config files) |

Not run: a Docker build, root `npm test` and `npm run check`, the Worker's
full `check` (Wrangler dry runs and `deploy:dry`), the default Worker Vitest
suite, and anything on GCP or Cloudflare.

## Findings

1. **Quadratic v1.2 expansion (fixed, `c0600bc2`).** See above.
2. **The T-2 importer's reader verification is quadratic too (not fixed).**
   It pages every v1.2 occurrence through its own PostgreSQL reader and took
   3,007 s here (3,379 s in the dense oracle's attempt). It runs in the GCP
   seed and the cutover import, so the real corpus needs the same treatment
   before the seal.
3. **Legacy expansion unmeasured at volume.** The v1/v1.1 expansion joins
   through indexes that also do not lead with `occurrence_id`.
4. **A refresh that loses the advisory lock reports success.** A first local
   attempt shared a database with another rehearsal's refresh, received
   `LOCK_HELD` with exit 0, and compared nothing. The rehearsal now fails
   `REHEARSAL_REFRESH_INCOMPLETE`; a deployed Job that loses the lock still
   exits 0 by design (the receipt says `LOCK_HELD`).

## Review fixes, 2026-10-02

A review of this branch at `e8b00f28` raised thirteen findings; two pairs
describe the same defect. Each was checked against the code before any
change. Local and synthetic evidence only, on the same workstation and
PostgreSQL 17 cluster.

| Finding | Verified | Disposition |
|---|---|---|
| The default rehearsal accepted any value on a withheld model date (major; reported twice) | Yes. With the committed Q-1 golden and this receipt's own `q1-final-plain` artifacts, changing the 2026-07-24 preview day to 3 participants with 0 refused, and the 2026-07-30 preview and allowance models to one invented model, left 0 unexpected differences | **Fixed.** An accepted date counts only when its value equals the oracle's per-date expectation exactly; without the expectation, or where it differs, the publication is an unexpected `model-days` difference (report `analytics-v2-parity-report-v3`, with `valuesHeldTo` and `unverifiedWithheldDates`). The expectation must be the oracle's schema, at the golden's clock, with nothing unresolved. `npm run gcp:fastpath:rehearsal`, the rehearsal's documented command and the plan's Gates command pass `golden-q1-node/per-date-expected.json`. The same mutation now fails (10 unexpected differences); the committed artifacts pass (14 dates accepted); with no expectation they fail (21 unexpected, 14 dates unverified) |
| GCP published the preview with refused owners silently left out of its fit cohort (major) | Yes. The cohort was the computed owners with fits; `d43c8f92` `publishStorageCommunityGraphPreview` defers (`cache_pending`) unless every member has a fits result, and the oracle's per-date expectation has no preview unless every owner has fits. The base comment at `7ef0e144` called this a known divergence; this branch's rewrite dropped it from the disclosure | **Fixed.** The preview is withheld (stored null, served as temporarily unavailable) whenever an effective owner has no current fit, from a kernel refusal or the memory budget. Changed expectations, pinned exactly: `compute.spec.ts` memory budget (preview null; it was a 3-owner coverage with every model date counting 4 participants and 1 refused) and `(c, day bound)` at the old bound (null; computed, non-null); the PostgreSQL memory-budget case (4 owners after the first run, null after the second). New case: a refused scalar fit withholds the preview. D7 now states it; it awaits the owner's confirmation. Non-effective owners stay outside the GCP cohort (their paths are not ported, a disclosed plan scope) |
| The batch variant bounds (40,000) let GCP compute owners production's reader refuses in every family (minor) | Yes. `telemetry-usage-effective-reader.ts` fails a page over 3,200 source variants (lines 52, 615, 951) and `telemetry-v12-effective-reader.ts` over 16,384 (91, 482); the same reader serves the graph, daily and cache lanes | **Disclosed** (below and in the cap-raise receipt). No code change: it is a D1 statement bound raised with OD-11, and it needs the owner's acceptance with the other Worker-only divergences |
| The memory estimate grows with retained history (minor) | Yes. The arithmetic reproduces: 8.43 MB of held evidence a day, about 606 MB fixed, refused after about 501 days at the default budget (about 1,265 days at the dense profile's 10,752 MiB) | **Not fixed; disclosed** (`resources.ts`, below). Loading the history before the analysis horizon in bounded segments changes the loader contract, the memory model and its pins, so it is not a cheap change; it is a remaining gate |
| The oracle publishes a model date on which every owner was refused; GCP and D7 withheld it (minor) | Yes (`oracle.mjs` 1410 to 1421 against `compute.ts`) | **Fixed by aligning GCP with the oracle**, whose source both goldens pin and which follows the owner's wording ("publish each model date"). Such a date now publishes with every member counted refused; only a date with no member is withheld. Neither corpus has such a date, so no golden changes. New `compute.spec.ts` case; D7 amended |
| Owner e's equality rests only on the direct call (minor) | Yes (golden manifest) | **Disclosed**: the owner e bullet above and the claim boundary below |
| The owner-parity compare was not fail-closed for fits, and left conflict-day values uncompared (minor) | Yes | **Fixed.** Only a `failed` fits reference stands for a production failure; an absent, stalled or size-limited one is invalid input. The eight owner-days with no production value are listed as `uncomparedOwnerDays` (report `analytics-v2-owner-parity-report-v2`). Two new unit cases |
| The day backstop did not protect the evidence digest (major) | Yes. `analyticsV2DayDigest` ran before `prepareAnalyticsV2Day` and outside its try, so a day over V8's string limit would fail the whole run | **Fixed.** A day is digested only after it prepares within the backstop; a refused day gets a refusal-marker digest, and every window through it is refused (`incomplete_window`), so the marker pins nothing. New case: a refused day whose record throws when read. On `e8b00f28` it fails the run with that error; now it is a `day_row_limit` refusal and every other owner is unchanged. The five new or changed `compute.spec.ts` cases all fail on the `e8b00f28` `compute.ts` |
| The start-up check's "cannot exhaust the heap by design" is not true (minor) | Yes. The 512 MiB reserve is fixed, while every computed owner's rows are held until the single write (`dense-final` stored about 12.1 MB of row JSON for five owners; owner e's 14,520 cache-band rows are 8.8 MB of it) | **Comment corrected; disclosed.** Per-owner writes or output accounting would change the one-transaction write; remaining gate |
| The snapshot transaction holds the primary's xmin horizon through compute (minor) | Yes (`analytics-refresh.mjs`) | **Disclosed** in the code and below |
| The v1.2 expansion rewrite (`c0600bc2`) had no negative test (minor) | Yes | **Fixed.** Opt-in fixture `v12Scope` and a PostgreSQL 17 case: one occurrence id with one eligible record and staged-manifest, incomplete-chunk and foreign-participant variants. Removing the ready-state, chunk-completeness or participant predicate from the expansion each fails the case. Not covered: the retained-authorization join, because every social capability state is retained and an accountless participant has a single v1.2 device, so the schema admits no non-retained variant beside a retained one |
| The Job has no time guard (minor) | Yes. One transaction at the end, `--max-retries=0`, timeouts 7,200 s and 14,400 s set from an extrapolation | **Disclosed**; remaining gate |

### Gates after the fixes

Local, at the review-fix commit, PostgreSQL 17 on port 55433.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (apps/worker) | rc 0 |
| `npm run analytics-v2:check` | 12 files, 121/121 under Node 26.2.0 (266 s) and Node 22.16.0 (344 s); 118 before, plus the three new `compute.spec.ts` cases |
| `npm run vendor:kernels:check` | 10/10 |
| `npm run gcp:fastpath:scripts-check` (socket and TCP) | rc 0, 58/58 |
| `npm run scripts:check` | rc 0, 967/967 |
| `npm run check` in `cloud-run` (socket) | rc 0; 225 tests: 224 pass, 1 skipped |
| `npm run postgres:domain:check` (socket and TCP) | rc 0. Vitest 12 files 76/76; node:test 337: 335 pass, 0 fail, 2 skipped (the same two). One more case than before: the v1.2 expansion's exclusions |
| Q-1 rehearsal, `npm run gcp:fastpath:rehearsal` | exit 0, `pass`: `model-days` 120/120, `model-days-per-date` 21 accepted with the values held, 14 dates, none unverified; `perDateEqual` true; second run 0 new revisions; 168 days published, 2026-04-17/18 blocked, 15 refusals. Response file `04f7a277…` and preview `b3722cc9…`, byte-identical to `e8b00f28`'s |
| The same with `--owner-reference …/golden-q1-node` | exit 0; fits 4/4, model dates 280/280, owner-days 672/672, cache owner-days 680/680, refusals 15/15; 6 uncompared owner-days |
| The rehearsal without `--per-date-expected` | exit 1, `gate_failed`: 21 unexpected `model-days` differences, 14 dates unverified |
| Dense rehearsal (fresh import, the Method command) | exit 0, `pass`, every gate true; dump `1d0bef8e…` pinned. Served families equal (model-days 141/141 against the per-date expectation, no accepted date), `perDateEqual` true; fits 5/5, model dates 350/350, owner-days 840/840, cache owner-days 850/850, refusals 15/15; 8 uncompared owner-days (b to e on 2026-04-17/18). Second run 0 new revisions. Response file `36316eca…` and preview `4158041c…`, byte-identical to `dense-final`'s, and every stored owner row equal to `dense-final`'s apart from run ids. T-2 2,895 s; refreshes 680 s and 662 s (read 140 s, prepare 115 s, model 408 s); budget 4,608 MiB, owner e estimate 1,517 MiB, sampled heap peak 1,673 / 2,157 MiB, peak RSS 2,114 / 2,560 MiB |
| Root `npm run architecture:check`, `test:preflight`, `docs:check` | passed (919 production files, 3,911 imports, 0 debt edges); rc 0, 20/20; valid (303 Markdown files, 1,610 source and config files) |

## What this does not prove

- Synthetic data on one workstation. Not Cloud SQL, Cloud Run, production
  volumes, or the largest real owner; the time and memory figures for that
  owner are extrapolations.
- The reference is production's native path computed outside the Worker's
  budget (the dense oracle's direct references). Production's lanes would
  publish these values only after its graph lane finished, which the oracle
  did not wait for, and its cache lane never reaches most owner-days here.
  This proves what production computes, not that it keeps up.
- For owner e the only reference is that direct call: no scheduled,
  checkpointed or published production result for e exists in the golden,
  and whether production's model blocks would prepare e's days with the same
  compositions is not established.
- Served cache-retention windows are not a parity basis on this corpus.
- Per-date model publication is a deliberate divergence from production's
  block withholding (D7), not parity. When an effective owner has no current
  fit, GCP withholds the preview where production would keep serving its last
  completed one.
- The divergences the cap-raise receipt lists (cache days production's
  Worker refuses or leaves unbuilt) still stand, and are wider than it said:
  production's reader fails a page over 3,200 legacy or correction variants,
  or 16,384 v1.2 variants, and that fails the graph window and the daily
  owner-day too, not only the cache day. GCP's batch bound is 40,000, so for
  such an owner it publishes daily values, fits and model dates production
  refuses. No corpus exercises this.
- Scale limits not yet engineered away, each explicit rather than silent:
  the memory estimate grows with retained history (the job holds the whole
  cache horizon of an owner at once); the heap reserve for outputs held until
  the single write is a fixed 512 MiB; and there is no time guard, so a run
  that reaches the task timeout writes nothing and repeats.
- The refresh holds its exported snapshot, and with it the Cloud SQL
  primary's xmin horizon, for the whole read and compute (657 s and 715 s
  for `dense-final`'s two runs here; about an hour, unmeasured, for the
  largest real owner), with the server's idle-in-transaction timeout off for
  that session. VACUUM cannot remove rows that die during a run, so runs
  should not be scheduled back to back on the shared primary; the task
  timeout ends a stalled run's connection.

## Remaining gates

- Owner review of D7's wording, including the preview withholding and the
  all-refused model dates added on 2026-10-02.
- Owner acceptance of the Worker-only divergences, including the reader
  variant bound.
- The cloud measurement above, on the test project, with the owner's
  authorization; then recalibrate the memory model on the Cloud SQL seed.
- Before the largest real owner's history outgrows the budget: load the days
  before the analysis horizon in bounded segments. Before the roster grows:
  account for the outputs held until the write. Before scheduling: a time
  bound per owner or run, measured on Cloud Run.
- Finding 2 before the seal; finding 3 if production holds dense legacy
  owners (OD-4).
