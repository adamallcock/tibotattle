---
title: Hosted API retirement data gates
date: 2026-08-27
type: runbook
status: owner-action-required
---

# Hosted API retirement data gates

## Purpose

The 2026-08-27 API cleanup removed unreachable hosted HTTP contracts while
preserving identity, device-sync, daily-community, and then-current whole-account
deletion. The [2026-08-30 decision](../decisions/2026-08-30-self-service-deletion-retirement.md)
subsequently retires self-service deletion in source and retains private owner
erasure and deletion-safe restore. Neither retirement destroys historical D1
rows, migrations, or tombstones, changes retention, or proves deployment.

This runbook is the separate production-data gate for any later physical schema
cleanup. It is read-only until every invariant below is satisfied. A source
deployment, a D1 inspection, and a destructive D1 migration are three distinct
operations and must have separate receipts.

## Retired runtime contracts

- `POST /api/v1/recover`
- `POST /api/v1/me/upload-authorizations`
- `POST /api/v1/me/contributions/read`
- `POST /api/v1/me/contributions/delete`
- `GET /api/v1/me`
- `GET /api/v1/me/stats`
- `GET /api/v1/me/insights`
- `GET /api/v1/stats/aggregate`
- `GET /api/v1/community/insights`
- the session-upload authorization branch of `POST /api/v1/contributions`
- `DELETE /api/v1/me` (2026-08-30 source retirement; `404 NOT_FOUND` without
  D1 access or participant mutation)

The following source contracts remain supported; verify deployment separately:

- private owner erasure through explicit `participantErasure` on
  `POST /api/v1/admin/action` with `action: "run_maintenance"`
- `POST /api/v1/device/upload-authorizations`
- device-authorized `POST /api/v1/contributions`
- `GET /api/v1/community/daily`
- current identity, session, device-pairing, and device-sync routes

For owner authorization, exact confirmation, audit, retry, and pre-cutover
active/deleting/tombstone counts, use the existing
[production operations procedure](./production-operations.md#private-owner-participant-erasure).
Public deletion-route retirement does not authorize removal of that pipeline
or its restore ledger. Ordinary maintenance without `participantErasure` must
not initiate participant erasure.

## Gate 0: credentials and change boundary

Run the checks from `apps/worker`, using the production environment and an
owner-provided `CLOUDFLARE_API_TOKEN`. Do not place the token in a command,
document, shell history, or receipt. A missing token is a blocked inspection,
not evidence that a table is empty.

The initial inspection is read-only. Do not run `UPDATE`, `DELETE`, `DROP`, or
a migration during the inspection pass.

## Gate 1: recovery-only identity safety

Count participants by lifecycle and identity-link state:

```sql
SELECT
  state,
  CASE
    WHEN identity_link_key IS NULL THEN 'unlinked'
    ELSE 'linked'
  END AS identity_state,
  COUNT(*) AS participants
FROM participants
GROUP BY state, identity_state
ORDER BY state, identity_state;
```

Then count active, unlinked participants with a live web session:

```sql
SELECT COUNT(*) AS active_unlinked_with_live_session
FROM participants AS p
WHERE p.state = 'active'
  AND p.identity_link_key IS NULL
  AND EXISTS (
    SELECT 1
    FROM web_sessions AS s
    WHERE s.participant_id = p.id
      AND s.state = 'active'
      AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
```

Do not remove recovery columns, retry receipts, or repository compatibility
code unless the owner has an explicit migration policy for every unlinked
participant. A non-zero result is a hard stop, not a row to discard.

## Gate 2: session-upload drain

The source deployment must first stop minting session upload authorizations.
Wait at least five minutes—the maximum token and consume-lease lifetime—before
running these checks:

```sql
SELECT state, COUNT(*) AS authorizations
FROM upload_authorizations
GROUP BY state
ORDER BY state;

SELECT COUNT(*) AS live_authorizations
FROM upload_authorizations
WHERE (
    state = 'unused'
    AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) OR (
    state = 'consuming'
    AND consume_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
```

`live_authorizations` must be zero before any session-authorization storage is
changed. Measure retained provenance separately:

```sql
SELECT
  (SELECT COUNT(*) FROM contributions
    WHERE upload_authorization_id IS NOT NULL) AS synthetic_session,
  (SELECT COUNT(*) FROM telemetry_contributions
    WHERE upload_authorization_id IS NOT NULL) AS telemetry_session,
  (SELECT COUNT(*) FROM contributions
    WHERE device_upload_authorization_id IS NOT NULL) AS synthetic_device,
  (SELECT COUNT(*) FROM telemetry_contributions
    WHERE device_upload_authorization_id IS NOT NULL) AS telemetry_device;
```

Non-zero legacy provenance is retained product history. Define how it will be
preserved before removing foreign keys or the authorization table.

## Gate 3: weekly aggregate storage

The weekly aggregate HTTP contract is retired, but the existing weekly
builder/admin projection remains a reversible compatibility subsystem until
production state is inspected. Record:

- weekly snapshot counts grouped by release state;
- active builder leases;
- pending or running rebuild jobs;
- latest published snapshot date;
- legacy telemetry-record count versus current v1 record count.

There must be no active builder or rebuild before removing weekly tables or
triggers. Do not drop `community_snapshot_mutation_control`: the current daily
aggregation path also uses its mutation epoch. Migrate that shared epoch to a
new daily-owned control before any weekly schema removal.

## Gate 4: receipts and follow-up migration

Capture a content-free receipt containing:

- UTC inspection time and deployed source revision;
- Wrangler version and production environment name;
- the aggregate counts above, with no participant IDs, tokens, or payloads;
- the pass/stop decision for each gate;
- the proposed follow-up migration filename and reviewed rollback plan.

Only after all gates pass should a new forward migration be authored. Never
rewrite the historical migrations that created the retained rows. Validate the
new migration against a copy of production-shaped data, deploy it separately,
and re-run private owner erasure, retired public-deletion refusal,
deletion-safe restore, device upload, daily community aggregation, and
admin-readiness checks. This is a future schema-cleanup gate, not a migration
required by self-service deletion retirement.

## Historical 2026-08-27 receipt

The repository and installed-bundle caller audit completed. A read-only remote
D1 inspection was attempted, but the local Wrangler session had no production
API token in the non-interactive environment. No production query or mutation
ran. Consequently, runtime contracts can retire, while physical D1 schema and
historical rows remain preserved pending this runbook.

That receipt records only the 2026-08-27 attempt; the 2026-08-30 documentation
update does not claim a new production inspection or mutation.
