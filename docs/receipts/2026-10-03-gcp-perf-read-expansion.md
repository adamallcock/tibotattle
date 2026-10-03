---
title: GCP source expansion implementation and proof receipt
date: 2026-10-03
type: receipt
status: source implemented; synthetic parity qualified; corpus and performance gates open
---

The exact A/B base is `48c26716a478bf92a830c27ea9c8ab7a90a0d929`, containing
committed REFRESH, corrected KPAR, W1E and Wave25. The isolated branch is
`codex/perf-read-expansion-20261003`. Central test/inventory prerequisites
`28c2c1cb`, `c63ebd48` and `87b6dac6` were cherry-picked without weakening their
assertions. Selection/evidence-plan changes belong to READ-PLAN; this lane
extracts its exact reviewed `legacySelectionPairCtesSql` helper from `58a271c1`.

Stage 1 adds same-snapshot existence facts for ready v12 manifests and applicable
method-version-1 correction facts. Empty expansion families skip only on these
necessary-condition proofs. Owned snapshots set `jit=off` and `work_mem=64MB`
in the existing read-only guard round trip. Supplied clients receive these
settings through the existing generic-plan scope, which restores all three
previous settings on success and operation failure. Fingerprint scope identity
keeps its original fields; existence/probe helper facts are excluded.

Stage 2 groups 2,000 IDs, retaining compareText order and original logical
200-ID batches. SQL caps each batch/family at 40,001 before wide joins. Group
budget G is 40,001, with a G+1 sentinel and incomplete-tail reissue. The reader
holds at most three family results of 40,002 rows, then processes each batch in
legacy/v12/correction order. All ordinal helpers are stripped before decoding
and fingerprint canonicalization. Decode, verification and reconciliation are
pure assembly seams; this lane does not dispatch assembly to Workers.

Correction archive dictionaries intentionally lack foreign keys. Missing
mandatory dictionary rows may disappear during the wide join; therefore the
correction group sentinel caps wide output, after the per-batch narrow cap.
Otherwise a narrow G+1 cut can hide later batches. A real fixture with 40,661
narrow facts and fewer than G+1 wide rows proves later-batch Map/fingerprint
parity. Legacy/v12 group limits remain before their wide joins.

A grouped statement error can belong to a later batch, preceding an earlier
batch's decode refusal in arrival time. Grouped reads use read-only savepoints
and replay failed SQL at the original 200-ID granularity. A real division-by-zero
statement abort proves rollback recovery and earlier-conflict precedence.
Explicit PostgreSQL user-request cancellation (57014) is terminal without
source retries. Single-batch family errors defer to the original family decode
position. Successful grouped reads add two `snapshot.control` statements per
group; their latency/CPU cost remains part of the measurement gate.

Stage 3 stages `0981_typed_records_owner_occurrence_idx.sql` only. The owner
probe requires a schema-qualified index on the expected table, valid and ready,
with no predicate/expression and exactly the expected three leading keys.
Absent, invalid, not-ready and wrong-key-shape cases fall back. Admission still
uses the reviewed exact v11 physical chunk/manifest pair helper. Expansion
completeness groups physical proof counts before joining allocations and unique
manifest memberships, preserving the original count-chain multiplicity.
The index adds one entry per record write. The header retains historical
449 MB/11.5 s synthetic evidence as a dated estimate; this lane did not measure
its current size/build time. Production storage/write amplification, concurrent
build and promotion remain explicit owner decisions.

The committed A/B tool bundles independent base/candidate graphs through the
actual Cloud Run plugins and compares exact serialized Maps, fingerprints and
closed refusal outcomes by aggregate SHA256. Its CLI keeps an exported
read-only snapshot alive while an imported snapshot covers every effective
owner, stream and Job-derived span, with complete fingerprint coverage in
windows of at most 400 days. Only counts/digests are printed. Cleanup rolls
back both clients before releasing the exporter and removes only owned scratch.
A family-first assembly mutation is a negative control for cross-batch error
precedence. Valid correction facts cover 420 occurrences, three facts each,
and three logical batches; fact IDs retain their original order.

Qualification uses a private locale-C PostgreSQL 17.10 cluster on loopback
port 55543, bounded synthetic fixtures, and Node 26.2.0 for closure gates.
No corpus import, cloud, remote migration, index promotion, push or deployment
was performed. Final validation/cleanup results are appended below.

Decode cleanup is deferred: the canonical legacy projection remains unchanged
until a separate projection-failure equivalence proof is available.

The coordinator owns the remaining measurement sequence: base/each stage on
clones of identical private templates, absent index versus valid staged index,
Q-1 and dense seven-table digest parity, then s015/full every-owner/stream/span
A/B and aggregate fingerprints; direct/+1 ms proxy ABBA K-PGSTAT family calls,
client wall, rows/bytes and server time; o01 peak RSS with identical flags; then
host-load-qualified production-range projection. Savepoint control calls must
appear beside family totals. Target <=300 s family client wall, <=6k family
statements and <=120 s o01 legacy server time are unmeasured acceptance targets.
`gcp-read-expansion-ledger.mjs` extracts the three numeric family ledgers and
preserves unknown protocol bytes as null. No before/after ledger, peak RSS,
latency or production speedup claim is made here. The local cluster does not
preload pg_stat_statements and is not a measurement substitute.


Validation on the final production source:

- Indexed occurrence/exclusion/parity PostgreSQL specs: 20/20 passed, no skips.
- Absent-index occurrence, refresh and staged-migration harness: 96/96 passed,
  no skips. Focused family-first mutation proof: 1/1 passed.
- Applicable source gates: vendor 59/59; analytics 24 files/254 tests;
  typecheck; Cloud Run full `npm run check`; root preflight 21/21 and architecture
  passed. The AB wrapper passes; the new scripts are wired into the owning
  script gate, and physical boundary specs into `postgres:domain:check`.
- Closure gates ran with a private temporary entry/pin for digest
  `1a8b53fef58eafff822d5b68226efb5e3a2fc40bff2be0756ceca2910cdf28cf`
  (166 inputs). That entry/pin is excluded from commits. Without it, build
  `--check` refuses `CLOUD_RUN_BUILD_KERNEL_UNREGISTERED`; registry-dependent
  script/build checks remain integration gaps on the clean head.
- `gcp:fastpath:scripts-check` core: 131 passed, 4 existing environment skips.
  Its unchanged production-tier sampler signal test first failed because
  sandboxed pgrep cannot inspect processes. Isolated unsandboxed prod-shape
  checks then passed 18/18. A complete unsandboxed rerun found an orphaned
  sampler in that same existing test. The coordinator assigned a separate
  owner to diagnose/fix it; this lane preserves assertions and failure
  evidence. The complete wrapper is not reported green.

Physical boundary fixtures use 200 independent admitted devices each carrying
200 identical occurrence IDs, so actual SQL returns40,000 valid variants.
Adding one complete 201st source raises cardinality to40,001. Immutable source
rows, transport/codec admission, constraints and original constants remain
intact. Correction physical SQL 40,000 passes and40,001 refuses; the legacy and
v12 fixtures assert both actual returned cardinality and exact oracle
Map/fingerprint results. These are bounded qualification tests, not measured
performance receipts.

Final physical boundary run: 2/2 passed with no skips (legacy and v12).
Both independent readers return exactly 40,000 SQL variants and compatible
200-occurrence Maps with sourceCount 200; both refuse 40,001. All fixture
schemas were removed. Peak observed cluster storage was approximately
1.224 GiB, below the 2 GiB fixture limit. The final closure digest was verified
again after all source edits. Temporary registry and pin files are restored
to their original five-entry contents.

Cleanup verified zero owned fixture schemas, stopped PostgreSQL55543, and
removed the entire owned private cluster. No listener or fixture database is
retained; dependencies and the isolated review worktree remain available.
