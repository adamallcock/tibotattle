---
title: Local model-block scheduling and publication qualification
date: 2026-09-28
type: receipt
status: verified-local
---

# Local model-block scheduling and publication qualification

## Boundary

Local, synthetic D1 and Workerd evidence on `codex/reset-analytics-delivery`,
based on `d4c1f19228da8da3fec2e638052184f961b66795` plus the preserved working
changes. No production activation, remote migration, release or live load test.
The scheduler's internal `modelBlocks` option defaults off. The production
Worker does not set it.

This implements the first integration experiment in the
[architecture plan](../plans/2026-09-28-analytics-redesign.md#current-local-slice-native-graph-adoption).
The existing native model kernel and cohort publisher remain the numerical and
publication reference. Statistical methods, public response schemas and source
telemetry retention are unchanged.

## Implementation

- Full historical blocks contain 32 UTC dates aligned to epoch-day multiples of
  32, wholly inside the existing 70-date preview and excluding today. Partial
  edge blocks, current dates and other graph families retain the native path.
- The adapter rechecks the complete block dependency vector, including session
  evidence and cross-day occurrence links. It separately captures each native
  graph scope and changes only the top-level fingerprint after proving the
  original block or native-fallback fingerprint. The shared graph writer
  validates payloads, source authority, target authority and readback.
- A partial block exposes no result prefix. Even native fallback calculations
  remain private until the block completes and passes adoption proof.
- One invocation budget counts actual source and target statements, including
  batch members, claim operations, cleanup, save and publication. The outer
  scheduled pass remains capped at 950.
- Per-owner admission permits at most four stored jobs. One compact target
  policy row fences the current authority, method and eligible ranges. Policy
  preparation reads the target, checks source authority afresh, then compares
  and swaps the target revision; old tokens cannot recreate retired work.
- Retirement preserves live leases and unfamiliar newer methods. Conditional
  parent deletion removes checkpoint parts through the existing foreign-key
  cascade. Owner erasure removes the policy, jobs and parts. The opt-in capacity
  branch can narrow existing policies and remove target-proven obsolete jobs
  without starting a new calculation or expanding admitted ranges. It acquires
  at most four job heads using the source/rowid index before checking eligibility.
  A revision-guarded integer cursor provides fair continuation and EOF wrap;
  it retains no owner or job identifier. Live leases and unknown methods do not
  prevent the scan from reaching later jobs.

## Qualification

The real scheduled-pass test uses mixed admitted v1/v1.1/v1.2 evidence and two
contributors. It observes a complete private block before native row visibility,
an incomplete-cohort publication gap, then a nonempty model-day publication and
an unchanged replay. Independent reference-versus-candidate benchmarks compare
complete public payloads from separate analytics databases.

### Paired analytical and publication measurements

The paired lanes run independently against initially empty analytics targets.
Every completed model-day payload and the final graph preview are compared as
exact serialized JSON. An opt-in fixture correction adds a valid priced usage
occurrence; the test requires an actual change in a published numeric model
value, not just an updated input digest. Both lanes include the second contributor
and current scalar-fit work required to publish the complete preview.

The comparison includes source scope capture, calculation, private checkpoint
writes, block admission and retirement, native adoption, cohort publication,
preview publication/readback and publication cleanup. Its controlled date loop
does not include the normal scheduler's fair-selection scan and owner-day claim.
Those are covered by the separate real scheduled-pass correctness test, not by
these paired performance ratios. Source admission and fixture setup are excluded.

#### Aligned 32-date block, sparse input

| Phase | Reference / candidate statements | Reference / candidate rows read | Reference / candidate rows written | Reference / candidate local elapsed ms |
| --- | ---: | ---: | ---: | ---: |
| Cold | 40,089 / 12,566 | 11,671,793 / 3,053,449 | 3,853 / 1,404 | 47,808 / 11,947 |
| Unchanged replay | 1,634 / 2,626 | 230,838 / 369,527 | 0 / 0 | 1,946 / 2,397 |
| Changed input | 30,841 / 8,965 | 13,704,297 / 3,544,027 | 2,745 / 267 | 40,006 / 10,106 |

The candidate uses **3.19 times fewer statements cold** and **3.44 times fewer
after changed input**. It adopts all 32 dates in both phases. Its busiest invocation
uses 930 statements. Submitted checkpoint payload bytes fall from 52,057,360 to
4,130,954 cold and from 52,607,828 to 4,022,075 after the correction.
The [32-date artifact](./2026-09-28-model-block-publication-block.json) was rerun
against the final capacity-cleanup schema and includes the complete-job read.

The no-change replay uses **60.7% more statements**. Additional authority,
admission and retirement checks precede native cache reuse. The small difference
in local elapsed time does not remove this query-cost regression.

#### Single-date control

Both lanes intentionally use the native path. Statement counts are identical:
1,568 cold, 115 on replay and 1,229 after changed input. All public payloads match,
and the correction changes a published numeric value. The
[single-date artifact](./2026-09-28-model-block-publication-small.json) also uses
the final schema and verifies that neither lane creates a private block.

#### Complete 70-date preview window, sparse input

Exactly 32 dates fall in one full aligned block at this UTC alignment. The
remaining 38 dates retain native computation. Each phase publishes all 70 dates,
and the candidate retains one complete private block. The second contributor
and current scalar-fit work remain native in both lanes.

| Phase | Reference / candidate statements | Reference / candidate rows read | Reference / candidate rows written | Reference / candidate local elapsed ms |
| --- | ---: | ---: | ---: | ---: |
| Cold | 130,441 / 83,462 | 64,305,530 / 39,751,107 | 12,791 / 8,623 | 234,964 / 106,036 |
| Unchanged replay | 3,496 / 4,488 | 794,695 / 932,712 | 0 / 0 | 3,734 / 4,027 |
| Changed input | 96,556 / 62,725 | 72,418,040 / 46,091,683 | 9,417 / 5,629 | 156,511 / 87,778 |

The statement reduction is **36.0% cold** and **35.0% after changed input**
(1.56 and 1.54 times fewer respectively). Replay uses **28.4% more statements**.
The candidate's busiest invocation uses 930 statements; all phases have zero
failed statements and independent profiler counts equal the invocation meters.
The [aggregate measurement artifact](./2026-09-28-model-block-publication-window.json)
retains costs by operation/family, D1 timing, checkpoint bytes and invocation
counts. This is local synthetic evidence, not a production throughput claim.
The 70-date run preceded the final capacity-cleanup pagination/schema change;
it did not exercise capacity refusal. The final-schema 32-date and single-date
controls above requalify calculation and publication after that change.

The first long run used the fixed benchmark start time as its final read time;
the reader correctly refused results computed more than five minutes after that
time. The harness now reads at actual completion time while keeping a shared
publication `generatedAt` value for exact comparison. The corrected run passed
in 596 seconds. No production freshness guard was changed.

### Next experiment

Extend shared calculation to the partial blocks at the edges of the 70-date
window, keeping the existing input-retention horizon. This addresses the 37
historical dates still computed individually in this alignment; today stays on
the native path. In the same bounded experiment,
measure a fast no-change path that avoids repeated admission/retirement work
while retaining current source and target proofs. Reuse common dependency proof
across date adoption and publication before adding parallel infrastructure.

The 10-times whole-system target remains unproved. R2 placement and multiple
workers remain later experiments: current measurements identify substantial
serial work that those changes would otherwise repeat.

### Final source and validation

The frozen Worker file set includes 665 tracked and nonignored untracked files.
Its SHA-256 is
`fdf79119b4f7a1bdf022488b7045de4be65943642fa04fef5bbdc6c7c569daa9`,
recorded at `2026-09-28T21:11:29Z`. The digest sorts repository-relative Worker
paths and hashes `path + NUL + file-sha256 + newline`. It identifies the complete
preserved Worker working tree, including earlier analytics work; it is not a
commit or a deployed artifact.

- Final store, real scheduled-pass and graph-hook tests: **49 passed**. A
  20-owner regression proves indexed four-head acquisition, cursor progress to
  obsolete tail jobs, EOF wrap, lease expiry, unknown-method preservation and
  the 40-query cleanup allowance.
- Final adoption, block runner, graph publication, contract and deadline tests:
  **50 passed across five files**, in 79.74 seconds.
- Worker TypeScript, architecture checks (**664 production files, 2,784 imports,
  no approved debt**), documentation checks and all **20 root preflight tests**
  pass.
- Final small and 32-date paired benchmarks pass; the 70-date comparison above
  passes on the earlier capacity-cleanup schema.

The umbrella `pnpm run product:worker:check` passed workspace-copy, endpoint,
generated-type, TypeScript and script checks. Its broad Vitest run recorded
**2,319 passes and one failure across 186 files** in 1,240.40 seconds. The run
loaded migrations at startup; the final source-cursor index and regression were
added while it was running. The new regression therefore failed with
`no such index: analytics_model_blocks_source_cursor` against that earlier
migration snapshot. The fresh final-schema store/integration run above passes
the same regression and all affected tests. This is not a claim that the umbrella
gate passed in one clean run.

The initial Worker file-set digest was
`779ac9740e16e1900a36ffbd48ce662f21241e3eba3d13221d7bdcc41d0fbe61`.
Only migration 0030, the block store, its test file and the publication benchmark
test changed between that broad run's start and the frozen final digest. The
final-schema store and owner-erasure recheck passed **57 tests across two files**
in 9.20 seconds, including the formerly failing indexed-cursor regression. Across
the final focused runs, 113 distinct tests pass.

An explicit `npm run deploy:dry` afterward passed its workspace and endpoint
guards, then stopped at the existing clean, committed release-tree requirement
in `production:stage-assets`. No files were staged or discarded to bypass it.
Wrangler dry deployment and staging qualification remain incomplete. No remote
operation occurred.

### Review and qualification limits

Review found and fixed a retained-v1.1 regression in the shared graph writer:
exact owner-revision guards apply to effective-source results; a pinned v1.1
generation remains valid across later appends. The existing retained-generation
test passes. Native fallback previously wrote a per-date row while its containing
block was incomplete; the private-result option and regression now keep those
outputs hidden until complete-block adoption.

The block authority digest includes correction and v1.2 runtime state, while
the existing native graph cache identity does not. Review did not establish a
supported activation sequence that changes the numerical result at an unchanged
owner input revision: admission requires the corresponding runtime to be active.
Arbitrary runtime reversals with retained data are not qualified by this slice.
Existing native-row reuse remains the intended adoption cursor. Comparing it to
a block output would not be independent proof for native fallback outputs.

## Measurement limits

Statement counts, scanned/written rows, D1 timing, elapsed local time and submitted
checkpoint bytes are separate dimensions. Workerd does not expose per-operation
CPU time or peak heap in this harness. The reference runs before the candidate;
other local regression work overlapped part of the 70-date run. Local elapsed
ratios are consequently not production latency forecasts. Source admission and
fixture construction are outside the analytical comparison. The single-date
control intentionally retains the native path. Erasure containment is covered by
separate functional tests; these paired runs do not measure erasure cost. The
optional dense 70-date benchmark has not been run.
The paired publication benchmark and real scheduled-pass fixture allow 60-second
invocations. A separate dense runner regression passes its default 20-second
deadline with an injected 50 ms per statement; these are distinct qualification
boundaries. Remote D1 latency, Worker CPU/heap and the complete scheduled path
under production timing remain unmeasured.

Platform references consulted for the implementation:
[Workers practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [D1 binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
The installed project types were checked against published Workers types
`5.20260928.1`; no runtime compatibility or dependency upgrade was introduced.
