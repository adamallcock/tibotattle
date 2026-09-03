---
title: PR94 account and plan attribution local qualification
date: 2026-09-03
type: receipt
status: complete
---

# PR94 local attribution qualification

The fixed-admitted-index comparison completed on 2026-09-03 with exit zero and
validated status **`passed_with_historical_artifact_refusal`**. Accounting and
calibration conservation passed. Both final-candidate production artifacts
passed the unchanged strict cache validator and were byte-identical.

The historical PR #94 merge still produces its known `cache_invalid` artifact;
this is recorded as a refusal, not relabelled as valid. Its two fresh processes
returned identical successful child envelopes and artifact bytes, each original
strict assertion refused exactly `cache_invalid`, and source, clock, generation,
dependency, query-plan and resource bindings passed. The later candidate fixes
the fitted-reset metadata defect and passes strict validation. This receipt
does not qualify the historical artifact for release.

## Exact scope and custody

- Before: `a3c850360bc83c0e27bef2171aeb4a302b72f472`, PR #94's first parent.
- After: `20f449ff5c222989029fe343f219f02b497ae1d4`, PR #94's merge result.
- Final measured source: `9494c0776892127284fca744a304cc3c0c58bdf3`.
- Runtime: Node.js 26.2.0, macOS arm64. Historical before/after dependencies
  match exactly; final dependencies are independently bound, including the
  subsequently reviewed dependency update and accounting optimization.
- Fixed interval: `2025-09-02T00:00:00.000Z` through
  `2026-09-02T00:00:00.000Z`.
- Immutable schema-11 index: generation 44, 1,508,540,416 bytes, SHA-256
  `e9f477efc2c1ea50360509fe70681c8bd04b7b4a5b16a56b5d2855f69628b6ce`.
- Closed JSON receipt: `pr94-admitted-index-comparison-v2`, 163,760 bytes,
  SHA-256 `fdce799d5ea7af8d53430aaf44036afafba24f6d80ac7267b3f47fdec8aabead`.
  It remains owner-only, mode 0600, regular file with one link. The coordinator
  independently reran `validatePr94ComparisonReceipt` after completion.

Only this content-free summary is committed. Private paths, source filenames,
raw content, account/reset identities, detailed frames and accounting amounts
are not published. The comparison neither scanned raw history nor accessed live
app state, credentials, or hosted services. It used separate private processes
and derived outputs, rechecked unchanged sources/dependencies/index, and did
not modify the input index or protected R7 receipts.

## Conservation and coverage review

All three lanes retained the same 726,740 indexed usage rows: 707,889 positive
usage records plus 18,851 explicitly reconciled zero-component rows. All
954,391 admitted quota observations were preserved. Exact row-level ledger
evidence, all six token components, decimal event-time amounts, pricing states,
provenance and warning aggregates matched. Disjoint plan/basis/disposition
populations sum to the original ledger; missing evidence remains explicit.

The shared generation contains 7,708 sources and no skipped sources or threads.
Its accounting coverage is complete. Its generic publication status remains
`partial` / `tool_provenance_incomplete`, with 903,427 retained tool facts; this
check does not promote incomplete tool provenance to complete evidence.

The calibration comparison reconciled 216 raw reset parents across four
candidates: all 864 parent/candidate pairs, with zero missing or added parents,
unexplained residue, duplicate primary votes, or lost primary fits. All 152
primary representations were retained (38 per candidate). Identical fit inputs
produced identical arithmetic in all 140 before/after comparable fits and all
152 after/final comparable fits.

The attribution change intentionally changes the observation population:

- 53 transitions move from eligible to aggregation-diagnostic-only; none is
  dropped from the ledger.
- 37 non-increasing cross-era transitions are no longer constructed. Eligible
  transitions change from 13,544 to 13,491; non-increasing transitions from
  9,884 to 9,847. The 341 no-usage and four pricing-warning rows are unchanged.
- One formerly nonfitting parent now has no within-era percentage change;
  its closed disposition explains the change from 136 to 135 parents with
  transitions. It was not an accepted fit that disappeared.
- Twelve retained primary representations have deliberately changed,
  plan-scoped inputs; 16 parent/candidate outcome signatures change. Their
  reasoned reconciliation is retained in the closed receipt. No fit with
  identical inputs changes, and no accepted primary fit is lost.
- The after-to-final comparison adds no calibration or population change.

Each candidate retains 35 Pro, two Plus and one other-plan primary fit, with no
unknown-plan primary. Only the Plus primary distribution changes with its
plan-scoped inputs; Pro and other-plan primary distributions are unchanged.
The closed receipt retains exact medians and central-80 ranges without
publishing private accounting amounts here. Independent aggregate review
confirmed the reconciliation and recommended closing this empirical gate.

All 216 parents have unknown account identity. The original-fit-gate
counterfactual checks found zero changed eligibility rows, point sets or fits
solely from that unknown label, and zero unknown-account-only exclusions.
This does not establish account-exact or same-login workspace attribution.
Empty distributions remain unavailable; plan identity and account identity
are not conflated.

## Production resource measurements

These are unmodified accounting-child processes, not the instrumented semantic
observer or end-to-end application refresh. Each revision ran twice in fresh
isolated processes under the same pinned clock and unchanged resource ceilings.

| Revision / run | Wall ms | User CPU ms | System CPU ms | True peak RSS bytes | Artifact bytes |
|---|---:|---:|---:|---:|---:|
| Before / primary | 97,080 | 92,190 | 9,230 | 1,832,960,000 | 11,955,053 |
| Before / repeat | 94,850 | 90,780 | 8,540 | 1,726,955,520 | 11,955,053 |
| After / primary, refused artifact | 324,550 | 310,020 | 21,560 | 1,742,848,000 | 12,123,253 |
| After / repeat, refused artifact | 322,700 | 309,050 | 20,860 | 1,967,374,336 | 12,123,253 |
| Final / primary | 39,570 | 43,520 | 1,060 | 2,080,473,088 | 15,511,261 |
| Final / repeat | 40,750 | 44,910 | 1,110 | 2,076,344,320 | 15,511,261 |

Final median wall time is 40,160 ms: 55,805 ms lower than before (-58.15%) and
283,465 ms lower than the historical after revision (-87.59%). Final median
peak RSS is 2,078,408,704 bytes: 298,450,944 bytes higher than before (+16.77%)
and 223,297,536 higher than after (+12.04%). All runs remain below the unchanged
6,442,450,944-byte ceiling; no timeout or resource guard fired. This is a
reviewed memory/time tradeoff, not an invented universal regression tolerance.
The coordinator accepts it for this release given exact conservation, the
substantial latency reduction and the retained resource headroom.

The final cache SHA-256 is
`bb90b9835fb786fdf1592ee18c6d1bcd5b84084a1d9a962c23d036bf15c7f61a`
in both runs. Each revision is repeatable within itself; cross-revision cache
bytes are not asserted equal because attribution and report structure change.
The final artifact has 1,265,955 bytes of headroom below its unchanged 16 MiB
limit. This is measured headroom, not a promise that arbitrarily larger future
corpora will fit; the fail-closed size and retained-input bounds remain active.
The receipt also retains query-plan classifications, cache/input/resource
limits, retained-input counts/bytes, and per-phase observations.

The separate instrumented semantic observer took 194,230 / 260,090 / 256,140 ms
for before / after / final, with peak RSS 3,916,480,512 / 4,241,031,168 /
4,508,811,264 bytes. Those measurements include evidence work and are not
product refresh timings. Its phase and CPU measurements remain in the private
receipt rather than being presented as the optimization result.

## Release decision and limits

The local PR #94 empirical gate is closed for this fixed admitted index. The
result is not raw-ingestion, application no-change/relaunch, cancellation,
installed-upgrade, end-to-end refresh, hosted deployment, consent activation or
provider-billing proof. Those boundaries retain their separate evidence and
decisions in the [release plan](../plans/2026-09-03-public-0.1.17-release.md).
The earlier failed runs remain failed; none was reused as a successful receipt.

The owner accepted the dogfood runtime and requested confidence-based release
completion. The full clean-profile/physical Login Item matrix is explicitly
deferred, not passed. Final signed-artifact/replacement, source and updater
integrity gates remain required, and unexpected Keychain prompts still stop
publication. Hosted migrations and the separately held website deployment are
not authorized by this local result.
