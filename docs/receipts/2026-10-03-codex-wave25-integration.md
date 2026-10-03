---
title: Wave25 local source integration
date: 2026-10-03
type: receipt
status: in-progress
---

This receipt tracks the isolated local Wave25 candidate based on qualified Wave24 `d87ee3a0b5235e53b0fb6feb0daf957ff83cdd69`. It is source integration evidence, with no deployment, release, cloud-performance or production-readiness claim. The owner decisions and optimization program in the GCP coordination home remain authority.

## Fold and decisions

The serial fold is REFRESH-OPT `ac997edb`, PRICER `d249b655`, W1A `b21d7902`, W1E `90e30e80`, EXCL `380b8e22`, SEMI `69308de6`, KPAR `ceb02449`, and the full MEAS-SYNTH range through `064066a4`. The eight merge checkpoint is `3db53f60`. All branch-local registry entries were dropped; baseline entries and pins 1–4 remain unchanged. One combined entry 5 is derived after the settled source closure.

Build reconciliation composes the exact fast-pricer binding and Node host hashing alias through `cloudRunBuildPlugins`, which the production build and closure/pricing verification passes share. W1E is promoted from staged 0961 to additive primary 0074, with generated runtime schema, migration assertions, public store facade and its separate global pricing inventory. Its three tables hold no owner-scoped data and do not enter the owner purge inventory.

The refresh runner retains the frozen row requirement on the first production run and the revision floor requirement on every production run. Operator exclusions continue to apply to departed members' historical saved contributions. Inline profiles use a 64 MiB semi-space with the corrected output budget. The production profile is `dense-workers`: 4 vCPU, 16 GiB, four Workers, 10,752 MiB owner budget, no process-wide V8 heap flags, and a 24-hour task timeout. Workers retain their own 192 MiB young-generation charge.

## Acceptance and scheduling

Focused pure tests and synthetic PostgreSQL gates are owned here on private port 55529. Fresh semantic Wave24 comparators are owned separately on port 55530. Heavy measurements require coordinator scheduling; none are started by this source integration.

The required semantic matrix is Q1, 1.2M and dense against the previous kernel. The after-wave performance matrix is a 1.2M CPU/GC/pgstat slice, full inline and four Workers, and the o01 probe. Repaired-source KPAR full-scale memory proof remains open until these runs. Main-isolate inspector profiles do not describe all Worker CPU, while process CPU and RSS include Workers. Loaded-host baseline timings do not qualify performance comparisons. Cloud measurement must choose `dense-workers` explicitly and bind source, seeders and image provenance.

## Digest comparison boundary

| Table scope | Semantic comparison | Provenance requirement |
|---|---|---|
| Seven existing derived families | Exact content equality after table-specific run/kernel/manifest/time stamps | Exact candidate kernel, manifest, run and source binding checked separately |
| Owner sets and saved contributions | Exact values and membership, except the declared EXCL unlinked/departed exclusion scenario | Exclusion digest and saved-member identity linkage checked; no global semantic exception |
| Price cards | Exact card ids, content hashes and references | `first_kernel_id` checked against the actual first registering kernel; never globally ignored |
| Kernel prices | Exact cards/projection | `compute_sha256` checked against each source-bound build class; never globally ignored |
| Pricing classes, kernel pricing classes, transition proofs | Candidate inline/four-Worker equality and class/proof assertions; absence from Wave24 explicitly declared | All new columns retained; no new table silently skipped |
| Runs and kernels | Separate execution/registry evidence | Successful run/cursor, immutable registry pins and bundle provenance verified |

Existing MEAS-SYNTH global field removal is insufficient by itself for this combined matrix. Final comparison tooling and receipts must name their exact table and column scope.

## Current checks

At the reconciliation stage, pool/read checks passed 21/21 and combined deploy/production-migration checks passed 60/60. The pricing-class suite passed all eight behavioral/negative cases; its ninth exact-input inventory required the expected new `fast-pricer.ts` input. The final settled-source validation and independent review remain open.

## Settled-source checkpoint

Kernel5 compute closure is `e022061bb1bccd6e3906fcbf5dc49edec1a06dbee63e70a74a8df22b1e1d9156`, vendor manifest `85e919a6f439ff351c37d5df373d2d7299dafa1d4cac2359de9b580f151d7241`, and entry pin `3e81ee257f82806f03ed6aa4bb545d8d416b22d4e144a1042e6a9acda22b8248`. Build check and full bundle build pass; registry8/8 and pricing-class9/9 pass. Pure measurement helpers12/12 pass with local process visibility. Scoped digest negatives6/6 pass.

The first focused PostgreSQL pass had69passes,3failures and1skip. All three were stale integration test wiring: missing production plugins in the W1E build fixture, the old73-migration count, and SEMI using the new Worker production profile for inline assertions. Individual repairs retain existing budget assertions and add Worker semi-space refusal coverage. The focused repair pass4/4 passes, including built kernels5/6,31stored owner-days,601events, and exact19-table full-versus-identity price proof. Full settled PostgreSQL repetition remains open. An automatic-review rejection of a broader proposed test-block rewrite occurred before execution; the accepted repair preserved the assertions.

The comparison collector explicitly supports one fresh completed run, or two same-kernel completed Q1 reruns when `expectedRunCount: 2` is supplied. It reports raw full-row hashes and per-table semantic hashes, exact policy hash and validated stamp evidence. Unknown tables and columns have no implicit masking. The baseline full run is retained by its owner for same-database reviewed policy capture; the old slice seven-family comparison requires an independently reviewed actual-schema equivalence proof.

## Focused qualification follow-up

Settled PostgreSQL repetition passed72/73 with0failures and1existing skip. Architecture passed969productionfiles/4154imports/0debt; root preflight passed. The owning analytics gate exposed a stale PRICER assertion requiring scalar repricing after preparation. REFRESH memo intentionally eliminates that repricing: the corrected test proves preparation executes the instrumented fast binding, scalar/model reductions do not reprice, and both results remain byte-identical to the oracle. The isolated PRICER suite passes11/11.

## Reviewed collector and operations fold

Policy follow-up94a72b16 checks every projected run_id/proof_run against a completed expected-kernel/manifest run; independent review accepted it and7/7 pure tests pass. Policy hash is `0f691bf83391573ac6d8e11854a72dc91f7d36aa615fb27724e18ea6414864bd`. Real tiny Q1 rehearsal passed on private55529 under Node22.16.0 refresh, retaining two schemas. The collector passed46 provenance checks, exactkernel5/compute `fd6b1a64872c47e1e3f1972a9e631e9b9ea91a0a93c62724738f9949929788e2`/manifest1, explicit2completedruns,3class tables, and raw plus semantic evidence for24tables. Local evidence: `/private/tmp/wave25-q1-report.json` and `/private/tmp/wave25-q1-digest-evidence.json`. Baseline owner collected reviewed Q1 kernel4 evidence from its retained database and refreshed the slice seven-family actual-schema equivalence proof; missing full raw slice evidence after its prior default cleanup remains explicit.

Qualified operations commits115a398d andbb974d6b folded as07fe999c andcf92f5fe. Their focused tests pass34/34; post-fold build check passes with the identical kernel5 closure/vendor/compute stamps. Owning analytics completed253/254 with one stale exact plugin-list assertion expecting only the Node plugin. Updated expectation requires both fast-pricer and Node plugins; all alias-boundary assertions remain. Targeted host primitive suite passes11/11. PRICER fuzz passed91,122 comparisons. A complete owning analytics rerun remains pending; no expensive corpus or performance qualification has been launched.
