---
title: Thread and project usage implementation
date: 2026-09-08
type: plan
status: implemented-preview
---

# Thread and project usage implementation

Shared accounting follow-on: [2026-09-09 implementation and limits](../design/2026-09-09-shared-work-accounting.md).
The sections below preserve the original prototype receipt.

Owner requested a viewable implementation after accepting the red-team direction
on 2026-09-08. Isolated branch: `codex/thread-project-usage`, based on verified
remote main `dffe64d60c3ea6de985c697c31678bdf22feb815`. The original checkout and
its unfinished changes are preserved. No merge, release or installed-app change.

## Delivery boundary and decisions

- Implement both projects and individual threads with worktree drill-down,
  exact-ID lookup, recent/token/API-equivalent sorting and model/account filters.
- Reuse the canonical index, source discovery/stable bounded reader, event-time
  pricer, safe local names, browser shell, regional formatting and translations.
- The first viewable implementation is entirely read-only: context observations
  and hashes live in an expiring report, not a new database schema. This is a
  deliberate smaller step than the design's proposed durable attribution tables.
  It delivers real project/thread totals while avoiding migration risk during UI
  review. A metadata-only pass does not re-derive token deltas or add usage facts.
- The existing stable source reader qualifies the indexed prefix for historical
  workspace context. It accepts same-inode append-only growth at a complete
  indexed physical boundary, while never reading newly appended usage. Deleted,
  replaced, truncated, same-size edited or unresolved context remains Unassigned. Refresh may resolve a location differently; an existing
  report never changes. This does not establish historical repository ownership.
- An atomically published index may report partial capabilities unrelated to
  tokens (for example tool provenance). Read admitted facts with separate token,
  source-order and metadata coverage; never infer missing data from that status.
- Worker-family grouping, durable names, global title search and durable project
  attribution/backfill remain later work. No dummy values enter production routes.

## Implemented owners

- `src/local-unified-index.js`: internal identity-preserving half-open fact port.
- `src/reporting/work-usage.js`: shared per-event token selection, exact cost
  accumulation, disjoint contribution cells and deterministic grouped queries.
- `src/local-work-usage-source.js`: read-only composition over the index and
  existing source mechanisms, scope-qualified identity and visible-row enrichment.
- `src/application/work-usage.js`: validated query lifecycle, cancellation,
  coalescing, expiring snapshots and opaque cursors.
- `src/platform/work-usage-projects.js`: bounded read-only local Git resolution.
- Existing companion worker/server: off-thread build and protected local POST.
- `apps/web/public/work-usage-view.js`: local page using shared styles/formatters;
  canonical English, Spanish and Simplified Chinese keys and generated mirror.

## Resource and privacy bounds

One active report build and two snapshots per companion process; five-minute idle
expiry, 1–100 row pages (25 by default), closed 4 KiB requests, at most 4,096 cursor entries per
snapshot, 25,000 threads/sources, 50,000 contribution cells, 10,000 resolved
locations and 250,000 context observations. Capacity failure is explicit and
never returns a truncated complete report. Next-page/detail queries reuse the
numeric cells and never scan canonical events. A new period/scope starts a new
report; sorting, model filters and drill-down reuse the existing report.

No source content or paths enter worker results. Approved safe basenames and
thread-name decoration exist only in transient local display sections. No index
or salt is created by the reporting reader. Custom index salts are injectable.
Unknown counts stay distinct from zero; price amounts stay decimal strings until
localized display rounding. Metadata observations carry resolver/discovery and
observation fingerprints; prices carry registry fingerprint and event-time basis.

## Validation checklist

- [x] Unit contracts: conservation, unknown/zero, output overlap, exact costs,
  stable pagination, malformed queries, cancellation, expiry and capacity.
- [x] Actual synthetic index: 100/300 cross-worktree facts, retained source loss,
  half-open bounds and unchanged source/index bytes.
- [x] Actual protected loopback route: method/media/body/Origin/Host/header checks,
  preparing/polling and stable pagination.
- [x] Final UI suite: 511 passed, including four response-boundary regressions.
- [x] Final local companion suite: 319 passed with loopback permission.
- [x] Existing index/window suite: 136 passed.
- [x] Focused reporting/source/browser/worker suite: 25 passed. Public-site
  isolation suite: 36 passed. Documentation, preflight (20 tests), architecture
  (zero debt edges), generated translations and whitespace checks passed.
- [x] Desktop and narrow rendered checks (observed widths 950 and 562 pixels):
  repository/worktree/thread totals, thread components, back focus restoration,
  exact-link lookup, model filter, cost display, and two-page totals. A requested
  390-pixel browser override still reported 562 pixels; true mobile width is
  not qualified. Override was reset. The actual saved local index also rendered
  successfully using the same worker and API.
- [x] Synthetic scale measurement on Node 26.2.0, macOS arm64 (see below).

The initial sandboxed local-server run failed because loopback listen was denied;
the same suite passed with that environment permission. This was not a product
failure. No native installation or public deployment was attempted.


## Measurement and remaining limits

The aggregation-only synthetic harness used known components and exact decimal
prices, and asserted conservation. These are local observations, not CI or
end-to-end source-scan benchmarks:

| Events | Threads | Cells | Build | Query median / max |
| --- | --- | --- | --- | --- |
| 100,000 | 10,000 | 10,000 | 301 ms | 41 / 43 ms |
| 1,000,000 | 10,000 | 10,000 | 2,806 ms | 40 / 41 ms |
| 1,000,000 | 25,000 | 50,000 | 2,725 ms | 179 / 198 ms |

Each query measurement covers ten alternating token/cost sorts. At the maximum
cell limit, retained heap growth was 70.9 MiB with both accumulator and finished
cells retained; this is not peak process memory. Maximum-size grouping exceeds
the design's 150 ms warm target, so that target is not fully met. Page queries
currently regroup bounded cells; caching ordered results is a possible follow-up
if representative histories justify its memory tradeoff.

The browser preview is ready for owner review. Durable metadata attribution,
worker-family grouping, a fully qualified native artifact, and the maximum-size
latency target remain outside this delivered preview. Reporting reads existing
history and does not refresh or backfill the underlying index.

The optional local-review artifact verifier stopped at an existing reviewed
package mismatch: its allowlist expects `fast-uri` 3.1.5 while the unchanged root
lockfile selects 3.1.6. The macOS builder already declares 3.1.6. No allowlist was
weakened to bypass that separate packaging gate. The initial public-release test
run lacked the independent worker dependencies; after installing its locked
packages, all 36 release-site tests passed.

## Review entrypoints

- Live read-only preview: <http://127.0.0.1:8795/>
- Synthetic reference preview: <http://127.0.0.1:8794/>
- Product entry: Projects in the local companion sidebar.

The two preview servers run from isolated temporary state. They are local review
processes, not an installed-app update, and the URLs require those processes to
remain running. Source work is isolated on `codex/thread-project-usage`.

## Follow-up requested on 2026-09-08

Owner requested a root-cause fix for widespread partial labels and an existing-style
primary table with projects expanded in place into named, linked threads, showing
the established token and value columns together. Acceptance: classify status-only
observations using canonical evidence; retain genuine unknown usage; conserve
known totals; reuse table/link/format owners; keep child pages bound to the same
snapshot and filters; verify actual rendered nesting and the live coverage result.


### Cause and correction

Codex can repeat complete cumulative token totals while updating allowance
information. The canonical extractor correctly admits no new tokens for an
unchanged counter, but retains an all-null usage row linked to the quota
observation. The first report incorrectly treated that row as missing usage.

The existing extractor owner now identifies exact source offsets for status-only
records: absent/null usage information with valid quota evidence, or complete,
consistent cumulative vectors equal to the preceding complete vector. The report
excludes a row only when that verified offset also matches an all-null canonical
row with a quota relation. First baselines, increases, partial or contradictory
counters, and unavailable source evidence remain unknown. Token deltas, prices
and the saved index are unchanged. Classification is versioned in report metadata.

The reader uses the recorded physical size and identity/state with the existing
stable source contract. Same-inode append growth must have a complete old line
boundary; reads stop at the indexed logical offset. Compressed sources require
exact physical state. Quarantined sources cannot provide classification. This
fixes false warnings from active files without admitting unindexed usage.

### Table revision and verification

The primary table reuses the existing accounting table, numeric cells, named
thread links and shared money/share formatters. Projects expand in place into
threads with six columns: project/thread, usage changes, tokens, token share,
API equivalent and value share. Child shares retain the whole filtered report's
denominator. Child paging pins the snapshot and filters, cancels stale requests,
and keeps keyboard focus. Worktree and token-breakdown details remain available.

The live seven-day verification excluded all 3,738 repeated status observations:
53,817 usage records remain, with zero incomplete or unknown token records and
zero projects carrying an incomplete-token warning. Source-location coverage is
separate: 739 of 740 source files supplied qualified mapping evidence, so missing
mapping remains Unassigned. This result is scoped to the saved local index and
selected period, not a claim of complete lifetime collection.

Validation after the correction: 22 source/report tests, 195 canonical-index
regressions, 513 UI tests, 319 local integration tests and 36 public-release-site
tests passed. Regressions cover repeated counters, genuine unknowns, changed and
missing sources, indexed-prefix append growth, nested paging/filter bindings and
stale child responses. Both preview tables were inspected in the browser; live
named links and the absence of the false warning were verified.


### Thread-row simplification requested on 2026-09-08

Removed the redundant three-dot token-detail navigation from thread rows. Thread
rows now end in the existing direct Codex links; exact-ID lookup can still show
its selected thread's components. Worktree navigation remains unchanged.

Reused the existing cache-drop table convention through a shared formatting
helper: `Parent task [Luna subworker]`, with independent parent and child links.
The report preserves the existing bounded local metadata reader's explicit
collaboration parent and nickname instead of flattening them into one name.
There is no inferred ancestry or change to usage grouping, sums or persistence.
The browser validates parent/child UUIDs, rejects self/mismatched links and
renders names as text. Missing names keep the existing local fallback.

Test-runner verdict: PASS. The 35 focused tests, 515 UI tests, 319 local integration
tests and 36 public-site tests passed with no failures, skips or flaky retries.
Coverage includes actual local SQLite metadata enrichment, unchanged input bytes,
parent/child link targets, bracket formatting, absence of row drill-down buttons,
and rejection of malformed ancestry. Architecture boundaries also pass.


### Inline model breakdown accepted on 2026-09-08

The owner approved an inline third level: project → thread → model. Each thread
has a separate caret and retains its canonical name/parent/subworker links.
Expanding reveals one row per model with cached input, uncached input, output
text, reasoning output and API-equivalent cost. Positive cache-write usage and
recorded combined output introduce separate columns so values are not hidden or
counted twice. Unknown values remain withheld; partial amounts are labelled.
The collapsed row names the model with the most recorded tokens and the number
of additional models, respecting the current filters.

The report composes model rows from canonical contribution cells using the same
component and exact-money merger as thread totals. It materializes model rows
only for the requested thread page, bounded by the existing snapshot cell cap.
The browser expands those immutable response rows without a second request.
One thread is expanded at a time; changing project, page or filters clears it.
No database, ingestion, pricing or external data source was added.

Validation: 20 initial focused tests passed, including model/component/cost
conservation across worktrees, filter isolation, combined-output withholding,
inline expansion with no request, unchanged thread totals, and collapse/reset.
The full UI suite passed 516 tests and local integrations passed 319 tests.
Architecture, generated translations and whitespace checks passed. The live
preview rendered a two-model thread using its saved counts and event-time costs.
The optional formatter command was rejected by automatic approval review for an
account usage-limit reason; no formatter dependency was installed or bypassed.


### Primary-thread families requested on 2026-09-08

Primary thread rows now include their explicit collaboration descendants, with
an included-subworker count. Grouping occurs before sorting and pagination.
Project, worktree and model filters apply to each original contribution before
its family is aggregated, so usage never moves between projects. Thread counts
in summaries count these families. The expanded detail separates primary-thread
usage from combined subworker usage and retains the family-wide model table.
An exact worker lookup still selects only that worker; a primary-thread lookup
includes its family, even if the primary has no usage in the selected period.

The existing protected local metadata owner now has a bounded ancestry-only
read. It follows explicit parent UUIDs for at most 64 levels and rejects cycles
by leaving affected records separate. Unknown ancestry stays separate. Group
handles remain scope-qualified and process-local. This pass reads no titles or
names and adds no durable store or accounting facts.

A missing-name diagnostic confirmed a displayed parent has a populated Codex
`title` but no explicit `name`, and the safe name resolver returns unavailable.
The current SECURITY rule excludes prompt-bearing title fallbacks. A user choice
is pending on allowing those titles only in local display; no title fallback
has been enabled by this revision.

Validation: 35 focused source/report/UI tests, 31 existing metadata regressions,
516 full UI tests, 319 local integration tests and the additional mounted family
regression passed. Family tests cover nested ancestry, cycles, roots without
local usage, pre-pagination grouping, conservation, model/worktree/project
filter isolation, exact-worker lookup and inline contributor totals.

Live verification retained the same seven-day token total while reducing the
thread count from 745 individual threads to 598 primary-thread families. One
expanded family grouped 31 subworkers; primary and subworker token/cost subtotals
matched its displayed combined values. The inspected page showed no separate
worker links. The local title-use question remains pending.


### Codex titles approved on 2026-09-08

The owner explicitly approved Codex titles for this local display. Projects &
threads now opts into the existing protected metadata reader's bounded title
fallback. Published session-index names and explicit saved names still take
precedence; parent labels use the same fallback. SQLite bounds title text to
512 characters before returning it to JavaScript. Whitespace is normalized,
NUL-containing titles are rejected before SQLite substring handling, and other
control-containing labels are withheld. The UI uses text nodes and canonical
UUID links. The default reader, cache-drop tables and ancestry-only pass still
exclude titles. No index, export, diagnostics, contribution or browser storage
was extended to contain title text. This approval resolves the preceding pending
name decision.

Validation of the approved title fallback: 83 focused metadata/source/UI tests
and 319 local integration tests passed, followed by the affected UI suites
again after the display adjustment. Architecture, documentation and whitespace
checks passed. The refreshed live seven-day preview showed named links for all
25 families on the first expanded project page, retaining grouped subworkers.
Long titles display at most two lines, with their full bounded text retained for
accessible links and hover inspection; the disclosure caret stays aligned.
Both local preview servers remain available for review.

### Unassigned and unpriced history corrected on 2026-09-08

The all-history preview's 7,903,052,909 Unassigned tokens exactly matched the
installed v14 index's unknown-model tokens. Source inspection confirmed initial
`session_meta.cwd` and later applied-settings directories were present, but the
view read only turn-context locations. The transient reader now consumes those
explicit location observations in source order. Omitted fields preserve the
last location, malformed updates invalidate it, and later observations never
backfill earlier events. The resolver version is now work-location-v2.

The existing v15 canonical reader already recovers historical parent models at
the applicable boundary; the preview had been reading the installed v14 index.
A fresh owner-only temporary index was built with that existing reader and the
preview now reads this separate snapshot. The installed index was not modified.
All 855,771 prior event identities were preserved with zero token-component
changes; the new snapshot also includes 170 newly recorded events. Every prior
unknown-model token was resolved and priced, recovering 5,841.76424832 USD in API
price equivalents. The refreshed all-history report has no Unassigned bucket
and no unknown-model cells. Other historical partial-price cases remain distinct.

Validation: 28 focused source/report tests passed, covering session directories,
settings-driven worktree changes, sparse and malformed context updates, canonical
token conservation and withholding prices without a recorded model. Architecture,
documentation and whitespace checks passed. The refreshed seven-day report was
inspected in the browser. Browser automation could read the rendered page but
its click and screenshot commands timed out during the all-history visual check;
all-history attribution and pricing were verified directly through the same
production report builder.
The full local integration suite also passed: 319 tests. Its initial sandboxed
run could not bind loopback ports; rerunning with local networking permitted
completed successfully.
