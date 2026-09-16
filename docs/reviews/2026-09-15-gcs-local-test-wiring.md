---
title: Isolated GCS test wiring
date: 2026-09-15
type: review
status: local-wiring-complete
---

# Isolated GCS test wiring

Historical initial wiring snapshot. For the current run namespace and CLI, use
the [GCS test runbook](../runbooks/2026-09-15-gcs-adapter-tests.md).

This extends the [adapter integration review](2026-09-15-gcp-adapter-integration.md)
on `codex/hosted-object-storage-adapter`. It adds a separate local Worker entrypoint
for synthetic release-object tests against a disposable GCS bucket. Production
Worker routing and contribution storage remain on their existing configuration.

## Local test host

The explicit `apps/worker/gcs-test/wrangler.jsonc` configuration uses a dedicated
local D1 nonce database with a placeholder remote ID. It has no routes, disables
workers.dev and preview URLs, and binds development HTTP to loopback. Its commands
run from `apps/worker`:

```sh
npm run gcs:test:db:local
npm run gcs:test:bundle
npm run gcs:test:dev
```

The database command applies only the existing nonce-table migration to local
`.wrangler/state/gcs-test` storage. It does not apply the contribution schema or
access a remote D1 database. Persistence protects replay across local restarts;
it does not qualify multi-host deployment. The bundle command uses Wrangler's
`--dry-run` and does not publish a Worker. Development HTTP is at port 8799.

Local D1 simulation does not prevent outgoing GCS HTTP. With valid credentials,
a valid signed test request can write to the configured real test bucket.

## Credential configuration

Copy `apps/worker/gcs-test/.dev.vars.example` to `.dev.vars` in that directory
with owner-only permissions. The real file is Git-ignored. Blank example values
fail closed. Supply:

- `GCS_TEST_BUCKET`: the approved disposable bucket, with the enforced test prefix.
- `GCS_ACCESS_TOKEN`: a short-lived token for the bucket-scoped test identity.
- `GCS_ACCESS_TOKEN_EXPIRES_AT`: its actual Unix expiry in seconds, no more than
  one hour ahead. The application rechecks expiry before provider requests.
- `GCS_TEST_RELEASE_TOKEN`: a separate synthetic HMAC signing secret.
- `GCS_TEST_PUBLIC_ED_KEY` and `GCS_TEST_PUBLIC_ED_KEY_SHA256`: the base64 public
  key and SHA-256 digest for a fresh synthetic Ed25519 signing key.

Do not paste credentials into task messages, command arguments or logs. Obtain
tokens through the selected identity's credential mechanism and write them only
to the owner-readable ignored file. Restart the local host after refreshing it.
This manual short-lived token lane is for local qualification; a deployed service
needs a refreshable identity integration.

The only application route is `POST /__gcs_test__/api/v1/release/appcast`, using
schema `usage-monitor-gcs-test-release-guard-v1`, channel `gcs-test`, and
`gcs-test/appcast.xml`. Synthetic artifact URLs use the reserved
`https://gcs-test-updates.invalid` origin; artifact bytes are fetched through the
GCS adapter, not that hostname. The tests provide an executable signed fixture.
The local binding and hostname checks are not a substitute for authentication
or a reviewed deployment configuration.

## Cloud inputs at the local-validation snapshot

At this snapshot a GCP login was available, but the active CLI project belonged
to unrelated work. Subsequent project selection and resource setup are recorded
in the [test asset review](2026-09-15-gcs-test-assets.md).
The intended project ID and bucket location must be supplied before provisioning.
Do not rely on ambient `gcloud` project defaults or change the active project.
Use explicit `--project` for each intended resource operation.

The proposed bucket must use the `tibotattle-gcs-test-` prefix, uniform bucket-level
access and public access prevention. A short-lived test identity should have
object read/create/replace permissions on that bucket only. Do not grant project
Owner/Editor or create a long-lived service-account key. The final bucket name,
identity, retention/versioning settings and cleanup procedure must be recorded
before the first cloud write.

[Google's bucket creation reference](https://cloud.google.com/sdk/gcloud/reference/storage/buckets/create)
documents the explicit project/location flags and access settings. Bucket location
is immutable; choose it before creation. Preserve the default recovery policy
unless a deliberate test-resource decision changes it. This lane does not qualify
GCS quarantine erasure.

## Qualification boundary

A successful local bundle and refusal smoke test prove runnable wiring only.
Actual GCS authentication, create/replace preconditions, concurrent writers,
replay refusal, permission errors and uncertain-write recovery still require
synthetic fixtures in the chosen test bucket. No production release artifacts or
private contribution data belong in this lane.

## Local validation snapshot

- Nonce migration: two statements successfully applied to the isolated local D1.
- Dedicated test Worker: Wrangler dry bundle passed without release-site assets.
- Actual loopback runtime: unsigned POST with no configuration returned sanitized
  503 and `Cache-Control: no-store`; unknown route returned 404. The server was
  stopped after inspection.
- Focused composition tests: 4/4 passed, including a signed commit and D1 replay
  refusal with mocked GCS HTTP, invalid configuration, route refusal, and token
  expiry between composition and provider access.
- Worker and portable TypeScript checks passed; portable Node lane: 17/17 passed.
- Architecture: 542 production files, 2,137 imports, no debt edges.
- Documentation governance and 20 preflight tests passed.

No live GCS requests, credentials in fixtures, cloud resources, remote migrations
or deployments were used. The original main checkout remains untouched; worktree
changes remain uncommitted.

The first startup attempt exposed an unsupported compatibility date. The test
configuration now matches the repository's `2026-07-26` date supported by its
installed runtime. A second startup exposed helper exports being interpreted as
Worker entrypoints; the separate `gcs-test/worker.ts` wrapper exports only the
default handler. Both fixes were exercised by the successful HTTP smoke.
Wrangler's local registry and logs were redirected to temporary writable paths
for this sandbox; this did not change credentials or cloud resources.
