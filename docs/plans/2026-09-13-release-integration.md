---
title: Next release integration and qualification
date: 2026-09-13
type: plan
status: source-integrated
---

# Next release integration and qualification

Prepare a coherent successor to public Electron 0.1.22. This is source
integration work, not a publication, migration, signing, or installed-platform
qualification receipt. The working candidate starts at remote `main`
`2866ecd3e8b8a466d55f2d4bef78205489570606`; version 0.1.23 is provisional.

## Acceptance boundary

- Account for all nine open PRs and relevant local work, using actual patches
  and behavior rather than branch names or apparent age.
- Preserve dirty worktrees and retained data. Integrate in an isolated branch.
- Retain the latest approved UI: animated allowance tanks and pace timeline,
  shared dashboard controls, interactive cache matrix, and compatible Trends
  and allowance history improvements.
- Verify Windows fixes already incorporated and identify any unique remaining
  platform work. Separate synthetic checks from physical platform evidence.
- Record each include, adapt, superseded, or defer decision, with exact source.
- Produce a tested source candidate, release notes outline, and explicit remaining
  release gates. Hosted activation and immutable release evidence remain separate.

## Initial inventory

GitHub reports nine open PRs on 2026-09-13. PRs 120, 122, 123, 124 and 133 form
part of a hosted/public-site stack with bases other than main. PRs 74, 111 and
116 are older desktop/release integrations; PR 115 contains usage capabilities
and reset classification. Their mergeability against their own bases does not
establish integration readiness against current main.

Already merged since 0.1.22: Windows collector and model timing recovery (#132),
model ordering (#131), shared runtime simplification (#128), usage coach/plugin
(#127), animated allowances (#134), report preloading (#135), dashboard
standardization (#136), and cache continuity matrix/model filtering (#137).
PR #129 was merged into the typed-storage branch, not main.

Local source candidates under review:

| Source | Intended behavior | Initial action |
|---|---|---|
| `58eaf7ae` | Isolated dev pacing identity and explicit waiting forecasts | Integrate; revalidate against combined UI |
| `91943d63` | Horizon Trends and linked comparison charts | Review overlap with current dashboard |
| `95e3f23b` | Plan-specific five-hour allowance history | Review data/UI contract and controls |
| `9c9cc141` / #115 | Passive usage capabilities and reset classification | Reconcile conflicts and schema coverage |
| Primary and other dirty worktrees | UI, smoke harness, provider and hosted experiments | Inventory only; no bulk staging |

## Execution

1. Complete patch-level UI, platform and hosted-stack audits.
2. Integrate independent reviewed desktop changes, adapting overlapping UI to
   the shared controls and current data contracts.
3. Run focused regression tests, generated-mirror checks and dependency/doc
   checks; then the combined desktop/local surface lanes.
4. Inspect the combined rendered app with an isolated profile and current data.
5. Record unresolved candidate, CI, physical-platform and publication gates.

## Progress

- Remote refs refreshed; release 0.1.22 verified as latest public release.
- 138 existing worktrees found; 11 contain uncommitted changes. No changes,
  branches, worktrees, or retained application data were removed.
- Isolated integration branch created from exact remote main.

## Integration decisions

| Work | Evidence | Decision |
|---|---|---|
| #134 fuel tanks and older `637de3ea` | Current renderer/controller match the old feature; main adds teardown coverage | Keep main; do not replay the older UI |
| #136 dashboard standardization | Shared reporting controls and current page headers | Keep as the UI foundation; adapt five-hour/Trends controls to it |
| #137 cache matrix | Merged at the candidate base | Preserve matrix assets, filtering and current evidence states |
| Five-hour history `95e3f23b` | Fifteen primary dirty files match this patch; 136 focused tests passed after reconciliation | Integrated once as `ffe219e0`; current forecast stays on Overview |
| Trends `9c1c7c5a` through `91943d63` | Four unique local commits | Integrated with shared controls; typed reset adapter follows |
| #115 `772dfc4b` and `9c9cc141` | Unique passive capability and reset-classification contracts | Port to current collector/projection owners; use Horizon presentation |
| Windows issue 130 | `c43b4159`/`d40c6461` map to main equivalents; `53060c72` and #132 are ancestors | Already present; no repeated integration |
| #74 older Windows/Electron reconciliation | Divergent historical architecture and retired modules | Preserve; do not merge wholesale. No additional current Windows fix identified |
| #111/#119 release tooling | Nineteen unique non-merge commits; consolidated patch `24de8339` covers missing functions | Port the tooling consolidation, not old release state or artifact pins |
| #116 old stable-site preparation | Mixes obsolete fencing and useful site/evidence work | Recover evidence tooling through `24de8339`; current site work through the separate hosted candidate |
| #120/#122/#123 | Divergent but useful accountless, public-site and scheduler source | Qualify in a separate worktree, then combine the source candidate; see linked hosted plan |
| #124/#133 | Typed D1 migration and sharding drafts with unfinished cutover gates | Preserve as a later qualified stage; no production operation triggered |
| Primary model-order changes | Already represented by main's ordering fix | Omit duplicate |
| Dirty local inference timing UI | Older schema/method and speed legend; main now has P50 and newer progress/coverage | Superseded presentation; preserve worktree, do not replace current implementation |
| Dirty Mac/compact-accounting prototypes | Older presentation branches | Preserve for reference; no bulk transplant over the approved current UI |
| Dirty Claude provider foundation | Large unfinished provider/ingestion work with its own qualification scope | Preserve outside this release candidate pending a dedicated source and data-contract review |
| Dirty credential-lifetime and D1 worktrees | Independent auth/operational changes | Preserve; no automatic inclusion or credential-policy change |

No PR was closed merely because it appeared old. Supersession is a source
selection decision, not proof that every historical commit was merged. Local
worktree snapshots and patch inventories remain private and untracked.

The [hosted stack plan](./2026-09-13-hosted-stack-integration.md) records the exact
source sequence, cancelling fence commits, already-applied migration evidence,
and unpushed verification optimizations. Do not alter a running recovery's
pinned source or journal to match the desktop candidate.

## Release gates after source integration

1. Complete combined local/browser/desktop tests, generated mirrors, architecture,
   documentation and release-tooling checks. Resolve integration defects; retain
   exact evidence when an environment or protected receipt prevents a gate.
2. Build and inspect an exact-source development app with an isolated profile.
3. Freeze the next version/source, update release notes and bind fresh artifacts.
   Historical 0.1.22 canary pins and receipts must not be relabeled as new proof.
4. Qualify each target: macOS arm64, physical Intel, native Windows x64 and Linux
   x64. Windows source-read/model-performance approval remains false until the
   reviewed native security and packaged timing tests pass.
5. Run current CI and review the consolidated changes. Signing, notarization,
   signed installer/update journeys, manifest/checksums, feeds, public website,
   Homebrew and immutable publication remain distinct subsequent gates.

No production data migration, hosted deployment, release tag, signed artifact,
updater feed or public release is created by this integration work.

## Qualification progress

The desktop integration includes commits `0d2cdb5f` (isolated development
pacing), `ffe219e0` (five-hour history), `00234304` through `15c44819`
(Trends), and `e7a73016` (release tooling and current dashboard smoke
contracts). `a8eec5fd` integrates the reviewed reset classifier, typed UI, and
package/export inventories. The approved main UI remains the foundation.

The initial broad root run completed 4,623 tests: 4,548 passed, 27 failed,
and 48 were skipped. Follow-up checks identified and repaired package asset
inventories, CSS localization rules, and release-tool caller inventories.
Packaging/export/local-review checks then passed 47 tests; the process-sensitive
R7 and native-network checks passed 49 tests under the required local process
permissions, and the synthetic private benchmark passed separately. macOS
bundle checks passed 73 with one skipped because this checkout has no prepared
Preview framework. The final combined-source checks are recorded below.

Two retained R7 receipt assertions still reject current source provenance.
The historical receipts are not rewritten or relabelled by this task. Fresh
protected release qualification remains necessary before a green release gate.

An independent reset review found that unknown credit expiry must not prove a
banked reset and that an unavailable account observation must clear historical
classification continuity. The candidate fixes both with synthetic regression
cases. These classifications remain evidence-based, not provider billing claims.

Reset review passed 76 focused tests after the two corrections. The historical
projection retains the existing five-million-record scan bound; independent
large-history reset-output memory qualification remains part of the resource
gate. No truncation was added that could hide missing historical events.

Electron shell tests completed 628 cases: 627 passed in the restricted shell,
and the one Electron startup case passed when rerun with native process access.
Architecture, both generated localization mirrors, and preflight checks passed.

## Combined candidate and local handoff

Source integration is committed at `ca58e3f47b688110be9fe7f5b89b3a73bf7a24c9`
on `codex/release-0.1.23-integration`. It includes hosted source
`a18fb6d75d80739077079c0a4cd34883011e9889`. All nine PRs remain open; no
remote merge, closure, push or publication was performed by this task.

Final combined-source checks:

- 925 browser, localization, tool-inventory and public-site tests passed.
- 341 reset/provider/collector/projection tests passed.
- Hosted source passed its complete Worker check: 1,048 tests across 80 files,
  package/type/script checks and both dry builds. After the combined merge,
  package guards, generated types, TypeScript, 92 quota-consumer tests and both
  dry builds passed again. Installed Worker package copies were refreshed from
  the unchanged lockfile to match the new quota-analysis kernel.
- Architecture passed with 542 production files, 2,145 imports and no approved
  debt edges. Generated mirrors and combined preflight passed.

A verified macOS arm64 development bundle was built from the exact combined
source. Its app.asar SHA-256 is
`15ea3eeddbf36f8692240bcf34c2e11b50c4619eb22ec505497ff31534ca49d2`.
The bundle, persistent isolated profile and launch command are retained in the
private local integration output. Nothing was installed into Applications.

Native inspection confirmed the renamed Allowance Value navigation, narrower
five-hour tank, removed per-tank observation timestamp, explicit forecast
waiting state, retained data during recalculation, and the approved visual
styles. The immediately preceding desktop build also demonstrated animated
Trends playback over real retained history, all comparison charts, typed reset
markers, and percentage-first cache matrix inspection. Public download/platform
switching and localized release copy were inspected in the hosted preview.

The development profile owns its own prospective pacing identity. An initial
waiting forecast is expected until it holds enough fresh, scoped observations;
copied production history is not relabelled to manufacture that evidence.
The public version remains 0.1.22. These source and development checks do not
close the release gates listed above.
