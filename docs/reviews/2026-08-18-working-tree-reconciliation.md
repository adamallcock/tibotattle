---
title: Working Tree Reconciliation and Cleanup
date: 2026-08-18
type: review
status: locally reconciled; unpublished
---

# Working Tree Reconciliation and Cleanup

## Outcome

The previously dirty `ship/v0.1.11` checkout has a byte-exact recovery commit,
and the changes that remain valid on current `origin/main` have been assembled
on an isolated integration branch. No branch was deleted, no remote ref was
deleted, and no integration branch was pushed, merged, deployed, or published
as part of this reconciliation.

| Boundary | Local evidence |
|---|---|
| Current integration base | `origin/main` and local `main` at `6c191224301b2ac846f77a3d7708fd9577ef2199` |
| Full pre-reconciliation recovery point | `backup/2026-08-18-pre-main-reconciliation` at `102c998748b9dda654822d100a41c0e86a66df24` |
| Forward integration branch | `codex/working-tree-reconciliation` |
| Website-owned lane | `codex/web-release-lane-main` at `f099d377a94e9c1a8cdf526da92e4caed7cd79a6`; squash-merged as PR #15 at `6c19122` |
| App Store-owned lane | `codex/mac-app-store-compatibility-plan` at `dcb796b08fa8ccb3cba7d71066f4ae1da223da61`; squash-merged as PR #16 at `d22a6bd` |

The recovery commit was created without changing the live checkout or index.
It includes every tracked change and every non-ignored untracked file that was
present in the original checkout. A temporary index loaded from `102c998` was
refreshed against the live working tree; both `git diff-files` and
`git ls-files --others --exclude-standard` returned no paths. This proves the
recovery commit still exactly represented the original working tree before its
normalization.

After PRs #15 and #16 merged, local `main` was fast-forwarded from `f42b26e`
to `6c19122`. The combined website patch has the same stable patch ID
(`c5bb765e723c46f1541039ed4b2f5cbf08518bd9`) and raw binary-diff SHA-256
(`dfa6bf0d94597c9de114a0ac4e59241eb50f50639eb32f53f9e501a8779f7e73`)
before and after its squash merge. The App Store patches share stable patch ID
`48aa1037d78e97837c75f93b22496a5c82062e0a`.
Accordingly, neither merged change was replayed on the rebuilt integration
branch. The rebuilt tree at `12295e1` exactly matched the previously validated
integration tree at
`backup/2026-08-18-reconciliation-before-pr15-pr16`; both resolved to tree
`3c82e1f2d4b406412647f95051aece10567c88f8`.

## Forward changes

The integration branch now starts from the two merged ownership lanes on
current `origin/main`, followed only by independently reviewed work that was
not part of either squash merge.

| Commit | Purpose |
|---|---|
| `ec56b4e` | Show weekly macOS allowance position |
| `555d8af` | Establish the canonical public web origin |
| `9ce607a` | Preserve unique documentation and quality findings |
| `ca23ab7` | Classify all web release tools |
| `aba2924` | Add the download trust and verification disclosure |
| `e9f7957` | Preserve UTC community calendar days |
| `7656168` | Date share cards from observed evidence |
| `964e9e3` | Align installer tests with shared formatting |

The download disclosure deliberately distinguishes checksum integrity from
software safety and source-to-binary provenance. Its version, DMG filename,
and SHA-256 are derived from verified installer metadata rather than frozen
page copy. No provenance or reproducible-build attestation was added because
the repository does not yet expose a public cryptographic attestation that
would support that claim.

## Validation

| Check | Result |
|---|---|
| `git diff --check` | Pass |
| `npm run architecture:check` | Pass; 369 production files, 1,444 imports, zero debt edges |
| `npm run tools:inventory:check` | Pass; 68 records, 70 executable paths |
| `npm run docs:links:check` | Pass |
| `npm run product:ui:test` | 280/280 pass |
| `npm run product:release-site:test` | 29/29 pass with normal loopback access |
| `npm run test:macos:source` | 43 pass; 3 intentionally excluded |
| Worker script checks | 149/149 pass |
| Worker runtime tests | 385/385 pass |
| Production Worker dry run | Pass with 20 generated public assets |
| Staging configuration and dry run | Pass; closed and intentionally unprovisioned |
| Signed 0.1.12 site generation | Pass after local stapling validation; exact checksum and trust copy inspected |

The staging receipt reports `STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED` and
`safe_unprovisioned`. That is the intended static boundary, not a live staging
readiness claim. The missing envelope-key warnings in the Worker tests are also
expected because the test environment does not load production secrets.

## Worktree cleanup

The registered worktree set was reduced from 35 to 13 after ancestry, status,
untracked-file, remote-ref, and patch-equivalence checks. Roughly 3.7 GiB of
worktree storage was reclaimed. Branch refs were retained even when a worktree
was removed, and no remote branch was deleted.

Before removing worktrees that contained generated or untracked evidence, the
relevant output was archived under:

`/.release-archive/worktree-cleanup/2026-08-18/`

The archive is approximately 10 MiB and includes release-build outputs,
validation logs, browser screenshots, stale raw Claude worktree directories,
and the detached origin-baseline inventory and release metadata. Archives were
listed and checksummed before their source worktrees were removed.

Removed worktrees were limited to proven ancestors, exact patch-equivalents,
superseded detached baselines, completed ephemeral agent worktrees, and invalid
registrations whose raw directories and branch refs had first been preserved.
After PR #15 merged, its clean 24 MiB worktree was also removed only after a
fresh check showed no untracked evidence and no ignored content beyond
dependency directories. Its local and remote branch refs remain at `f099d37`.

## Worktrees still preserved

The remaining worktrees are intentionally retained until their unique commits,
dirty files, active ownership, or release artifacts are resolved:

- the clean `main` checkout and this integration worktree;
- local-index release and checkpoint worktrees;
- admin v0.2 and Claude foundation worktrees;
- log-processing performance and cache-switch/cost-lens worktrees;
- the detached signed v0.1.12 artifact carrier;
- v0.1.13 performance-client and UI red-team worktrees;
- the share-card plan worktree, whose unique commit has not been fully replaced
  by the narrower share-card change on the integration branch; and
- the public-prep worktree.

Removal from this set requires a fresh status and untracked-file check plus
proof of ancestry, patch equivalence, or explicit abandonment. Release artifacts
must be archived before their carrier is removed.

## Publication boundary

This document records local reconciliation only. It does not authorize pushing
`codex/working-tree-reconciliation`, deploying the website or Worker,
submitting to the App Store, publishing an update feed, or deleting any
remaining branch or remote ref. PRs #15 and #16 were merged by their owning
threads; this reconciliation only verified and consumed their resulting
history.
