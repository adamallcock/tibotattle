---
title: Hosted 0.1.18 readiness repair
date: 2026-09-05
type: review
status: source-qualified
---

# Scope and evidence boundary

This forward repair follows the 0.1.18 desktop source merge. It does not
change the published source tag, signed installers, applied migrations,
collection consent, or staged protocol activation. Deployment and live
recovery require separate verification through the maintained
[production runbook](../runbooks/production-operations.md).

The admin asset inventory now embeds the telemetry module required by its
client. Recursive import-closure validation rejects missing or unreviewed
dependencies. The same inventory supplies public-origin refusal checks;
admin modules remain behind owner authentication and outside public assets.

Analytical ingestion can advance the source epoch while leaving a sealed
weekly revision active. Finalization previously rejected that stale active
row. The replacement now journals and withdraws it in the same atomic batch
as publication, under the existing owner, lease and epoch fences. Immutable
payloads and history remain intact; no telemetry is deleted.

The stale-active condition was confirmed through closed live metadata and
reproduced locally before the fix. Snapshot and publication-fencing tests
pass 24 cases, including real ingest, published and suppressed revisions,
replay, epoch/owner/lease races, rollback, newer journals and policy changes.
Three selected scheduler integration tests also pass. These are source and
local-runtime results, not a claim of live recovery or desktop qualification.
