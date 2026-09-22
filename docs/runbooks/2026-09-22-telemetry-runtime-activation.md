---
title: "Protected telemetry runtime activation"
date: 2026-09-22
type: runbook
status: maintained
---

This runbook is the owner-operated sequence for enabling the staged telemetry
successor after the Worker and typed storage release have qualified. It covers
the hosted runtime state only. It does not change local cache calculations,
rewrite existing usage evidence, or apply a migration.

The usage successor (`usage_v12`) and the model-performance stream
(`performance`) are independent runtimes. Activating usage leaves performance
staged; performance may remain staged until its histogram collection has a
separate rollout decision.

## Preconditions

The target primary and analytics D1 roles must have the common forward
migration prefix and a durable, read-only post-migration/post-deploy
reconciliation receipt. The receipt contains the exact schema and
`d1_storage_migrations` ledger SHA-256 for both roles, the deployed source
commit, the owner-captured Worker version/config metadata, and its canonical
proof digest. The Worker live-checks `DEPLOYMENT_SOURCE_COMMIT` against the
receipt and re-reads both D1 roles before activation. The version and config
metadata are bound into the owner-authenticated receipt; this deployment does
not expose runtime bindings for them. The receipt fields are evidence pins;
the maintained operator transaction independently captures and compares the
live version/config immediately around the admin POST under the shared
production lock. The shared provider-schema predicate is used when calculating
the schema digest, so exact provider-owned metadata is excluded while a shadow
object remains visible as drift.

Usage activation requires the common primary forward rows through
`0008_telemetry_v12.sql` and the final typed v1/v1.1 and successor usage
objects. The independent `0009_performance_reports.sql` migration, performance
tables, and histogram bucket checks may be absent or remain staged. Performance
activation requires the complete primary prefix through `0009`, every pinned
performance object, and the exact report bucket and measurement checks. Both
targets require typed storage, the same valid source namespace for v1 and v1.1,
and enabled upload registration and processing controls.

The runtime row must still be `staged`. Record its current `policy_revision`
from a read-only post-deploy check and use that value as `expectedRevision`.
Do not guess a revision or start a new operation/key against an already-active
row. An exact retry of the same idempotency key and complete request is the
lost-response recovery path. A stale revision, tuple mismatch, missing schema
object, disabled control, or JSON storage mode is a refusal and does not
produce an activation success.

## Activation sequence

1. Apply the forward migration set using the protected migration procedure and
   retain its ledger and reconciliation receipt. Migration application is a
   separate operation from activation.
2. Reconcile the target D1 role read-only. Confirm the typed v1 and v1.1
   admission state, source namespace, collection controls, the staged target
   runtime row, its exact revision, and the target-specific schema/migration
   state. For usage, performance tables may be absent; for performance, the
   full performance migration, tables, indexes, triggers, and bucket contract
   must be present.
3. Deploy the Worker build containing the activation path. A deploy does not
   apply D1 migrations and does not activate a runtime.
4. Repeat the post-deploy read-only checks. Confirm that the runtime target is
   still staged and that `uploadRegistration` and `processing` are enabled.
5. Create the post-deploy receipt from the owner-private directory. The
   command performs only fixed read-only Cloudflare inventory and D1 `SELECT`
   calls, re-reads the Worker and both D1 roles before writing, refuses any
   source/config/schema/ledger drift, and writes a new 0600 file without
   overwriting an existing receipt:

   ```sh
   node apps/worker/scripts/telemetry-runtime-reconciliation.mjs \
     --account-id <account-id> \
     --worker-name <production-worker-name> \
     --output <owner-private-directory>/telemetry-runtime-reconciliation.json
   ```

   Keep that file owner-private and use its complete JSON object as the
   `reconciliation` value below. The source commit is live-checked from the
   deployed `DEPLOYMENT_SOURCE_COMMIT` binding; the version ID and config
   fingerprint are captured from the same Worker inventory. The generator
   refuses an existing output path, so preserve the original receipt for
   recovery evidence and choose a new path for a recapture.
6. Create two owner-private, mode `0600` JSON files: the request file contains
   the exact body below (with the receipt copied byte-for-byte), and the admin
   session file contains the owner session used by the maintained operator
   entrypoint. The session file shape is:

   ```json
   {
    "schema": "telemetry-runtime-admin-session-v1",
    "origin": "https://admin.tibotattle.com",
    "cookie": "CF_Authorization=<owner Access cookie>",
    "csrfToken": null,
    "accessJwt": "<same owner Access JWT as CF_Authorization>"
  }
  ```

   Keep the Access cookie and JWT only in that private file. The maintained
   entrypoint posts exactly `POST /api/v1/admin/action` with the exact origin
   and `x-usage-monitor-admin: 1`; it sends the optional CSRF header only when
   a session token is supplied. It accepts either the verified Access JWT
   header or the `CF_Authorization` cookie and never prints session values. It
   refuses any origin other than the reviewed admin origin. Generate a fresh
   bounded UUIDv4 idempotency key for the attempt and include the exact
   reconciliation receipt from the post-deploy check:

   ```json
   {
    "action": "run_maintenance",
    "telemetryRuntimeActivation": {
      "target": "usage_v12",
      "expectedRevision": 1,
      "confirmation": "activate_telemetry_v12_runtime",
      "idempotencyKey": "<uuid-v4>",
      "reconciliation": {
        "schema": "typed-forward-post-deploy-reconciliation-v1",
        "capturedAt": "<canonical ISO timestamp>",
        "sourceCommit": "<40 lowercase hex characters>",
        "versionId": "<owner-captured deployed Worker version UUID>",
        "configSha256": "<owner-captured live config SHA-256>",
        "deploymentAttestation": {
          "schema": "typed-forward-live-deployment-attestation-v1",
          "capturedAt": "<canonical ISO timestamp>",
          "sourceCommit": "<same deployed source commit>",
          "versionId": "<same owner-captured deployed Worker version UUID>",
          "configSha256": "<same owner-captured live config SHA-256>",
          "attestationSha256": "<SHA-256 of the canonical unsigned attestation>"
        },
        "primary": {
          "schemaSha256": "<64 lowercase hex characters>",
          "ledgerSha256": "<64 lowercase hex characters>"
        },
        "analytics": {
          "schemaSha256": "<64 lowercase hex characters>",
          "ledgerSha256": "<64 lowercase hex characters>"
        },
        "proofSha256": "<SHA-256 of the canonical unsigned proof>"
      }
    }
  }
   ```

   Replace `1` with the reconciled revision and obtain the proof fields from
   the operator receipt; do not hand-edit its digests. Run the maintained
   operator transaction from the repository root:

   ```sh
   node apps/worker/scripts/telemetry-runtime-reconciliation.mjs \
     --mode activate \
     --account-id <account-id> \
     --worker-name <production-worker-name> \
     --repository-root "$PWD" \
     --operation-directory <owner-private-directory>/telemetry-runtime-activation \
     --request-file <owner-private-directory>/telemetry-runtime-activation-request.json \
     --admin-session-file <owner-private-directory>/telemetry-runtime-admin-session.json
   ```

   The entrypoint acquires the shared production lock, captures the live
   Worker version/config immediately before the POST, compares those facts to
   the nested deployment attestation, and captures them again before releasing
   the lock. A stale version/config receipt is refused before the POST. The
   endpoint performs one D1 batch containing the runtime compare-and-swap, the
   collection-control revision guard, and the terminal success audit update.
   The batch either commits all of those changes or commits none. It writes
   only the closed, content-free activation request envelope and singleton
   runtime row; no participant or event payload is included.
7. Verify the response and runtime row read-only. Confirm `state = active` and
   the revision increased by exactly one. When the performance stream is
   installed, its independent row must remain staged during usage activation;
   it may be absent while performance is still unprepared. Keep the response
   and audit operation identifier with the release evidence.

Performance activation is optional and follows the same proof and operator
sequence only after its separate collection decision. Its exact request is:

```json
{
  "action": "run_maintenance",
  "telemetryRuntimeActivation": {
    "target": "performance",
    "expectedRevision": 1,
    "confirmation": "activate_telemetry_performance_runtime",
    "idempotencyKey": "<uuid-v4>",
    "reconciliation": "<same receipt shape, with exact live role digests>"
  }
}
```

Use the reconciled performance revision. This operation cannot activate the
usage runtime and can be omitted while performance remains staged.

## Failure and recovery boundary

The activation CAS has an exact state, revision, schema, method, privacy, and
limit tuple in its `WHERE` clause. The collection-control revision is bound in
the same batch. A returned zero-row CAS is a deterministic admin conflict and
cannot claim a competing activation. A successful batch has both an active
runtime at the next revision and a `success` audit row with the same durable
operation id.

If the response is lost after the batch commits, retry the identical request,
including the same idempotency key and reconciliation proof. The Worker reads
that exact unique audit row and returns the prior success without another
mutation. Reusing a key with any different target, revision, or proof is a
conflict. If a process failed after writing the `started` intent but before
the batch, an identical retry reuses that intent while the runtime is still
staged. A `started` audit alongside an active runtime is ambiguous and returns
the reconcile-required error; inspect the exact operation id, runtime row, and
audit row before taking any further action. Never promote that audit by reading
the runtime alone.

The maintained operator command journals its lock and POST boundary in the
owner-private operation directory. If it exits after `lock_intent`, rerun the
same command with `--resume`; it adopts that exact owner when the shared lock
is already held or acquires it when the lock is still absent. A fresh operation
captures live deployment identity before POST, so a version/config drift
refuses before the POST; create a new reconciliation proof and operation key
after the deployment is stable.

If it exits with `admin_intent`, `--resume` asserts the existing owner and
first retries the exact same request. A completed Worker replay returns the
durable success before mutable proof checks, journals `release_intent`, and
releases the lock even when the deployment has since drifted. If the replay is
refused or its response is lost, use the separate reviewed reconciliation
mode. Reconciliation mode never posts to the admin route: it reads the fixed
target runtime and exact audit row under the held lock:

```sh
node apps/worker/scripts/telemetry-runtime-reconciliation.mjs \
  --mode reconcile \
  --account-id <account-id> \
  --worker-name <production-worker-name> \
  --repository-root "$PWD" \
  --operation-directory <owner-private-directory>/telemetry-runtime-activation \
  --request-file <owner-private-directory>/telemetry-runtime-activation-request.json \
  --admin-session-file <owner-private-directory>/telemetry-runtime-admin-session.json
```

That mode releases only after a durable success with the expected active
revision or a durable failure with the original staged revision. A still
started audit, an active revision without matching success, a missing audit,
or any read uncertainty remains fail-closed and retains the lock for review.
If it exits with `release_intent`, `--resume` releases or reconciles that exact
owner and returns the stored result without posting again.

If post-deploy verification fails, leave the target staged and resolve the
migration, schema, configuration, or collection-control issue before retrying
with the newly reconciled revision. An active runtime is forward-only; use the
existing collection-control containment procedure for an incident rather than
attempting an undocumented state reversal. Cache calculations remain on their
existing implementation until a separately approved back-catalog change.
Performance remains independently staged by default.
