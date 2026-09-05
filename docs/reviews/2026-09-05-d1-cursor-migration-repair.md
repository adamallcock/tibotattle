---
title: D1 cursor migration repair for 0.1.18
date: 2026-09-05
type: review
status: in-progress
---

# D1 cursor migration repair for 0.1.18

Scope: the owner-approved repair of unapplied migration `0043` and its two v1
analytical readers. This is not a production-deployment or desktop-publication
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
  a later added id-alias test is separately green. Full final owning validation,
  remote repaired migration application and final-source qualification remain
  pending and must be recorded before release.

All current repair paths are outside the desktop payload and R7 input closures.
This avoids unnecessary R7 regeneration, not exact-source desktop rebuilding:
the earlier signed stable attempt names the pre-repair commit and cannot be
relabelled as the repaired source. Preserve its local tag object and artifact
bytes, verify no public tag exists, and finalize new artifacts from the final
clean annotated source.
