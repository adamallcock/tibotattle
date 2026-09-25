---
title: GCP test gateway journey after restored collection controls
date: 2026-09-25
type: receipt
status: recorded
---

# GCP test gateway journey after restored collection controls

This is point-in-time evidence for the isolated `tibotattle` test project in
`us-east1` on 2026-09-25. It qualifies one synthetic v1.2 upload and cleanup
journey through the public test gateway. It does not qualify production data,
the full Worker route set, browser sign-in, a desktop release, or traffic cutover.

## Restored control state and source correction

The first smoke execution on this source line stopped before fixture creation
with `SMOKE_RUNTIME_CONTROLS_NOT_READY`. A prior test-publication restore Job
had transactionally read back collection-control revision 4 in the exact
degraded, upload-only synthetic mode: enrollment and publication off, upload
registration and processing on, reason
`synthetic_v12_test_upload_only`. The old smoke allowed only revisions 2 and 15.
The test activation Job would not accept revision 4 and was not used as a
repair. The source correction at candidate `c388769b` accepts a positive
PostgreSQL revision only with both v1.2 runtimes active and every exact
upload-only control field, including the reason, matching. The focused smoke
check passed 18/18. The failed pre-seed run left no object generations in the
isolated cleanup bucket.

## Exact artifact and deployment

The reviewed 434-file archive has source digest
`30767445f3aaa7c9b9d24a780b05f82cab0b8f3fc86b843d70c2158cf58b391a`
and SHA-256
`13288f93df4d40632fc5b3c5acde211c2fa740f1e8d9aa1e0d3d776b87041808`.
It was uploaded create-only to the test build bucket and read back at
generation `1790367932735680`. Regional Cloud Build
`e6674c57-e5e2-44c1-980e-b3de91a2787f` succeeded with source provenance
and produced image
`us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host@sha256:b44ea0ef501f0458fd687e57aa0065ba48fbb5841ed9c6301aa5d06b69c6a1be`.

The gated backend deployment returned `deployed`, no blockers, an
unauthenticated IAM denial, and matching archive/build/image provenance.
IAM-private revision `tibotattle-test-app-00046-64g` serves 100% of backend
traffic. The separate public test gateway serves the same image at revision
`tibotattle-test-oauth-gateway-00004-jq2`, also at 100%. Its reviewed page
JavaScript and video returned HTTP 200; an unlisted admin API returned 404.
Gateway health reported PostgreSQL 17, primary migration 44/44 and independent
ledger migration 6/6, while explicitly reporting
`workerApplicationReady:false`.

After the gateway update, the enabled `_Default` request-log exclusion still
matched this exact gateway service. A fake callback probe returned HTTP 200;
after log ingestion, the project retained one content-free callback route
event, zero gateway request-log entries, and zero occurrences of the fake code
or state marker. No real OAuth code was used. Both Cloud SQL instances remained
zonal with 10 GiB SSD, at `db-g1-small` primary and `db-f1-micro` ledger;
the backend and gateway each retained a two-instance maximum.

## Synthetic write, readback, and erasure

The one-task, zero-retry smoke Job was pinned to that image and the exact
public gateway origin. Execution `tibotattle-v12-smoke-qb6tb` reported
`status=ok`: manifest and encrypted chunk staged and exactly replayed,
domain activated and replayed, credential rotated and replayed with the old
secret rejected, and effective-record, PostgreSQL, and GCS readbacks true.
Publication remained withheld under the verified degraded controls.

Read-only discovery `tibotattle-v12-synthetic-discovery-rh9qh` found exactly
the newly tagged synthetic owner, one referenced GCS object, one registered
pending reference, and zero unattributable pending references. The exact-owner
cleanup `tibotattle-v12-synthetic-cleanup-pbbdd` returned `complete` with one
object deleted. Replay `tibotattle-v12-synthetic-cleanup-cd9gn` returned
`already_complete`; the eraser's completion path checks participant absence
and the primary erasure receipt before returning that status. An all-versions
listing of the isolated cleanup bucket matched no objects. A further
read-only discovery execution refused the now-absent target with
`SYNTHETIC_DISCOVERY_TARGET_OWNER_INVENTORY_MISMATCH`; that command requires a
present owner and is not a separate post-erasure success receipt.

## Source checks and remaining gates

The Cloud Run check, focused smoke 18/18, focused accountless PostgreSQL 17
erasure 3/3, deploy-gate 21/21, Worker TypeScript check, architecture check,
documentation check, and preflight passed on this source line. This receipt
does not record the candidate's complete Worker gate.

A dedicated Google test OAuth client and real browser sign-in are still
unconfigured. The gateway's static TiboTattle page renders, but its local
companion reports unavailable; static rendering does not prove the desktop
journey. Older Worker routes, real D1/R2 history transfer, social owner
erasure with analytics retirement, full scheduled publication, and production
rollback rehearsal remain separate gates. Production Cloudflare was not
changed.
