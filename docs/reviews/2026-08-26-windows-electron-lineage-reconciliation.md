---
title: Windows Electron Lineage Reconciliation
date: 2026-08-26
type: decision-record
status: accepted locally; physical qualification pending
---

# Windows Electron Lineage Reconciliation

## Decision

Continue Windows and Electron work from
`codex/windows-electron-reconciliation-20260826` at merge commit `5d3f9dcf`.
That commit combines the canonical Electron and multi-root integration at
`5ad34f9a` with current `origin/main` at `7c88d13a`.

Do not replay or wholesale-merge any of these older lines:

- `codex/windows-electron-current-main` at `f173c1b4`;
- `codex/windows-electron-parity-local-main` at `f2b05fa5`; or
- `origin/codex/windows-electron-v013-integration` at `7fa6347d`.

Three independent source and patch audits found no feature or safety control
that must be transplanted from those refs. Their useful work is already present
or has a newer semantic replacement. Replaying them would reintroduce older
Electron, SQLite, qualification, and signing designs.

This decision closes source-lineage reconciliation only. It does not claim a
qualified Windows artifact, a signed installer, macOS Electron parity, or Linux
support.

## What the reconciliation retains

The chosen line contains the older branches' Windows Credential Manager,
credential-audit, filesystem, protected-state, SQLite-session, contribution
queue, prepared-artifact, Electron packaging, protocol, process-tree, and owned
download foundations.

It also contains later controls that the older lines lack:

- private factory-issued bindings for protected state and staged SQLite work;
- native unified-index qualification, phase diagnostics, off-main execution,
  bounded cancellation, and abandoned-stage cleanup;
- journal cleanliness, delete-pending, held-handle identity, reparse and
  hard-link checks, no-clobber first publication, and safer rename handling;
- a two-job prepare/sign boundary in which only the protected signing job can
  mint Azure credentials;
- canonical preparation-manifest transport and revalidation;
- exact certificate-subject hash preflight and Authenticode subject binding;
- current macOS Electron smoke and real-history QA harnesses;
- current Settings, Share, toolbar, tray, lifecycle, startup-refresh, and
  cancellation behavior;
- bounded one-to-eight-root Settings and companion launch semantics with an
  explicit primary root; and
- separate opt-in WSL2 multi-root qualification coverage.

The old `apps/electron/preload.js` is intentionally replaced by the current
`preload.cjs`. The old cache-continuity gap surface is intentionally replaced by
the newer cache-reuse outcome raster.

## Rejected alternatives

### Replay `codex/windows-electron-current-main`

Rejected. Its core work is represented in the canonical integration, while it
lacks later native SQLite safeguards, private qualification bindings, the
prepare/sign split, certificate-subject binding, current macOS QA, multi-root
Settings, and WSL2 qualification.

### Replay `codex/windows-electron-parity-local-main`

Rejected. It has no file absent from the reconciliation tree. The reconciliation
tree adds 58 paths and contains newer shared dashboard, accounting, shell,
lifecycle, cancellation, and qualification behavior.

### Replay `origin/codex/windows-electron-v013-integration`

Rejected. Its credential and contribution primitives are preserved, while its
four non-patch-identical commits have explicit semantic replacements. It lacks
the later SQLite, signing, Electron, WSL2, and macOS QA layers.

### Rebase onto `origin/main` alone

Rejected. `origin/main` does not contain the Windows Electron candidate. The
selective merge at `5d3f9dcf` preserves the integration and also incorporates
current Codex binary/version discovery and doctor diagnostics without removing
multi-root CLI semantics.

## Branch-hygiene actions

The repository setting `delete_branch_on_merge` is enabled. This is the missing
future-cleanup control; the existing `main` and version-tag rulesets were not the
cause of retained feature branches. This checkout also has `fetch.prune=true`.

Eight registrations whose `/private/tmp` worktree directories no longer
existed were pruned from Git metadata. No files or branch refs were removed by
that operation.

Fifteen retained branches for merged PRs #53 through #67 were deleted locally
where present and deleted from `origin` only after all of these checks passed:

1. GitHub reported the PR as merged into `main`;
2. the remote branch tip matched the recorded PR head SHA;
3. the patch or squash result was present on current `origin/main`; and
4. no registered worktree used the branch.

| PR | Deleted branch tip | Merged result |
|---|---|---|
| #53 | `491882fd` | `d2d6a7c8` |
| #54 | `1b5632b3` | `2bcd0078` |
| #55 | `1a11011e` | `285bee48` |
| #56 | `2aa8f91c` | `d8a40911` |
| #57 | `53102085` | `527589ec` |
| #58 | `8febf5be` | `fa51ef8c` |
| #59 | `abd17cd8` | `d79f002d` |
| #60 | `557bfdbd` | `c0c6deed` |
| #61 | `587a98a4` | `2d113da2` |
| #62 | `0cc99489` | `abd101bb` |
| #63 | `7ed05a98` | `cff87d40` |
| #64 | `1ab5698d` | `8687cbb9` |
| #65 | `7d9fa1c7` | `69688b95` |
| #66 | `c5ef1ac8` | `06f405f6` |
| #67 | `e3a99be5` | `67becece` |

The 31 `codex/windows-electron-qualified-*` refs remain intentionally
preserved. They may be retired only after exact-current-revision warm and clean
Windows receipts replace their evidence and the replacement provenance is
retained. Active dirty Codex and Claude worktrees, the credential-lifetime
branch, and the intentionally parked credit-drawdown branch are also outside
this cleanup.

## Remaining gates

1. Run the focused source and contract matrix for the reconciliation commit.
2. Build an exact-digest macOS Electron package and prove real-history quick
   result, advancing status, responsive cancellation, complete Usage and
   Community data, Settings, Share, tray icon/menu, close, relaunch, and quit.
3. Run warm and clean native Windows x64 qualification for that exact revision,
   plus the separate WSL2 multi-root canary.
4. Resolve or explicitly accept the owned-download destination race before a
   production parity claim.
5. Only after qualification, run the protected Azure signing and installed-app
   matrix. No publication or version bump is authorized by this record.

## Validation

| Check | Result |
|---|---|
| Merge conflict review | `docs/reference/product-reference.md` retains both multi-root command semantics and current doctor diagnostics |
| Privacy and account boundary tests | 28/28 pass |
| `git diff --check` | Pass after the focused repair and this record |
| `npm run architecture:check` | Pass; 431 production files, 1,681 imports, zero debt edges |
| `npm run docs:links:check` | Pass |
| Windows signing/finalizer contracts | 150 pass, 4 expected platform skips, 0 fail |
| Windows SQLite/unified-index/cancellation contracts | 190 pass, 36 explicit native-Windows-only skips, 0 fail |
| Electron parity/multi-root/macOS smoke contracts | 415/415 pass after the single permitted repair |

The repair changed only the qualification fixture classifier and its regression
assertion: `config/deployment-endpoints.js` is an Electron-shell resource in the
runtime manifest, not a third-party dependency. Production runtime behavior was
already fail-closed and was not changed.
