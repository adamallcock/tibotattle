---
title: Durable shared analytics local qualification
date: 2026-09-28
type: receipt
status: local-qualified
---

# Durable shared analytics local qualification

## Status and claim boundary

Local implementation of both requested stages is complete: durable model-date
batches adopted by the existing publisher, and durable shared features consumed
by daily activity/API value, scalar/model fits and cache continuity. The clean
candidate passed its complete owning gate at **2026-09-29 01:51:29 UTC** and
native D1 schema qualification/package review at **01:51:31 UTC**. This proves
local qualification and migration preparation; it is not online qualification,
a production performance claim or permission to change production.

Candidate `4ac0b999b68a4c6ce6974fcb6ba7f311bba173c7` is frozen in a
clean isolated qualification checkout, based on the deployed analytics revision
`75a9b7efb260b062a25a90807886b7c984670a97`. It contains the scoped Worker and
supporting documentation changes. It is not a merge of unrelated main-branch,
client, admin-history or website work. The original working tree is preserved.
The local branch is `codex/analytics-shared-qualified-local`; it has not been
pushed, merged to main or deployed.
The [redesign checklist](../plans/2026-09-28-analytics-redesign.md) tracks L0–L9;
[production operations](../runbooks/production-operations.md#opt-in-durable-batches-and-shared-analytical-features)
remains the operational authority.

## Implemented scope

- One version-neutral effective reader prepares admitted v1, v1.1 and v1.2 day
  evidence. A private durable feature frame carries daily values, ordered/priced
  scalar evidence, quota/model features and cache events. Missing evidence stays
  unknown under the existing reducers.
- Exact day dependencies and producer/pricing methods determine reuse. Current
  source, target, input revision and erasure authority are re-proved. An unrelated
  upload can retain valid day preparation and unfinished model-block progress.
- Bounded leased stages promote complete heads atomically. Lost write responses,
  expired claims, corrections during save, prior pricing methods, incomplete
  schemas and owner erasure have explicit recovery/refusal tests.
- Historical model blocks cover clipped ranges of up to 32 dates and reuse
  overlapping evidence. Complete results enter the existing graph and cohort
  publication contracts. Today retains its existing native model path.
- Daily publication, shared scalar/model graph work and cache continuity use the
  actual scheduled consumers and query meters. Feature preparation respects the
  larger daily slice and graph/finalization reserves. Analytics retains its
  950-statement cap; publication and cache retain their existing independent caps.
- Cleanup scans bounded pages, retains live claims/current complete features,
  removes obsolete or abandoned work, and participates in physical erasure
  absence checks. Completed frames use session digests and local ordering
  ordinals; no raw source JSON or raw session identifiers are retained.

The first representation is bounded to 6,000 source rows and 4 MiB per day,
8 MiB per complete graph window, and four admitted model jobs per owner.
Unrepresentable or oversized input falls back to the existing bounded path.
These limits are not analytical refusals and do not publish missing evidence as
zero. Deduplication and authority still use opaque contributor identity; the
candidate does not yet replace every job with a partition independent of it.
Incremental updates replace affected day/output contributions. They do not yet
maintain event-level delta fits or cache-pair indexes.

## Local validation

Focused results before the full gate:

| Gate | Result and boundary |
|---|---|
| Model batches, shared graph and publication parity | 60 tests passed; independent candidate/reference D1 databases, nonempty scalar/model results, exact published JSON, replay, numeric correction and physical erasure |
| Shared feature store | 10 tests passed; resumable pages, full 101-day read below 950 statements, unchanged-day reuse, repricing, lost response, correction at save, cleanup and pre-migration refusal |
| Daily/cache consumers | 112 tests passed; exact public JSON, accepted numeric correction, carry boundaries, erasure, flags and actual scheduled meters |
| Owner erasure | 19 tests passed; physical heads, parts and model-policy absence, damaged cleanup, partial schema refusal and pre-0030 compatibility |
| Populated native D1 upgrade | One regression passed; pre-0030 schema, prior published payload, 0030–0032 upgrade, unchanged retained rows, foreign keys and old public-reader parity after new features |
| Architecture | 668 production files / 2,817 imports checked; zero baseline debt |
| Root/document preflight | 20 tests passed; documentation governance checked 289 Markdown and 1,147 source/config files |
| Full owning Worker gate | Passed on `4ac0b999`: 191 test files / 2,356 tests; workspace guards, endpoints, generated types, TypeScript, script tests, default dry bundle and staging configuration/dry bundle all passed |

Measured synthetic completion, including real scheduled query meters:

| Workload | Observed local work |
|---|---|
| Cold scheduled daily publication | 1–2 invocations across runs; peak at most 318 statements; latest two-pass run 349 total |
| Cold dense scheduled cache continuity | 10 invocations; 3,012 total statements; peak 352; 8 feature days, 427 events and 426 adjacencies |
| Cold shared model graph, direct calls | 21 graph calls; 2,778 total statements; peak 135/950 |
| Cold shared scalar graph, direct calls | 2 graph calls; 356 total statements; peak 224/950 |
| Warm graph replay | One graph call / 18 statements per metric |
| Accepted graph correction | Model: 3 calls / 410 statements; scalar: 1 call / 224 statements |
| Scheduled model completion under 20-, 55- and 480-second windows | 4–5 invocations in observed runs; peak at most 898/950 |

Direct graph calls are not cron invocations: an invocation can attempt several
pieces of work. Counts vary with synthetic identities/work ordering. These are
bounded local progress measurements, not Cloudflare latency or a whole-system
speedup. The earlier 153-second whole-test time included setup and the reference;
it must not be compared with shared graph compute time as a performance ratio.

## Migration and recovery evidence

Read-only live observation at **2026-09-28 23:33:58 UTC** found exactly 28
analytics ledger entries: 0001–0026, 0028 and 0029. All stored SQL hashes match the
candidate. Its migration inventory deliberately excludes independent 0027 and
has 31 entries. The primary development checkout also contains 0027; its strict
inventory test therefore expects 32. No remote migration ran.

The populated SQLite transaction rehearsal used the exact observed names/hashes,
1,000 synthetic owners, 365 published days and 365 queued days: 2,096 retained
rows across five populated tables. Before committing each new migration, the
rehearsal closed the connection during an open transaction and reopened it,
proving both schema and ledger rollback. Forward application preserved every
old row byte-for-byte. Foreign-key and integrity checks passed; replay found no
pending migration. A separate native D1 regression covers real public payload
and reader parity rather than treating the SQLite fixture as a valid public
response.

| Forward migration | SHA-256 |
|---|---|
| 0030 analytics model blocks | `dadfa48933c01d05de2b497b3510b952bf548f3c91fed9afe235ca7ad98c6c82` |
| 0031 clipped model ranges | `c5f743fe8c06e00e5f5d8ddadd380cc28e91b188886185a58e718d68d3844c0b` |
| 0032 shared features | `06dab543000daa616d38911093645c9a738ae132d95b4e8e93cd5d2c7298893a` |

The first final-gate run was interrupted when its checkout directory disappeared
during Vitest (`process.cwd` reported `ENOENT`). The exact committed source was
restored into a new attached checkout and protected against concurrent cleanup
while validation runs. That interrupted run is not a passing test claim.

A subsequent full-suite attempt reported two model-block integration failures
just beyond their five-second default timeout; the unchanged focused file passed
all four tests. It also reproduced a deterministic clipped-edge fixture failure
across UTC midnight: graph selection used September 28 while retirement used
September 29 and correctly removed the now-expired edge. The final test fixture
uses one Date-only advancing clock after native SQLite admission, preserving
real I/O timers, test timeouts, elapsed deadlines, query limits and assertions.
That focused case passed. The already-failed suite was stopped and restarted on
the committed correction; neither interrupted attempt is a qualification pass.

The next complete Vitest run on `fd724652` finished at **2026-09-29 01:12 UTC**:
190 files passed and one file failed; 2,355 tests passed and one failed. The
deferred-feature test constructed September 28 quota evidence but omitted
`nowMs` when resuming, so the September 29 calculation correctly rejected its
identity. Candidate `4ac0b999` supplies the matching fixed calculation date.
All four focused tests pass; production code, assertions and timeouts are
unchanged. The full owning gate subsequently passed on that clean commit.

### Final qualification and retained package

The final `npm run check` ran from **01:19:35 to 01:51:29 UTC** on `4ac0b999`
with a clean source tree before and after. Its Vitest stage passed every test;
the two dry deployment stages also passed. The source-bound owning-gate receipt
SHA-256 is `25d1e6d0acd6ffcb85e27a0e028a0be66797f6cb264e759afcc35bea88b65475`.

The maintained native workerd qualifier then applied all 31 analytics migrations
to fresh synthetic D1 with no foreign-key violations. Its normalized predecessor
schema after migration 0029 matched the read-only live schema observation,
`fa355093db39b408a56a70415ccbad84c49d66b684ce7fec8128e45abbf74ee6`.
The final schema digest is
`8fa1f3bafb1368a701027babf191a30aa3ba944309f98a8c76cf083140cce781`.

| Retained proof | SHA-256 |
|---|---|
| Native analytics qualification | `d99cf321ad44671073d3824a16915921e6bac9621cda6aceb3b4023d1e107993` |
| Qualified migration evidence | `7cf8ecb51c38c46c74911cf1c98653c2eb4e43e87bf1e95b61917b25003a8bb6` |
| Prepared production migration plan | `2ebf66eadb4a015b9de0e071c1793f0dbed678aefe37b1968465018db6a3edad` |
| Private package manifest | `c798674991eee62446380d7a6faffc03258be837d329e449a9070ab32c4c97fa` |

The ignored local package is `.release-build/analytics-shared-local-4ac0b999`.
All 154 inventoried files were checked after retention for their exact length,
digest and owner-only permissions. It includes passing logs, qualified migration
bytes, populated interruption/preservation evidence, three bundles and retained
upload configurations, verification scripts, a private migration handoff and
the separate aggregate model-refusal investigation. The maintained migration
operator accepted the retained mirror in plan-only mode. No remote adapter was
created and no remote migration was executed.

The recorded live ledger and schema are dated observations, not independent
proof of current production identity. The prepared plan associates them with
its target; revalidate that association and live state before execution. An
expired plan must be regenerated and reviewed rather than executed unchanged.

## Artifacts and online boundary

All three scheduled Worker bundles compiled with Wrangler 4.114.0, Node 26.2.0,
compatibility date 2026-07-26 and new controls disabled. These are local artifacts;
there was no upload. The final bundle SHA-256 values are:

- Analytics: `0f4bd4c230a145a4c8d6f7727b7ce2f3efdac1919ae458e950ce625687a9027c`.
- Publication: `449b6d5ba09a1e11abe3b96c13c7f0ee38f52596e2825712503bec44c4f7d3dd`.
- Cache: `5e84880acfe240c387bcdefbe7437dedae3ec8ffe699de8f5d0423e388eabf5b`.

Private hash-pinned upload configurations point to these exact bundles. Their
configuration source identity is pinned to `4ac0b999`. The test-only correction
does not change the three module hashes from `fd724652`. Fresh live identity
and configuration checks remain required before any upload.
The generic owning gate's website assets are a local test fixture, not a
production website release. After the passing gate, that fixture, its staged
copy and the generic dry-run artifacts were reversibly archived outside the
qualification checkout. The three scheduled deployment bundles remain in the
verified package. No website release is part of this work.

Package retention rechecks both copies of the owning gate's logs against the
receipt, reloads the qualified migration inventory, and verifies each of the
three expected bundle/configuration pairs, source commit and disabled controls.
Six negative packaging checks rejected changed source, duplicate roles, changed
configuration bytes, enabled controls, corrupt bundle bytes and escaped paths.
The retained observation records ledger names/hashes with a hashed target
identity. Local files remain writable: recheck their manifest and bundle/config
hashes immediately before any later authorized operation.

Live revisions observed at **23:31 UTC**:

| Worker lane | Source | Active version |
|---|---|---|
| Analytics | `75a9b7ef` | `d96c6ce2-c8a6-41c7-9717-c570020ba6e3` |
| Daily publication | `ba7f00b2` | `d1c3360a-1708-49bd-bb87-19bd3ea8a609` |
| Cache continuity | `0fb6a5e6` | `d2aa2df4-ced0-4bb6-8b28-2e2e472a0e2c` |

Each was at 100%; none had the new feature controls active. A subsequent
read-only role inventory inspected all seven TiboTattle-named Workers. Four bind
the analytics target: the three above and the existing graph-day preparer.
Analytics and publication can complete typed erasures and must both receive the
new absence checks before feature activation. The preparer does not execute that
erasure completion path. No public/admin Worker was bound to this target in the
observed deployment, so a simultaneous public website release is not required. No code, database,
control or schedule was changed in this local phase.

The next gate is separately authorized online qualification at concurrency one,
followed by forward migrations, disabled code deployment and staged activation.
The handoff order is:

1. Revalidate active versions, bindings, custom ledger, schema digest and current
   recovery posture; stop on drift or an occupied production coordination lock.
2. Qualify the same candidate online with isolated synthetic admitted inputs,
   complete-output comparison, correction and erasure, initially at concurrency one.
3. Review the exact analytics-only migration plan and its qualification digest.
   The maintained D1 operator defaults to plan-only; explicit authorized execution
   appends only 0030–0032 to the matching 28-entry prefix, with ledger/schema
   readback between atomic migrations. Independent 0027 is excluded.
4. Deploy the three pinned Worker artifacts with controls disabled. Preserve the
   live public response contract and existing runtime settings. Verify analytics
   and publication now contain the new erasure checks before enabling features.
5. Enable shared publication, cache continuity, shared graph features, then model
   batches as separate observed stages. Compare completed output identity, queue
   drainage, failures, statements, elapsed time and retained storage. Exercise
   actual work; an idle successful pass is insufficient.
6. On mismatch, recurring failure, stalled progress or erasure regression,
   disable the relevant feature controls on the new code. Preserve forward
   schema, last completed publications and erasure-aware completion checks.
   Do not downgrade storage or roll an erasure writer back to code that omits
   the new private tables from its proof.

R2/object features, containers, worker concurrency and a tenfold whole-pipeline
improvement remain untested target work.


## Worker revision reconciliation

A separate Sol/Luna investigation used public Worker revision `ae637aa7` and
reported a local effective-model publisher fix at `875d4b9e`. Its repaired
`storage-community-graph-publication.ts` is byte-identical to the same file in
analytics revision `75a9b7ef`, which was confirmed active at 100% again at
2026-09-29 00:55 UTC. The model writer and public website deploy independently;
the website health revision is not evidence of the model writer's revision.
The candidate already contains that fix. Existing multi-plan/quota-track
eligibility refusals and public daily-date lag are separate from this corrected
publication-method selection. Faster processing does not turn refused evidence
into an identified model estimate.

The investigation's later clarification is relevant: a multi-plan refusal can
also describe attribution conflicts, while no supported quota track can mean
that recorded evidence did not survive selection and attribution. Those refusal
codes locate the stopping point; they do not establish that evidence was absent
or that waiting for more uploads will resolve the cause. That diagnosis remains
separate from the local efficiency qualification.
