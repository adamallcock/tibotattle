---
title: GCP KPAR memory recovery and local evidence
date: 2026-10-03
type: receipt
status: in-progress
---

# GCP KPAR memory recovery and local evidence

Local source and synthetic measurements only. No cloud measurement, release,
production qualification or cadence decision is established here. This branch
starts at `ec07d4c15142989e9a6a9a0bcc9e90e9cb8b6522`, earlier than integration
head `b8864974`; Wave 25 must reconcile the subsequent integration changes.

## Implemented contract

Production/staging renders one 4 vCPU, 16 GiB task, four compute Workers,
86,400 seconds, no job retries and no inherited V8 heap-size flag. Such a flag
would override each Worker's resource limits; the job refuses it. The main
heap stays at V8's runtime default. Worker admission uses task memory minus
that actual main heap and a 1,024 MiB native reserve.

A Worker's old-space limit is its deterministic owner estimate plus 256 MiB,
capped by the pool minus a 256 MiB overhead charge. Its young-generation limit
is 192 MiB, included in that overhead. Charges and slots remain occupied until
termination resolves. An OOM retries that owner once, alone, with the whole
pool; another OOM fails closed. No partial owner result is merged or written.

At most three snapshot read calls run concurrently. Calls stream their results
through ordered parts; the main heap does not retain a whole owner segment.
The Worker reconstructs the sequential map and prefetches at most one next
segment. Prepared days release raw usage/session occurrences; only needed
analysis-horizon quota occurrences remain. Failure drains active reads before
snapshot readers close. The first failure keeps its original closed code.
Pre-compute owner reads remain serial after concurrent counts timed out on the
loaded local cluster; production-tier evidence is required before raising this.

## Inherited immutable measurements

The recovered runs load captured self-contained bundles, not changing source.
Their hashes below identify the prior implementation; recovery fixes described
below are qualified separately. All runs use Node 22.16.0, PostgreSQL 17 and a
synthetic 53-owner corpus. No private corpus was read. The host was concurrently
loaded, so timing ratios describe these runs and are not isolated causal gains.

| Run | Finished UTC | Wall seconds | State | Owners | Peak RSS MiB |
|---|---|---:|---|---|---:|
| I-w1 inline | 2026-10-03 17:14:17 | 19,526 | complete | 53 computed, 0 refused | 5,463 |
| N3 four Workers | 2026-10-03 17:17:40 | 8,393 | complete | 53 computed, 0 refused | 10,705 |
| N4 four Workers, explicit young cap | 2026-10-03 18:37:50 | 5,584 | complete | 53 computed, 0 refused | 11,274 |

Phase timing sums (seconds), not sequential wall-time components:

| Phase | I-w1 | N3 | N4 |
|---|---:|---:|---:|
| Read | 4,029.390 | 5,296.048 | 4,422.069 |
| Prepare | 3,614.229 | 3,936.656 | 2,651.629 |
| Scalar | 311.371 | 333.056 | 216.674 |
| Model | 11,546.612 | 13,366.253 | 8,597.804 |
| Write | 7.069 | 6.441 | 6.510 |

Concurrent loads/Workers add their own phase times; their sum can exceed wall
and is not CPU time. N3 sampled mean 2.38 busy cores out of four versus 0.91
inline; N3's 8,393 s wall is 2.33 times shorter on this concurrently loaded
host. This comparison does not isolate the young-generation change in N4.

N3 had zero OOM retries, peak four Workers, three loads, admission charge
10,857 MiB within an 11,216 MiB pool. Its sampled main heap peak was 1,747 MiB;
the owner computation's sampled used-heap peak was 4,900 MiB. The old receipt's
`largestLiveHeapMiB` field reported 4,740 MiB (88% of the relevant limit), but
that field samples delayed GC callbacks: it is **not** an exact post-GC live-heap
peak. Recovery names it `largestGcCallbackHeapMiB` and describes it correctly.
Neither sample proves a worst-case memory bound; admission and alone retry do.

N4 had zero OOM retries, peak four Workers and three loads, admission charge
11,049 MiB within the same 11,216 MiB pool. Its receipt reports main heap
2,254 MiB and largest sampled owner heap 4,840 MiB. The old delayed GC callback
field reports 4,739 MiB (88%); it has the same sampling limitation described
above. Sampled mean busy cores were 2.44. These loaded-host results identify
prior bundles only and do not qualify corrected source checkpoint `ceb02449`
or a combined kernel 5 candidate.

N4, N3 and I-w1 have exactly equal output digests in every family the inherited
measurement harness records: cache bands, journal cursor, owner days, owner
fits, model dates, preview and published daily payloads. The recorded digest
values were compared directly, without additional masking. The inherited
harness already removes its documented run/stamp fields when hashing rows.
The [retained aggregate digest proof](./2026-10-03-gcp-kpar-digests.json)
records all seven comparisons. This gate does not claim coverage of later
Wave 23/25 tables.
All three completed runs dropped their own clones. Captured N4 bundle hashes
were rechecked unchanged when its final result was collected.

| Captured bundle | SHA-256 |
|---|---|
| N3 refresh | 1be422bf0dff7159c683615f392d9f904bb5f6bf1dc231e8a2f8d6376b3669fc |
| N3 Worker | 5cbce0622e1d2aba2e1adc132448b54631242b3131c831e0ea805fa651ae0b85 |
| N4 refresh | 574de11c5747cec3f6266a6f4f6f53e5e8e63337d9d3cc7a848502357d8c922e |
| N4 Worker | 5cbce0622e1d2aba2e1adc132448b54631242b3131c831e0ea805fa651ae0b85 |

The original inherited source diff and bundle hash manifest are preserved in
local recovery scratch. Original report basenames are `I-w1.json`,
`I-w1.samples.json`, `N3-w4.json`, `N3-w4.samples.json`, `N4-w4.json` and their
logs. Only the aggregate digest proof is retained here.

## Recovery review and verification

A read-only review found and recovery fixed:

1. Admission released a Worker's charge before asynchronous termination,
   allowing replacement to overlap it. Deferred-termination tests now cover
   result replacement, abort waiting and alone retry.
2. GC observer metrics claimed exact post-GC live heap although delivery can
   be delayed by synchronous compute. Fields and claims now identify callback
   samples, with no automatic decisions based on them.
3. Active read loads outlived pool abort and snapshot closure. Abort now drains
   all started loads, and job cleanup drains Workers/loads before closing readers.
   A delayed-read regression proves no part is delivered after abort.

The local time model is recalibrated from the completed recovery inline run:
read 0.50 ms/occurrence, prepare 0.45 ms/occurrence, scalar 0.08 ms/analysis usage,
model 2.86 ms/analysis usage. Its exact phase times were read 4,029.390 s,
prepare 3,614.229 s, scalar 311.371 s and model 11,546.612 s. These are conservative
rates from a loaded local host; cloud step factor and cloud calibration remain
separate. The 24-hour deadline retains exit/write margins and refuses projected
work that cannot finish; it is not a promise of completing every possible corpus.

Completed local gates during recovery: TypeScript; analytics-v2 187/187;
pool/read 21/21; deployment-render tests 19/19; registry 5/5; Q-1 8/8 gates,
zero unexpected public/owner differences. The first PG refresh-suite pass exposed
a failure-order regression in recovery, repaired without weakening its assertion;
the targeted real-Worker failure test then passed. The final focused PG suite
passed 52/52 with zero skips, including real Workers 2/4 exact-row parity.
Final Q-1 passed all eight gates, with zero unexpected public and owner
differences and two schemas dropped. Cloud Run/profile scripts passed
615 cases with four pre-existing skips; docs governance, preflight 21/21 and
architecture (958 production files, 4,096 imports, zero debt edges) passed.
Root commands used pnpm with `pnpm_config_verify_deps_before_run=warn`:
pnpm 11 wanted to reinstall the inherited copied dependencies, which were
preserved; no install or lockfile change was performed.

## Integration and remaining proof

- N4 final receipt and seven-family equality are collected. No additional
  benchmark was launched for this inherited evidence.
- Reviewed source checkpoint `ceb02449` passed the focused final tests, docs,
  preflight and architecture gates recorded above. Full corrected/combined
  candidate performance and memory qualification remain open.
- Keep branch-local kernel 3 (inherited measurement) and 4 (recovery's correctly
  named Worker metric) separate here. At Wave 25 DROP both branch-local entries
  and pins; derive one consolidated kernel 5 with method v2 on the merged line.
- Reconcile SEMI `69308de6`: inline keeps 64 MiB semi-space, and subtracts only
  young-generation growth beyond the original 48 MiB allowance. Workers have
  no inherited heap flags; their pool footprint still uses the full actual main
  heap limit. Reconcile monitoring, resources, manifests, test-deploy and rehearsal.
- Run merged Q-1, dense/s015 parity and the production-tier cloud profiling kit
  on the TEST estate under its existing authorization. First verify target/image
  identity and ownership; reuse the seeded instance only if it is still present
  and owned, otherwise use the MEAS-SYNTH/MEAS-PROD-TIER kit. Capture PG/CPU
  summaries and exact digests, then tear down only the disposable owned estate.
  Cadence remains the owner's decision after that proof.
- Recovery full-corpus timings qualify captured pre-fix bundles. Final focused
  tests qualify repaired termination/cleanup; they do not establish repaired
  full-corpus performance or Cloud Run memory behavior.
