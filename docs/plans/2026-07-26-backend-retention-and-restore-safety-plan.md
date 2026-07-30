---
title: Backend Retention and Restore Safety Plan
date: 2026-07-26
type: plan
status: in-progress
---

# Backend retention and restore safety plan

## Outcome

Turn the existing local Cloudflare Worker proof of concept into a backend whose
privacy lifecycle is executable and independently testable. The service must:

1. accept only bounded, encrypted, privacy-safe contribution envelopes;
2. validate and deduplicate canonical metadata in D1;
3. retain accepted encrypted quarantine objects for no more than seven days
   after successful processing;
4. preserve participant deletion across restoration of an older primary D1
   backup;
5. rebuild or withdraw participant and aggregate state before deleted data can
   be served; and
6. expose only content-free operational health.

This work remains local and synthetic. It does not authorize a production
deployment, public route, real participant data, or external invitation.

## Existing evidence

The current Worker already implements:

- bounded request reads and strict JSON/content-type handling;
- authenticated, one-use upload authorization;
- encrypted R2 quarantine writes;
- server-side decrypt, schema/privacy validation, pricing, canonical D1 ingest,
  occurrence-level deduplication, and fixed safe errors;
- participant-only contribution reads, stats, insights, export, and deletion;
- delayed immutable community snapshots with withdrawal triggers; and
- local incident controls for enrollment, upload registration, processing, and
  publication.

The remaining lifecycle gaps are automatic R2 retention and deletion-safe
restore behavior.

## Contract

### Independent deletion ledger

A second D1 database, `DELETION_LEDGER`, is independent of the primary
`USAGE_MONITOR_DB`. It stores no participant identifier, account identifier,
content, event, contribution, object key, IP address, or free text.

Each row contains only:

- a domain-separated SHA-256 digest of the opaque random participant ID;
- a fixed schema version;
- deletion time; and
- a bounded `retain_until` time.

The digest formula is:

```text
SHA-256("app-usagemonitor/deletion-tombstone/v1\0" + participant_id)
```

Tombstone retention is initially 400 days for this development proof. That
value is not a production policy. Before an invite pilot, the approved primary
backup and soft-delete horizon must be fixed, and tombstone retention must
exceed it with documented margin.

### Participant deletion order

Deletion uses this fail-closed order:

1. mark the participant `deleting`, which withdraws derived snapshots;
2. write or verify the independent deletion tombstone;
3. delete all participant R2 quarantine objects;
4. delete primary canonical and identity rows.

If the independent ledger is unavailable, deletion does not remove the primary
rows. The participant remains in a non-serving, retryable `deleting` state.

### Restore suppression

Before a restored primary database is allowed to serve traffic:

1. enumerate primary participants in bounded pages;
2. derive each independent digest;
3. compare it with the deletion ledger;
4. mark matches `deleting` to withdraw derived snapshots;
5. remove their R2 objects; and
6. delete their primary rows.

The scheduled lifecycle pass repeats this process as defense in depth, but it
does not replace the pre-serve restore procedure.

Each paid-tier lifecycle invocation scans at most 100,000 primary/tombstone
rows, suppresses at most 100 restored participants, and removes at most 100
quarantine objects. It reports incomplete work explicitly and blocks aggregate
publication until subsequent passes complete. These development bounds stay
below the current official
[paid-Worker D1 query limit](https://developers.cloudflare.com/d1/platform/limits/)
and [R2 multi-delete limit](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/);
a Free-tier deployment is not supported by this design.

### Quarantine retention

For accepted contributions older than seven days:

1. delete the opaque R2 object;
2. set `quarantine_deleted_at` only after R2 deletion succeeds; and
3. retain canonical metadata required for participant results and calibrated
   aggregates under its separately approved retention class.

Rejected payloads are not persisted by the current Worker, so no rejected-object
retention job is required yet.

### Scope deliberately deferred

This slice does not silently invent policies for:

- coarsening or deleting exact canonical events after 180 days;
- deleting participant weekly features after 24 months;
- cloud-provider soft-delete and backup settings;
- production tombstone duration;
- operator audit-log retention; or
- public aggregate-version retirement.

Those remain release gates, not hidden defaults.

## Verification

The implementation is complete for this local gate only when tests prove:

- malformed and prohibited uploads remain rejected without R2/D1 residue;
- duplicate uploads remain idempotent;
- seven-day R2 objects are deleted while canonical stats remain available;
- a failed R2 delete is retryable and is not falsely marked complete;
- a participant deletion cannot complete without a tombstone;
- a 101-participant restored set is suppressed in bounded 100-plus-1 passes,
  with the first pass explicitly incomplete;
- restoring pre-deletion primary rows while retaining the independent ledger
  causes full suppression before service;
- no participant, canonical record, contribution, snapshot, session,
  authorization, device credential, or R2 object is resurrected;
- health reports both databases and lifecycle capabilities without identifiers
  or counts; and
- the focused Worker tests, type checks, dry deployment, local HTTP lifecycle
  drill, and full product checks pass except for already-frozen unrelated
  provenance gates.
