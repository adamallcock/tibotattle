---
title: Working Tree Reconciliation and Cleanup
date: 2026-08-18
type: review
status: locally consolidated; active Windows lane pending
---

# Working Tree Reconciliation and Cleanup

## Outcome

The repository's registered worktrees were reduced from 13 to two without
deleting any remote ref, pushing, deploying, or publishing. All dirty,
untracked, ignored-artifact, ancestry, tree-equivalence, and stable-patch
boundaries were checked before removal.

The two worktrees still registered are:

- the root checkout on `codex/windows-electron-delivery`, which is actively
  dirty and owned by another in-progress thread; and
- the clean `codex/working-tree-reconciliation` integration worktree.

Local `main` and `origin/main` were verified equal at `6c19122`. Website PR
#15 and App Store PR #16 are each present exactly once on that base. Their old
topic commits were patch-equivalent and were not replayed.

## Recovery boundary

Before cleanup, all 146 then-visible refs and tags were preserved in:

`/.release-archive/worktree-consolidation/2026-08-18/pre-consolidation-all-refs.bundle`

Its SHA-256 is
`825586afe9c5fb7a2a64313d6f26d422a58d67e3d4b0ec6fac40bc54e90d550f`,
and `git bundle verify` passed.

Unique dirty files, browser evidence, generated evidence, release metadata,
and Sparkle tooling were separately archived in the same directory. The
signed v0.1.12 rollback app remains under
`/.release-archive/stable/0.1.12/` and passed recursive strict code-signature
verification.

The v0.1.13 development app and receipt are archived as
`v0.1.13-development-artifact-and-receipt.tgz` (SHA-256
`d2aa1ce9f2a69b8815cbe3f22b8c9bd40470a9ef2aff2cbc9388e687aba1d9f1`).
Performance plans and receipts are archived as
`performance-branch-receipts.tgz` (SHA-256
`26fdfa2cedcf698f8ea8871362fc5292e7eb816a2da935ae8a21a1ea41e9c94e`).

## Forward integration

The integration branch retains only work that was absent from current main:

| Commit | Purpose |
|---|---|
| `ec56b4e` | Show weekly macOS allowance position |
| `555d8af` | Establish the canonical public web origin |
| `9ce607a` | Preserve unique quality and operations findings |
| `ca23ab7` | Classify web release tooling |
| `aba2924` | Add the download trust and verification disclosure |
| `e9f7957` | Preserve UTC community calendar days |
| `7656168` | Date share cards from observed evidence |
| `964e9e3` | Align installer tests with shared formatting |
| `1a11090` | Port validated log-processing performance layers |
| `b7336c6` | Label share cards with a bounded reported Codex plan |
| `a955a22` | Redact a generated-image UUID from durable documentation |
| `256cfaa` | Retain full unknown provenance when inference overlaps it |
| `0a90d41` | Gate native startup refresh on rendered-dashboard readiness |
| `5b6b65d` | Preserve the original share-card boundary assertions |

The download disclosure distinguishes checksum integrity from software safety
and source-to-binary provenance. Version, DMG filename, and SHA-256 values are
derived from verified release metadata rather than frozen page copy. No public
cryptographic source-to-binary attestation is claimed.

The old worker-isolation coordinator and v0.1.13 release wrapper were
intentionally not ported. The worker source was syntactically invalid, and
parity with the current accounting, Claude, and side-chat configuration
contracts was not proven. Their refs, receipt, manifest, and development app
remain recoverable from the bundle and archives.

## Validation

| Check | Result |
|---|---|
| `git diff --check` | Pass |
| `npm run architecture:check` | Pass; 371 production files, 1,447 imports, zero debt edges |
| `npm run docs:links:check` | Pass |
| Performance-path focused tests | 177/177 pass |
| `npm run product:ui:test` | 283/283 pass after readiness coverage |
| Share-card focused tests | 182/182 pass after final boundary assertions |
| `npm run product:release-site:test` | 29/29 pass with loopback access |
| Local companion server | 47/47 pass with loopback access |
| Fast-mode accounting | 16/16 pass against this worktree's package source |
| `npm run test:macos:source` | 44 pass; 3 artifact-only checks intentionally skipped |
| Worker runtime tests | 385/385 pass in the independent reconciliation audit |

The worktree-local `node_modules` symlink resolves workspace aliases through
the root checkout. The accounting suite was therefore rerun with an ephemeral
loader pinned to this worktree's `packages/accounting/index.js`; all 16 tests
passed. The loader was then removed.

## Cleanup result

Historical worktrees were removed only after unique files and artifacts were
archived or their commits were proven landed, superseded, or represented on
the integration branch. The final four historical carriers reclaimed about
965 MiB of apparent disk usage; earlier verified removals reclaimed additional
space. Local branch refs remain available and shared Git objects were retained.

## Final one-worktree transition

The repository can safely reach one worktree only after the Windows owner
commits and validates its complete change. The remaining steps are:

1. apply the completed Windows commit to this integration branch;
2. resolve and test any cross-lane conflicts;
3. fast-forward local `main` to the resulting linear tip;
4. remove this temporary integration worktree; and
5. switch the clean root checkout to local `main`.

Capturing the root before that handoff would risk committing a partial Windows
implementation. This document does not authorize a push, deployment, release,
remote-ref deletion, or publication.
