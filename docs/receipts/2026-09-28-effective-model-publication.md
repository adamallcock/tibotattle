---
title: Effective model publication deployment
date: 2026-09-28
type: receipt
status: deployed-initial-canary-complete
---

# Effective model publication deployment

The owner authorized production deployment. The scoped candidate fixes the
method check used to publish completed effective model results. Production
activation, independent version/configuration/schema verification and the
nine-run natural-workload canary are complete. The exact deployment lock has
been released. The larger model-block performance path remains local-only.
The [production runbook](../runbooks/production-operations.md) governs operations.

## Scope and source

- Candidate: `75a9b7efb260b062a25a90807886b7c984670a97`, a clean local commit
  based on production source `23575017c61d7b83093227d71e09096e50cf7bd1`.
- Target: `tibotattle-analytics-recovery-20260914` only.
- Change: validate effective model compositions with the same v1.1 attribution
  method used by their writer. Other publication validity and authority checks
  remain in force. The regression computes a genuine READY effective result
  and verifies nonempty published values.
- This deployment excludes the model-block runner, scheduler integration and
  migration 0030. It cannot activate the local benchmark's 13–26-times
  statement reduction. The 950 cap, disabled delivery boost and topology remain
  unchanged. No database migration is required.

## Qualification and baseline

- Focused publication suite: **39/39 passed** on the clean candidate.
- Wrangler **4.114.0** analytics-only dry build: passed using the verified live
  configuration, with no website assets binding or model-block module.
- Bundle: **1,418,255 bytes**, SHA-256
  `55aedd52981a4daac4e99eafbe4ecced4d1643791237d73c2802fa8c00278f3c`.
- The required full Worker gate passed **2,224/2,224 tests across 172 files**
  in **939.02 seconds**, plus workspace-copy, endpoint, generated-type,
  TypeScript and **910 operations-script assertions**. It then exited 1 at
  general website asset staging because the generated public release manifest
  is absent. The later staging checks were not reached. The separate verified
  analytics artifact has no website assets binding; this receipt does not
  qualify website or staging deployment.
- Independent live verification at **18:41:47 UTC** found source `23575017`
  active at 100%, version `4514cd0c-fff8-47d3-a487-a7a291f0dbb5`, with expected
  bindings, runtime and every-minute schedule. The **18:43:19 UTC** snapshot
  verified all **190 schema objects** and **28 migration entries** against the
  prior migration rehearsal.
- At **18:43:55 UTC**, daily publication had **119 dates queued**, oldest
  **June 2**. There were **2,113 stored graph results**, none newly computed in
  the preceding hour; the latest model publication date was **September 28**.
  Daily publication runs in a separate Worker; these observations are not a
  performance measurement of this candidate.
- A bounded **18:48:10 UTC** readback found publications for all **70 model
  dates** in July 21–September 28, including **64 nonempty dates**. All six
  stored effective model results across three dates were `not_testable`; none
  was READY and waiting on this method check. This fixes a reproducible
  publication defect but does not explain or accelerate the current daily
  queue. The ordered date/payload-hash vector has SHA-256
  `8e1cc8a6c5ad901c56586236749b7f205a6ef24b9b315db2a66be6c8ac1d9de0`.

## Activation

- Version **`d96c6ce2-c8a6-41c7-9717-c570020ba6e3`** is active at **100%**.
- Activation began at **19:02:01 UTC**. Independent verification at
  **19:02:25 UTC** confirmed the exact source/version, bindings, runtime,
  every-minute schedule, schema and ledger.
- The deployment reused the guarded analytics-role workflow with source,
  bundle, configuration and predecessor pins under the shared coordination
  lock. No migration, other Worker deployment or source branch push/merge
  occurred. The previous immutable version remains the rollback target.
- At **19:02:26 UTC**, all 70 model publications and their ordered payload-hash
  vector matched the baseline exactly. No READY effective result existed to
  demonstrate this fixed path on natural production inputs.
- The existing Chrome public tab was refreshed and the model graph rendered
  successfully. The original By plan view was restored after inspection.

## Completed natural-run canary

From **19:03:08 through 19:11:03 UTC**, the observer captured **eight ordinary
passes and one long pass**, all on the exact deployed version. All nine had
outcome `ok`, with **zero exceptions, lane failures or graph failures**. Each
reported `idle` / `complete`. Statement counts ranged from **56 to 149** under
the unchanged **950** cap; the long pass used **110**. The observer completed
successfully and stopped. This is scheduler-health evidence; the runs found no
new graph work and establish no production throughput multiplier.

Final independent version/resources/schema/ledger verification passed at
**19:11:21 UTC**. At **19:11:22 UTC**, all 70 publications still had exactly
the baseline payload-hash vector, and there were still no READY effective
results. The exact coordination lock was released at **19:11:48 UTC**.
No rollback was needed.

The **19:11:26 UTC** aggregate still had **119 daily dates queued**, oldest
June 2, and **2,113 stored graph results**. The separate daily publisher had
advanced its June 2 partial folds since the 18:43 baseline: summed v1 progress
revisions rose **80 → 130**, and v1.1 revisions **57 → 108**. Those are persisted
intermediate steps; the queued date had not yet published. This analytics-only
release does not change that publisher or claim its work as a performance gain.

The remaining integration work is the native graph adoption/authority bridge,
bounded scheduler admission and retirement for durable date blocks, followed by
separate migration and production qualification. The local 13–26-times statement
reduction is not active in production.
