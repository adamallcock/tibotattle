---
title: GCP private route candidate and synthetic v1.2 journey
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP private route candidate and synthetic v1.2 journey

On 2026-09-25, a source-pinned candidate passed the complete Worker gate and
was deployed to the IAM-private `tibotattle` **test project** in `us-east1`.
One fresh synthetic v1.2 journey then passed against the new revision, and its
exact owner and object were removed. Production Cloudflare continued serving;
the test maintenance Scheduler remained `PAUSED`.

## Source and validation

The clean detached source was commit `8aefd9b7` (before later route and
historical-transfer work in the integration worktree). The allowlisted Cloud
Run source-content digest was
`b939f0a639d0863f47a8b3e343175b4f224cbfad6bb65de01432527a2bb3c45f`;
the archive SHA-256 was
`915f98555d72c759571c32b29b3fc1121a0add53f16d3800fca3a15978828062`,
stored as create-only object generation `1790350044072966`.
Regional Cloud Build `29dcea93-02f4-4940-ac33-ebc223c2b967` succeeded and
produced image
`sha256:e03f9ed1a9f266683e95d6351e939db94ef534a56565378fd2ca83b9c1326c60`.

`npm run architecture:check` passed at that clean source. The complete
`npm run product:worker:check` exited successfully: its Worker Vitest suite
passed 159 files and 2,000 tests, the Node Vitest suite passed two tests,
and the migration, transfer, type, script, deployment dry-run and staging
configuration stages completed. The dry runs did not deploy Cloudflare.

## Private revision and journey

The source-pinned deployment gate returned `deployed` with no blockers.
Revision `tibotattle-test-app-00035-ws7` received 100% of private test traffic
from the exact image above. The separate `verify` gate returned `verified` with
no blockers; both gates observed `denied_without_identity` for an anonymous
invocation. The backing stores remained the isolated A2 primary schema at
39/39 migrations, independent ledger at 6/6, and the A2 GCS bucket.

The smoke Job was pinned to that image, with one task and zero retries.
Execution `tibotattle-v12-smoke-82gwf` succeeded. Its content-free receipt
reported an exactly replayed day manifest and chunk, exactly replayed domain
activation, credential rotation with old-secret rejection, PostgreSQL and GCS
readback, and one effective-record readback. Health met the migration-39/ledger-6
contract. Daily publication stayed withheld by verified degraded collection
controls.

Read-only discovery `tibotattle-v12-synthetic-discovery-swk9n` found exactly
one target synthetic owner, one referenced object, one pending reference, and
zero unattributable pending references. The cleanup Job's image, exact owner,
isolated bucket, bucket-birth proof and zero-retry policy were read back before
execution. Cleanup `tibotattle-v12-synthetic-cleanup-hv6sk` completed with
`objectsDeleted=1`. A second discovery of the same target,
`tibotattle-v12-synthetic-discovery-lrj56`, returned the expected
`SYNTHETIC_DISCOVERY_TARGET_OWNER_INVENTORY_MISMATCH`: the owner was absent.
An independent all-versions GCS listing returned no objects.

## Boundary

This receipt qualifies this candidate's private synthetic v1.2 path and exact
cleanup. It does not qualify the later social-device disconnect and historical
transfer changes, the remaining Worker routes, OAuth/session/admin ingress,
scheduled publication, production source transfer, public traffic, or a graph
speedup over Cloudflare. The complete cutover gate board is in the
[source integration plan](../plans/2026-09-24-gcp-source-integration.md#cutover-gate-board).
