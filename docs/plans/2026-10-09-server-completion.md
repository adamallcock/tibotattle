---
title: TiboTattle post-cutover server completion
date: 2026-10-09
type: plan
status: in-progress
---

Owner requested continuation of server work. Root is sole provider executor. Public GCP routing and enabled daily analytics/five-minute maintenance remain live. Client 0.1.28 publication is complete and its signed bytes are outside this change.

## Acceptance

1. Upload activation: preserve ordinary staged progress; observe actual activation and resulting journal/publication evidence. READY chunks alone are not activation. Diagnose a closed failure before proposing a server repair; no forced generation membership.
2. Historical spend: implement K-REPRICE/OAI-5 using original saved owner membership and retained price inputs. Preserve non-spend evidence, exclusions and missing-evidence states; append only changed spend, separately record stamp-only equivalence, and make replay idempotent. Scope stale heads and owner-day work before a bounded live pass.
3. Public Pro 10x: adopt approved four-plan normalization (Pro 1, Pro Lite 2, Pro Max 0.4, Plus 10) with GCP public v1.4/model metadata, appropriate preview/cache identities, compatible website reader first, and a genuine fresh projection. Preserve old values under their historical basis until replaced; do not relabel 20x values.

## Sequence

- Reconcile clean source against live origin dec6, Jobs 2e, edge 24411, cost config 833148f8, and current client/main a09/94ba.
- Build independent server repricing and public contract changes in explicit owned files; record focused tests and synthetic PostgreSQL validation.
- Integrate, review exact candidate and run owning gates, preserving baseline failures honestly.
- Prepare guarded fresh website/server candidates and bounded jobs; reconcile current operations before each dispatch and verify actual receipts/outputs.
- Archive originals and update root supervision plus coordination plan at each material boundary.

## Current work

Public reader 82e56a/site 59b37d and admin reader 5bea28f are deployed, verified, and unlocked. Live legacy public graphs remain available. An authenticated admin read exposed a pre-existing 42/43-model catalog compatibility gap in the older reader lineage; a separate reader-only repair preserves the existing public bundle and both historical and current allowance bases. The server lineage already contains the 43-model catalog. Upload staging reached 92 days through August 16 at 16:25 UTC; activation remains unconfirmed.

Server source is implemented and locally qualified in the isolated 833148f8 branch. Final normal build, registry/pricing (18), generated context (1), Worker typecheck, preflight (21), documentation, and focused PostgreSQL/domain gates passed. Kernel 13 and schema 77 are frozen. Broad Worker results retain 26 failures reproduced on the unchanged baseline; its 20 scoped failures were repaired and passed across serial focused runs. The two broad analytics regressions were repaired with retained old-value reconstruction proofs (10/10). Broad root results retain 27 baseline failures, 14 environment gaps, and one unrelated native UI smoke result that remains unqualified; its scoped version-contract regression passed 13/13 after repair. No complete Worker/root or native-client green claim is made.

Projection-cache and progress readers now match the new projection writer while preserving source calculation identity; cache tests passed 92/92 and progress tests 7/7. Schema 77/native rollout/repricing have not run. Reviewed native rollout and separate bounded repricer adapters are prepared. Fresh full production profiles were captured at 16:31 UTC; backup-horizon audit passed at 16:46 UTC. Root is sole provider executor and will build the frozen server while the independent reader repair completes, then pause and drain old Jobs before schema 77 and immediate four-resource rollout.

## Decisions

Existing owner decisions: OD-OAI-4 saved cohort spend-only republish; Round 7 stamp-only equivalence without a new revision; Round 9 GCP v1.4 for new normalization plus metadata; Round 19 one analytics-v2-price-input-v1 codec/table and departed-member exclusions. These supersede dated unresolved notes in older plans.
