---
title: GCP A2 daily preflight v2 and migration 38
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP A2 daily preflight v2 and migration 38

This is a 2026-09-25 snapshot for the IAM-private `tibotattle` **test project**
in `us-east1`. Production Cloudflare remained the serving system. The test
maintenance Scheduler remained paused. No production D1 or R2 data was copied,
and no daily revision was published.

Commit `b2dea68a` added a read-only preflight that evaluates the source fence
and the publisher's exact selected-day v1/v1.1 source query in one bounded
repeatable-read transaction. The clean archive had source-content digest
`cca02a118f8623dd49eaa75a88b15c6304880a3108a957e4662ac33079c6d3c7`
and SHA-256
`63850f705c8123cbf341fe3b179f500dd39c4bac48d1bba8fc735a0fb5782750`.
Build-bucket generation `1790343701346233` was submitted as Cloud Build
`0ceea429-acb9-4e17-8e30-8e02d7e68013`, which succeeded and produced image
`sha256:0e96293b62dcf2be3439249ebced9f104d4db294dd9fc1b07041c5cbab2a057b`.

After successful on-demand backup `1790342260460`, named test migration Job
execution `tibotattle-test-database-migrate-whmt4` completed with the primary
at 38/38 migrations and the independent ledger at 6/6. The latest primary
migration was `0038_analytics_event_tuple_versions.sql` with checksum
`c20e692d07cd16ae5f870832610ce6bdf7b97eb734fe4ed96b821fdd85757b2f`.
The exact-source deploy gate then passed for the private test service, including
an unauthenticated denial. An authenticated health request returned HTTP 200,
PostgreSQL 17, primary migration 38 current, ledger migration 6 current, and
`workerApplicationReady: false` as designed for this partial host. The new
private `GET /api/v1/me/devices` route returned HTTP 401 `AUTH_REQUIRED`
without a participant session and disclosed no device data.

Read-only daily preflight execution
`tibotattle-community-daily-publish-test-wr5rf` reported `status: blocked` for
2026-09-25. It found no source-state row, no analytics cursor, no v1 or v1.1
admission state, and publication controls disabled. The publication policy was
present and ready; neither v1 nor v1.1 had an eligible record for that day.
The Job exited 2 to signal the expected block. An authenticated daily HTTP
read returned HTTP 503 `BACKEND_STORAGE_UNAVAILABLE`, preserving the public
read fence.

The next test gate is a narrowly scoped synthetic source/admission/cursor
activation and selected-day fixture, followed by one guarded daily publication
and exact HTTP readback. This receipt does not qualify v1.2 analytics, the full
application route set, production transfer, public ingress, or graph throughput.
