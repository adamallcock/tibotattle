---
title: D1 cursor migration repair for 0.1.18
date: 2026-09-05
type: review
status: completed
---

# D1 cursor migration repair for 0.1.18

Scope: the owner-approved repair of unapplied migration `0043` and its two v1
analytical readers, plus the subsequent expression-parentheses-only remote
parser compatibility repair of unapplied `0044`/`0045`. This is not a production-deployment or desktop-publication
receipt. The [release plan](../plans/2026-09-05-public-0-1-18-release.md) retains
the ordered release gates and the separate manual-testing waiver.

## Failure and preservation boundary

The first approved migration application completed `0042`, then refused `0043`
with `out of memory: SQLITE_NOMEM [code: 7500]`. Read-only inspection found the
exact 42-entry ledger prefix, all original `0043` additions absent, unchanged
collection controls, and the existing deployed service healthy. The exact v1
record count before and after refusal was 3,192,817. Equal aggregate counts
are not row-for-row identity proof. Recovery bookmarks and original receipts
remain private and unchanged; no restore, telemetry deletion or ledger editing
has been performed.

The final whole-table cursor index is the leading failure hypothesis, not a
proven server-side failed-statement trace. Cloudflare documents per-migration
rollback and bounded D1 resources, not an operator memory override for this
index build. Sources: [migration commands](https://developers.cloudflare.com/d1/wrangler-commands/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Reviewed repair

Only the unapplied `0043` index creation is removed; all its fencing, cache
invalidation, triggers, seeds and columns remain byte-identical. The already
applied `0042` and all other historical migration files retain their pinned
digests. The repaired `0043` SHA-256 is
`acc7c319478487eec408c5bbcebd90e60f029fb02a608c901b7c6f71706c2f49`.

Both scalar allowance and model-composition readers use the existing `0036`
index through two explicit seeks: drain equal-time rows after the current id,
then fill the page from later times. A row-value `(time, id)` predicate alone
does not seek the implicit rowid suffix in the tested D1 planner. The replacement
queries retain participant state, selected-device/day, cutoff and row caps.
The page remains bounded to 5,000 rows, with at most two queries per page.

Physical id ordering must not change attribution. A compact minimum-occurrence
candidate per session/timestamp preserves which event inherits the previous
session interval, including a dropped first event and ties spanning pages.
The existing 100,000-session cap bounds retained clocks and pending candidates
together. Composition retains each bin/model's earliest occurrence tuple to
restore the former floating-point iteration order without retaining raw rows.
Cost guards refuse unrepresentable contributing totals instead of fitting
truncated or order-dependent costs; excluded composition bins remain excluded.

The shared schema probe now requires the existing non-partial ascending binary
index, its exact three keys and rowid suffix, and `id` as the sole INTEGER
rowid-alias primary key. It refuses missing, partial, reordered, descending,
collation-changed, expression or extra-key lookalikes. Cloudflare documents
these metadata interfaces in its [SQL statement reference](https://developers.cloudflare.com/d1/sql-api/sql-statements/).

## Evidence collected during repair

- Local historical-prefix upgrade and schema adversarial tests pass, including
  preserved source rows, foreign-key checks, consent lifecycle and missing guards.
- Read-only production metadata at 04:48:11 UTC verified the final index and
  id-alias prerequisite at migration prefix 42; 79 rows read and zero rows
  written. The complete post-migration schema probe remains a later gate.
- Both explicit seeks have local D1 query-plan regression tests for the required
  three-/four-key seek and absence of an ORDER BY temporary tree. Scalar tests
  include unequal costs, reversed id/occurrence order, dropped first events,
  page-boundary ties and cap refusal.
- The owning allowance and fencing suites pass 59/59 tests, with TypeScript
  clean. A controlled sort-removal mutation fails the equal-share/zero-cost
  first-occurrence regression; restoring the exact source restores the tested
  semantics. Independent review found no remaining actionable issue. The
  adapter method stamp advances to `v1-era-buckets-2` so earlier cached fits,
  model history and publication evidence cannot bypass the new guards.
- The initial script-suite attempt was refused by the sandbox's local listener
  restriction. The authorized local-runtime rerun passed all 183 script checks;
  a later added id-alias test is separately green. The complete final owning
  validation and remote repair application are recorded below; exact-source
  desktop rebuilding remains a separate release gate.

## Subsequent remote parser compatibility repair

The complete Worker gate at `15325bbc6bf2aa42fb29902ff6d32a72ef7f14ac`
passed 184 script checks and 543 application tests across 43 files, plus
workspace/package, generated-type, TypeScript, endpoint and all three dry
bundles. The first complete attempt had one five-second test-harness timeout;
only the fixed 100,000-session fixture received a documented 20-second budget.
Its exact acceptance/refusal assertions and production limits are unchanged.
Dual-runtime R7 freshness and reconstruction remain green.

The approved retry applied repaired `0043`, then `0044` was rejected with
`incomplete input: SQLITE_ERROR [code: 7500]`; `0045` was not attempted.
The pinned Wrangler remote migration path sends the entire SQL file and its
tracking INSERT to D1's query API. Unlike its local path, it does not use the
client-side statement splitter. Both remaining files use LF, not CRLF, so
upgrading for the separately documented CRLF fix would not address this input.
Source: [Cloudflare's remote-command explanation](https://github.com/cloudflare/workers-sdk/pull/15044).

Cloudflare previously documented a parser problem with unparenthesized CASE
expressions inside triggers: [workers-sdk issue 4727](https://github.com/cloudflare/workers-sdk/issues/4727).
A synthetic read-only production EXPLAIN probe reproduced it at 05:09:21 UTC:
the bare expression returned the same incomplete-input refusal, while the
parenthesized expression returned 15 instruction rows and zero writes. The
ledger remained at 43 and the synthetic object count stayed zero before and
after. EXPLAIN compiles the statement without executing CREATE TRIGGER; this
does not create a production probe object or expose user rows. It is a direct
synthetic reproduction, not a server trace identifying the failed statement
within the original migration. [SQLite EXPLAIN semantics](https://www.sqlite.org/lang_explain.html).

The compatibility change adds parentheses around exactly twelve complete CASE
expressions in `0044` and seven in `0045`. No comments, whitespace outside the
wrappers, predicates, literals, NULL branches or operations change. A regression
removes exactly those wrappers and requires each original reviewed SHA-256;
all already-applied migrations, including repaired `0043`, are untouched.
New digests:

- `0044`: `9b2661a5052ca8a08e18098e960891a49e7f1c7516b2c1b8cacf32c6f294f5e4`.
- `0045`: `89f0df9e95eb98fa7ae8cb00dc82fe19f8933689a8002e647e638fdc870990fe`.

Local compiled-program and branch parity, full owning validation, observed
rollback/preservation and a fresh exact pending-set check precede another apply.
Consent remains staged, and no new consent, activation, telemetry deletion,
production restore or migration-ledger rewrite is authorized by this syntax fix.

The 05:13:49 UTC read-only aftermath confirms exact ledger 43, all ten repaired
`0043` objects/nine columns present, all forty attempted `0044` objects and its
one column absent, and unchanged controls/consent. The expected epoch increment
and publication `updating` state are present; old-source health is HTTP 200.
Its exact v1 record count was 3,192,617, down 200 from the retained baseline
and previous post-refusal supplement. Further production mutations were held
until read-only retained-journal investigation explained the entire difference.

At 05:22:51 UTC, all 748 superseded revisions had exact full-identity,
revision-plus-one and timestamp-matching successors, with zero unmatched
links in either direction. Their 123,996 replacement records minus 124,370
superseded records contribute -374; four first revisions contribute 174,
exactly explaining -200. The retained journal reconstructs all three earlier
exact counts. One SELECT independently matches the current journal sum and
actual record count at 3,208,989. Participant/device/consent counts are
unchanged, deletion tombstones/cooldowns are zero, and no erasure markers are
present. Eight diagnostic SELECTs report zero writes. This closes the
aggregate/current-view discrepancy; it is not payload-level preservation proof.
Private lifecycle and exact-link receipt SHA-256 values are respectively
`cfb8e089b51691cd120a66572c6483ba0f4a89e380472ce9616f4a2086a257fc`
and `9132172cb604f27813e5e63d8ae549ffd6ad3b9c6cbd711c185fccb062ee4486`.

Independent memory-only compilation compared original/current `0044` and
`0045` in all four combinations: 312 compiled DML programs across 26
trigger-bearing tables, with 234 cross-variant comparisons, match after
excluding only trace text and connection-specific virtual-table pointers.
No DML was executed. Forty focused transport/domain/credential tests and the
24-test schema/lineage suite pass. The final clean repair source `68d7451b`
passes all 543 Worker tests across 43 files, 185 script checks, workspace and
generated-type/TypeScript/endpoint guards, and default/staging/production dry
bundles. Preflight/docs pass 20/20 and R7 reconstruction passes 2/2 on each
of pinned Node 26.2.0 and 24.14.0, without skips.

After a fresh exact `[0044, 0045]` pending-set and all reviewed-hash guard,
both repaired files applied successfully. The 05:47 UTC read-only aftermath
verifies exact prefix 45 and complete attribution schema, unchanged collection
controls, all expected participant seeds, zero v1.1/rollback records, unchanged
rank-one floors and the staged v1.1 lifecycle. The frozen snapshot intentionally
reports its one saturated record count rather than pretending it is exact;
the independent exact supplement records 3,208,989. The existing Worker is
still healthy at its prior source; this is not new-deployment qualification.

The independent 05:53:47 UTC reconciliation closes the complete before/after
aggregate boundary: 750 exactly linked replacements contribute -206 records,
and 91 first revisions contribute 16,378, matching the exact +16,172 delta.
Both historical totals reconstruct exactly and same-statement current journal
and record counts both equal 3,208,989. All sixteen checks pass, including
unchanged identity/consent counts and zero independent deletion markers; five
SELECTs report zero writes. Its private receipt SHA-256 is
`82ff84142e117624018b9df2e0617b7732ca5225d4f31a912c3b43faeadee395`.
An initial follow-up ledger read failed without a completed reconciliation;
its diagnostic evidence is retained and is not counted as a passing result.

All current repair paths are outside the desktop payload and R7 input closures.
This avoids unnecessary R7 regeneration, not exact-source desktop rebuilding:
the earlier signed stable attempt names the pre-repair commit and cannot be
relabelled as the repaired source. Preserve its local tag object and artifact
bytes, verify no public tag exists, and finalize new artifacts from the final
clean annotated source.
