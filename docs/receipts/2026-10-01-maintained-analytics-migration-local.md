---
title: Maintained analytics populated local migration rehearsal
date: 2026-10-01
type: receipt
status: local-verified
---

# Maintained analytics populated local migration rehearsal

Point-in-time local D1 evidence for the H06 migration and recovery portion of
[the analytics redesign plan](../plans/2026-09-28-analytics-redesign.md), recorded
on 2026-10-01. The original behavioral result, whitespace checkpoint and a
later exact-source rerun are recorded separately below.
The integration owner and remaining work are recorded
in [the execution ledger](../plans/2026-09-30-maintained-analytics-framework.md).
This receipt covers the uncommitted `codex/maintained-analytics-framework`
candidate based on `f056940fefabed0c7f0e88353cf54845b077f0c8`, using Node.js
26.2.0 on macOS arm64, Vitest 4.1.11 and local Miniflare D1. It establishes no
online qualification, full Worker gate, deployment, production migration,
activation, convergence, throughput, performance multiplier or release result.

## Executed scope

The new [migration suite](../../apps/worker/test/maintained-analytics-migration-rehearsal.spec.ts)
uses the existing synthetic corpus and `applyD1Migrations` transaction/ledger
mechanism. It upgrades analytics prefix **0033 to 0047** and source ingestion
isolation prefix **0013 to 0016**: 14 analytics and three source migrations.
The predecessor is the complete locally reviewed prefix, not an observed
remote ledger. No live records, resources or credentials were read or changed.

The populated fixture has 14 calendar dates, two requested graph dates, mixed
v1/v1.1/v1.2 overlap, sparse quantities, corrections and a second independent
owner. Genuine ordered delivery creates target authority, applied-event
receipts and the source cursor. Native entrypoints complete one daily
publication, a historical model publication and a non-null graph preview,
including fits/model calculations for the complete eligible fixture cohort.

The assertions establish:

- Every predecessor table's original columns, row count and sorted row digest
  remain equal after every forward analytics step. Binary values participate
  in the hashes. The source fixture has at least 16 populated tables; analytics
  has at least six. Exact reviewed provider-owned metadata is excluded through
  the existing provider-schema predicate; the migration ledger is checked
  separately for the exact appended names and order.
- Native daily and graph preview readbacks remain exactly equal throughout the
  upgrade, alongside the stored historical model publication, authority,
  delivery receipts and checkpoints. Existing foreign keys remain valid.
  Table-scoped `quick_check` returns `ok` for every application table.
- Each of the 17 pending migrations is executed with a synthetic late failing
  statement before ledger commit. Actual D1 batch rollback preserves the
  complete prior table snapshot, schema digest and ledger. Retrying the exact
  unmodified migration succeeds. The retry fixture is populated; a genuine
  native-derived canonical page is also present before migrations 0045–0047.
- A committed 0034 migration whose response is deliberately lost is reconciled
  through the existing ledger. Retry performs no second migration batch, leaves
  its schema/data unchanged and records the migration exactly once. Replaying
  the complete successful 17-migration suffix changes no table rows.
- The composed pipeline refuses every intermediate analytics prefix, the source
  predecessor, missing 0046, missing 0047 and a missing graph safety trigger
  before coverage, admission or claims. The effects producer independently
  refuses missing 0046 without creating an absence proof or acknowledging a
  source range. Missing source/analytics replay guards withhold physical erasure
  proof. None of these refusals converts missing schema to an empty result.
- Switching all three feature controls to disabled and using the candidate's
  native serving entrypoints preserves accepted daily/model/preview output and
  every new canonical/partition row. The migration ledger retains 0047. This
  qualifies the local serving-control seam, not a deployed binary rollback.

## Focused validation

Worker commands were run from `apps/worker`; docs/preflight commands used the
repository root. The pnpm launch override disables automatic dependency repair
for that invocation. Initial default launches attempted installation and refused
without a TTY; no dependency tree or lockfile was changed by this rehearsal.

| Command | Result |
| --- | --- |
| `./node_modules/.bin/vitest run test/maintained-analytics-migration-rehearsal.spec.ts` | 8/8 passed; 10.02 seconds; final run at 03:42:09 America/New_York |
| `./node_modules/.bin/vitest run test/typed-evidence-restore.spec.ts -t 'typed snapshot preserves dictionary ids, active correction facts and source authority across restart'` | Selected existing P9 case passed; one unrelated case excluded by the name filter; 13.34 seconds; final run at 03:42:10 America/New_York |
| `./node_modules/.bin/tsc --noEmit` | Passed after the final rehearsal additions |
| `pnpm --config.verify-deps-before-run=false run docs:check` | Passed documentation governance |
| `pnpm --config.verify-deps-before-run=false run test:preflight` | Integration owner reported a passing post-whitespace run on 2026-10-01: 20 tests, documentation governance (291 Markdown / 1,178 source/config files), whitespace and root layout |

The existing P9 case separately proves lost promotion acknowledgement,
resumed frozen installation, exact authority/correction/typed evidence,
foreign keys, idempotent finalization and independent deletion replay before
serving. A missing maintained erasure replay trigger refuses replay and leaves
the restored source unservable until the guard is restored and replay completes.

The first composed-runtime regression failed on the earlier candidate:
analytics prefix 0045/source 0016 returned `idle / complete` without 0046.
The integration owner added 0046/0047 capability guards and propagation of an
unavailable effects producer. The unchanged refusal assertion passes on the
final candidate. Earlier failures in the new test harness involved the existing
32-step contract, exact provider metadata exclusion and constructor preservation;
those were corrected in the test only. No test was skipped or weakened to clear
a production failure.

D1 forbids `PRAGMA integrity_check` here, and database-wide source `quick_check`
returned `SQLITE_NOMEM` even for this small fixture. The passing bounded checks
cover each application table separately plus database-wide foreign-key checks
and retained-row/schema evidence. They do not claim a successful database-wide
integrity scan. The final runs also emitted existing missing envelope key and
oauth4webapi sourcemap warnings; these synthetic tests do not require envelope
keys.

## Snapshot fingerprints

Pending SQL inventory SHA-256: `1f411ffcc255f8c710405c6d5c7eb89620085228c34b7d7f1bcbf7ae99b4ca5c`.
Executed source/test scope SHA-256: `6d5ba681680cb4fd9709b9873cd12d4c745e631e045f21bc444eb3482fa55f80` (234 files).
The latter scope is every file under `apps/worker/src`, these 17 SQL files, the
shared corpus fixture and the two named test files. Each fingerprint hashes
UTF-8 compact JSON of the sorted `{path, sha256}` list, with object keys sorted.
It is a byte snapshot, not a clean-tree or full-bundle qualification. Later
behavioral code or migration edits require a new rehearsal against their exact
bytes. The validation times and executed fingerprint above remain point-in-time
evidence for the tested bytes.

### Whitespace-only checkpoint

At **2026-10-01 07:55:11 UTC**, the same 234-file scope hashes to
`077856e6875c1d2e95b801853cb422b60cad026b975b69ac273240df275cbc22`.
The 17-migration inventory hash remains unchanged. The integration owner removed
exactly one trailing LF byte from `apps/worker/src/storage-erasure-artifacts.ts`;
the current file hashes to
`aa4eff14790f6174ffa013acce50fdaa3541ddd78b45b28a448003c259b1565d`.
Reconstructing that single removed byte restores the exact executed source/test
scope hash above, establishing that all other scoped bytes are unchanged. This
formatting repair does not change behavior. No migration suite or typecheck was
repeated solely for it; the original execution times and results are preserved.

After this repair, the integration owner separately reported that root preflight
passed: 20 tests, documentation governance (291 Markdown and 1,178 source/config
files), whitespace and root layout. That result is a post-whitespace preflight
observation; it does not relabel the original migration-suite execution scope or
qualify later behavioral changes.

| Pending SQL | SHA-256 |
| --- | --- |
| `apps/worker/analytics-migrations/0034_shared_preparation_work.sql` | `4ec8ef417424d03d37fa0eab76c1cbae7bd44c07e06e3a3e5b836c220b0db5d4` |
| `apps/worker/analytics-migrations/0035_effective_dependency_summaries.sql` | `3625beb41b0dcd43f1387c914f197501f4af4c3c05d3fa4e27ac7ce8281cc20c` |
| `apps/worker/analytics-migrations/0036_canonical_analytics_facts.sql` | `adb62fc7eaec89025a68714073bfd9093904a8a12baa6b39a2e3931f80bf4b60` |
| `apps/worker/analytics-migrations/0037_canonical_feature_contributions.sql` | `5cbcb05d7a6bfdb328fe16581d563f7ac4612f5ee65ff28798b83dfd14f0ac42` |
| `apps/worker/analytics-migrations/0038_analytics_partition_work.sql` | `1f7017ea3a01e5b25be2cb0cb4cc39a9d01285df3933837545d720e5c13170c1` |
| `apps/worker/analytics-migrations/0039_canonical_rolling_inputs.sql` | `830fa8f6263dc81211e921c5ffd972f171c1077742a5c61a325183a9c3465462` |
| `apps/worker/analytics-migrations/0040_canonical_cache_pairs.sql` | `a12c517222b6c0d579a742433a85d5c01d203adb580f35fe8037f66c67bc50b5` |
| `apps/worker/analytics-migrations/0041_canonical_publication_closure.sql` | `bc09603798a3e904e972349b5e7d00fe8e0729711cada2dfed31cb57fe1b35a7` |
| `apps/worker/analytics-migrations/0042_terminal_replay_coverage.sql` | `63b39f8af7c10e646e5e8187d2d0b79c18cd15970794855353399177bd26f2ad` |
| `apps/worker/analytics-migrations/0043_analytics_work_capacity.sql` | `1bf489889f27f0c0071f2e4425439398ce57970205543786204b1450358157b8` |
| `apps/worker/analytics-migrations/0044_canonical_quota_identity.sql` | `73f3c188d209156c947a3b6babcc8acd0ddd40adb69a829c2e49544a4e17d05c` |
| `apps/worker/analytics-migrations/0045_maintained_output_work.sql` | `4e99d411431a915ce1793f35061f539e601c4c206d473302f70a0c69278dbbc3` |
| `apps/worker/analytics-migrations/0046_source_empty_outcomes.sql` | `99f0fefad8db364875afdba743fa7296940a3903662046ed80af4cc49334208b` |
| `apps/worker/analytics-migrations/0047_analytics_cleanup_cadence.sql` | `f7434285a02addd9497f44e870c2f635321475b93ec5f8b1e2660fdb06ffe3d9` |
| `apps/worker/ingestion-isolation-migrations/0014_effective_dependency_mutations.sql` | `846dac19c7759cd8924eeb0632787c85d7d231f8f357ca5fcbf999ac3ab5970a` |
| `apps/worker/ingestion-isolation-migrations/0015_effective_selective_dependencies.sql` | `f13862cca051ff88e4f9e67363b131483311ad085cf4bc8d7c006506c729706a` |
| `apps/worker/ingestion-isolation-migrations/0016_terminal_replay_coverage.sql` | `6b012125f4f69e4c035c65d22ee86b63c9c71d7d9833078aac3c2ad7d5bf2de9` |


## Latest source and migration rerun — 12:43 UTC

The integration owner reran the populated rehearsal and both typed-restore
cases after the ordinary lifecycle repairs, publication admission guard and
producer coverage index. The first run passed nine of ten migration/restore
cases and failed the existing predecessor-source preservation assertion: the
new early retirement opportunity wrote target cadence bookkeeping before
refusing the incomplete source schema. The failure is retained in
`/private/tmp/p0-maintained-migration-latest.json`; the assertion was unchanged.

The runtime now verifies selective source capabilities before any retirement
or bridge write. It still checks source restore readiness first and retains
the coverage producer's own fresh proof. Retirement continues to receive a
bounded turn when both source and target migrations are complete.

The focused combined command passed **17/17** on the corrected source:

```sh
./node_modules/.bin/vitest run \
  test/maintained-analytics-migration-rehearsal.spec.ts \
  test/typed-evidence-restore.spec.ts \
  test/storage-analytics-canonical-runtime.spec.ts \
  test/storage-analytics-work-retirement.spec.ts \
  test/storage-analytics-publication-admission.spec.ts
```

That is eight populated migration cases, two typed-restore cases, two composed
runtime cases, three ordinary retirement cases and two publication admission
cases. The JSON result is
`/private/tmp/p0-maintained-source-refusal-recheck.json`. The installed Worker
TypeScript compiler passed after the source repair. No complete owning gate or
external operation ran.

The pending17-file compact-JSON inventory hash is
`8fd1b9a3f8c3bd41222d7904f75cb254b20382ddf2caaf000a9948c43de63db7`. The same234-file source/test scope defined above is
`1c58376a17a66644bcc3d585c0f3306a939bb0cab2e5eab1e9d1651c873e0407`. This later receipt does not relabel the original hashes.
Changed SQL bytes relative to the original rehearsal are:

| Pending SQL | Latest SHA-256 |
| --- | --- |
| `apps/worker/analytics-migrations/0038_analytics_partition_work.sql` | `83723de995dc8560f452a4ed1721521fa88e601a84d657d31d0d7ca8eda0a58b` |
| `apps/worker/analytics-migrations/0041_canonical_publication_closure.sql` | `6904c246643994a7680e96628316cb22b2014109487fb83cb404f6f8ed278319` |
| `apps/worker/analytics-migrations/0043_analytics_work_capacity.sql` | `82b6ee9e743d4545a8077145416ce87b5f805bcec824d31fc3f27a771570042a` |

The new0038 index selects producer work by source, stage, revision and partition;
0041 and0043 contain the locally reviewed publication/capacity refinements.
All17 current migration bodies participated in the populated rollback,
interruption and ledger replay checks. The current source remains uncommitted
and under integration; any later behavioral change requires its affected
checks and the final frozen rehearsal. Hosted D1 batch/time limits and exact
code/schema/control ordering remain distinct online qualification gates.

## Remaining gates

H06 remains open. The EOF formatting repair and source fingerprint checkpoint
and post-whitespace root preflight are complete. The integration owner owns
combined source qualification. The separately maintained local forward operator now enumerates this17-step
suffix and has its own synthetic transport/atomic-batch rehearsal in the
[forward operator receipt](./2026-10-01-maintained-analytics-forward-local.md).
That operator result and this native test migration mechanism are separate
evidence. Packaging and independently reviewing their final exact payloads,
source/target reconciliation, ordered code/schema/activation and containment
remain required before hosted qualification.

A deterministic batch abort is not an abrupt process interruption. The separate
P9 protocol test covers resumable promotion and response loss, not hosted
execution time or provider terminal status. No destructive downgrade, schema
version relabel, source wipe, remote migration or deployment was performed.
The frozen combined Worker gate, equal-output whole-workload comparisons,
isolated online qualification and separately authorized production cutover
remain outside this receipt.
