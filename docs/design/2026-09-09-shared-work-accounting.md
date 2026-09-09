---
title: Shared accounting for project and thread summaries
date: 2026-09-09
type: decision-record
status: implemented-first-stage
---

# Shared accounting for project and thread summaries

Keep the accepted UI. Extend the existing accounting pipeline so its consumers
share calculated results, not just calculation code. Start with shared streaming
projection and cached task subtotals; add persistent incremental materialization
only after measuring the remaining refresh cost. The first stage is implemented in an isolated checkout. No database migration,
retention-policy change, installation or release is included. Later incremental
ideas below remain design options, not claims of implemented behavior.

## Evidence and workspace status

Inspected the available main checkout at e4f2b742 and, separately, the prototype's
recorded base dffe64d60c3ea6de985c697c31678bdf22feb815 through Git on 2026-09-09.
The following newer capabilities were verified against that pinned base:

- `src/local-unified-index.js` owns canonical event identities, nullable token
  components, account scope, session identity, source order and generations.
- `src/local-unified-accounting-source.js` already supports a fused window and
  full-history read through `indexedHistory.onUsage`. Its current full-history
  callback deliberately excludes attribution; task identity and account scope
  need a reviewed internal contract, not a change to public/export callbacks.
- `src/replay-safe-accounting-cache.js` already shares projected events between
  those two consumers through `PROJECTED_EVENT`, and memoizes price plans with
  `createAccountingPricer`. Exact accumulation helpers also exist.
- Existing period/timeline summaries discard task identity. Their public,
  sometimes rounded totals cannot be divided back into exact task amounts.
- The prototype described in this conversation reused canonical facts and the
  pricer but built a separate report snapshot and scanned retained sources for
  project metadata. That is a useful prototype, not the desired final refresh path.

The previous temporary prototype was recovered from saved authored edits into
`codex/shared-work-accounting`, based on the same pinned revision. The original
main checkout remains untouched by this implementation. The feature has not landed
in main.

## Implemented first stage

- The companion's existing `usageBatches` loop prices each positive event once.
  A prepared work collector consumes the same row and exact priced projection,
  including nullable facts before the companion skips zero/null projections.
- One metadata discovery prepares all four exact periods (24h, 7d, 30d, all) and
  all account scopes. This uses sparse period accumulators, not approximate time
  buckets. A global 50,000-cell limit bounds the aggregate across every scope and
  period; capacity errors never publish truncated totals.
- The existing server projection cache retains a combined internal result.
  Dashboard and work selectors clone only the requested part. Work identities and
  display metadata cannot enter the ordinary dashboard DTO or its persisted file.
- Reuse checks generation, index path, declared baselines, source configuration,
  clock direction and exact next time-membership boundary. Code and price registry
  changes require process restart, which clears this process-local cache. SQLite
  sidecars and uncertain file identity prevent reuse. Work errors are retryable.
- Concurrent compatible reads share the build. One cancelled subscriber does not
  cancel another; the last cancellation aborts it. Cancelled or superseded builds
  cannot replace a completed cache. Reports retain their actual cached interval.
- Names remain separately enriched for visible rows. Source location and worker
  ancestry remain frozen with the accounting generation; fully independent
  rejoining of changed repository/ancestry metadata is a later stage. A report
  refresh can reuse unchanged accounting and honestly retains its original age.
- This stage removes repeated work across navigation and consumers within a
  generation. A changed generation or elapsed window boundary still performs a
  full shared pass. Persistent contribution partitions and cross-generation
  incremental updates are not implemented.

## Longer-term layers

1. **Canonical facts, unchanged owner.** Ingestion alone handles replay,
   cumulative deltas, lineage and token admission. Reporting never re-parses
   token counts to build a competing ledger.
2. **One shared projected event.** Within the accounting refresh, normalize and
   price each admitted event once per required accounting basis, then feed the
   same immutable result to existing totals and the new task accumulator.
   Preserve nullable components, exact money, coverage, pricing provenance,
   account scope and event/source identity before any lossy display projection.
3. **Reusable task subtotals.** Cache sparse subtotals by account, original task,
   model and time bucket. Preserve workspace-segment identity where a task moves
   between directories, so project filters do not silently treat a task as having
   one project. Choose bucket size after measuring cardinality; existing 15-minute
   buckets are a candidate, not a mandatory retention or precision decision.
4. **Independent local metadata.** Resolve repository/worktree observations,
   names and worker ancestry separately. Join them to subtotals for display.
   A rename, regrouping or changed parent relationship must not trigger pricing.
   Keep source-order metadata segments and explicit unknown boundaries.
5. **Presentation queries.** Filter and sum cached subtotals, group workers under
   their parent, calculate shares, sort and paginate. A caret expansion, sort or
   page change must not scan source logs, re-price events or refit quota models.

Task identity must survive until after aggregation. Parent totals include each
original task exactly once; a parent-inclusive total is never added again to its
children. Project and worker grouping remain independent of accounting identity.

## What can be shared

| Computation | Reuse strategy |
|---|---|
| Token deltas and replay exclusion | Existing canonical facts, without re-derivation |
| Cached/uncached input and split/combined output | One qualified shared component projection |
| Event-time API equivalent and price coverage | Existing pricer and exact sums; share its result |
| Periods, model totals and task totals | Independent accumulators consuming the same projected event |
| Cache-hit rates and component shares | Ratios of shared sums; never averages of row percentages |
| Primary model | Largest recorded-token subtotal under the active filters |
| Project and worker grouping | Metadata joins and summation after fact filters |
| Quota calibration and allowance forecasts | Reuse qualified outputs only under the same account, plan, window and model version |
| Historical window boundaries | Sum complete buckets; handle partial boundary buckets from canonical events or an exact cached event slice |

API-equivalent cost, observed quota movement and estimated allowance consumption
remain separate measures. Project token shares do not establish project quota
shares. Any future allocation of quota needs its own explicit estimate semantics.
Reasoning is part of output: split components and a combined output alias must
never be added together. Missing price or token evidence never becomes zero.

## Reuse and invalidation

A published view references compatible versions of facts, projection semantics,
price registry/basis, metadata and grouping rules. Publication is atomic; an
interrupted refresh leaves the preceding usable snapshot labelled with its age.

- New usage: process newly admitted events and update affected subtotals.
- Parser/model correction: replace affected source/event contributions; event key
  alone is insufficient because the same event can acquire corrected metadata.
- Price correction: invalidate amounts dependent on the changed cards/intervals,
  retaining token facts. Never apply today's rate to past usage by accident.
- Rename or repository/worker mapping change: rebuild the relevant joins only.
- Moving time window: expire/add bucket contributions and recompute boundary
  slices, even when the fact generation itself has not changed.
- Cache loss/version mismatch: rebuild from canonical facts through the same path.

For a persistent phase, use a versioned derived cache with contribution receipts
or replaceable source partitions, not a second authoritative event store. It must
handle replacement, removal and correction as well as append. Unchanged source
partitions can be reused across generations only when their content/provenance
is proven identical. Retaining new opaque workspace relationships requires a
matching privacy/schema review; paths and titles stay out of accounting caches,
exports and uploads. Keep metadata caching bounded and transient until then.

## Delivery sequence and verification

1. Restore the prototype into a durable isolated checkout and pin its base.
   Reconcile null/coverage and period-boundary semantics before consolidating.
2. Instrument current fact scans, price calls, metadata scans, elapsed time and
   peak memory. Extend the existing fused pass with a bounded task accumulator.
   Retain shared snapshots across requests with explicit compatible-version keys.
3. Measure warm navigation and refresh. If full refresh remains material, introduce
   incremental cached partitions; consider cached per-event prices only if exact
   boundary queries or correction handling justify the additional storage.
4. Require exact conservation of components and money across tasks, projects,
   worker families, models and existing totals under identical filters and basis.
   Test account isolation, partial windows, price epochs/context bands, model
   corrections, missing data, cancellation/restart, and metadata-only changes.
5. Performance acceptance: warm sorting/expansion/pagination performs zero source
   scans and zero pricing calls. Fused refresh has at most one projection per event
   and accounting basis. Incremental refresh work scales with changed evidence;
   unchanged historical contributions are neither replayed nor re-priced.

No speedup percentage is claimed before those measurements. Some lightweight
filtering and summation will always remain; the avoidable work is repeated parsing,
pricing and model fitting over unchanged history.


## Validation receipt, 2026-09-09

The combined-reader tests compare every period/account snapshot against the
standalone reader and preserve the unchanged companion usage/timeline. Fixtures
exercise inclusive lower and exclusive upper boundaries, future observations,
known-zero versus unknown counts, exact decimal price reuse, worker/direct parity
and the global cell cap. Server tests cover reuse, concurrent requests, subscriber
cancellation, retry after failure, selected-output isolation and cached bounds.

A synthetic loopback preview uses the production server's default work builder
and shared cached reader with a test index. It is labelled synthetic; it is not an
installed-app or real-history performance qualification. Browser expansion and
period switching preserve the single accounting-build counter. Final verification on the isolated branch:

- Local integration: 326 passed. UI: 517 passed. Selected accounting, source,
  metadata and API/documentation contracts: 69 passed.
- Source packaging: 98 passed, three artifact-only skips. Two actual native
  artifact/audit checks passed outside the outer sandbox. Client exporter: three
  passed, including explicit new-module inventory assertions.
- Synthetic resource and lifecycle checks: 42 passed outside the outer sandbox;
  the separate application/differential runner group passed 23 tests there.
- Architecture: 388 production files, 1,590 imports, zero boundary debt.
  Documentation and preflight passed (20 preflight tests).
- Browser: project and model expansion, task names/links, period switching,
  25-row pagination and keyboard disclosure verified. The instrumented shared
  reader stayed at one build across these actions, including page reload.

The initial broad suite ran 3,968 tests: 3,924 passed, 23 failed and 21 skipped.
All feature-related inventory, API, localization and packaging failures were
repaired and rerun successfully. Platform/resource failures passed their focused
reruns with host statistics and native sandbox access available. The entire broad
suite was not rerun after repairs; no blanket green-suite claim is made.

Two tool-inventory assertions are confirmed baseline defects at `dffe64d6`: the
inventory has 95 entries while its unchanged test expects 94, and it omits the
already existing admin asset generator's static caller. They are outside this
change. Two retained-release-evidence tests also reject receipts whose workload
hash/file count describes the prior source. Those receipts were not rewritten;
release qualification must regenerate evidence for the eventual final candidate.

The cache is process-local. Restart, a changed canonical generation, or an exact
window boundary still rebuilds the shared projection. No real-history speedup,
cross-generation incremental performance, signed distribution or installation
claim is made by this receipt.


## Real-history follow-up, 2026-09-09

This follow-up qualifies the production combined reader and work-usage route in
an isolated loopback preview, using a consistent read-only backup of the installed
index. It supersedes the synthetic-only limitation above for this local check;
it does not qualify an installed app or release. Source is the first-stage
`7b9dca88` commit plus the related-report and zero-usage fixes described here.
Private validation scripts retain aggregate-only receipts outside the repository.
No real task names, account IDs, source paths or transcript contents are retained
in this record. The installed index and its generation were not modified.

The initial backup contained 859,331 canonical usage facts under parser
`unified-rollout-typed-v15`; SQLite integrity validation passed. Existing
incremental ingestion on the isolated copy skipped 8,653 sources and scanned 78
(13 resumed and 65 rescanned), publishing 861,682 facts. Inserted occurrences
include replacements during rescans, so the insertion count is not net new usage.

Two real-data defects were identified and repaired:

- A roughly one-minute combined build could outlast the next moving-window
  boundary by orders of magnitude. Period and scope switches now send the last
  available `sourceSnapshotId` and retain its displayed accounting time. The
  application validates that source and the resulting canonical generation,
  rejects expired or changed anchors, and preserves the source during rapid
  switches. Polling uses only the new snapshot ID. Explicit refresh uses the
  current clock. Cache validity and freshness labels are not relaxed.
- The existing positive-usage projection returns no price for zero-token facts.
  The work accumulator now recognizes a fully known zero as zero API-equivalent
  cost without requiring a model rate. Partial, contradictory or missing token
  evidence remains unpriced. Existing nonzero exact amounts are conserved.

The initial seven-day Unassigned bucket exactly matched 37 same-size source files
whose modification identity differed from their index cursor. The metadata
reader correctly withheld stale mappings. Reindexing those changed sources with
existing ingestion resolved the bucket; no source-identity check was weakened.
After refresh, all four reporting periods have no Unassigned contributions. The
seven-day window also has no incomplete or unknown token facts; older history
retains genuine gaps. The 192 seven-day unpriced facts were all fully known
zero-token auto-review records, while all 64,089 positive-token facts had exact
prices. The zero-usage fix removes that false coverage penalty.

An independent canonical iterator and the existing accounting pricer reconcile
all four windows and populated account scopes with the combined companion
projection. Project, task-family, worktree, worker contribution, and model rows
conserve components, event coverage and exact decimal money. The comparison
explicitly accounts for the companion's five-minute future tolerance and its
omission of zero/unknown usage facts. An initial audit-script accumulator bug
in equivalent account identities was corrected before accepting the receipt.

Measured on this local history, single runs (not a benchmark distribution):

- Consistent backup and integrity check: 5.4 seconds.
- Existing incremental ingestion and publication: 49.8 seconds, about 1.11 GB
  scanned. The scan phase itself took 11.4 seconds; staging/publication also costs
  time and is not claimed to scale solely with appended usage.
- First combined report after publication: 53.8 seconds, 15,015 contribution
  cells across four windows. Independent reconciliation: 12,870 checks passed
  in 8.8 seconds.
- Browser project expansion: about 0.3 seconds. Project/model disclosure,
  keyboard collapse and a seven-day to 30-day switch kept the accounting build
  counter at one and retained the displayed timestamp.
- Explicit refresh advanced the displayed time and invoked one new combined
  build, taking 51.2 seconds; its 12,870 reconciliation checks also passed.

Refresh still traverses historical facts and source metadata. Shared computation
and warm navigation are verified; cross-generation incremental accounting is
not implemented. The next optimization should reuse unchanged contributions and
metadata under explicit source/generation invalidation, while retaining these
conservation checks. The initial report latency remains a material limitation.

The final zero-usage fix was then rebuilt against the same isolated generation
at a newer report time: 50.5 seconds and 12,868 conservation checks passed. The
changed check count reflects the moving window. Seven-day unpriced and incomplete
counts are both zero. Thirty-day history retains one unknown/unpriced fact;
all history retains 1,214 incomplete and 196 unpriced facts. Those gaps are not
relabelled as complete. Focused regression coverage includes known zero without
a rate, partial zero, missing components, contradictory output, positive unpriced
usage, and conservation when zero and priced usage share a row.


Final scoped validation: 55 focused accounting/source/API/UI regression tests,
327 local integration tests, 518 UI tests and API-reference contracts passed.
Architecture, documentation and preflight checks passed. Rendered seven-day
preview has no missing-count warning, no Unassigned row and no partial-price
labels; switching back to it retained the final build counter. The previously
recorded baseline tool-inventory and protected release-receipt limitations remain.
