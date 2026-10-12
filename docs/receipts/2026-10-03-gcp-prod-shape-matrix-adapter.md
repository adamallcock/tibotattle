---
title: Production-shape matrix adapter source qualification
date: 2026-10-03
type: receipt
status: source-validated-review-pending
---

Base: frozen Wave26 `06222bf3aafda3d0ddd09ee1d4e793b2622eacf7`.
This receipt qualifies local measurement argument plumbing only. No corpus
refresh/import, PostgreSQL connection, cloud operation, registry change or
compute/source-policy change was performed. The live capture tree and other
owners' databases remain separate. Numeric performance and rollout admission
remain with root and the original performance briefs.

## Implemented contract

`measure-local.mjs` now accepts `--workers`, `--model-block-size` and
`--model-fanout`. Values follow the existing runtime bounds: integer worker
count 1..16, integer block size 1..70 and exactly auto/all/off. Valid local matrix
combinations are deliberately narrower: overrides require `--profile
dense-workers`, workers 2..16, and a refresh rather than `--import-only`.
`dense-workers --workers 1` refuses with guidance to use `--profile dense`
without matrix overrides for W1 INLINE. No implicit profile or heap switch
occurs. Missing, invalid and repeated matrix flags refuse before execution.

Default INLINE and W4 argv remain byte-identical. Only explicitly supplied
block/fanout flags are appended; omitted values retain runtime defaults 10/auto.
W2/4/7/8/16 use the existing dense-workers resources: cpu 4, 16 GiB task,
10,752MiB output budget, 86400s task timeout and no inherited INLINE old/young
heap flags. The original INLINE 12288MiB old-space/64MiB semi-space settings
remain unchanged. Worker admission and resource policy are unchanged.

The report records `measurementIdentity` with the original wrapper
`baseProfile`, actual resource `profile`, explicitly `requested` settings
(null when absent), and `effective` worker/block/fanout/execution settings.
Actual refresh and guard-probe results retain the same identity. CPU,
allocation and memory profiling retain their existing projection and
compatibility rules, using the actual worker count.

`refreshArguments` is shared by actual refresh, guard and report construction.
Report argv now retains every Node launch argument and replaces only the
workspace bundle path with `dist/analytics-refresh.mjs`; the previous
unconditional `slice(1)` omitted the first heap flag or bundle path. The guard
log now reads the actual selected timeout from the resolved profile instead
of incorrectly passing that profile object back into the name-only resolver.

## Validation

Under Node 22.16.0 with `--experimental-strip-types`:

```sh
node --experimental-strip-types --test \
  apps/worker/scripts/gcp-fastpath-prod-shape/prod-shape.check.mjs \
  apps/worker/scripts/gcp-fastpath-prod-shape/refresh-pgstat-lifecycle.check.mjs
```

All 27 tests pass, including existing production-wrapper no-orphan/timely
teardown and PostgreSQL-sampling lifecycle tests. The matrix tests exercise
W2/4/7/8/16 × b1/5/10/14/70 × auto/all/off (75 combinations), round-trip launch
flags through the actual refresh parser, and compare requested/effective
identity, budgets, timeguard, absence of inherited heap flags and report argv.
Negative cases cover missing/invalid/duplicate values, INLINE overrides,
import-only overrides, W1 guidance and existing profiling/guard exclusions.

A tiny content-free executable probe is launched through the actual refresh
and guard adapters and proves identical received flags, environment and
reported identity. It performs no analytics compute or database/socket access.
The initial sandbox run could not read macOS `kern.clockrate` through
`/usr/bin/time`; the complete owning tests passed with that native read
permission. Plain Node 22 requires the existing type-stripping flag for the
driver's source imports; the bundled analytics child remains Node 22.

Read-only `cloud-run/build.mjs --kernel-closure` remains the frozen K6 identity:
compute SHA `532075c301cbef77008564bed0fc0b4bc3fa0333b8e1ae5df5d230c3bbb90ab0`,
closure SHA `9b87afb4e6770de9d9b06e34a01869c1c665e7ce8347d74d12294c4c5345a388`,
vendor SHA `424029091301630c4ae3d66244302a102fa30053540e9c530e349eb52a00bdae`.
No artifact or registry was rewritten by that inspection.

## Measurement handoff

After exact tool/source and resource admission, a parallel local matrix uses
the existing importer/measurement path with, for example,
`--profile dense-workers --workers 7 --model-block-size 14 --model-fanout auto`.
Use `--profile dense` without matrix flags for the INLINE comparator. Record
the new driver SHA and independent source/build/bundle/corpus bindings.
The adapter does not grant permission to start a full import or benchmark.
The required o01+o53 provenance, clone/memo-input adapter, exact output/raw/
stamp gates, native error/budget/cancellation gates and 16 GiB RSS measurements
remain required; this source proof establishes none of those numeric results.
