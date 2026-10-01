---
title: GCP fast-path test-project deployment
date: 2026-10-01
type: receipt
status: snapshot
---

# GCP fast-path test-project deployment

This is a 2026-10-01 receipt for commit `e73158c5` on
`claude/gcp-fastpath-final`, deployed to the owner-designated test project
`tibotattle` with the owner's explicit approval in chat. It records
**synthetic, content-free** evidence on disposable test resources only. It
does not qualify the edge, production routing, production data, production
volumes or any Cloudflare resource. Nothing was pushed to GitHub.

## What ran

Command, from a clean worktree of the commit, at `apps/worker`, Node 26.2.0:

```sh
node scripts/gcp-fastpath-test-deploy.mjs all --commit=claude/gcp-fp-deploy \
  --now=2026-10-01T12:00:00.000Z --out=<receipt dir>
```

| Step | Result |
|---|---|
| Build | Cloud Build `6ac30d20-7014-4c26-8dad-794121b3918d`; image `tibotattle-host@sha256:95f534149c8fe581f2fe9bdf0d7747c6a0672ba6a38f8cb3fe8eb1af17fb19ff`, tag `fastpath-e73158c5a2af` |
| Migrate | Job execution `tibotattle-fastpath-test-migrate-kw555`, 26.7 s; 62 primary and 7 ledger migrations current in the pinned fast-path schemas of database `tibotattle_fastpath` |
| Seed | Same importer chain as the local rehearsal, run as the impersonated migrator over the Cloud SQL connector into `typed_legacy_transfer_rehearsal_target_fastpath_cd40451d`: identity copy (20 tables, 51 rows, 31 foreign keys rechecked), typed-legacy, legacy transport, v1.2 (T-2), v1.2 event sources, usage correction, ingestion journal; sealed source sha256 `3aa696e734efc31c…`. Runtime readback (read-only, as the runtime IAM user): 62 migrations, 4 participants, 11,183 typed records, 510 v1.1 and 170 v1.2 day manifests, 6 journal rows, 4 public source owners; the runtime user cannot create in the schema or write migration history |
| Refresh (first) | Job execution `tibotattle-fastpath-test-analytics-refresh-mbgph`, 2 vCPU / 4 GiB, 96.6 s; `complete`: 4 owners, 680 owner-days, 168 days published, 2026-04-17 and 2026-04-18 blocked, 15 refusals (cache day 2, cache lookback 7, model window 4, source conflict 2) |
| Origin | IAM-private service `tibotattle-fastpath-test-origin`, revision `00004-vdp`, `fastpath-test` mode on the seeded schema; the journey service account is the only invoker |
| Verify | `/api/health` 200; `GET /api/v1/community/daily?from=2026-04-15&to=2026-10-01` 200, `public, max-age=300`, 396,337 bytes, sha256 `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d` |
| Refresh (second) | Job execution `tibotattle-fastpath-test-analytics-refresh-vc559`: `complete`, 0 days published (no new revisions), same blocked days and refusals |
| Protected services | `tibotattle-test-app` revision `00050-96x` and `tibotattle-test-oauth-gateway` revision `00006-vrr`, image `sha256:7913cec3…`, unchanged before and after |

## Parity

The cloud response body is **byte-identical** to the local rehearsal's
served body for the same seed and clock (sha256 `a27aee71…`, 396,337 bytes).
The local rehearsal compares that body with the d43c8f92 production-code
oracle: every family is equal except the documented model-day
block-withholding difference (14 dates) and informational cache counts; see
[GCP fast-path local rehearsal](./2026-10-01-gcp-fastpath-local-rehearsal.md)
and [GCP fast-path final integration](./2026-10-01-gcp-fastpath-final-integration.md).

Cloud refresh phases (first run, ms): read 36,648; prepare 14,923; model
15,191; scalar 1,214; write 1,226; cache 103; community 105. The read phase
dominates against the shared-core `db-g1-small` test instance; the local run
of the same corpus takes about 16 s.

## Cleanup

After verification, six stale schemas from earlier proof and failed-seed runs
were dropped from the disposable `tibotattle_fastpath` database (one schema at
a time, because a single transaction exceeded the instance's lock table).
Remaining: the two pinned migration schemas, `tibotattle_transfer` and the
seeded schema with its control schema. The fast-path database, jobs, origin
service, bucket, image tags and Token Creator bindings remain for further
testing.

## Not covered

The edge proxy, production mode, production data and volumes, dense owners,
the native dense fallback, incremental refresh, the v1.0/v1.1 intake routes
over the cloud origin (exercised locally only), and any Cloudflare change.
