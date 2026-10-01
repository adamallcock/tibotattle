---
title: Hosted source stack integration for the next release
date: 2026-09-13
type: plan
status: source-integrated
---

# Hosted source stack integration

Prepare a separate hosted integration branch from application main
`2866ecd3e8b8a466d55f2d4bef78205489570606`. This plan records source selection;
it does not authorize deployment, migration, activation or changes to the running
production recovery. The desktop release can proceed independently of the D1
drafts. Follow the [documentation index](../README.md),
[current release status](../current-status.md),
[production operations](../runbooks/production-operations.md),
[migration rehearsal](../runbooks/release-migration-rehearsal.md) and
[publication reconciliation](../runbooks/release-publication-reconciliation.md)
for their respective gates.

## Dependency and evidence snapshot

The common ancestor is `10657851`. The hosted sequence is site 0.1.21
`9accd6f0`, accountless runtime/schema `90cde16e` through `03d4217f`, site
0.1.22 `d705bd00`, [Homebrew PR #122](https://github.com/adamallcock/tibotattle/pull/122)
`5119bc9b`, [scheduler PR #123](https://github.com/adamallcock/tibotattle/pull/123)
`3de7ccd0`, [typed-storage draft #124](https://github.com/adamallcock/tibotattle/pull/124)
`eda56e7c`, then [shard draft #133](https://github.com/adamallcock/tibotattle/pull/133)
`0631b2fb`. [PR #120](https://github.com/adamallcock/tibotattle/pull/120) also has
two sibling documentation commits after `03d4217f`: `44c28218` and `19a74361`.
They are not ancestors of the Homebrew/scheduler branch.

The PR inventory reports #120, #122 and #123 ready for review; #124 and #133
remain drafts. All five were mergeable against their stacked bases. That does
not establish mergeability against application main: a read-only three-way
comparison finds conflicts in CHANGELOG, styles, canonical/generated i18n,
current-status and tool inventory. None of the five heads is an ancestor of
main or has patch-equivalent commits there; some documentation content has
nevertheless already been reconciled independently.

The public [download page](https://tibotattle.com/) observed on September 13
shows 0.1.22 downloads and Homebrew controls for both Mac architectures. Its
HTML does not establish the current Worker revision. Exact current health was
unavailable through this audit's public access path. The retained
[September 11 activation record](https://github.com/adamallcock/tibotattle/blob/19a743610542309e3f55a97dbd714bda5d84b57b/docs/decisions/2026-09-11-public-contribution-sources.md)
records source `03d4217f`, applied migration `0060`, and resumed scheduled
publication. Migrations `0057`–`0059` were already completed. Source integration
must preserve those files and must not replay their production operations.
Scheduler deployment was not independently verified by this audit.

## Exact scheduler-prefix selection

These are the 20 commits in `origin/main..3de7ccd0`, oldest first. “Retain”
means port the relevant source change onto current owners, not replace files
with their older branch versions or execute a historical operation.

| Commit | Classification and treatment |
|---|---|
| `81a0a592` | Obsolete operational toggle: enables the migration mutation barrier. Omit. |
| `350fbb5a` | Cancels the preceding toggle. Omit; main and the final hosted source already have the barrier disabled. |
| `f496494c` | Hosted configuration parity: production accountless enrollment/ownership flags and generated types. Exclude from this source candidate. Reconcile separately against live configuration before any authorized deployment; no activation flags change here. |
| `a62b940d` | Required Electron public-site renderer, exact publication-plan/artifact validation, evidence schema/policy and tests. Retain; preserve explicit owner-acceptance semantics without relabelling unpassed checks. |
| `d03c3633` | Shared catalog preservation correction to the preceding site change. Retain its final catalog boundary. |
| `d5d9ccaf` | Normal Mac replacement renderer/catalog behavior. Retain final behavior, not intermediate 0.1.20 release claims. |
| `8e42637f` | Compact verified download controls, clipboard/localization behavior and renderer tests. Retain. |
| `7b6cfdc9` | Translated documentation initialization. Retain. |
| `9accd6f0` | Updated native-to-Electron transition copy and tests. Retain applicable final copy; historical qualification stays dated. |
| `90cde16e` | Accountless public-source selection, migration `0060`, bounded rebuild, privacy/copy and schema gates. Retain runtime and exact migration; reconcile dated current-status edits. |
| `dd98b2cc` | Exact local/remote SQL comment-form verification with negative tests. Retain; do not normalize arbitrary drift. |
| `03d4217f` | Deployment candidate defaults to the checked-out source. Retain guard and regression test. |
| `d705bd00` | Current local-analysis page descriptions in the canonical site catalog. Retain. |
| `ba736634` | Homebrew actions preserved inside generated Electron download panels. Retain. |
| `a85b9214` | Narrow-screen full Homebrew command visibility. Retain alongside current styles. |
| `5119bc9b` | Historical release-note synchronization. Do not replay wholesale: 0.1.19–0.1.22 notes already match main; main's CHANGELOG has newer exact source links and correct released wording. |
| `6427bb44` | Graph budget begins after required maintenance and bounded weekly publication. Retain shared query budget, source/privacy gates and scheduler tests. |
| `86fb66f6` | Closed scheduler diagnostic-field assertions. Retain. |
| `ead9227c` | Content-free reconstruction failure classification and prepared-evidence errors. Retain runtime and privacy/regression tests. |
| `3de7ccd0` | Database/account-capacity failure classifications. Retain with tests. |

PR #120's sibling docs are selective evidence input: its release notes match
main, and main's September 13 status already reconciles the historical
activation/rebuild facts. Preserve that newer status and immutable 0.1.22
provenance. Add the sibling commits' dated “Observed activation” section to the
newly integrated public-source decision where absent; do not restore the old
0.1.21-current or Windows/Electron-unreleased statements.

## Least-risk consolidation

1. Start an isolated hosted branch from the current main source. Apply the
   retained patches above in dependency order, grouped into reviewable site/
   evidence tooling, accountless/schema parity, and scheduler commits. Keep
   production configuration reconciliation separately inspectable. Exclude
   both transient fence commits and the superseded release-note replacement.
2. Preserve main's architecture and release contracts during conflict resolution.
   The old branch's `package.json` still says 0.1.18; its public-site builder
   imports retired `collectMacOSWebModuleGraph`. Keep the current version,
   `collectWebModuleGraph` from `runtime-closure.mjs`, current app-only asset
   exclusions, i18n checks and tool inventory. Merge canonical catalog keys,
   then regenerate both browser and Electron mirrors. Never copy the old tree.
3. Keep `MIGRATION_MUTATION_BARRIER_ENABLED` false and migration `0060` byte-exact.
   No migration command, collection-control mutation or deployment follows from
   creating this candidate. Never point a new migration executor at the running
   recovery's journal or replace its pinned source.
4. Qualify the combined source: focused public-source/scheduler tests, complete
   Worker gate, public-release-site and release-evidence tests, architecture,
   i18n mirrors, documentation and preflight. Build a local public-site preview
   using the reviewed 0.1.22 publication plan/artifacts so the candidate retains
   all four downloads and both Homebrew actions; inspect translations, narrow
   layouts and metadata. A future release uses its own reviewed artifacts.
5. Record an exact candidate source and resolve remaining failures before a PR
   or deployment claim. A later hosted deployment still requires independent
   current-source, migration-ledger/schema, recovery and guarded publication
   checks. Do not infer them from a desktop build or earlier PR checks.

## D1 stage held separately

Typed draft `eda56e7c` adds schema/copy/admission/analytics and guarded cutover
operations. Its [source plan](https://github.com/adamallcock/tibotattle/blob/eda56e7ca6428d13ac14a8bbd1a3fc237dc359a9/docs/plans/2026-09-11-d1-typed-storage-isolation.md)
retains outstanding combined-source qualification and execution-window rollover
proof. It records only the independent deletion-ledger `0003` upgrade as applied;
that dated record is not a current main-database cutover receipt.

Shard draft `0631b2fb` records a local owning gate at `f787f705`: 1,523 tests and
four dry builds. Its [source plan](https://github.com/adamallcock/tibotattle/blob/0631b2fb1f79f0ce59f0eba31c0a0b1bef1c920a/docs/plans/2026-09-13-d1-shard-continuity.md)
still requires the owner copier/final route switch, complete moved-owner
lifecycle/export coverage, qualified spares, physical-growth calibration and
isolated cloud rollover/failure qualification. Catalog activation also requires
exact historical issuance/locator backfills, routing and deletion-ledger `0005`
and relevant analytics/origin migrations, with their own approval/readback.
Checked-in production remains JSON storage; catalog mode is not enabled.

Genuine local-only D1 follow-ups are `65ae8325` then `6c8d5711` (verification read
coalescing and width-bounded pages), plus sibling `9ede991b` (verification wakeup
bursts). They start at `cd1ae544`; their worktrees were clean in this audit.
Review and qualify their combination on a separate D1 candidate before any use
in recovery. Preserve the mutation limits, exact proofs and uncertain-outcome
fences. The apparently unique `ea5f026a`/`bd085073` fixes are already represented
semantically in `0631b2fb`; replaying their old inventory assertions would
regress deletion-ledger coverage from `0005` to `0004`.

## Integration result

The selected hosted source was committed at `a18fb6d75d80739077079c0a4cd34883011e9889`
and combined with the desktop candidate at `ca58e3f47b688110be9fe7f5b89b3a73bf7a24c9`.
The full Worker gate passed 1,048 tests and dry builds. The combined source then
passed 92 focused quota-consumer tests, package/type checks and both dry builds;
925 combined browser/public-site/localization/inventory tests passed. See the
[release integration plan](./2026-09-13-release-integration.md) for exact artifact
and remaining release boundaries. Production flags and D1 drafts remain excluded.
