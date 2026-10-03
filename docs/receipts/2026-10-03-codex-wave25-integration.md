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
