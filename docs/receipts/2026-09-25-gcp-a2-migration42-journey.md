---
title: GCP A2 private journey after PostgreSQL migration 42
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP A2 private journey after PostgreSQL migration 42

On 2026-09-25, the isolated `tibotattle` test primary in `us-east1` advanced
from PostgreSQL migration 41 to 42. A source-pinned, IAM-private Cloud Run
revision then completed a fresh synthetic v1.2 upload, activation, credential
renewal, storage readback, and exact-owner cleanup. Production Cloudflare
continued serving. The test Scheduler stayed paused; publication remained
disabled, and no public daily aggregate was published.

## Exact source and pre-migration safety

- Clean candidate commit: `1ca6eaf1` on branch
  `codex/gcp-cutover-candidate-20260925`.
- Allowlisted Cloud Run source-content digest:
  `087b41b5b71e4a8b770da6eb8ea1bb1eaddf9ce749e87e2b2839deb39e3098f1`.
  The create-only archive had SHA-256
  `b8813cb034bb01d5aeca9672355f188657000c428f58ad1ed8a6325354001276`
  and GCS generation `1790357994632489`.
- Regional Cloud Build `f3f62f32-408f-4cce-9dfb-ae8b2a2c8db1` succeeded and
  produced immutable image
  `sha256:f404119d430c635b4ca656dbbc37a5e719aa791f5ec93a928f57e52c7d25fba2`.
- The primary's manual pre-migration backup `1790358112267` completed
  successfully at `2026-09-25T17:43:23Z`. The primary was PostgreSQL 17,
  `RUNNABLE`, zonal, with backups, point-in-time recovery, and deletion
  protection enabled.

The clean candidate passed `npm run architecture:check`, `npm run docs:check`,
`npm run test:preflight`, `npm --prefix apps/worker/cloud-run run check`, and
`PG_TEST_SOCKET=/private/tmp/tibotattle-pg-root-20260921/socket
PG_TEST_PORT=55432 npm --prefix apps/worker run postgres:domain:check`
(51 Vitest passes; 23 Node passes and one skip). The broad Worker check passed
its code and test stages but first stopped at `deploy:dry` because the fresh
clone lacked the generated public-site manifest. After generating that ignored
artifact from the same checkout, `deploy:dry` and `staging:check` passed
separately. The initial run is not represented as one uninterrupted green
command.

## Private database and service

The one-task, zero-retry migration Job
`tibotattle-test-database-migrate-x85fv` succeeded on the exact image. Its
structured receipt reported primary 42/42 with latest migration
`0042_accountless_history_retention_import.sql` and SHA-256
`c072c60b22d77c850eacc081e39e73c02fb5f7a4d74e209f1e797e18a7dac2f8`;
the independent erasure ledger remained 6/6. Migration 42 creates a guarded
synthetic retention-import permit. No historical D1 marker was imported.

The guarded deployment and independent readback showed revision
`tibotattle-test-app-00038-qh2` serving 100% of private test traffic from the
exact image. The read-only provenance/IAM verifier returned no blockers and an
unauthenticated probe was denied.

## Synthetic journey and cleanup

The one-task, zero-retry `tibotattle-v12-smoke-6g8gs` Job succeeded. Its
content-free receipt reported exact manifest and chunk replay, domain
activation and replay, device-credential rotation and renewal with the old
secret rejected, and matching PostgreSQL, GCS, and effective-record readback.
Publication was withheld by verified degraded collection controls.

The bucket had zero live or versioned objects before the run. Read-only
discovery `tibotattle-v12-synthetic-discovery-z2c2b` found exactly one targeted
synthetic owner, one referenced object, one registered pending reference, and
zero unattributable pending references. The exact target was matched to the
smoke receipt without displaying its identifier. Cleanup
`tibotattle-v12-synthetic-cleanup-rdph8` completed and deleted one object;
retry `tibotattle-v12-synthetic-cleanup-q5gdc` returned `already_complete`.
An independent all-versions GCS listing then counted zero objects.

## Boundary

This proves one private test journey on the named image and resources. The
Google OAuth client, public callback gateway, real D1/R2 source snapshot and
transfer, full route parity, scheduled public analytics, matched Cloudflare
performance target, and production traffic switch remain unqualified. The
separately committed D1 retention source fence and prospective real-source
PostgreSQL permit are local work and were not applied to Cloudflare or this
test service.
