---
title: GCP test migration 44 and narrow OAuth gateway journey
date: 2026-09-25
type: receipt
status: recorded
---

# GCP test migration 44 and narrow OAuth gateway journey

This is point-in-time evidence for the isolated `tibotattle` test project in
`us-east1` on 2026-09-25. It does not qualify production Cloudflare data,
browser sign-in, the full Worker route set, a release, or a traffic switch.
The source-built runtime was candidate commit `d6af3dce`; a later test-only
correction is not in this image.

## Exact artifact and migration

The allowlisted source archive had source digest
`a6aaaf3d99e9166953c90dc74095d3172c0615ad4231ee3f28e263ac73baaefa`
and archive SHA-256
`41a16b32a967630fecf70fc3ca827c69cc6e44438ead67ce17b80b1ba1638690`.
The create-only build-bucket source generation was `1790361820868517`.
Regional Cloud Build `708cb057-5482-48a1-aa49-2ce82da68c0f` succeeded
and produced image
`us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host@sha256:a2ce3efa5c8c76e15910e01ab434cdb1d2903ee73d67cf61335fbf89a6855a52`.

Manual primary backup `1790361927917` completed successfully before the
forward migration. The single-task, zero-retry execution
`tibotattle-test-database-migrate-mnrrn` succeeded on the isolated A2 schemas.
Its structured receipt reported primary 44/44, ending at
`0044_accountless_import_claim_erasure.sql`, and independent ledger 6/6.
Local PostgreSQL 17 tests had passed the complete 43-to-44 migration and
imported-claim owner-erasure checks before the hosted migration.

The gated deployment readback returned `deployed` with no blockers, matching
the source generation, archive hash, build and image. Backend revision
`tibotattle-test-app-00040-fmg` then served 100% of traffic, with the
canonical test gateway origin configured. The backend IAM policy grants
invocation only to the gateway and test runtime service accounts; anonymous
invocation remains denied.

## Gateway and callback logging

The separate test gateway served revision
`tibotattle-test-oauth-gateway-00002-jk4` on the same image. Its dedicated
service account has only backend `roles/run.invoker`. The gateway permits
only its explicit health, Google handoff, enrollment, session, logout and
pairing-mint routes; an unrelated contribution route returned HTTP 404.
The gateway is public so a browser can reach the test callback. The backend
remains IAM-private.

The project had only `_Default` and `_Required` logging sinks and no folder or
organization ancestor. The enabled `_Default` exclusion matches Cloud Run
request logs for this exact gateway service. Synthetic probes returned HTTP
200 for health and the callback. After ingestion, Cloud Logging showed only
content-free stdout route telemetry for the probes, no gateway request-log
entry, and no project log containing either fake callback query marker. This
qualifies the observed test probe, not every future logging configuration.
No real OAuth code or state was used; the callback HTTP response does not
prove browser sign-in.

## Hosted v1.2 data and erasure journey

The exact-image smoke execution `tibotattle-v12-smoke-jmvtl` reported
`status=ok`: a staged and exactly replayed manifest and encrypted chunk,
activated and exactly replayed domain, rotated/replayed device credential
with the old secret refused, and positive effective-record, PostgreSQL and
GCS readbacks. Public publication stayed withheld by the verified degraded
test controls.

Read-only discovery `tibotattle-v12-synthetic-discovery-h5j5n` found exactly
one newly tagged synthetic owner, one referenced GCS object and one registered
pending reference, with zero unattributable pending references. Exact-owner
cleanup `tibotattle-v12-synthetic-cleanup-mdttm` reported `complete` and one
object deleted. A second execution, `tibotattle-v12-synthetic-cleanup-t98hs`,
reported `already_complete`. An all-versions listing of the isolated cleanup
bucket then returned no objects.

## Source validation and remaining gates

The Cloud Run check, migration manifest check, architecture check, docs check,
and preflight passed for the candidate. The complete Worker gate reached
1,999 passing tests and one failing test setup: the pre-retention test applied
source-transfer migration 0063 after intentionally omitting its 0061 table.
Commit `c92f8304` constrained that fixture to migrations before 0061; the
focused test file then passed 18/18. The complete Worker gate must be rerun
on the final integrated revision.

A dedicated Google test OAuth client and test user, browser sign-in and device
pairing claim, full route and maintenance coverage, real D1/R2 snapshot and
reconciliation, a sustained performance comparison, and explicit production
activation are still separate gates. Production Cloudflare was not changed.
