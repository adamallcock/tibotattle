---
title: Shared public community sample
date: 2026-09-11
type: decision-record
status: accepted
---

# Shared public community sample

Accountless and signed-in contributions enter the current public community
sample under the same statistical, suppression, and abuse controls. The owner
approved this decision on 2026-09-11. Implementation and production activation
are separate gates; the checklist below records their actual state.

## Sample and privacy contract

- Call the unit a **contribution source**, not a person or verified provider
  account. Preserve installation and provider-account-track attribution.
- Retain existing replay prevention, device/source election, fit qualification,
  minimum sample suppression, and bounded reads. Do not combine unrelated
  installation identities or claim global deduplication: separate installations
  can contribute overlapping provider history.
- Accountless admission requires the exact durable active owner, enrollment,
  device, and v1.1 authorization chain, including its versioned policy and bound
  source device. Do not create social sign-in, consent, or legacy cohort grants.
- Upload credential expiry stops new uploads. It does not withdraw already
  accepted data. Explicit authority revocation or erasure immediately fences
  published generations and in-flight cache writes before background rebuilding.
- Preserve persistent opt-out and the existing installation transition notices.
  The [sharing-default decision](./2026-09-04-accountless-sharing-policy.md)
  remains authoritative for local permission and scheduling behavior.
- Sealed legacy weekly snapshots retain their original social transport and
  cohort policy. This change admits accountless sources to the current daily
  activity, allowance, and model calculations; it does not relabel historical
  snapshots or manufacture legacy uploads.

## Delivery gates

- [x] Verify the production source and preserve its enabled accountless upload
  settings, released app assets, and deployment bindings.
- [x] Implement one shared public authority view, public source selection, and
  cache policy versioning.
- [x] Add a forward trigger/metadata migration with bounded retained-source
  discovery. Do not repeat the completed 0057–0059 data migration.
- [x] Prove mixed-source inclusion, replay behavior, ineligible-source filtering
  before caps, and withdrawal/erasure fences with populated local tests.
- [x] Update public labels and privacy disclosure; inspect rendered results.
- [x] Complete Worker, documentation, architecture, and deployment dry-run gates.
- [ ] Apply the reviewed forward migration and guarded deployment; verify live
  health, policy state, public responses, and ordinary scheduled publication.

This is a hosted-service and website change. It does not require another desktop
release, installer rebuild, signing pass, or update-feed change.

## Production sequence

The reviewed predecessor is `9accd6f08a8bc519868f24a970b619e5e0e2a5f0`.
Read-only observation on 2026-09-11 found primary migrations through 0059 and
the independent deletion ledger through 0002. The sole pending operation is
`0060_public_contribution_sources.sql`; preserve both historical ledgers.

1. Complete the full Worker gate and the populated local migration rehearsal.
   The rehearsal preserved 1,000 synthetic source chains and 100,000 records in
   each telemetry table, including interruption rollback and zero-write replay.
2. Recheck live source, migration prefix, collection controls and maintenance
   ownership. Acquire the existing 20-minute maintenance lease only if unowned
   or expired; keep its generated owner token in the private operation record.
   Do not steal another executor's lease. This hold prevents old lifecycle code
   from revoking expired accountless credentials during the transition.
3. Apply only 0060 through the normal D1 migration command. It replaces public
   authority triggers, invalidates derived publications, recounts prepared
   metadata and creates bounded discovery state. It does not copy or remove
   retained uploads. Verify the exact new schema and both migration ledgers.
4. Deploy the clean reviewed source with the
   [guarded production wrapper](../runbooks/production-operations.md#guarded-deployment-wrapper),
   requiring the exact predecessor above. Preserve enabled enrollment/ownership,
   existing collection controls, release assets and bindings.
5. Verify the deployed source and public surface, then release only the owned
   maintenance lease. Observe scheduled rebuilding and the shared sample.
   Public figures can temporarily be unavailable while invalidated aggregates
   rebuild; an accepted source still needs the existing fit/suppression rules.

If a migration response is uncertain, inspect its ledger and schema without
retrying or restoring data. If migration succeeds but deployment fails, retain
and renew the owned maintenance hold while reconciling the deployment. Never
replay 0057–0059 or clear an unknown deployment journal to unblock this change.

## Observed activation

On 2026-09-11, 0060 applied once with its reviewed bytes unchanged. Primary
migrations now end at 0060; the deletion ledger remains at 0002. Exact schema
verification passed for all 43 new/replaced objects. Remote D1 retains inline
comments that local Wrangler strips, so the readiness probe accepts the two
exact expected definitions without normalizing observed SQL. Missing and altered
guards remain rejected in both representations.

The guarded deployment of `03d4217fe4d42d9d342b6ad34b73905c025b9ead`
returned verified health/public-surface results and released its Git coordination
owner. The owned maintenance hold was released after independently matching the
live source and changed website asset hashes. Collection stayed operational;
scheduled maintenance resumed. The first 48 daily rows were published and 271
retained days remained queued; the current cohort was ready with 15 of 15
source members prepared. Recent public graphs still await their days.
No active accountless analytical head existed at the first post-deployment read;
that does not weaken admission rules or justify synthetic public measurements.

A subsequent installed 0.1.21 check identified an independent desktop reader
limit above one million quota observations. Its active accountless credential
and upload authorization were intact, but preparation failed before upload.
The bounded desktop repair and new app qualification are separate from this
completed policy migration and deployment; they must not be inferred from
the hosted test results.
