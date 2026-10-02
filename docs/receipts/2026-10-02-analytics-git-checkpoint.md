---
title: Analytics Git maintenance checkpoint
date: 2026-10-02
type: receipt
status: prepared-source-checkpoint
---

# Git preservation scope

The owner authorized a complete commit and push after the October 2 maintenance
pause. Destination is the existing `origin` repository, `adamallcock/tibotattle`,
branch `codex/maintained-analytics-framework`. No remote branch with that name was
present at the pre-push inspection. Base commit is
`f056940fefabed0c7f0e88353cf54845b077f0c8`.

The [candidate manifest](./2026-10-02-analytics-candidate-manifest.json) records all
318 integrated changed files with exact hashes. They matched the verified local
recovery archive before packaging. Five unapplied source/test proposals and their
review metadata are preserved in the [draft checkpoint](../reviews/2026-10-02-analytics-draft-checkpoint.md).
Primary and original worktrees are outside this checkpoint's mutation scope.

Integrated candidate commit: `905eae33f86da5509850c83fb127c9a6e9ff7a70` (318 files). The following
commit preserves the separate unapplied drafts and this checkpoint record.

## Validation boundary

The following checks passed against this source checkpoint on Node 26.2.0:

- Worker TypeScript: `npm run typecheck`.
- Worker workspace package-copy guard.
- Generated admin UI asset equality check.
- Documentation governance: 308 Markdown / 1,246 source/config files after source integration.
- Architecture: 716 production files / 3,210 imports / zero debt edges.
- Root workspace hygiene and the preflight lane: 20 tests, zero failures.
- Syntax of all 36 changed JavaScript modules and parsing of new JSON artifacts.
- All 318 original candidate hashes still exactly match the recovery manifest.
- All five packaged diffs reconstruct byte-for-byte and pass `git apply --check`;
  none was applied.
- Added-content checks found no private-key, token or personal-path pattern matches.

The root pnpm wrapper attempted an automatic dependency reinstall and was refused
by the filesystem boundary. The same documentation, architecture, workspace and
preflight entrypoints were then run directly with Node, against preserved installed
dependencies; each passed. No dependency reinstall was used as qualification.

The full owning Worker suite remains pending. The known terminal result is four passes and three failures;
original physical-read gates remain unqualified. No assertions, checks, budgets or
release gates are weakened for this checkpoint. See the
[maintenance pause](./2026-10-02-analytics-maintenance-pause.md) and
[oracle follow-up](../reviews/2026-10-02-analytics-oracle-followup.md) for detailed
retained results and outstanding work.

A pushed source checkpoint remains distinct from integration completion, CI,
deployment, migration, activation and production qualification. P0-P11 remain
incomplete; production work still requires its separate authorization.
