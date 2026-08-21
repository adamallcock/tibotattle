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

## Regeneration procedure

Runtime scales with the owner's real Codex corpus: the synthetic profiles
take about a minute each, but the `real-local-history` pair benchmarks the
real corpus (measured 2026-08-19 at ~4,880 rollouts / ~120 GiB: well over
ten minutes total, and growing with the corpus). Budget 20–30+ minutes,
run it in the background, and never put it under a foreground timeout — a
killed run must then be recovered (below) before any retry.

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

## The workload binding is by content, not by execution

This is the single most confusing property of these receipts, and it costs an
hour every time somebody rediscovers it.

`R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256` binds **342 files by content**:
276 under `src/`, plus `packages/`, `scripts/`, `contracts/`, `schemas/`, two
`generated/` artifacts, `package.json`, and the lockfiles. Editing any one of
them invalidates every receipt — **whether or not the benchmark executes it**.

The benchmark itself is narrow. All profiles run one worker,
`scripts/r7-resource-benchmark-worker.js`, and its module graph is export-only:
walking all 131 reachable modules turns up **no reference to
`replay-safe-accounting-cache` or `local-archive-accounting-index`**. R7
exercises source scan, export set materialize/verify, deletion, workspace
discard, and Claude callback lifecycle. It does not exercise the accounting
rebuild, the archive projection, or anything gated on
`accountingSourceMode`.

So "#48 turned R7 red" and "#48 changed an R7 number" are entirely different
claims. The first is routine and expected — #48 edited
`src/replay-safe-accounting-cache.js`, which is in the bound set. The second
cannot happen, because no R7 profile runs that code. The same holds for #49.

**Before attributing any metric shift to a commit, check that the benchmark
actually reaches the changed code.** One command:

```bash
grep -rn "accounting" src/export-set-controller.js src/export-set-materializer.js \
  src/export-set-verifier.js src/export-deletion.js src/export-source-plan.js
```

Silence means the export path never touches it, and the commit is not your
explanation.

## Peak RSS moves between regenerations without a code cause

Regeneration `ce8267f` came in 10–21% higher on peak RSS in some
`real-local-history` operations than its predecessor, while wall-clock and CPU
went *down* and every determinism comparison matched. It is worth recording
what that was **not**, because two independent readers first attributed it to
#48's raised V8 old-space cap on the strength of a matching magnitude
(a measured 128 MB against #48's documented ~123 MiB lazy-GC swing). That
attribution was wrong: R7 never runs the code #48 changed, so the numeric
agreement was a coincidence.

It was also not corpus growth. Between the two runs `sourceFiles` moved 3020 →
3025 and `sourceBytes` by **0.03%**, with `outputRecords` identical at 437,110.
A 0.03% input change does not produce a 21% RSS change.

No code cause exists, and that is verified rather than inferred. Intersecting
the nine files changed between the two regenerations (`005c2b8..7e064f0`)
against the 131 modules R7 actually executes gives an **empty set**: the changes
were three workflow YAMLs, `scripts/publish-sparkle-update.js` and its test, and
two accounting modules with their tests — none of them reachable from the
benchmark worker. Reproduce with:

```bash
git diff --name-only <prev-regen> <this-regen>
```

and check each path against the worker's import graph before blaming any commit.

What remains is environmental: ordinary run-to-run variance in a 26 GB streaming
scan — GC timing and page-cache state — plausibly amplified by system memory
pressure from other processes. Note that memory pressure genuinely *can* move
peak RSS, which is exactly the axis on which concurrent load is worth
suspecting; CPU contention is not (see below). The cheap discriminator, worth
running before anyone sets thresholds but not before a release: re-run
`real-local-history` alone on a quiet machine. If RSS returns to the earlier
level it was pressure; if it stays high, something real is there to find.

Practical consequence for whoever formally resolves the R7 thresholds: peak RSS
carries real run-to-run spread that is not tied to any code change, so a
threshold set flush against a single regeneration's numbers will be too tight.
Set it against spread observed across several runs, not against one.

## Interpreting a regeneration you did not run

Compare a fresh receipt against its predecessor with
`git show HEAD:generated/<file>` before assuming a run was contaminated:

- **Wall-clock and `childCpuMs`** are the contention-sensitive fields. Real
  contention skews them *consistently upward*. Deltas that scatter in both
  directions — especially large negative ones — are ordinary run-to-run noise,
  not another process stealing cycles.
- **`determinism.comparisons`** and the `runProjectionSha256es` are
  contention-independent: each profile runs the workload twice and compares
  canonical projections. If those all say `matched`, the substantive content of
  the receipt is intact whatever the machine was doing.
- **Peak RSS** is the weakest signal of the three, and the easiest to
  over-explain. It does not move because another process used CPU, but it does
  move with GC timing, page-cache state, and system memory pressure, so it
  carries real spread between runs with no code cause at all. If you reach for a
  commit to explain an RSS step, first confirm the benchmark executes that
  commit's code (see above) and that `sourceBytes`/`outputRecords` did not move.
  A magnitude that happens to match a number in some commit message is not
  evidence; that exact coincidence has already misled two readers once.
- `materialized-boundaries` records all-zero metrics by design
  (`not_run_profile`); it is not evidence of a failed run.

## Merge discipline

A branch-side regeneration certifies that branch's tree only. Merging with a
mainline whose workload files differ produces a third tree — regenerate once
more on the merge result before (or immediately after) it lands, or trunk goes
red.

## Interrupted runs

An interrupted or killed run leaves control files in the REPOSITORY ROOT
(not `generated/`): `.r7-release-evidence-install-v1.json` and a
`.r7-release-evidence-staging-<uuid>/` directory, both gitignored. A new run
refuses to start while they exist. Recover with:

```bash
node scripts/regenerate-r7-release-evidence.js --destination generated --recover
```

It prints `discarded_incomplete_generation`, clears the control files, and
leaves the committed receipts untouched. Do not delete the control files by
hand.

## Progress output

The regenerator prints phase progress to STDERR (`r7-progress …`): an upfront
plan line, `[n/8]` begin/end per phase with elapsed and an ETA extrapolated
from completed weight, and a two-minute heartbeat through the long
real-local-history pass. Stdout remains exactly the final summary line. A
failure therefore names the phase it died in instead of costing the whole
42-59 minute window to discover.

The regenerator itself is OUTSIDE the workload-source set (only the two
`scripts/r7-*-worker.js` files are bound), so its progress reporting can be
improved without invalidating receipts — including receipts from a run already
in flight, which holds its own copy of the code.
