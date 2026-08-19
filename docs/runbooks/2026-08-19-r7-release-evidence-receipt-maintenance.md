---
title: R7 release-evidence receipt maintenance
date: 2026-08-19
type: runbook
---

# R7 release-evidence receipt maintenance

The ten retained receipts in `generated/r7-release-*.json` are the dual-runtime
(Node 24.14.0 pinned candidate + Node 26.2.0 compatibility crosscheck) release
evidence for the R7 workload. Each receipt embeds the SHA-256 and file count of
the **current workload source set** — the closure computed by
`workloadSourcePaths()` in `src/r7-release-evidence-schema.js` (runtime `src/`
closure, the two R7 worker scripts, `generated/telemetry-v0.1-*.json`,
`packages/accounting/package.json`, `packages/telemetry-contract/package.json`,
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`).

## When receipts go stale

Any commit that changes a file in that set — including a plain
`package.json` version bump or a merge that brings such changes in — makes
`test/r7-generated-release-evidence.test.js` fail its
`current-workloadCodeSha256` / `current-workloadCodeFileCount` invariants.
This is deliberate: retained evidence must have been produced from the code
it vouches for. Do not hand-edit receipts or weaken the invariant; rerun the
generation.

Known instance: the 2026-08-19 pace-fix PRs (#22–#24) landed workload-source
changes without regeneration, leaving trunk red on these two tests until the
community-onboarding merge regenerated the receipts.

## Regeneration procedure (~2 minutes)

1. Receipts must be owner-only before `--replace` — a fresh checkout or
   `git worktree add` materializes them as `0644`, and the tamper guard then
   fails with the misleading `R7 destination receipt is unsafe`:

   ```bash
   chmod 600 generated/r7-release-*.json
   ```

2. Run the regenerator with **resolved, hash-verified runtime binaries** —
   never a symlink such as `/opt/homebrew/bin/node` (it fails staged-receipt
   validation with a usage+validation error). The script verifies each binary
   against its pinned SHA-256. Node 24.14.0 lives only in the primary
   checkout's untracked `.release-deps/node-runtimes/` (worktrees do not
   inherit it; pass an absolute path); an nvm-installed Node 26.2.0 official
   binary matches the crosscheck pin. The `--start-at`/`--end-at` interval is
   pinned in-script and must be passed exactly:

   ```bash
   node scripts/regenerate-r7-release-evidence.js \
     --node24 "$PRIMARY_CHECKOUT/.release-deps/node-runtimes/node-v24.14.0-darwin-arm64/bin/node" \
     --node26 "$(realpath "$(command -v node)")" \
     --start-at 2026-06-24T09:00:00.000Z \
     --end-at 2026-07-25T09:00:00.000Z \
     --replace
   ```

3. Confirm the summary line (`regenerated 10 validated receipts; source files
   N; source SHA-256 …`). The script exits nonzero on failure, but a shell
   pipeline (`| tail`) masks that — check the summary, not just the exit.

4. Verify and commit the receipts (explicit paths):

   ```bash
   node --test test/r7-generated-release-evidence.test.js
   ```

   The revalidation test always runs; the decision-rebuild test additionally
   requires the invoking Node to be exactly 24.14.0 or 26.2.0 and skips
   otherwise. The decision outcome is expected to remain
   `release_open` with every profile decision `unresolved` until the R7
   thresholds are formally resolved.

## Merge discipline

A branch-side regeneration certifies that branch's tree only. Merging with a
mainline whose workload files differ produces a third tree — regenerate once
more on the merge result before (or immediately after) it lands, or trunk goes
red. Interrupted or crashed runs leave a journal; recover with
`--destination generated --recover` rather than deleting control files.
