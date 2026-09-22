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

The target D1 role must have the complete forward migration prefix and a
read-only reconciliation receipt. The Worker activation gate checks the four
typed-forward ledger rows and their source hashes, the final typed v1/v1.1 and
successor schema objects, the exact runtime tuple, and the performance report
bucket and measurement checks. The Worker must be configured with typed
storage and the same valid source namespace for both v1 and v1.1. Upload
registration and processing collection controls must both be enabled.

The runtime row must still be `staged`. Record its current `policy_revision`
from a read-only post-deploy check and use that value as `expectedRevision`.
Do not guess a revision or retry an already-active row. A stale revision,
active row, tuple mismatch, missing schema object, disabled control, or JSON
storage mode is a refusal and does not produce an activation success.

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
5. From the owner-pinned Access/admin session, with the existing CSRF
   protection, submit exactly one `run_maintenance` request for the usage
   target:

   ```json
   {
     "action": "run_maintenance",
     "telemetryRuntimeActivation": {
       "target": "usage_v12",
       "expectedRevision": 1,
       "confirmation": "activate_telemetry_v12_runtime"
     }
   }
   ```

   Replace `1` with the reconciled revision. The endpoint performs one
   compare-and-swap from `staged` to `active`, increments the revision, and
   returns the resulting revision. It writes only the digest-only admin audit
   envelope and the singleton runtime row; no participant or event payload is
   included.
6. Verify the response and runtime row read-only. Confirm `state = active`,
   the revision increased by exactly one, and the independent performance row
   remains staged. Keep the response and audit operation identifier with the
   release evidence.

Performance activation is optional and follows the same sequence only after
its separate collection decision. Its exact request is:

```json
{
  "action": "run_maintenance",
  "telemetryRuntimeActivation": {
    "target": "performance",
    "expectedRevision": 1,
    "confirmation": "activate_telemetry_performance_runtime"
  }
}
```

Use the reconciled performance revision. This operation cannot activate the
usage runtime and can be omitted while performance remains staged.

## Failure and recovery boundary

The activation CAS has an exact state, revision, schema, method, privacy, and
limit tuple in its `WHERE` clause. Zero updated rows is an admin conflict. A
replay is not treated as an idempotent success, and each attempted operation
has a completed success or failure audit when the audit store is available.

If post-deploy verification fails, leave the target staged and resolve the
migration, schema, configuration, or collection-control issue before retrying
with the newly reconciled revision. An active runtime is forward-only; use the
existing collection-control containment procedure for an incident rather than
attempting an undocumented state reversal. Cache calculations remain on their
existing implementation until a separately approved back-catalog change.
