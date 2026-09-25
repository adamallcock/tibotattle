---
title: Telemetry v1.2 public eligibility
date: 2026-09-25
type: plan
status: ready-for-review
---

# Telemetry v1.2 public eligibility

## Boundary

The owner decided on 2026-09-25 that accepted v1.2 uploads are public
contribution sources on the same terms as v1.1. This plan covers the hosted
Worker source, two forward ingestion-isolation migrations and their local
proof. It does not apply a remote migration, deploy, or read production data.
The public daily figures stay unchanged until both migrations are applied and
the reviewed source is deployed in the order below.

## Findings (source and local tests, 2026-09-25)

- The public eligibility view admitted an accountless device only through its
  v1.1 grant and a v1.1 head. The shipped desktop client negotiates v1.2, so
  an install that went straight to v1.2 was never a public source.
- A v1.2 domain activation journaled nothing. A v1.2-only owner therefore had
  no analytics owner identity. A social owner in that state made the daily
  cohort throw, which would stop every public day. A counted owner's later v1.2
  upload never re-queued its days, and the cached fold stayed current.
- Lease renewal could not extend the v1.2 grant, whose trigger forbade any
  expiry change. After the first renewal the active authorization view refused
  that device's v1.2 uploads permanently. A repeated grant request was a no-op
  that still returned 201.
- Ordinary opt-out neither revoked the v1.2 grant nor retained v1.2-only
  history, unlike v1.1.

## Changes

1. `0010_accountless_v12_renewal.sql` (PR 1) gives the v1.2 grant the v1.1
   grant's forward-only, lease-bound renewal and repairs drifted grants.
   Renewal, the capability read and the v1.2 write gate apply the same lease
   equality as the active authorization view.
2. `0011_v12_public_eligibility.sql` (PR 2):
   - adds active and retained v1.2 accountless branches to the eligibility
     view. They are disjoint from the v1.1 branches because they require a
     device with no v1.1 domain;
   - lets the opt-out marker name an accepted v1.2 head;
   - adds the v1.2 delivery bridge. An eligible v1.2 head mints the shared owner
     link when absent and journals one `owner-active` change;
   - bridges the existing eligible v1.2 heads once.
3. The analytics runtime acknowledges a v1.2 event, which advances the owner
   revision. It re-queues exactly the days whose accepted manifest changed.
   Opt-out revokes the v1.2 grant and writes the marker only for a currently
   eligible device. Schema probes keep all code paths unchanged before their
   migration.

## Deployment order (owner-authorized, protected)

1. Deploy the reviewed source first. Before `0011` it classifies no v1.2
   events, and before `0010` it keeps the four-row renewal.
2. Apply `0010`, then `0011`, to the live primary role. The 2026-09-22 typed
   forward operator is pinned to its own predecessor and applies only
   `0006`–`0009`. These two files need a reviewed forward operation of their
   own. Do not append them to that operator's historical plan.
3. Never apply `0011` before the source that understands its journal events.
   Older runtimes route an unknown event to the v1.1 handler, which refuses it
   and stalls ordered delivery. The ordered ledger already puts `0010` first,
   so a grant that drifted before `0010` is repaired before its head can be
   bridged.
4. Verify health, then the public daily rows for recent days, then the admin
   upload and eligibility counts.

## Validation

Recorded in the pull requests. The local gates are the full Worker Vitest
suite, the typed preflight and forward-operator script checks, typecheck,
documentation preflight and the architecture check.

## Open follow-ups

- Allowance fits still select only v1, v1.1 and legacy sources, so a
  v1.2-only source contributes daily activity but no allowance fit.
- The storage daily payload sets `contributingDevices` equal to contributing
  owners. Relabel it or count devices.
- The graph readiness hint omits v1.2-only members. Publication's full member
  check includes them.
- Confirm live eligibility and publication counts with read-only aggregate
  queries after deployment.
