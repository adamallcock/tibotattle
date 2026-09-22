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

The target primary and analytics D1 roles must have their complete forward
migration prefixes and a durable, read-only post-migration/post-deploy
reconciliation receipt. The receipt must contain the exact schema and
`d1_storage_migrations` ledger SHA-256 for both roles, the deployed source
commit, the owner-captured Worker version/config metadata, and its canonical
proof digest. The Worker live-checks `DEPLOYMENT_SOURCE_COMMIT` against the
receipt and re-reads both D1 roles before activation. The version and config
metadata are bound into the owner-authenticated receipt; this deployment does
not expose runtime bindings for them. The shared provider-schema predicate is
used when calculating the schema digest, so exact provider-owned metadata is
excluded while a shadow object remains visible as drift.

The Worker activation gate also checks the four typed-forward ledger rows and
their source hashes, the final typed v1/v1.1 and successor schema objects, the
exact runtime tuple, and the performance report bucket and measurement checks.
The Worker must be configured with typed storage and the same valid source
namespace for both v1 and v1.1. Upload registration and processing collection
controls must both be enabled.

The runtime row must still be `staged`. Record its current `policy_revision`
from a read-only post-deploy check and use that value as `expectedRevision`.
Do not guess a revision or start a new operation against an already-active
row. An exact retry of the same idempotency key and complete request is the
lost-response recovery path. A stale revision, tuple mismatch, missing schema
object, disabled control, or JSON storage mode is a refusal and does not
produce an activation success.

## Activation sequence

1. Apply the forward migration set using the protected migration procedure and
   retain its ledger and reconciliation receipt. Migration application is a
   separate operation from activation.
2. Reconcile the target D1 role read-only. Confirm the typed v1 and v1.1
   admission state, source namespace, collection controls, staged successor
   runtime rows, exact revisions, and the expected schema/migration state.
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
6. From the owner-pinned Access/admin session, with the existing CSRF
   protection, submit exactly one `run_maintenance` request for the usage
   target. Generate a fresh bounded UUIDv4 idempotency key for the attempt and
   include the exact reconciliation receipt from the post-deploy check:

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
   the operator receipt; do not hand-edit its digests. The endpoint performs
   one D1 batch containing the runtime compare-and-swap, the collection-control
   revision guard, and the terminal success audit update. The batch either
   commits all of those changes or commits none. It writes only the
   digest-only admin audit envelope and singleton runtime row; no participant
   or event payload is included.
7. Verify the response and runtime row read-only. Confirm `state = active`,
   the revision increased by exactly one, and the independent performance row
   remains staged. Keep the response and audit operation identifier with the
   release evidence.

Performance activation is optional and follows the same proof and sequence only after
its separate collection decision. Its exact request is:

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

If post-deploy verification fails, leave the target staged and resolve the
migration, schema, configuration, or collection-control issue before retrying
with the newly reconciled revision. An active runtime is forward-only; use the
existing collection-control containment procedure for an incident rather than
attempting an undocumented state reversal. Cache calculations remain on their
existing implementation until a separately approved back-catalog change.
Performance remains independently staged by default.
