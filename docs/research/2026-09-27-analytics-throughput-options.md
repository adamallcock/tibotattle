---
title: Analytics effective quota-day qualification
date: 2026-09-27
type: research
status: recovery-qualification
---

# Analytics effective quota-day qualification

This records implementation and local qualification of the analytics-only candidate.
The first production test was rolled back after a cleanup compatibility defect;
the recovery below preserves the optimization with a compatible storage key.
Synthetic statement counts do not establish a production speedup.
The maintained operational authority is [Production service operations](../runbooks/production-operations.md).

## Effective quota-day reuse: implementation and qualification

The next increment prepares quota inputs during the existing first source scan,
then reuses complete days for both metrics and overlapping result windows.
Usage continues through the existing effective reader. This preserves scalar
fits and the streamed usage refusal boundaries while measuring quota reuse
independently.

- Add an explicit effective layout to the existing immutable prepared-day
  store. Keys use the correction-aware day dependency, including linked source
  variants and sessions, rather than the owner-wide revision.
- Retain bounded, content-free quota preparation inputs in the existing
  checkpoint while a day spans multiple pages. Oversized preparation falls
  back to the maintained paged calculation.
- Count all admitted quota rows before filtering, and rebase cached endpoint
  IDs across the selected days. Require complete coverage and conservatively
  fall back at the existing reset-cluster bound.
- Verify migration preservation and pre-migration fallback, interrupted/retried
  preparation, fits/model parity, correction and authority invalidation,
  erasure, and cold/warm actual statement counts.

This increment requires a forward analytics migration before activation.
Local source qualification, migration rehearsal, and production deployment
remain separate gates.

The implementation uses the existing `GRAPH_DAY_PROJECTION_FOLD` switch and
checks the migration capability before staging any effective day. Its new
checkpoint namespace can adopt paged work; disabling the switch preserves the
old reader namespace. Per-day preparation retains at most 12,800 rows or 4 MiB.
The whole-window loader rejects encoded payload above 8 MiB and raw reset
fragments above 4,096 before reading source dependencies. It batches manifest
reads, verifies all source dependencies before decoding any cached payload,
and reserves enough queries for a cache miss to advance the pager.

Review identified two additional lifecycle requirements, now implemented:

- A late cache miss selects deterministic one-page checkpoint groups. A
  successor larger than 30 parts can then stage and resume instead of repeatedly
  discarding the same partial four-page group.
- Effective prepared inputs age out at the oldest reachable graph input day,
  derived from the existing 70-day result horizon and 100-day model lookback.
  The 170 inclusive input days preserve every scheduled window without retaining
  obsolete derived days indefinitely. Source and daily data are untouched.

The 101-day resource regression uses actual D1 statement metering. A warm load
uses 711 statements with 239 remaining. Replacing only the final day causes a
miss after 609 statements, leaving 341 and decoding no cached payload. Keeping
both the old and rebuilt final-day heads still loads the exact new dependency
in 711 statements. Oversized memory or reset-fragment metadata selects the
paged path before any source dependency or cached payload decoding.

Final dense-fixture measurements (6,001 quota observations over five days,
120 usage events, 950-statement cap) show exact fits/model parity. Counts include
source validation, checkpoint reads/writes, preparation and result publication:

| Calculation | Paged, grouped checkpoints | Effective quota-day reuse | Source / analytics statements | Compute invocations |
| --- | ---: | ---: | ---: | ---: |
| First model calculation, including preparation | 1,925 | 935 | 698 / 237 | 3 → 2 |
| Fits over the same inputs | 1,926 | 179 | 142 / 37 | 3 → 1 |
| Model for the adjacent result day | 1,925 | 178 | 142 / 36 | 3 → 1 |

Both warm calculations read zero quota source pages; each paged baseline reads
124 and the cold prepared calculation reads 44. Warm calculations use about
10.8 times fewer statements, and cold preparation uses 51.4% fewer. Across all
three calculations, including preparation, the count falls from 5,776 to 1,292
(77.6% fewer). The existing 950-statement invocation cap is unchanged.

These are synthetic statement counts, not production speed or completion
estimates. The whole workflow still includes daily publication, usage reduction
and scheduling. The corpus establishes exact output parity and removal of
repeated quota scans; a production sample must establish elapsed throughput.

### Final source qualification

Qualification completed on September 27 local time (September 28 UTC), on the
patch based on `d4c1f192`:

- The complete Worker command passed workspace-package, endpoint,
  generated-type, TypeScript and script checks. Its full Vitest run exercised
  162 files and 2,055 tests: 2,054 passed and one exact checkpoint-registry
  expectation still listed only the old formats. The expectation was updated
  to include the two new effective quota-day formats, retaining exact equality;
  all 11 tests in that file then passed. No runtime change followed the full
  suite, and the suite was not repeated after this assertion-only correction.
- The final dense-fixture benchmark passed independently with the counters
  recorded above. The 101-day budget tests, correction/authority invalidation,
  old-checkpoint adoption, large checkpoint saves, erasure and migration
  preservation also passed in the full run.
- Architecture boundaries, documentation governance, preflight (20 tests),
  TypeScript and diff checks passed. The analytics example dry build passed.
- The separate generic website `deploy:dry` command stopped at its required
  clean, committed release-tree check. Website/staging asset deployment gates
  remain unqualified; the combined Worker command is not reported all-green.

A separate analytics candidate was prepared on the last recorded deployment
source `31a32281c1224b63de45b55b14e44b66357ce321`. Its eight changed/new runtime
modules and migration are byte-identical to the qualified source. Unrelated
website/client changes and the newer admin-metrics publication implementation
were not copied. TypeScript, the exact local schema-generation assertion and
all 19 migration/store tests passed on this baseline, including the upgrade
without analytics migration 0027. Its analytics-only dry build used the
disabled, unbound example configuration; live bindings are not qualified by it.

Artifact identities:

- Analytics migration 0028 SHA-256:
  `7b83ecee7ad08506c636598b3e6ddb11894066dcc706474f8013bb8ea65a5b90`.
- Runtime/migration patch against the deployed baseline SHA-256:
  `8089e33e2804c5f40c772371e1a481c8a1f920b09d74008fa550c184017bca91`.
- Analytics JavaScript from that baseline plus the patch SHA-256:
  `6645fb2d85bac7ba3be6dc74bea2697c8a31518dc1d114df16185cd00634303a`.

The production step is to recheck the active version, bindings, fold switch
and analytics schema, apply only migration 0028, then deploy the analytics
candidate. It keeps the 950 cap and delivery catch-up disabled. Migration and
activation require explicit production authorization. Observe natural scheduled
runs for completed results, publication freshness, source-page counts and
errors before assigning a live speedup. This local qualification does not
establish current production backlog counts or completion time.

## Mixed-version checkpoint recovery

The first candidate, source `10ce797d`, applied analytics migration 0028 and
activated successfully. Natural scheduled work exposed a cross-Worker
compatibility defect: an older publication Worker retired the new
`:quota-days-1` checkpoint method. The exact new head was observed permanently
retired while its original paged checkpoint remained intact. Analytics was
restored to source `31a32281`; migration 0028 remains applied.

The repair keeps the seven original recognized method names. Prepared storage
keys derive a domain-separated dependency digest using
`effective-quota-days-2`; source, acquisition and analytical result identities
remain unchanged. The new reader adopts the original unwrapped key, and old
readers cannot load the new payload. Abandoned key tombstones are preserved.

After exact completed-result readback, a bounded retirement page marks the
prepared head retired, allowing existing cleanup Workers to drain the remaining
parts. The path reserves eight statements and uses a two-write page limit;
concurrent head changes leave the valid result intact. Owner erasure and age
retention remain unchanged.

Recovery qualification: TypeScript passed; seven dedicated compatibility
cases and 39 graph/prepared-fold cases passed. An independent review found no
blocker and reran eight compatibility/adoption/cleanup cases, all passing.
The complete Worker check is being repeated. The recovery's completion cleanup
adds a few target queries beyond the original synthetic counts above. No
production speedup is claimed.
