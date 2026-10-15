---
title: R7 admission repair and complete suite verification
date: 2026-10-14
type: plan
status: in-progress
---

# R7 admission repair and complete suite verification

The last completed hosted candidate, `fd0112d0c`, passed PostgreSQL and Cloud Run gates
and four auxiliary workflows. Its hosted Worker runtime ran all 2,836 tests
and failed one graph case at the unchanged five-second limit; later Worker
stages were not reached. The complete local Worker pass belongs to predecessor
`60e00d9ee`. Five local experimental files remain preserved and uncommitted.
A bounded Linux thread diagnostic has passed portable tests and independent
review; its hosted Linux execution is pending. No graph timing repair is
established.

The Claude ingestion and repeated-plan validation repairs are reviewed and
tested. The 15 October R7 attempt passed all six synthetic phases and
complete-corpus admission, then failed the unchanged elapsed-resource limit.
All ten original receipts were preserved. R7 receipt freshness, the full local
umbrella gate and final-commit hosted CI remain pending. Another private-history
regeneration requires explicit owner authorization after an automatic
approval-review refusal. No resource limit or test assertion was relaxed. The
suite is not green.

The owner requested resolution of the remaining R7 blockers and a complete
green root suite without weakening checks. Work starts from clean
`f86e58b4a79c16bcb0452977e33fdb4d4b5a83c1` and continues the
[security closeout](../reviews/2026-10-13-security-remediation-closeout.md).

Acceptance requires a diagnosed, regression-tested correction where a source
defect exists, independent review, complete protected regeneration of all ten
receipts on frozen source, passing freshness checks, a completed `pnpm run check`
with no failures or cancellations, and passing hosted CI on the final commit.
Existing platform qualification skips
remain explicit; no new skip, relaxed assertion, increased admission limit or
timeout, partial receipt reuse, or private-input alteration is permitted.

| Owner | Responsibility | State |
|---|---|---|
| R7 admission owner | Classify the refused input; fix the confirmed one-byte under-rejection in both Claude tail readers | Implemented and reviewed in `22bf86eed` |
| Admission contract reviewer | Independently trace discovery, line admission, interval filtering, source frontiers and integrity contracts | Existing limit refusal confirmed; strengthening correction specified |
| Benchmark cancellation owner | Propagate cancellation to the owned child without changing workload, timeout or assertions | Implemented in `9b4bb3d5733151efe62f68b713c306ed7f479312`; independent review and 121 focused checks passed |
| Snapshot investigator | Inspect documented artifacts and bounded local metadata for an existing complete, unmodified corpus snapshot | No candidate found in the documented locations checked |
| Coordinator | Integrate reviewed fixes, freeze source, supervise authorized validation and record exact outcomes | Focused repairs reviewed and tested; protected regeneration and final gates pending |

Any newly authorized private-history operation must remain local and follow the
[R7 maintenance runbook](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md).
Only content-free diagnostic classifications may leave the reader. Private
history, paths, filenames, identifiers and record contents must not enter
reports, fixtures, logs or external services. The retained interval and both
hash-pinned runtimes remain unchanged. The owner authorized pushing the branch,
updating the PR and merging when ready. Signing, release publication and
deployment remain separate operations.

The previous refresh failed before source-plan freeze with
`operation=create source=claude_transcript reason=export_resource_line_bytes`.
A bounded local byte-count census now establishes one complete structured line
of 30,678,766 bytes above the existing 16,777,216-byte (16 MiB) limit and no
unfinished tails or observed source identity/size changes. No source contents,
filenames or identifiers were parsed,
copied or emitted. The refusal was required by the pre-integration implementation;
interval/type eligibility remains unknown and does not bypass the preparse cap.
The owner was unsure whether a complete unmodified historical snapshot exists.
No input selection, filtering or substitution has been performed.

The bounded snapshot investigation found no raw-corpus candidate in documented
checkout artifacts, R7 transaction artifacts or the documented temporary-root
locations. Plans remain in memory/stdin; backup artifacts preserve receipts or
derived SQLite, not raw history. This is not a claim that no snapshot exists
elsewhere, and no undocumented private location was searched.

Independent synthetic probes found a separate under-rejection: a file with no
newline and exactly limit-plus-one bytes can pass the tail search as an empty
prefix. Correcting both Claude helpers strengthens the existing boundary, but
did not admit the oversized current record under that implementation. The retained oversized-tail
refusal, exact-limit behavior and old frozen-prefix verification must remain.

A synthetic Node test also confirmed that the outer test timeout does not stop
an awaited child when its abort signal is not propagated. The benchmark repair
must prevent receipt emission after cancellation and preserve the private task
tree if termination cannot be confirmed. This is a cleanup defect, not an
established explanation for the initial timing slowdown.

Before main integration, a fresh matrix could not be produced from the current
corpus under the unchanged limit. No blind regeneration retry is justified. Any existing snapshot must be
complete, unmodified and suitable under the same evidence contract; derived
receipts or plans cannot substitute for missing raw input. A passing focused
retry alone is not a green complete suite.

## Verification record

The admission correction passed both complete owning files: 21 transcript
export tests and five incremental-canonicalizer tests. Independent reviews found
no remaining issue in those changes. Architecture and documentation checks
passed before the local commit.

The cancellation owner's permitted serial lane passed 121 tests without skips,
failures or cancellations. The original materialized benchmark and the new
abort-during-final-cleanup regression each retained the complete two-pass
workload and their 30-second limits. A real synthetic `node:test` subprocess
confirmed that test cancellation kills and observes closure of its owned child.
The first restricted execution encountered the known RSS-inspection permission
gap; the permitted run passed without changing an assertion or budget.

Independent cancellation review found no remaining issue and reran the frozen
three-file lane: 121/121 passed, with no failures, cancellations or skips. Both
reviewers confirmed that timeout budgets and existing workload assertions remain
unchanged. Final architecture and all 22 preflight tests passed.

The full root command `pnpm test` completed on clean integration commit
`9b4bb3d5733151efe62f68b713c306ed7f479312`, using Node.js 26.2.0, normal umask
022 and permitted local OS inspection. It ran 6,265 tests in 475.766 seconds:
6,216 passed, two failed, zero cancelled and 47 skipped. The retained platform
skips were unchanged. The original materialized benchmark passed in 6.774
seconds, and the real abort-during-final-cleanup regression passed in 7.228
seconds with the existing 30-second limits.

Both failures are in `test/r7-generated-release-evidence.test.js`: current-code
receipt revalidation and exact decision rebuilding from the eight runtime
inputs. Both reject stale `/contractProvenance/workloadCodeSha256` evidence.
No other failure or cancellation remained in this full run. All ten retained
R7 receipts are byte-for-byte unchanged from the previous closeout, and no
regeneration journal, staging or backup artifact remains. No fresh matrix or
green aggregate suite has been established.

## Pre-integration input blocker

Before integrating current main, the next dependency was an owner-supplied exact location and provenance for an
existing complete, unmodified raw corpus snapshot suitable under the unchanged
identity contract and registered 24 June–25 July 2026 interval. That snapshot
must first pass bounded, owner-only admission and integrity verification. If
it qualifies, regenerate all ten receipts together on frozen source under both
pinned runtimes, rerun freshness checks, and rerun the complete root suite.
Keep any supplied private location out of this document and test artifacts.

The owner was unsure whether such a snapshot exists. No compliant local path to
green remained under the pre-integration implementation with the available inputs. A filtered copy that removes
the oversized record does not preserve the evidence. Changing the admission cap
or input policy requires a separate explicit product decision outside these
repairs. Native qualification, signing, release and deployment remain separate
gates.

## PR integration

The owner authorized pushing a PR and merging when ready. The reviewed source
at `b703ecb38a0737c1453190482bb122d10b741d6a` was pushed as
[draft PR 296](https://github.com/adamallcock/tibotattle/pull/296). The PR remains
draft while the R7 gate above is blocked; hosted checks do not replace the
complete root gate.

Integration with `main` at `7f521836fe7b6e8df7dbb88b53f04a2511dac6ba` resolves
nine overlapping Worker, locale and tool-inventory files. Both parents' locale
keys and inventory records are retained, and generator-owned catalogs and
Worker types are regenerated from canonical inputs. Focused locale tests passed
20/20 and tool-inventory tests passed 6/6. Five documents introduced by `main`
also required portable replacements for private absolute paths under the
unchanged documentation validator; their historical evidence is preserved.

The new GCP edge composition requires explicit appcast admission bindings and
public-probe admission around forwarded health/readiness requests. These
integration repairs retain the existing limits and fail-closed behavior.
The corresponding staging profiles, synthetic snapshots, dry-run harnesses and
pre-credential checks retain those exact operational limits. Maintained staging
callers also exposed missing overlay/reference adapters and an ignored staging
health origin; the repairs preserve the production defaults and existing
isolation checks. No live resources were changed.

Focused integrated Worker validation passed 202 runtime tests and 113 script
tests with no skips or cancellations, plus TypeScript and generated-type checks.
During integration, the unchanged application gates passed: UI 1,094/1,094,
local companion 420/420, macOS transition 127/127, release site 82/82, release
trust 87/87, and local-review runtime. Telemetry mirrors and preflight also
passed. These are source and local test results, not installed/native release
qualification. Complete frozen-source validation must
finish before any stronger readiness claim. The pre-PR root suite result above
remains attributed only to its named commit.

The integration was committed and pushed as
`a1ac524ff5b7ddf73562ada93624ee0f9233bcba`. Independent review cleared the
edge, staging and configuration repairs. Its complete local Worker command
finished with exit 1 after 1,084.058 seconds: the preceding Node phases had
1,304 passes and seven existing PostgreSQL-dependent skips, then Vitest had
2,807 passes and three failures across 184 files. The remaining command stages
were not reached. The three health/readiness parity failures exhausted the
unchanged burst-two admission bucket shared by independent table rows; their
response assertions must remain intact while the scenarios receive isolated
test state and explicit lease-cleanup checks.

Hosted CI also exposed an omitted classification for three newly added
operational rate-limit bindings. The correction declares their exact edge-only
inventory without adding them to the six replay bindings or nine injected
origin bindings. It retains shape, duplicate, missing and unknown-name refusal,
and both origin service planes explicitly reject injection of those bindings.
Independent review cleared this correction. Its focused configuration checks
passed 54/54; the complete owning offline infrastructure gate passed 390/390,
both with zero skips or cancellations.

The parity correction separates the original 14 readiness rows, eight health
rows and five malformed-source values into independent cases. All original
response and exact/absent-source assertions remain, and each migrated request
checks that its named probe budget has zero active leases before the next test
reset. The owning file now passes 39/39 cases, compared with the previous 14
tests containing three failed multi-row cases. Independent review, TypeScript,
documentation and all 23 preflight checks passed. No production admission
limit, timeout or assertion was relaxed. Full root and final hosted results
remain pending for the corrected candidate.

The complete root suite on clean, pushed
`10ed81fb6e0a3adecde214fbbe57f6bc7b559152` finished in 479.127 seconds:
6,394 tests, 6,346 passes, four failures, zero cancellations and 44 platform
skips. Two failures remain the R7 workload-hash freshness checks. The other two
are the incremental same-length mutation rejection and complete-line CR byte
boundary case. The incremental fast path truncates timestamps to milliseconds;
the proposed repair preserves sub-millisecond precision without adding a full
prefix scan to unchanged refreshes. Final assertion details confirm a missing
expected rejection in both Claude cases. Hosted Cloud Run checks passed on
this commit; Worker and PostgreSQL gates are still running.

Main commit `8a2e1783a326762468c7b9eebf3a62e1d67f865b` records an accepted
exporter repair that uses the existing bounded skip-and-count rule for complete
Claude lines incapable of carrying usage. This preserves complete raw inputs
and their integrity coverage, but its literal-only key detection misses escaped
JSON keys. The corrective work must conservatively retain such lines as
potentially relevant, preserve the exact 16 MiB and unfinished-tail limits,
retain irrelevant-line counters and update the boundary fixture to exercise a
usage-bearing record. The maintenance runbook must distinguish this bounded
reader behavior from prohibited input filtering. The private oversized record
has not been classified under the corrected predicate. Only reviewed source,
passing synthetic regressions and a frozen candidate can justify a new protected
regeneration attempt; no private-input retry has occurred at this stage.

On 15 October 2026, both source corrections completed independent review with
no actionable findings. All 52 owning tests passed on each pinned runtime,
Node.js 24.14.0 and 26.2.0, as did the three affected synthetic benchmark cases
on each runtime. Architecture passed with 1,006 production files, 4,367 imports
and zero debt edges; documentation, all 23 preflight checks and whitespace also
passed. The escaped-key regression demonstrably fails against the old source.

The canonicalizer now retains fractional timestamps and migrates v0.2 stores
forward to v0.3 with nullable precision metadata. Legacy rows revalidate their
prefix once before using the unchanged fast path; parsing metrics and bounded
tail work remain intact. A transactional database guard prevents actual v0.2
readers from overwriting the v0.3 schema marker. Historical-reader probes on
fresh and migrated populated stores preserve version, schema and logical rows.
Unknown/newer closed stores are refused without changing their bytes or creating
sidecars. Existing live-WAL reads retain SQLite coordination to see committed
versions; coordination bytes are not claimed immutable. Identical or deliberately
restored filesystem timestamps remain outside the metadata fast-path guarantee.

Both pinned binaries, all ten unchanged owner-only receipt destinations and
absence of transaction artifacts were reverified. The next step is one complete
protected regeneration attempt after committing and freezing these repairs.
This is justified by the reviewed inherited reader policy and its new escaped-key
correction, not by a changed cap, interval, selected corpus or receipt hash.


## Protected attempt and remaining integration work — 15 October 2026

The complete protected attempt at
`ea57471257ab9b3c5b9ba5e1ac2f3419200736d6` held the workload source closure
unchanged throughout execution.
All six synthetic phases passed. The complete shared source plan froze
successfully, clearing the earlier line-admission blocker under the reviewed
reader policy. The history lifecycle subsequently failed with
`export_resource_elapsed_time`; its existing cumulative active-operation budget
is 600,000 ms. The failure did not identify the operation, runtime or pass, so
no exact attribution is claimed. All ten original receipts remained
byte-identical with owner-only permissions, and no transaction or cleanup
artifacts remained. No partial receipt was installed and no input was changed.

Static investigation found that Claude bundle verification revalidated the full
plan for every source, causing quadratic metadata work. The scoped repair uses
one complete validation followed by source-specific verification, retaining
source identities, frozen-prefix hashes, interval checks and caller-mutation
refusal. This is a concrete performance defect and a plausible contributor to
the elapsed failure, not a measured causal conclusion. Independent security and performance reviews are clear. All 29 owning tests
pass on each pinned runtime, including full-plan integrity, later-source prefix
corruption, nested caller mutation, linear metadata scaling and source counters. A separate
reviewed diagnostic change preserves only closed operation/runtime/pass labels
alongside the sanitized failure code; all eight owning tests pass on each
pinned runtime. Neither change alters limits, accounting or receipt admission.

Hosted run `38677723777` at `10ed81fb6` passed Cloud Run. Worker completed
2,835 tests with 2,833 passes and two failures caused by existing five-second
case limits; PostgreSQL repeated eight inherited assertion failures and reached
its unchanged 45-minute job limit. Reviewed candidate repairs restore current
projection identities, distinguish classification-proof reads from usage-fact
probes, complete the exact migration inventory, and execute the blob-verified
historical oracle independently from current code. Historical pricing parity and separate current-pricing coverage now pass
against disposable PostgreSQL 17.11. Worker fixture setup is
batched or split into independent cases while retaining every original
assertion and five-second limit.

PostgreSQL CI is being partitioned into four closed, disjoint parts of the same
95-file canonical plan. Each retains the 45-minute limit, serial file execution
and strict missing/duplicate/skipped-result refusal. A final aggregate requires
all four parts to succeed; no runner or test is removed. All 73 scoped runner/workflow tests and all 87 release-trust tests pass on
Node.js 26.2.0, with zero skips or cancellations; policy validation covers 25
workflow files. Backend runtime validation, the complete final `pnpm run check`,
and final-commit hosted CI must all pass before the authorized merge of PR #296.


The repaired projection paths passed all 35 tests across the three owning files
against disposable PostgreSQL 17.11, with zero skips; Worker TypeScript also
passed. The three Worker timeout cases passed individually in 2,064 ms, 860 ms
and 1,223 ms under their unchanged 5,000 ms default; the full umbrella remains
responsible for unfiltered coverage. Historical-oracle provenance passed against
the actual pinned source. Its first v0.1 comparison reproduced a difference in
pricing method, registry version and registry digest, while contribution costs
matched. The narrow, explicitly historical test composition passed every original
full-row comparison, including usage records. Separate complete current-pricing,
persisted-provenance, replay and retired-route checks also passed. No historical
assertion or production pricing behavior was discarded.


The complete occurrence file passed 20/20 tests, including family-first bounds,
40,000-plus-one refusal, rollback, cancellation and index negative controls.
Both complete historical-oracle and migration-inventory files passed 37/37
with zero skips or cancellations. The four CI partitions, projection repair,
fixture changes, occurrence probe repair, historical oracle and R7 source
changes have independent review and publication-privacy clearance. Documentation,
all 23 preflight checks and architecture also pass. The disposable database was
stopped after validation. The next gate is one complete protected R7 attempt on
the frozen candidate; its success is not presumed from these focused results.

## Current candidate verification — 15 October 2026

The pushed candidate `b57ac6fdac82b1390d131c95aea0a8221c389af5` completed
the full root suite with 6,432 tests: 6,386 passes, two stale R7 receipt failures,
zero cancellations and 44 existing platform skips. Its protected regeneration
launch was rejected by automatic approval review before execution because exact
authorization for the private-history read and atomic ten-receipt replacement
was not established. No process started, private corpus was read or receipt
changed in that attempt. The owner confirmation remains pending; no alternate
execution path is authorized by this refusal.

The separate product run passed UI 1,094/1,094, release site 82/82, local
companion 420/420, Worker application 2,836/2,836 across 184 files, Worker Node
2/2 and analytics 349/349. Eleven existing Worker script skips required a local
PostgreSQL environment; these are distinct from the zero-skip application suites
and the actual PostgreSQL tests recorded above. The product command then
correctly rejected an ignored public-site build left from before main integration.
Canonical regeneration repaired that local prerequisite without source changes.
Both remaining Worker dry-run commands passed on clean `0ab39d92`; no deployment
occurred. Separately, macOS transition passed 127/127 and local-review runtime
qualification passed. These completed pieces do not relabel the failed original
aggregate as a passing complete run.

Hosted run `38688571002` at `b57ac6fda` passed Cloud Run and the complete
PostgreSQL Vitest partition, 15 files and 107 tests with zero skips. Dependency
scanning, release trust, documentation and contract drift also passed. The first
Node partition passed 40 files and 261 tests with zero skips. The second Node
partition completed 39 files and 333 tests: 332 passed, one timed out and none
skipped. The real v12 SQL 40,000/40,001-variant boundary exceeded its unchanged
600-second case limit; the 45-minute job limit was not reached. The aggregate
correctly failed. The bounded SQL path received the follow-up repair below. Worker passed
all 2,836 application tests, then its historical-vendor test failed because the
shallow checkout lacked required source history. Edge integration passed
13/15 tests and failed the closed limiter inventory and golden comparison.
Commit `0ab39d92` adds the three current operational guards to the exact inventory
without expanding route-admission replay and adds bounded comparison diagnostics.
Before the follow-up repair, the focused golden reproduction failed its unchanged
zero-difference check:
336 spend-provenance, 74 allowance-breakdown, 72 model-day and 76 preview
differences. The PR remains draft and unmerged.

The reviewed follow-up comparison repair builds an explicitly selected current
Q1 expectation from immutable, hash-pinned historical inputs and independently
pinned current metadata. It preserves every historical amount, count, coverage,
common-plan and model value; validates all additional four-plan and catalog
fields; and retains exact zero-unexpected and per-date comparisons. Legacy
comparison behavior and historical fixtures remain unchanged. Mutation coverage
rejects altered values, provenance, metadata, wire shape and duplicate days.
All 95 owning checks passed on both Node.js 22.16.0 and 26.2.0. The complete
15-case edge file passed against PostgreSQL 17.11 in 334.46 seconds with zero
failures, skips or cancellations, including every route probe and the full S9
rehearsal. Documentation, all 23 preflight checks and architecture also passed.

The Worker CI prerequisite correction fetches full history while retaining all
provenance assertions, action pins, permissions and deadlines. Its workflow
tests passed 23/23, workflow policy verified 25 files, and release trust passed
87/87 with zero skips. Independent reviews of both repairs are clear.

The SQL boundary diagnostic measured 39.492 seconds of duplicate occurrence
reads in one 129.587-second local v12 run. The repaired test asserts on the
original returned values and original refusal codes retained by its existing
comparison call. It preserves independent base/candidate reads, complete
occurrence and fingerprint parity, exact 40,000 acceptance and 40,001 refusal,
the 200-ID batch and the 600-second deadline. No production SQL or fixture was
changed. Six helper checks cover assertion propagation and normalization edge
cases. Independent correctness and privacy review cleared the final source;
the complete two-case boundary file passed against PostgreSQL 17.11 and Node.js
26.2.0 with zero failures, skips or cancellations: legacy 59.078 seconds, v12
108.274 seconds, total 167.487 seconds. These local timings do not establish a
hosted speedup. The final complete local run, final-commit hosted CI, and
explicit R7 authorization and replacement remain outstanding.

The pushed follow-up `52db7a1066bc23a7d406863595bd5f67fd4ef878` passed the
complete local product gate in 1,823.91 seconds. Worker application passed all
2,836 tests across 184 files, and analytics passed 349 tests across 33 files,
both without skips. The existing 11 local PostgreSQL-environment script skips
remain separate from hosted database coverage. Dry-run staging, macOS transition
and local-review runtime qualification also passed. The full root rerun finished
6,433 tests: 6,387 passes, the same two stale R7 workload-hash failures, 44
existing platform skips and zero cancellations. The umbrella stops at those
failures; its complete product portion passed separately on the same commit.

Hosted run `38694697425` passed all four PostgreSQL partitions and their strict
aggregate: exactly 95 files and 716 tests, with no skips, duplicates or gaps.
Cloud Run, documentation, release trust, dependency scanning and contract drift
also passed. Worker completed 2,836 runtime tests with 2,835 passes and one
five-second timeout in the full 16-owner graph-publication meter case. The job
ended at 47 minutes 15 seconds, before its unchanged 60-minute limit. No semantic
assertion mismatch was reported. The same source had passed locally and in the
previous hosted run; the cause of its timing variation is not established.

The scoped follow-up removes 90 redundant setup statements by draining the
ordered journal after all uploads and reading the stable owner roster once.
It adds exact equality between all 16 source events and their target receipts.
All 16 upload journeys, 32 serial fresh-scope kernel computations, four daily
passes, both real publications, exact 14/16 statement counts and the five-second
limit remain. Independent strictness review is clear and the full owning file
passes 36/36 without skips. The measured local timing improvement is small;
hosted timeout robustness remains unproven until the next complete CI run.
R7 authorization, regeneration and final freshness checks remain pending.

Hosted run `38702465381` on `df269a9e9` passed all 184 Worker runtime files and
2,836 tests, including the repaired 36-case graph file. Its meter case reported
4,842 milliseconds including lifecycle; no separate body timing was exposed.
Analytics passed 33 files and 349 tests, and the historical vendor checks passed
59/59. All four PostgreSQL partitions and their aggregate passed 95 unique files
and 716 tests without skips or coverage gaps. Cloud Run, documentation, release
trust, dependency scanning and contract drift also passed.

The Worker job then failed at 40 minutes 36 seconds in the production-shape
tooling checks, before its unchanged 60-minute limit. That stage passed 33 of
36 tests, with two failures and one existing missing-shell skip: the local
measurement helper passed macOS `time -l` to GNU time on Ubuntu, and a real
cleanup test could not spawn `zsh`. The preceding fast-path script checks passed
211 tests with two existing environment skips. The next repair must supply the
required shell and select the correct platform measurement interface while
preserving real child execution, metric units, cleanup assertions and every
existing limit. This run establishes the graph repair's hosted pass, not a
complete Worker gate or Linux production measurement qualification. R7 consent
and regeneration remain pending; the PR stays draft and unmerged.

The reviewed platform repair explicitly provisions `zsh`, GNU time and procps
in the Worker job, verifies the exact process-tool paths and `zsh/datetime`,
and bounds setup to five minutes within the original job deadline. The native
timer retains BSD behavior on macOS and selects a fixed GNU format on Linux,
normalizing RSS to bytes while keeping unavailable or invalid metrics explicit.
Unsupported platforms refuse before measurement work. The real child launch,
arguments, resource environment, ownership checks and cleanup deadlines remain;
missing-shell skips and silent syntax-check bypasses are removed.

Node.js 26.2.0 on macOS passed all 39 production-shape checks without skips,
including the real child and cleanup cases. Workflow checks passed 24/24,
workflow policy verified 25 files, and release trust passed 87/87. Independent
reviews of the timer and prerequisite changes are clear. The Worker README and
operations runbook now document the prerequisites. Full final-candidate local
and hosted validation, native Linux execution and the protected R7 gate remain
outstanding; these focused results do not establish a full measurement receipt.

Candidate `0d8cde0d0` passed the complete local product gate in 1,468.89 seconds,
including all 2,836 Worker runtime tests, 349 analytics tests, 39 production-shape
checks, 127 macOS transition tests and the dry-run and local-review tail gates.
The 11 existing PostgreSQL-environment script skips remain separate. Its root
run completed 6,434 tests in 483.466 seconds: 6,388 passed, the same two R7
workload-hash freshness checks failed, and 44 existing platform cases skipped.

Hosted run `38709067567` passed all 95 unique PostgreSQL files and 716 tests,
with no skips or coverage gaps, plus Cloud Run and all auxiliary workflows. The
new Worker process prerequisites installed and passed their smoke checks. The
Worker runtime then finished 2,836 tests with 2,835 passes and one timeout in
the same graph meter case; its reported lifecycle duration was 7,472 milliseconds.
The job ended after 47 minutes 19 seconds, before its original 60-minute limit.
The graph file's bytes match the preceding hosted pass. No semantic assertion
mismatch was reported, but the earlier fixture optimization has not provided
sufficient timing margin. The later Linux timer and shell-cleanup checks were
not reached. The next scoped repair must reduce measured fixture work while
retaining all real journeys, calculations, publication assertions and the
five-second case limit. No blind rerun or resource-limit change is justified.

Two further synthetic diagnostic runs on the unchanged graph source isolated
database-call cost. The final run measured 731 milliseconds in the 32 kernels,
including 621 milliseconds covered by active database calls. Each computation
made 93 calls containing 106 statements. Across the complete set, 96 repeated
short-page reads consumed 45 milliseconds, only about 3.2% of the profiled
1,398-millisecond test phases. All non-database kernel work together occupied
110 milliseconds; the coarse runtime timer did not establish a material cost
for the separately identified unused scalar-evidence hashing. These are local
diagnostics, not hosted performance or a demonstrated timeout repair.

The diagnostic cases ran every original assertion before intentionally reporting
their closed timing summaries as failures; they are not counted as green test
runs. Instrumentation was removed and the test file restored byte-for-byte to
`0d8cde0d0`. No production optimization was adopted on these measurements.
Whole-upload concurrency remains unsafe because admission shares a row allocator.
Splitting the publication case would omit its combined model-history and preview
path unless the preview case retained the full workload. A follow-up must preserve
that coupled path, all fresh source and authority checks, checkpoint recovery,
statement accounting and the unchanged five-second limit. The hosted timeout and
the separately consent-gated R7 replacement remain unresolved.

A subsequent production prototype batched independent metadata reads at the
same validation boundary: the ordinary v1.1 source-pin, collection-control and
calculation-authority proofs, plus two checkpoint-save metadata pairs. It reused
the existing SQL and row validators. Separate prewrite and postwrite proofs,
checkpoint part writes, compare-and-swap promotion and final readback remained.
Every statement was still charged. A failed native batch propagated immediately;
a later SQL failure could take precedence over an earlier invalid row, but could
not authorize a write or accepted result. Successful results retained validation
order.

Three paired synthetic runs retained all original publication assertions and
exactly 3,392 kernel statements in each run. Database round trips fell from 2,976
to 2,208, a 25.8% reduction. Median kernel time fell from 729 to 642 milliseconds
(11.9%); median whole-case time fell from 1,448 to 1,393 milliseconds (3.8%), with
one pair slightly slower. This demonstrates reduced round trips and local kernel
cost, not sufficient hosted timeout margin. All timing instrumentation was removed.
The four owning files passed 81 tests without failures or skips, and TypeScript,
architecture, documentation and all 23 preflight checks passed. Independent review
found no actionable safety or correctness issue. The prototype preserved the
original 16-owner case and its limit; its lost-response test injected failure
at the same part-write operation after the two new metadata batches.

The prototype was not adopted. Review established that the maintained scheduler
constructs a selected snapshot and therefore bypasses the ordinary-source batch;
only the checkpoint batching applies to that runtime path. Combined with the
small whole-case timing gain, the broader change is not justified as this timeout
repair. The prototype and its evidence are retained locally for future review,
and its seven files are restored to the unchanged candidate. The next diagnostic
run will collect bounded aggregate runner-resource measurements alongside the
unchanged hosted Worker gate. It must preserve the full test command, its exit
status, all existing timeouts and every existing check.

The diagnostic wraps the exact Worker command with a single owned `vmstat`
sampler at 30-second intervals. It logs aggregate counters and timestamps only,
preserves the gate's exit status, and kills and reaps the sampler on ordinary
exit or trapped cancellation. A successful gate also requires the sampler to
remain alive. The existing job deadline bounds the output. No runner, resource
limit, test timeout, required check, permission or action pin changes.

The executable shell regression belongs to the mandatory Ubuntu workflow
contract step, outside the portable root test glob. The root test enforces that
unconditional route and exact gate command. Synthetic cases exercise success,
gate failure, sampler failure, simultaneous failure and both interruption
signals. They check arguments, status preservation and sampler termination;
forced untrappable termination is outside the cleanup claim. This diagnostic
adds evidence for the next run; it does not resolve the hosted timeout or the
separately pending protected R7 operation.

Hosted run `38722050344` on `676ac10a8` passed all 95 canonical PostgreSQL
files and 716 tests, the strict aggregate, Cloud Run and all four auxiliary
workflows. Worker runtime passed 184 files and 2,836 tests in 1,423.96 seconds;
its graph meter case passed in 4,879 milliseconds. The separate Node lane passed
2/2, and analytics passed 33 files and 349 tests in 434.70 seconds. The unchanged
graph case has both passing and failing hosted outcomes; its timing remains
flaky, and this diagnostic commit does not establish a timeout repair.

The Worker job failed after 39 minutes 27 seconds in the production-shape
process test: 38/39 passed with no skips or cancellations. The signal-cleanup
harness did not observe its required owned-child evidence within the existing
five-second startup bound. It failed before sending a signal, not at the
teardown deadline. The original failure lacked a scenario label, so the specific
variant and cause require a focused diagnosis. The native timer matrix and real
caller cleanup checks passed; deployment dry-run and staging checks were not
reached. The wrapper preserved the gate's failure exit status.

Excluding the initial since-boot report, 77 aggregate 30-second resource samples
showed no swap activity or stolen CPU and at least 7,165,696 KiB free memory.
Adjacent samples around the graph report showed 73–74% aggregate CPU idle.
The final sample overlapped the start of the failing process test but did not
cover its complete failure window. These coarse samples neither establish
resource pressure as the cause nor exclude short or per-core stalls. The next
repair retains all process scenarios, assertions and five-second bounds. An
early mandatory run of the existing production-shape gate will expose Linux
process failures before the full Worker gate, which retains its complete check
chain and the later production-shape run.

Source review identified a concrete test portability defect: three harness
invocations reopen Node-captured stdio through `/dev/stdout` and `/dev/stderr`.
The [pinned Node.js documentation](https://nodejs.org/download/release/v26.2.0/docs/api/child_process.html#optionsstdio)
explicitly excludes that descriptor-filesystem access. The first such invocation
is the resistant-root scenario, but the unlabelled hosted failure does not prove
which scenario failed. The narrow test correction retains regular log destinations
and duplicates the capture descriptors with shell-native redirection at those
invocations. Descendants inherit the duplicates, so the capture-close assertion
still depends on their exit. Production shell functions, all eleven scenarios,
PID visibility and group ownership, the unrelated sentinel and five-second
startup and cleanup bounds remain unchanged. Closed scenario labels make future
failures attributable without exposing shell output or private data. Native Linux
qualification still requires the new hosted run.

On Node.js 26.2.0/macOS, the complete production-shape gate passed 39/39 with
zero skips, failures or cancellations; its signal case exercised all eleven
variants in 7.910 seconds. A separate bounded synthetic control verified that
the inherited duplicate descriptors keep Node captures open after the parent
exits, while ordinary file redirection does not, and confirmed exact-group
cleanup. Independent review found no weakened assertion or workload. Workflow
and sampler checks passed 26/26, release trust passed 87/87, and policy checked
25 workflow files. These focused results qualify the test correction locally;
the next hosted run must prove its Linux behavior and complete the unchanged
Worker gate.

Hosted run `38728825727` on `ec45fb401` passed Cloud Run and all four auxiliary
workflows. Its PostgreSQL partitions executed all 95 unique canonical files and
716 tests without skips, missing files or duplicates; 715 tests passed and the
v12 real SQL boundary case timed out at its unchanged 600,000-millisecond limit.
The case retains 40,000 accepted variants, refusal at 40,001 and the 200-ID batch.
Its reported duration was 600,001.691 milliseconds; no semantic assertion
mismatch or failing intra-case phase was reported. The legacy boundary case
passed in 139,469.071 milliseconds. The node-2 job completed after 28 minutes
48 seconds, before its 45-minute deadline, and PostgreSQL cleanup succeeded.
The strict aggregate correctly failed. Previous passing evidence does not close
this new timeout; diagnosis must establish a bottleneck before a repair or rerun.
The Worker job then failed after 45 minutes 8 seconds, before its 60-minute
deadline. Its early native Linux production-shape gate passed all 39 tests with
no skips or cancellations in 10.313 seconds, including the repaired signal case.
Worker runtime completed 184 files and 2,836 tests: 183 files and 2,835 tests
passed; the same full 16-owner graph publication case exceeded its unchanged
5,000-millisecond timeout, reporting 6,997 milliseconds. The graph file passed
35 of 36 tests. No assertion mismatch was reported. The later Node, vendor,
analytics, fast-path, production-shape and deployment dry-run/staging gates
were not reached. The earlier process repair is now natively qualified, but
the complete Worker gate and graph timing remain unresolved.

Its 88 aggregate 30-second resource intervals, excluding the initial since-boot
report, again showed no swap activity or stolen CPU time. Free memory stayed
above 8,321,000 KiB. Samples around the graph file showed 74% aggregate CPU idle
and 1–2% I/O wait. Results were buffered, so an exact per-case wall-clock window
is unavailable. These measurements do not establish a resource cause or exclude
short or per-core stalls.

A bounded local diagnostic on the unchanged complete v12 boundary passed in
88.542 seconds, retaining every 40,000/40,001, 200-ID, parity and refusal check.
Fixture seeding took 14.061 seconds, while the eight real expansion queries took
63.105 seconds (71.3%): 31.357 seconds in the pinned historical reader and
31.748 seconds in the candidate. Fixture batching was not adopted. Temporary
instrumentation was removed byte-for-byte and the exact owned PostgreSQL cluster
stopped. These local measurements do not close either hosted timeout or the
separately pending R7 consent and regeneration gate.

One candidate 40,000-row query execution plan retained the generic-plan setting,
read-only repeatable-read snapshot, original fixture and query. It returned all
40,000 rows in 8.936 seconds with no disk or temporary reads. The plan did not
support completeness counting as the dominant cost: those 40,000 aggregates
accounted for about 560 milliseconds inclusive. Instead, the eligibility lateral
ran 40,000 times and took about 8.64 seconds inclusive. An inner CTE estimated
at one row returned 200 rows per invocation, feeding two index scans with eight
million loops and 24 million shared-buffer hits each. No raw plan, SQL, binds or
rows were retained. The exact owned cluster was stopped again. The next reviewed
prototype may reuse the complete eligibility result for each distinct matched
chunk within the same statement, preserving every predicate and multiplicity;
count-only and fixture-only optimizations are not justified by this measurement.

The reviewed eligibility prototype preserves the complete lateral relation and
its row multiplicity, evaluating it once per distinct matched chunk/manifest pair
and joining back on both keys within the same statement. A matching single-query
measurement returned the same 40,000 rows in 610.377 milliseconds. Eligibility
evaluations fell from 40,000 to 200, the two index scans from eight million loops
each to 40,000, and shared-buffer hits from 49,191,043 to 1,806,557. Generic-plan,
JIT, work-memory and read-only snapshot settings were unchanged; no disk reads or
temporary spill occurred. The unchanged full boundary file passed both cases
without skips or cancellations: legacy in 56.421 seconds and v12 in 128.108
seconds, under their original 600-second limits. This is a query-level improvement
and a complete boundary pass, not evidence of a whole-case speedup or hosted
qualification. The new synthetic regression passed its focused run, followed by
all 21 occurrence tests and all ten read-plan tests on Node.js 26.2.0/PostgreSQL 17,
with zero failures, skips or cancellations. The regression compares actual public
results and the full pre-group eligibility bag against the immutable historical
reader, then proves that scope deduplication and either missing join key are
detected. Independent semantic and publication reviews are clear. Documentation
governance and all 23 preflight checks passed. The full local Worker gate and
exact-head hosted CI remain required.

The graph case now has a reviewed test-only observer emitting eleven fixed,
content-free phase records with numeric elapsed time, round-trip and statement
counts. It preserves native batch boundaries, promises, results and errors;
every upload, fresh scope/kernel, daily pass, publication and assertion remains.
Observer identity can add a positive authority-schema cache check, so its
measurements describe the instrumented workload, not an uninstrumented baseline.
Typechecking and all 36 owning graph tests passed. A separate temporary delay
after all original assertions forced the unchanged five-second timeout and
verified that all eleven records survive the reporter's failed-test buffering.
That expected diagnostic failure is not a passing gate; the temporary delay was
removed and the exact reviewed source restored. The next hosted run must provide
actual failing-case phase evidence if the graph timeout recurs; no graph
performance repair is claimed.

Hosted run `38739514155` on `3ad784a2e` exposed an omitted integration step:
Cloud Run and all four PostgreSQL jobs refused the new compute closure with
`CLOUD_RUN_BUILD_KERNEL_UNREGISTERED` during bundle construction. No PostgreSQL
test file ran; every owned PostgreSQL container stopped and the strict aggregate
failed. The four auxiliary workflows passed. The build guard is correct: changing
the occurrence reader requires a new append-only kernel-registry entry under the
existing registration contract. Registration and its owning validation must be
completed before a fresh full run; old entries and closure checks remain intact.
The parallel local Worker gate was cancelled after this known admission failure,
with exact owned-process cleanup verified. It had completed 1,183 tests and seven
existing PostgreSQL-environment skips without a test failure, but had not reached
Worker runtime, analytics or deployment dry-run/staging checks. It is incomplete,
not passing evidence for the candidate.

The registration correction derives kernel 19 from the actual build closure and
appends its canonical registry pin. All 18 historical entry blocks and the old
pin block remain byte-for-byte unchanged. Independent source and semantic review
confirm that vendor provenance, pricing identity and orchestration method stay
unchanged, while the compute identity advances with the source. All 19 owning
registry and pricing-class checks passed without skips or cancellations. Full
analytics passed 33 files and 349 tests, plus 25 script checks and 100,076 synthetic
pricing comparisons, without failures or skips. The complete offline Cloud Run
check passed all 16 test invocations: 574 tests passed and four explicitly
PostgreSQL-gated tests skipped in the database-free local environment, with zero
failures or cancellations. Both the build check and actual 13-bundle build resolved
kernel 19. This qualifies local registration and analytics; the full local Worker
gate and exact-head hosted PostgreSQL/Worker gates still require completion.

The superseded `3ad784a2e` Worker job retained useful failed-case diagnostics
before cancellation. Its complete graph file reported 35/36 passing; the target
case reported failure at 6,863 milliseconds. All eleven phase records survived:
16 uploads completed at 1,322 milliseconds, journal proof at 2,262, daily cohort
at 2,400, and kernels 8/16/24/32 at 3,264/4,119/4,980/5,843. All original
assertions completed at 5,893 milliseconds, beyond the unchanged five-second
limit. The observer counted 5,110 round trips and 7,231 statements, with 5,198
milliseconds summed settled-call time and a 46-millisecond maximum. No semantic
assertion mismatch was observed; cancellation prevented the final error and
runtime summaries. Completed file reports covered only 15 runtime files and
778 tests, with one failure. This is incomplete failed-run evidence, not a full
gate result or graph repair.

Thirty resource intervals from that job, excluding the initial since-boot
report, showed no swap usage/activity or stolen CPU and at least 9,130,468 KiB
free memory. The interval covering the graph case and its predecessor each
reported 74% CPU idle and 2% I/O wait. These coarse aggregate measurements still
cannot establish cause or exclude short or per-core stalls. The next read-only
investigation traces the actual serial kernel path for safe round-trip reductions
while the full `60e00d9ee` gates continue; every fresh scope and assertion remains
required.

On `60e00d9ee`, hosted Cloud Run completed all five check steps and 1,191 tests
across 20 reported invocations with no failures, skips or cancellations. The
PostgreSQL edge partition completed its one canonical file and all 15 tests with
no environment gaps. Both jobs built kernel 19 and stopped their owned databases.
The Vitest partition also passed its 15 files and 107 tests, and node-1 passed
40 files and 262 tests, without failures, skips or environment gaps. Node-2,
the strict aggregate and complete Worker gates are still pending; these completed
jobs do not establish a green full suite.

The local Worker gate on the same source passed its complete runtime suite:
184 files and 2,836 tests in 817.45 seconds, without failures or skips. The
separate Node lane passed both tests, analytics passed all 33 files and 349 tests,
and all 39 production-shape checks passed. Fastpath reported 209 passing tests
and four existing PostgreSQL-environment skips. The gate then exited 1 at the
release-tree cleanliness guard after 1,416.3 seconds: the coordinator's evidence
update to this plan was the only dirty path. The guard correctly refused before
asset inspection; neither Wrangler dry-run nor staging checks ran. This is a
failed complete command despite passing test stages. Preserve the pending plan
separately, validate the missing tail on the clean candidate, and then rerun the
complete gate without intervening edits. No guard bypass is permitted. The
runtime pass does not resolve the observed graph timing sensitivity or qualify
the remaining hosted gate.

Static graph review ruled out a pool of unchanged concurrent fixture uploads:
their staged admissions share a singleton allocator, and an existing deterministic
race regression requires one competing admission to refuse before an explicit
retry. Parallelizing those journeys would change the workload, not merely remove
idle waits. Two narrower production candidates remain unimplemented: combining
reader admission with its same-query liveness proof, and batching checkpoint stage
insertion with metadata verification. Their projected savings are not measured
wall-time improvements; the latter also needs failure-atomicity and error-order
coverage. Neither currently justifies a graph repair claim. The ongoing full local
gate retains exclusive use of the heavy validation lane and frozen source.

The complete hosted PostgreSQL suite on `60e00d9ee` passed all 717 tests across
95 canonical files, with zero failures, skips or environment gaps. Canonical,
selected, reported and unique file counts all agree, with no overlaps or missing
files. The strict aggregate succeeded. Partition totals were Vitest 15 files/107
tests, node-1 40/262, node-2 39/333 and edge 1/15. Both unchanged real boundary
cases passed their 40,000-accept/40,001-refuse checks, 200-ID batches and
600-second per-case limits. Their combined file took 643.485 seconds; individual
case durations were not emitted. The occurrence regression file completed in
162.659 seconds. Node-2 finished in 26 minutes 31 seconds, within its unchanged
45-minute job limit. These logs contain no PostgreSQL CPU/RSS sampler, so no
resource-cause claim follows. The hosted Worker gate remains pending.

The coordinator preserved the pending evidence plan separately and restored only
its tracked copy to the committed bytes. On clean `60e00d9ee`, both unchanged
remaining commands passed: production dry-run in 2.276 seconds and staging
configuration/dry-run in 1.251 seconds. Staging reports `configured_unverified`;
no deployment occurred. No asset rebuild or guard change was needed. The first
full attempt remains failed, with 4,861 passing tests, eleven existing local
PostgreSQL-environment skips and no test failures or cancellations. A fresh
complete Worker command started at 13:49:58 UTC on 15 October with the entire
tracked checkout frozen. Pending evidence stays outside the checkout until the
clean-tree-dependent validation completes.

The fresh complete local Worker gate on clean `60e00d9ee` exited 0 after
1,377.535 seconds at 14:12:56 UTC on 15 October. It reported 4,861 passing tests,
eleven existing PostgreSQL-environment skips and zero failures or cancellations.
The complete Worker runtime passed 184 files/2,836 tests, the separate Node lane
passed both tests, analytics passed 33 files/349 tests, and production-shape
passed all 39 tests. Both final Wrangler dry-runs completed; staging remained
`configured_unverified`. The owner verified process cleanup and a clean final
checkout. The failed earlier command remains separately recorded.

The exact-head hosted Worker job completed with failure at 14:09:03 UTC after
48 minutes 46 seconds, before its unchanged 60-minute job limit. Runtime ran all
184 files/2,836 tests, with 2,835 passes and one graph timeout explicitly reported
at the unchanged 5,000-millisecond limit. Every pre-runtime check passed, including
1,311 Worker script tests and all 39 early Linux process checks. The subsequent
Node, vendor, analytics, fastpath, later production-shape and deployment/staging
steps were not reached. PostgreSQL cleanup reported stopped. The full hosted run
therefore failed despite passing PostgreSQL, Cloud Run and auxiliary workflows.

Ninety-five resource intervals, excluding the since-boot sample, showed no swap
usage/activity or stolen CPU. Free memory stayed at or above 7,290,292 KiB.
Nearby thirty-second samples reported 73–74% aggregate CPU idle and 4–8%
I/O wait. These coarse measurements establish no test-level cause and do not
rule out brief or per-core stalls. A scoped reader-admission experiment and an
independent fence review now own the next investigation, with one serial local
measurement lane. The five-second limit and the full graph workload remain
unchanged; no repair or final-suite pass is claimed.

The completed graph file reported 35/36 passing; the target took 7,336
milliseconds and the final error explicitly identified its 5,000-millisecond
timeout. All eleven diagnostic records were present and all original assertions
completed at body time 6,370 milliseconds. The phases took 1,422 milliseconds
for uploads, 869 for journal proof, 142 for daily/roster work, 3,888 for the 32
kernels and 49 for both publications and final assertions. The totals remained
5,110 round trips and 7,231 SQL statements. Kernel work accounted for 445 of the
477-millisecond increase from the older cancelled run; this establishes elapsed
cost, not a resource cause.

A scoped reader-admission experiment removes the duplicate standalone
pre-acquisition proof only for nonempty paged groups. The closed snapshot
normalizer, original failure precedence, nonpaged pre-proofs, every post-proof,
retained-membership predicate, direct-reader default and query reserve remain.
Independent review is clear; all 21 snapshot tests passed, including eighteen
new negative cases. The adjacent budget regression retained its exact deferred
state, durable checkpoint, four physical pages and all upper bounds; its exact
authority-query expectation advances from five to four for the eliminated
duplicate query. Adjacent validation remains pending at this checkpoint.

Three paired complete-target measurements retained all eleven records and the
unchanged graph test. Each baseline used 5,110 round trips/7,231 statements;
each candidate used 4,982/7,103. Body times were 1,660/1,594, 1,446/1,435 and
1,551/1,383 milliseconds for baseline/candidate respectively. The median fell
7.5%, with paired gains from 0.8% to 10.8%; this noisy local result does not
qualify a hosted timeout repair. A second experiment is being prepared for two
independent checkpoint read pairs, preserving separate writes and the final
post-write fence. It has no measured result or adopted implementation yet.

Additional static review found no redundant empty promotion or terminal-page
read in the five-promotion fresh kernel: each acquisition transition follows a
distinct real reduction pass. Whole-group or prepared-fold alternatives change
durable progress or configuration contracts and are not neutral shortcuts. The
positive authority-schema cache is reached only by a schema-error fallback;
the successful current workload has zero such probes per kernel. The earlier
general observer-identity caveat does not establish an actual extra schema
probe or a timing cause in this workload.

The reader experiment's adjacent validation subsequently passed all 36 tests
across three files, bringing the owning total to 57 with no failures or skips;
Worker typechecking also passed. Its four-file patch remains uncommitted and
does not establish a hosted repair. Both checkpoint read-pair experiments were
rejected before production edits: a failed batch loses the first proof and
reserves both statements, changing the original unavailable classification and
query spending when the first proof must refuse. A fallback reread spends an
additional query and observes later state. Independent review confirmed that
this could bypass the graph's newer-head deferral. Two new baseline negatives
passed against the unchanged checkpoint implementation. The complete checkpoint
file then passed all 14 tests without failures or skips, and typechecking passed.
No checkpoint batching or timing experiment was adopted.

Further source review found no larger safe round-trip reduction in the current
upload, journal or five-promotion kernel. The ordinary fixture's reader candidate
uses 95 calls/108 statements per fresh scope and kernel; the selected scheduler
has additional epoch proofs and is a distinct, statically counted path. Combining
journal proofs has the same error-priority and budget-reservation problem as the
rejected checkpoint batches. No production change follows from those ideas.

The runtime audit found an actual reporter difference: inherited Codex environment
markers select Vitest's minimal reporter locally, while CI selects default plus
GitHub Actions reporting. Two paired complete graph-file comparisons used explicit
reporters and the same native JSON reporter on frozen source. All four runs passed
36/36 tests, with no skips or failures. Default/minimal target durations were
1,695/1,635 and 1,674/1,638 milliseconds; console output fell about 92%, but the
36–60-millisecond local gain does not explain or resolve the hosted timeout.
No reporter configuration was changed. D1's supported temporary persistence
options still use disk-backed SQLite, and its calls stay inside workerd; no
equivalent storage switch or fsync cause has been established. One bounded local
native/Node profiling run is the next diagnostic, with synthetic fixtures and
the original workload and five-second limit retained.

The single profiling diagnostic finished with an incomplete-capture status,
separate from its passing selected test. The full target passed in 1,851
milliseconds overall and 1,462 milliseconds of body time; all eleven records,
16 uploads, 32 kernels and 4,982 calls/7,103 statements were retained. The other
35 cases were explicitly unselected for this diagnostic. Native sampling
produced headers but no call stacks, and workerd had exited before the final
identity check; no native or SQL cost can be attributed. Node's sampled interval
weights were 81.07% idle and 16.07% diagnostic overhead, with delayed hook/log
delivery. These are not CPU-time measurements or evidence of a hosted cause.
No retry occurred; all owned processes exited and source stayed unchanged.

The next scoped investigation prepares passive Linux measurements of only the
hosted Worker shell's owned descendants at a finer interval. Closed CPU/RSS/I/O
aggregates must preserve gaps and process identity, without reading command
lines, environments, payloads or unrelated processes. Existing aggregate
sampling, workload, tests, deadlines and resource limits remain. This diagnostic
addition is pending implementation and independent review, not a performance
repair or a passing hosted gate.

The five-file Linux diagnostic addition subsequently passed independent exact-byte
review and all 43 owning tests without failures, skips or cancellations. The
executable Bash harness retains its original six scenarios and adds four checks
for independent or simultaneous sampler failure. Both owned samplers are reaped;
the original Worker failure remains authoritative. Existing `vmstat`, the full
Worker command, workload and limits are unchanged. Fixed output records are
bounded to 8 KiB; backpressure or a closed pipe ends diagnostics without raw
errors or an accumulating output queue.

The sampler anchors the parent and descendant lifetimes, checks per-thread child
lists, and emits closed CPU, process-summed RSS and per-task I/O aggregates.
Observed gaps remain explicit. Clock frequency is obtained from the Linux host;
the 100-millisecond scan budget is cooperative, and `metadataReads` counts
metadata operations/admissions rather than exact system calls. RSS is not unique
memory, and I/O counters do not measure fsync latency or device throughput.
Real Linux execution and overhead remain unqualified. The next commit will
contain only diagnostics and this evidence record; the five reader/checkpoint
experiment files remain uncommitted. Its production closure therefore remains
kernel 19, enabling a comparable hosted diagnostic run without claiming a repair.

The coordinator's complete workflow-contract command passed 101/101 tests,
release-trust checks passed 87/87, all 25 workflow-policy files passed, and
documentation/preflight passed 23/23. These focused results have no failures,
skips or cancellations. They do not replace the final local umbrella or hosted
gates. The five experimental files still match their preserved bytes.

Diagnostic commit `d94c7f00c` was pushed with production source unchanged.
Its Release trust workflow correctly refused the new executable because the
coordinator omitted its tool-inventory registration. The failing command ran
38 tests with 37 passes and one `unclassified_executable` failure. The local
87-test release-trust command did not include that inventory check. Three other
auxiliary workflows passed; Hosted backend was still running when this failure
was diagnosed. No partial hosted result is promoted to a passing gate.

The scoped correction adds the sampler's canonical repository-operations
registration and its actual workflow/test callers, preserving all 189 existing
records. The exact inventory expectations advance from 189 records/188 paths
to 190/189 while retaining strict equality and all refusal/importer checks.
The complete previously failing command passed 38/38 with no skips, failures or
cancellations; inventory validation passed with 190 records, 189 executable
paths and 59 aliases. Sampler, production source, checker and workload remain
unchanged. This repairs tool registration, not the graph timing failure.

At 16:00 UTC on 15 October, the corrected pushed candidate
`fd0112d0ca0a72af47f9588ad1ab8554147a017a` had passed Cloud Run's complete five
steps and 1,191 tests across 20 invocations, with zero failures, skips or
cancellations. Kernel 19 built and database cleanup reported stopped. All four
auxiliary workflows passed. Release trust passed 209 tests, including the
repaired 38-test inventory command and every later step; documentation passed
33 tests and OSV's 27 guard tests plus its scanner succeeded. The Codex offline
PR check passed. Existing publication-only and live-comparison workflow steps
remained event-conditionally skipped and are not newly qualified. Worker and
the complete PostgreSQL aggregate were still pending.

The superseded, cancelled `d94c7f00c` Worker log established partial Linux
sampler capability: 405 samples over 404.186 seconds, with Node and workerd
observations and no configured-limit crossings. A final missing-root sample and
closed unavailable marker preceded the cancellation message; normal exit-trap
cleanup is unproven by that cancelled job. There were no graph phase records.
The graph's eleven records contain relative durations, without an absolute
clock anchor. Buffered log arrival timestamps cannot precisely align them
with sampler UTC intervals, so these observations do not establish a graph
phase's CPU or I/O cost, causality, or a performance repair.

At 16:08:55 UTC on 15 October, the same `fd0112d0c` candidate completed all
four PostgreSQL partitions and the strict aggregate in hosted run `38763813448`.
The 95 canonical, selected, reported and unique files agree exactly: Vitest
15 files/107 tests, Node 1 40/262, Node 2 39/333 and edge 1/15, totaling
717/717 passed tests with no skips, failures, environment gaps, missing files
or overlaps. Both real boundary cases passed with the unchanged 40,000/40,001
rows, 200-ID batches and 600-second per-case limits. Their combined file took
286,170 milliseconds; this is not an individual-case timing. Each partition
verified PostgreSQL 17.11 and successful stopped cleanup. The coordinator
independently checked all five complete log hashes, native summaries and the
strict aggregate result. Worker remains pending; this qualifies PostgreSQL,
not the full hosted or final local suite, and does not resolve graph timing.

That hosted run completed at 16:45:49 UTC with Worker as its sole failed job.
Worker ran all 184 runtime files and 2,836 tests: 2,835 passed and the unchanged
graph case timed out at 5,000 milliseconds. The graph file ran all 36 cases,
with 35 passes; the target reported 8,365 milliseconds. All eleven diagnostic
records survived, with all original assertions completing at 7,463 milliseconds
of body time, 5,110 calls and 7,231 statements. Uploads took 1,915 milliseconds,
journal proof 1,143, daily preparation 119 and kernels 4,247; kernel quartiles
were 898/718/1,541/1,090 milliseconds. Summed settled-call time was 6,885
milliseconds and the largest call 138. There was no additional semantic
assertion failure. The complete runtime took 2,802.94 seconds; the 55m05s job
stopped before its unchanged 60-minute limit. Workflow checks 101/101, early
process checks 39/39 and pre-runtime checks 1,311/1,311 passed without skips.
Later Node, vendor, analytics, fastpath, production-shape and dry-run/staging
stages were not reached. PostgreSQL cleanup succeeded. No retry was started.

The new sampler emitted 3,232 valid samples over 3,232.759 seconds through the
failed step, with no unavailable, root-loss, configured-limit or counter-regression
records. Metadata gaps remained explicit: 28 missing, one unreadable and eleven
malformed observations across 26 samples. Workerd had matched CPU/I/O observations
in 2,660 samples and Node in 3,231; these are partial lifetime measurements, not
complete process totals. Maximum record size was 1,787 bytes and observed scan
duration 39.337 milliseconds. No cancellation or runner orphan termination was
logged. This supports observation through the normal failure path, but individual
sampler exit statuses and successful reaps were not explicitly recorded.

Aggregate sampling produced 107 complete 30-second intervals, excluding the
initial since-boot report and leaving the final approximately 23 seconds without
a closing interval. There was no swap or stolen CPU; interval means were 71.35%
idle and 10.65% I/O wait, with 6.85–8.84 GiB free memory. These host-wide
observations and matched process counters establish no graph-phase cause or
diagnostic overhead. Relative graph records still cannot be precisely aligned
to the sampler's clock. Production source, every workload and all limits remain
unchanged; the five local experiments remain preserved and uncommitted.

A separate read-only review rejected conditional single-statement checkpoint
consolidation. Lazy branch execution does not prevent preparation from resolving
later tables or columns, so a missing later relation can preempt the required
first-proof refusal. Blanket error translation or a later proof reread would
also change the contract. Theoretical call reductions are not admissible savings;
no implementation or test run followed. Existing negative fault injectors would
need to target any future query shape explicitly to avoid a vacuous pass.

The next diagnostic is a bounded Linux ancestor launcher for the complete,
unchanged 36-case graph file. It retains the five-second test timeout and
observes only owned thread CPU, runnable delay and closed syscall/state categories
at a target 250-millisecond cadence, with a separate 240-second command cap.
Access denials, disabled counters and identity races remain unavailable evidence.
Sampled occupancy cannot prove exact wait duration or SQLite attribution.
The existing later complete Worker gate remains mandatory; failure in the early
diagnostic prevents that later gate from running and cannot qualify it.

On 15 October, separate source, workflow and inventory owners completed this
implementation, with independent review of each boundary. Portable launcher
checks passed 32/32, including the production orchestration paths for success,
interruption, command cap, established child failure, unadmitted identity,
readiness failure and supervisor reparenting. Review found and corrected
cleanup-induced status replacement, stale promise-race side effects and initial
identity admission before publication. Cleanup evidence is deliberately limited
to verified owned-group signaling and direct-supervisor reap; it does not prove
independent disappearance of every descendant. No debugger attachment, system
configuration change or privilege is introduced.

The coordinator's complete mandatory workflow command passed 134/134, release
trust passed 87/87, and documentation/preflight passed 23/23, with no failures,
skips or cancellations. Workflow policy verified 25 files and architecture
boundaries passed. The full historical qualification/inventory command passed
38/38; inventory reports 191 records, 190 executable paths and 59 aliases. The
only prior-record change is the actual new sampler importer; all other historical
fields and checker rules remain unchanged. The reviewed launcher source hash is
`0f9728fd97d8b3605ab44caf42411e2d5d8f1d95a91f7f5437c37d04bd3908a8`.
The graph source and all five preserved experiments remain unchanged. These
checks qualify portable synthetic behavior and source wiring only. Linux procfs
execution, the complete 36-case diagnostic, observer overhead, final-candidate
gates and a graph timing repair remain unqualified.
