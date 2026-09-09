---
title: Production accountless contribution activation proposal
date: 2026-09-09
type: plan
status: proposed
---

# Scope and evidence

Prepare production collection for the accepted [Electron sharing policy](../decisions/2026-09-04-accountless-sharing-policy.md). This proposal authorizes no remote write, credential renewal, migration, deployment, public admission, or release publication. The production migration prefix, deployed Worker revision, collection controls, and secret availability have **not been inspected for this proposal**.

The [Electron readiness record](2026-09-05-electron-release-readiness.md) records the signed staging pass: automatic accepted upload, authenticated restart with retained installation binding, and persistent opt-out. Fresh classification and the three-visible-notice transition have focused source/composition evidence; the signed rehearsal seeded default-on and did not run an untouched installation or seven-day migration.

Enrollment, upload ownership, encrypted v1.1 transport, renewal, scheduling, opt-out fencing and installation-scoped replay protection are implemented. Production configuration still omits both accountless mode flags, whose server defaults are disabled. Public selectors explicitly exclude accountless owners. The older September 4–5 integration/migration proposals are historical, not the current implementation boundary.

# Proposed operation sequence

1. **Read-only intake.** Observe both production D1 migration ledgers with the maintained [migration rehearsal command](../runbooks/release-migration-rehearsal.md#observe-the-deployed-prefix). Record the exact Worker revision and collection-control revision/values. Inspect required secret names and bindings without reading or rotating their values. Preserve existing production encryption keys and the identity-link key/version.
2. **Prepare exact migration admission and recovery.** Canonical accountless source migrations are `0057_accountless_enrollment_ledger.sql`, `0058_accountless_upload_ownership.sql`, and `0059_accountless_upload_renewal.sql`. These names are not a claim about the remote pending set. Rehearse the observed prefix against the exact intended source. Migration 0058 snapshots/rebuilds populated ownership tables and restores their descendants; prepare the production backup/recovery and deletion-ledger implications before requesting approval for the exact pending set. Retained synthetic preservation tests do not measure current production size or attest remote migration bytes.
3. **Apply only the approved migration operation.** Use the maintained [production migration gate](../runbooks/production-operations.md#schema-migration-gate). Retain exact migration/ledger readback, foreign-key/integrity and preservation evidence. The deployment wrapper does not apply migrations. Do not deploy code requiring new columns before their schema is verified.
4. **Deploy the reviewed accountless configuration and privacy copy.** After schema verification, use the immutable production deployment wrapper, with normal preflight and post-deploy checks. The proposed configuration diff below enables the two accountless authority routes. Confirm `enrollment`, `uploadRegistration`, and `processing` collection controls permit the intended operation; do not change unrelated controls or disable existing social publication. Preserve social enrollment and all existing abuse limits, bindings and secrets.
5. **Verify a bounded, explicitly approved production canary.** Use an ordinary signed candidate and a disposable synthetic source. Verify enrollment, accepted encrypted upload, authenticated restart continuity, duplicate retry, and persistent opt-out. Confirm the source remains excluded from public aggregates and revoke its authority afterward. The staging rehearsal is compiled to staging: do not repoint it or remove its isolation checks. The exact canary execution/profile and cleanup need preparation before this separate live-write approval.
6. **Publish the release only after its independent gates pass.** Bind the deployed service, privacy wording and expected contribution behavior to the exact release artifacts. Windows signed runtime, the current Mac updater edge and protected R7 remain separately tracked; this plan does not close them.

# Proposed configuration diff — not applied

Only add these two properties to `env.production.vars` in `apps/worker/wrangler.jsonc`, after the existing `ENROLLMENT_MODE` property:

```diff
         "ENROLLMENT_MODE": "open",
+        "ACCOUNTLESS_ENROLLMENT_MODE": "enabled",
+        "ACCOUNTLESS_OWNERSHIP_MODE": "enabled",
         "ACCOUNT_SCOPED_INGEST_MODE": "disabled",
```

Both modes are explicit deployment controls; an app preference alone cannot open the server. No new production secret, key rotation, public-selector change, or global collection-control change is proposed.

For an admission incident, disable the two accountless modes and verify refusal of enrollment/ownership/renewal. That is **not** a claim that already issued upload authority is revoked: use the reviewed targeted revocation or collection-control response for accepted/in-flight authority. Do not roll back the rebuilt schema or deploy incompatible old code as an automatic recovery step. Preserve receipts and reconcile ambiguous remote outcomes before retrying.

# Separate public-sample decision

Recommendation: activate accountless collection with the current public exclusion retained, and describe that exclusion accurately. Public inclusion is not a deployment toggle today. It needs an explicit decision and engineering to adapt the social-only selectors and publication rules.

The proposed label is **contribution sources**, not people or verified provider accounts. One retained installation deduplicates retries; independently created installations can upload overlapping cloud-synced history. A global overlapping-history policy is not implemented. Before public admission, decide how to handle that overlap and source influence, preserve conflicting/partial evidence and existing suppression/revocation, and test the resulting aggregation. Do not silently clip accepted usage totals or merge distinct provider accounts.

# Completion evidence

Retain the exact source/configuration and migration digests, authorized operation identifiers, readbacks, privacy deployment verification and canary receipt. Keep schema, deployment, accepted private collection, public aggregate admission, signing, installed runtime, updater and release publication as separate claims. No production action was performed while preparing this proposal.
