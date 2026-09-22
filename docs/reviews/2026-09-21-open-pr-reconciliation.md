---
title: Open pull-request reconciliation
date: 2026-09-21
type: review
status: reviewed
---

# Open pull-request reconciliation

This is a read-only GitHub and local Git snapshot taken on 2026-09-21. It
audits the 20 open pull requests in `adamallcock/tibotattle` against the
refreshed remote `main`. It records source ancestry, patch equivalence and the
stacked base relationships that affect a close or review decision. No pull
request was merged, closed, deleted, rebased, commented on or otherwise
modified.

The comparison base is `origin/main` at
`8e8df1b5d6aeb5283da2b7979b15c966df61fbe3` (the merge of PR #193). The PR
head SHAs and base SHAs below came from the live GitHub pull-request listing;
they are a point-in-time record and should be refreshed before taking any
remote action.

## Result

Twelve open PR tips are already exact ancestors of current `main`, even though
GitHub still lists them as open. Four additional non-ancestor tips have no
remaining unique implementation patch after patch-equivalence review: #124,
#160 and #166 are old stacked branches whose changes are represented on
`main`; #138 is an older production-canary update superseded by the newer
canary workflow already on `main`.

Four PRs contain work that remains unique relative to `main`:

- **#133** adds the typed-storage shard routing, owner-movement and
  multi-origin analytics/erasure work. It is a large, production-impacting
  storage stack and depends on the #124 typed-storage base.
- **#150** adds exact prebuilt-index admission during authority promotion and
  a clock-independent migration fixture. It is a small but safety-sensitive
  recovery change and depends on the #124 storage stack.
- **#152** adds cutover schema/ledger validation, independent count and
  high-water checks, and a bounded read deadline for the full foreign-key
  check. It is the only unique PR directly related to the typed production
  maintenance path and depends on #151.
- **#158** has code that is patch-equivalent to `main`, but two commits still
  uniquely update the dated Worker analytics research record. That document is
  point-in-time evidence and contains a private temporary-path reference in
  the PR version; it must be reviewed or split before any merge.

The open PR set does not contain the public-site asset preservation needed for
the admin dashboard deployment. That preservation is a deployment-candidate
composition concern; merging the old storage stack is not a prerequisite for
the admin-only update.

## Per-PR disposition

`Tip ancestor` means `git merge-base --is-ancestor <tip> origin/main` passed.
For non-ancestors, `patch-equivalent` means the non-merge commits had no
right-only change under `git log --cherry-mark --right-only --no-merges`, with
merge-parent deltas inspected separately. “Close candidate” is a proposed
disposition only; no remote close was performed.

| PR | Base ref @ SHA | Head ref @ SHA | Relation to current `main` | Patch-level finding and disposition |
|---:|---|---|---|---|
| [#124](https://github.com/adamallcock/tibotattle/pull/124) | `codex/community-scheduler-repair-20260911` @ `3de7ccd0a293e1d9b95ce14b591dbf5f1c2d1f2b` | `codex/d1-typed-storage-isolation` @ `eda56e7ca6428d13ac14a8bbd1a3fc237dc359a9` | Tip not ancestor | The 24-commit range is old typed-storage work. Its merge commit's two-file parent-upsert delta has the same stable patch ID as `ceeeca32`, which is on `main`; no other non-merge change is unique. **Close candidate: already incorporated.** |
| [#133](https://github.com/adamallcock/tibotattle/pull/133) | `codex/d1-typed-storage-isolation` @ `eda56e7ca6428d13ac14a8bbd1a3fc237dc359a9` | `codex/d1-shard-replay-20260913` @ `25797e48f6b5948873ec0bb22dc90dfcbac7dcea` | Tip not ancestor | 29 unique commits, 141 files, adding shard routing, owner movement, retained-origin resolution, multi-source publication and resumable erasure. **Preserve for deliberate storage review; do not close as stale.** |
| [#138](https://github.com/adamallcock/tibotattle/pull/138) | `codex/d1-typed-storage-isolation` @ `eda56e7ca6428d13ac14a8bbd1a3fc237dc359a9` | `codex/production-canary-022-20260914` @ `8c6f11577aeffb7bccab60559c6346b981cf199f` | Tip not ancestor | One unique commit updates the canary workflow and fixtures from the 0.1.19 rehearsal artifact to a 0.1.22 stable artifact. `main` now binds a later reviewed production-canary artifact, so this exact update is superseded. **Close candidate: superseded by `main`.** |
| [#150](https://github.com/adamallcock/tibotattle/pull/150) | `codex/d1-typed-storage-isolation` @ `eda56e7ca6428d13ac14a8bbd1a3fc237dc359a9` | `codex/d1-promotion-index-recovery-20260914` @ `c3f01b42fce7b778c060487690a4cd82be61b0e1` | Tip not ancestor | Two unique commits change authority promotion to accept only exact prebuilt final indexes and make a migration fixture relative to the current clock. **Preserve for recovery-safety review.** |
| [#151](https://github.com/adamallcock/tibotattle/pull/151) | `codex/d1-typed-storage-isolation` @ `eda56e7ca6428d13ac14a8bbd1a3fc237dc359a9` | `codex/d1-upload-first-cutover-20260914` @ `8da57e767a3b7b3d38d3bf80546e75afcd59e08d` | Tip ancestor | The 18-file upload-first cutover range is already reachable from `main`. **Close candidate: already incorporated.** |
| [#152](https://github.com/adamallcock/tibotattle/pull/152) | `codex/d1-upload-first-cutover-20260914` @ `8da57e767a3b7b3d38d3bf80546e75afcd59e08d` | `codex/d1-cutover-schema-comparison-20260914` @ `85b0c730db5a23586f9c706b89de93f5393ce535` | Tip not ancestor | Four unique commits add independent native counts/high-water seeks, typed admission sequence checks, an operator-ledger check and a 35-second read-only foreign-key-check deadline. **Preserve for typed production-maintenance review.** |
| [#153](https://github.com/adamallcock/tibotattle/pull/153) | `codex/d1-upload-first-cutover-20260914` @ `8da57e767a3b7b3d38d3bf80546e75afcd59e08d` | `codex/typed-v1-owner-query-index-20260914` @ `4dbfcc1a772cc7893b898a0ec6b833e42a703b32` | Tip ancestor | Typed Admin summaries, bounded owner-index queries and related tests are already reachable from `main`. **Close candidate: already incorporated.** |
| [#154](https://github.com/adamallcock/tibotattle/pull/154) | `codex/typed-v1-owner-query-index-20260914` @ `4dbfcc1a772cc7893b898a0ec6b833e42a703b32` | `codex/d1-analytics-catchup-admin16-20260914` @ `5c90782f549bad205c8c67333181585e435aabcc` | Tip ancestor | The bounded typed analytics catch-up worker and tests are already reachable from `main`. **Close candidate: already incorporated.** |
| [#155](https://github.com/adamallcock/tibotattle/pull/155) | `codex/d1-analytics-catchup-admin16-20260914` @ `5c90782f549bad205c8c67333181585e435aabcc` | `codex/d1-analytics-catchup-3page-20260915` @ `b94215b20491c6a178e2eb2dd216a0d66649dbb0` | Tip ancestor | Partial-page and amortized catch-up changes are already reachable from `main`. **Close candidate: already incorporated.** |
| [#156](https://github.com/adamallcock/tibotattle/pull/156) | `codex/d1-analytics-catchup-3page-20260915` @ `b94215b20491c6a178e2eb2dd216a0d66649dbb0` | `codex/d1-analytics-catchup-auto-boundary-20260915` @ `18b38f1d2ed707d5e8ab6795ef6ec833b988bc13` | Tip ancestor | Format-boundary catch-up continuation is already reachable from `main`. **Close candidate: already incorporated.** |
| [#157](https://github.com/adamallcock/tibotattle/pull/157) | `codex/d1-analytics-catchup-auto-boundary-20260915` @ `18b38f1d2ed707d5e8ab6795ef6ec833b988bc13` | `codex/d1-analytics-v11-throughput-20260915` @ `79048a39a7e2f4f8f1e5d948b4de4b0365308f4a` | Tip ancestor | Known-work reuse and independent source-read batching are already reachable from `main`. **Close candidate: already incorporated.** |
| [#158](https://github.com/adamallcock/tibotattle/pull/158) | `codex/d1-analytics-v11-throughput-20260915` @ `79048a39a7e2f4f8f1e5d948b4de4b0365308f4a` | `codex/d1-analytics-admitted-v11-20260915` @ `139063351deed2d4e458ecd00ecad3b4f65bc40e` | Tip not ancestor | Analytics code commits are patch-equivalent to `main`; two unique commits only update `docs/research/2026-09-15-worker-analytics-performance.md`. **Preserve for documentation review or split; do not merge the PR version unchanged.** |
| [#159](https://github.com/adamallcock/tibotattle/pull/159) | `codex/d1-analytics-admitted-v11-20260915` @ `614e42eb8095c6b37a6afe12693b71dfc7c46f3e` | `codex/d1-analytics-v11-page-groups-20260915` @ `b482cf8093175b2c06e9b014a0ea2a9d12eaba69` | Tip ancestor | Bounded physical page grouping is already reachable from `main`. **Close candidate: already incorporated.** |
| [#160](https://github.com/adamallcock/tibotattle/pull/160) | `codex/d1-analytics-v11-page-groups-20260915` @ `b482cf8093175b2c06e9b014a0ea2a9d12eaba69` | `codex/graph-historical-reader-recovery-20260915` @ `8a58c9320d65937dd26b764278bc34ade552cfec` | Tip not ancestor | The merge tip equals its second parent; its non-merge graph-read changes are patch-equivalent to mainline commits from the parallel recovery branches. **Close candidate: already incorporated.** |
| [#162](https://github.com/adamallcock/tibotattle/pull/162) | `codex/graph-historical-reader-recovery-20260915` @ `8a58c9320d65937dd26b764278bc34ade552cfec` | `codex/graph-cache-publication-priority-20260915` @ `ab6d9f6080ce25e4ebaf35613a12b16925de7c04` | Tip ancestor | Completed-fit publication priority is already reachable from `main`. **Close candidate: already incorporated.** |
| [#163](https://github.com/adamallcock/tibotattle/pull/163) | `codex/graph-cache-publication-priority-20260915` @ `ab6d9f6080ce25e4ebaf35613a12b16925de7c04` | `codex/graph-direct-cross-plan-20260915` @ `72d44c2a04758f01508a53bd18ffa54bff46f9e2` | Tip ancestor | Bounded direct reads and one retry for repaired history are already reachable from `main`. **Close candidate: already incorporated.** |
| [#164](https://github.com/adamallcock/tibotattle/pull/164) | `codex/graph-direct-cross-plan-20260915` @ `72d44c2a04758f01508a53bd18ffa54bff46f9e2` | `codex/graph-missing-fit-priority-20260915` @ `6dc1e7e0d21353a3b7ef879a03bd707f6bb97483` | Tip ancestor | Missing-fit prioritization is already reachable from `main`. **Close candidate: already incorporated.** |
| [#165](https://github.com/adamallcock/tibotattle/pull/165) | `codex/graph-missing-fit-priority-20260915` @ `6dc1e7e0d21353a3b7ef879a03bd707f6bb97483` | `codex/graph-direct-read-diagnostic-20260915` @ `94fdff6d6b27c27e78d99c2114d6579538e8f0c3` | Tip ancestor | Owner-bounded v1.1 analysis and safe direct-read diagnostics are already reachable from `main`. **Close candidate: already incorporated.** |
| [#166](https://github.com/adamallcock/tibotattle/pull/166) | `codex/graph-direct-read-diagnostic-20260915` @ `94fdff6d6b27c27e78d99c2114d6579538e8f0c3` | `codex/graph-authority-checkpoint-recovery-20260915` @ `9ab10f05505f08922a5cde9f6c988d26d75e8006` | Tip not ancestor | The 18-commit branch has no unique right-only non-merge patch; its head patch is equivalent to mainline commit `0d44507f`. **Close candidate: already incorporated.** |
| [#170](https://github.com/adamallcock/tibotattle/pull/170) | `codex/graph-direct-read-diagnostic-20260915` @ `94fdff6d6b27c27e78d99c2114d6579538e8f0c3` | `codex/graph-retention-recovery-20260916` @ `2373a0202e24f52c7280ac2961b27d1719beb4ef` | Tip ancestor | Graph retention and opt-out history changes are already reachable from `main`. **Close candidate: already incorporated.** |

## Stack and worktree notes

The PRs form an old typed-storage and analytics stack rather than 20
independent changes. Exact base-SHA matches show #124 as the parent of #133,
#138, #150 and #151; #151 is the parent of #152 and #153; #153 feeds #154,
then #155, #156, #157 and #158. #159 is based on the earlier `614e42e` point
of the analytics branch, not the current #158 tip, so its title alone must not
be treated as a dependency. #160, #162, #163, #164, #165 and #166 continue
the graph-recovery line; #170 is a parallel branch from the #165 base.

Where a matching head branch had a registered local worktree, the worktree was
checked read-only for tracked modifications. Seventeen present head worktrees
were clean at audit time; three head branches had no registered worktree. This
is an observation about local state, not evidence that the remote branches are
disposable or that their owners have abandoned them.

## Evidence boundary and next action

This review establishes source ancestry and patch disposition only. It does not
establish that any PR is safe to deploy, that a typed-storage migration is
authorized, or that a production database can be changed. The four unique
areas should remain available for an explicit storage/recovery review. A
maintainer can then close the 12 exact-ancestor PRs plus the four
equivalent/superseded candidates after checking ownership and any required
retention of historical evidence. No remote cleanup was performed as part of
this audit.
