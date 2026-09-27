---
title: GCP public-source eligibility parity review
date: 2026-09-27
type: review
status: snapshot
---

# GCP public-source eligibility parity review

**Status:** Source-only review of integration base `e379944911a0462d83c45fb4bfe97e608d2e7542` on 2026-09-27. This uses repository code and synthetic fixtures only. No live Cloudflare D1, GCP database, deployment, or production behavior was inspected.

## Decision

**Hard no-go for claiming OA-2 public-source parity or cutover readiness.** PostgreSQL migration 0046 matches the latest five-branch Cloudflare isolation view exactly, but the normal D1 primary migration lane still has the older two-branch view, and staged PostgreSQL bootstrap, daily publication, and typed-v1.2 cohort readers do not all consume the five-branch contract. There is no safe one-file helper change that closes these distinct transfer and reader gaps. This review changes no eligibility, consent, withdrawal, erasure, migration, manifest, or runtime behavior.

## Five-branch source contract

The latest D1 isolation definition is recreated by [`0012_v12_empty_day_manifests.sql:177-354`](../../apps/worker/ingestion-isolation-migrations/0012_v12_empty_day_manifests.sql); its v1.2 branches were introduced in [`0011_v12_public_eligibility.sql`](../../apps/worker/ingestion-isolation-migrations/0011_v12_public_eligibility.sql). PostgreSQL [`0046_owner_journal_authority.sql:491-668`](../../apps/worker/postgres/migrations/primary/0046_owner_journal_authority.sql) is the same definition after whitespace/comment normalization, apart from PostgreSQL's `NULL::text` cast in the social branch. The existing [oracle fixture](../../apps/worker/postgres-test/fixtures/community-public-source-owners-oracle.json) and [PG17/static parity tests](../../apps/worker/postgres-test/postgres-owner-journal-authority.spec.mjs) cover twelve synthetic cases and pin the full SQL text.

| Branch | D1 and PostgreSQL 0046 rule |
|---|---|
| Social | Active social participant; `device_id` is null. The owner view is schema-agnostic, so downstream readers may select supported v0.x, v1, v1.1, or v1.2 evidence. |
| Accountless v1.1 active | Exact active enrollment, owner, device and v1.1 authorization chain, matching lease expiry, and an accepted v1.1 head for that device. |
| Accountless v1.1 retained | Exact marker naming the accepted v1.1 head; all four revocations are `user_opt_out` at the marker timestamp. |
| Accountless v1.2 active | Exact active successor chain and accepted v1.2 head; excluded if the same participant/device has any v1.1 domain. |
| Accountless v1.2 retained | Exact opt-out marker and v1.2 head; same-device v1.1-domain exclusion also applies. |

The view does not admit accountless v0.x-only or v1-only sources. When a device has both v1.1 and v1.2 domains, the v1.1 branch owns it and the v1.2 branch is excluded.

This parity claim applies to the isolation candidate, not the normal D1 primary migration lane. In the inspected source, [`0060_public_contribution_sources.sql:6-40`](../../apps/worker/migrations/0060_public_contribution_sources.sql) is the only primary-lane definition and contains social plus active accountless v1.1. The newer retained and v1.2 branches live in the separate isolation migration sequence. The accepted [public sample decision](../decisions/2026-09-11-public-contribution-sources.md) also says implementation and production activation are separate gates; this source review does not establish that the five-branch definition is active on Cloudflare.

## Runtime differences

### Legacy v0.x and v1

Staged PostgreSQL [`0053_community_publication_authority.sql:59-108`](../../apps/worker/postgres/staged-migrations/primary/0053_community_publication_authority.sql) counts eligible current v1 chunks, v1.1 heads and v1.2 heads missing journal receipts. Its comment explicitly places legacy v0.x-only owners outside the pending count. If no other family is pending, the seed can mark bootstrap complete while accepted v0.2 evidence has no PostgreSQL source receipt. The D1 restore bootstrap instead checks for accepted v0.2 contributions and calls `bootstrapLegacyStorageOwner` ([`authority-restore-bootstrap.ts:76-105`](../../apps/worker/src/authority-restore-bootstrap.ts); [`legacy-storage-journal.ts:7-17`](../../apps/worker/src/legacy-storage-journal.ts)).

The PostgreSQL daily publisher duplicates eligibility rather than reading 0046. Its [`publicDailySourceCtes`](../../apps/worker/src/postgres-community-daily-publisher.ts) reads social and accountless v1.1 owners, selects v1 chunks when no v1.1 head exists, then selects v1.1 records (`:144-153,244-325`). It has no v0.2 reader. Thus social v0.2 remains eligible under the D1 source contract but is not represented by this PostgreSQL bootstrap/daily path. The D1 current publication reader explicitly recognizes v0.2 alongside v1 and v1.1 ([`community-publication.ts:98-146`](../../apps/worker/src/community-publication.ts)).

Social v1 is counted and read by the PostgreSQL v1 daily path. Accountless v1-only remains excluded by both source views. The [PostgreSQL effective-owner reader](../../apps/worker/src/postgres-typed-legacy-effective-reader.ts) also distinguishes source readability from graph eligibility: it documents that legacy v1/v1.1-only inputs remain readable for quota/session while effective usage and graph inputs remain unavailable because their additive-correction authority has not been transferred (`:1114-1123`).

### v1.1, v1.2, opt-out, and terminal withdrawal

Accountless v1.1 active and exactly marked opt-out sources are admitted by the view and represented by the PostgreSQL daily CTE. [PostgreSQL device disconnect](../../apps/worker/src/postgres-device-disconnect.ts) pins the exact accepted head, revokes upload authority, and deliberately emits no `owner-withdrawn` event for ordinary opt-out (`:124-132,425-445`). This matches the accepted [upload-only opt-out decision](../decisions/2026-09-15-opt-out-stops-future-uploads.md). Owner erasure and other terminal withdrawal remain a separate path; [PostgreSQL publication readers](../../apps/worker/src/postgres-community-daily.ts) fence terminal `owner-withdrawn`/`owner-erased` journal entries.

Two PostgreSQL typed-v1.2 cohort differences remain:

1. The typed effective-owner candidate predicate in the [PostgreSQL effective-owner reader](../../apps/worker/src/postgres-typed-legacy-effective-reader.ts) joins `telemetry_v12_typed_active_authorizations` and does not apply the 0046 same-device v1.1-domain exclusion (`:1082-1103`). An active v1.1+v1.2 device can therefore enter the v1.2 cohort even though D1 assigns that device to v1.1.
2. After ordinary opt-out, 0046 still admits the exact retained v1.2 head, and the lower-level v1.2 record reader uses `telemetry_v12_typed_retained_authorizations` ([`0025_typed_v12_normalized.sql:89-112`](../../apps/worker/postgres/migrations/primary/0025_typed_v12_normalized.sql); [`postgres-typed-v12-effective-reader.ts:430-445`](../../apps/worker/src/postgres-typed-v12-effective-reader.ts)). The owner-candidate predicate instead requires active authorization. A v1.2-only accountless owner can therefore disappear from a future graph cohort after opt-out even though the retained record reader and D1 contract preserve its accepted history. The already published result remains visible because disconnect does not emit a terminal event; this is a future cohort-selection gap.

The PostgreSQL daily publisher states that it excludes v1.2 because its current analytical projection reads v1/v1.1 only ([`postgres-community-daily-publisher.ts:144-153,634-647`](../../apps/worker/src/postgres-community-daily-publisher.ts)). The accepted 2026-09-25 extension in the [public sample decision](../decisions/2026-09-11-public-contribution-sources.md) puts accountless v1.2 on the same public-calculation and opt-out terms. The current PG daily reader therefore does not yet implement that source-family extension.

## Product decision versus code work

- The exact v1.2 inclusion and ordinary opt-out-retention rules are already accepted. The view is aligned; using the view's exact gate in the PG typed cohort and adding the v1.2 daily projection are code/reader work, not new policy decisions.
- Preserving accepted social v0.x history is the existing D1 behavior and has a D1 restore journal path. GCP parity requires transfer/bootstrap and reader coverage. If the destination is intended to retire v0.x from current public calculations instead, that scope change needs an explicit product decision and matching maintained documentation; this review does not infer one.
- The isolation-view activation state must be reconciled as a separate deployment/migration gate. The candidate five-branch SQL and its PG parity test do not prove activation.

## Acceptance criteria before closing OA-2

1. Identify and verify the intended D1 source-view activation point; do not treat isolation SQL or migration 0046 alone as live evidence.
2. Keep a synthetic PG17 test that proves the five view branches, plus reader-level negative/positive cases for accountless v0.x/v1-only exclusion, social v0.x/v1 inclusion, v1.1/v1.2 selection on one device, and exact retained v1.2 after opt-out.
3. Make PostgreSQL bootstrap stay incomplete while an eligible social v0.2 source lacks its required journal receipt, or record an explicit product decision that retires that family from the destination.
4. Bring the PG daily and typed-v1.2 cohort readers onto the same eligibility contract, including the v1.1-domain exclusion and retained-opt-out path. Preserve separate owner-erasure/terminal fences.
5. Validate migration, transfer, readers and publication with synthetic populated PostgreSQL fixtures; report source/runtime/deployment gates separately.

No behavior patch or new test was added in this review. The existing 12-case synthetic PG17 view oracle is the focused behavioral evidence; this review records the remaining cross-reader gaps without changing policy or migration state.
