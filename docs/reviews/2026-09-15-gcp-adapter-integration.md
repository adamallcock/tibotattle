---
title: GCP adapter integration seam
date: 2026-09-15
type: review
status: locally-validated
---

# GCP adapter integration seam

Local implementation snapshot on `codex/hosted-object-storage-adapter`, based
on `9385bad260698814cc2a4a6c685575a3fd63811a`. This extends the first release
adapter slice. The unrelated primary checkout and cloud resources were not
modified. These are application integration points and local tests, not a
claim that the hosted backend runs on GCP.

## Implemented scope

- Release policy accepts explicit object-storage and replay-nonce interfaces;
  Cloudflare binding/configuration composition is separate from the handler.
- The GCS JSON API adapter uses injected credentials and transport, conditional
  current-generation operations, digest enforcement and sanitized failures.
  The existing signed protocol, keys and refusal behavior are preserved.
- A concrete application entrypoint and Node tests exercise alternative adapter
  wiring. There is no automatic provider selection or fallback.
- One quarantine object port spans ingest, health, reconciliation, retention and
  owner erasure, with R2 as its implementation. GCS quarantine deletion remains
  unimplemented until its erasure contract is proved.
- Local tests cover policy, D1 nonce behavior, GCS HTTP and R2 lifecycle behavior;
  exact resource inputs and remaining live-test gates are documented below.

## Boundaries

The first executable GCP seam serves release objects. It is not a replacement
for transactional contribution storage, privacy erasure, analytical publication,
or Worker deployment/runtime coordination. Those retain the staged design in
[the investigation](../research/2026-09-15-hosted-storage-portability.md).

A GCP-hosted release service must supply a durable shared nonce implementation;
process memory is insufficient across instances or restarts. A Worker can use
GCS with its existing D1 nonce adapter during a separately authorized test.

## Where a new adapter plugs in

`apps/worker/src/release-guard-application.ts` is the composition entrypoint.
`createReleaseGuardApplication` returns `{ fetch(Request): Promise<Response> }`.
The application chooses dependencies once at startup, not from request fields.
A new object provider implements `ReleaseObjectStore`; a new replay provider
implements `ReleaseNonceStore`. Runtime-specific listeners/auth-token discovery
stay outside the policy handler.

```ts
import { createReleaseGuardApplication } from "./release-guard-application";
import { GcsReleaseObjectStore } from "./gcs-release-object-store";

const app = createReleaseGuardApplication({
  contract: reviewedTestChannelContract,
  signing: testSigningSettings,
  nonces: durableSharedTestNonceStore,
  objects: new GcsReleaseObjectStore(
    testBucketName,
    getShortLivedAccessToken,
    fetch,
    1024 * 1024, // appcast writes are bounded to 1 MiB
    30_000,
  ),
});
// Pass incoming Web API Requests to app.fetch in the test host.
```

The identifiers in this example are explicit host-supplied inputs, not new
configuration variables or a runnable deployment. The executable version using
synthetic keys and mocked Google HTTP is
`apps/worker/portable-test/release-guard-application.spec.ts`.

The `r2Bucket` contract field and payload `bucket` remain the legacy signed
protocol's logical destination identity. They do not select the GCS bucket;
the GCS constructor does. Keep a separate reviewed test channel contract, test
signing material, isolated HTTP endpoint and disposable bucket. Do not repoint
the production release contract to test resources.

## Before wiring disposable GCP assets

1. Choose the test bucket and a narrowly scoped test identity. Metadata/media
   reads need `storage.objects.get`. Uploads need `storage.objects.create`, and
   replacement also needs `storage.objects.delete`. See Google's
   [get API](https://cloud.google.com/storage/docs/json_api/v1/objects/get) and
   [insert API](https://cloud.google.com/storage/docs/json_api/v1/objects/insert).
2. Supply a refreshable token callback using that host's credential mechanism.
   The adapter does not discover credentials or persist tokens. It only sends
   them to the fixed Google Storage origin and rejects redirects. Its deadline
   bounds waiting for a token, but the callback must manage cancellation of its
   own authentication I/O; late results are ignored.
3. Supply durable, shared replay storage. An isolated Worker can compose the
   existing D1 adapter with GCS. A GCP-only host still needs a durable nonce
   adapter; an in-memory map is only a test double, never a deployment option.
4. Seed only synthetic signed fixtures in the disposable bucket and exercise
   create, replace, stale-generation refusal, concurrent writers, replay,
   permission failure and uncertain-write recovery. Confirm actual metadata,
   object bytes and unchanged objects after refusal. Do not retry an uncertain
   signed request blindly: its nonce may already be consumed and its write may
   already have committed.
5. Review test-bucket retention/versioning and an exact cleanup procedure. This
   release-object interface intentionally has no delete/list operation. It does
   not establish the erasure guarantees required by contribution quarantine.

Google's [request preconditions](https://cloud.google.com/storage/docs/request-preconditions)
provide atomic generation matching. The adapter uses `ifGenerationMatch=0` for
creation, preserves generation IDs as strings for replacement, and conditions
reads on the live generation. It does not select an archived `generation`.
SHA-256 is checked locally before upload; it is not a Google generation token.

## Contribution quarantine seam

`apps/worker/src/quarantine-object-store.ts` defines `put`, `head`, `delete` and
bounded `deleteMany` operations. All four ingest paths, health checks,
reconciliation, retention and owner erasure use it. The single
`quarantineObjectStore(env)` composition function in `apps/worker/src/index.ts`
selects `createR2QuarantineObjectStore`. A future quarantine provider is selected
there and passed into the lifecycle functions; request input cannot select it.

The port preserves pending-journal registration-before-put and accepted-write
cleanup ordering. D1 and object storage do not share a transaction. Deletion
batches are limited to 202 keys; partial failure rejects, leaving durable state
eligible for retry. Alternative providers must bound total batch duration and
concurrency, rather than starting an unbounded set of requests.

Quarantine and release object ports deliberately differ. Quarantine `head` is
used to decide whether cleanup can be abandoned. Its absence result must not
hide retained versions that still require erasure. Successful deletion must
satisfy the bucket's retained-data erasure guarantee. Do not reuse the GCS
release adapter's live-object 404 semantics as proof of quarantine erasure.
GCS quarantine remains unimplemented until soft-delete, versioning, retention,
and cleanup behavior are qualified for the chosen test bucket.

Independent review also checked delayed-insert safety. The v1/v1.1 canonical
inserts do not share the legacy pending-state triggers, but their admission
triggers require unexpired upload authority and a five-minute consume lease;
reconciliation waits one hour. A normally stalled upload therefore loses insert
authority before cleanup can delete its object. A new database adapter must
preserve that ordering or provide an equivalent atomic fence. Missing legacy
triggers alone do not establish a reachable production race.

The next database step is one transactional contribution operation such as
`insertTelemetryV1Chunk`, with PostgreSQL integration tests for atomic dedup,
retries and authority. This change does not make contribution SQL, Durable
Object coordination or maintenance scheduling portable.

## Replay retention correction

The existing timestamp check accepts a signed request up to 300 seconds early
and 300 seconds late. Retaining its nonce for only 301 seconds from first use
allowed a future-dated request to pass replay checking after that retention
expired. The new regression first failed with a current-state conflict (409)
instead of replay refusal (401), proving the request had reached storage again.
Retention is now 601 seconds from first use; the test checks both 301 seconds
and the final accepted 600-second boundary. D1 pruning and the unique claim run
in one batch transaction. This is a source correction, not a deployed fix.

## Validation snapshot

Environment: isolated macOS worktree, Node.js 26.2.0, Wrangler 4.114.0. Fixtures
are synthetic; GCS HTTP is mocked. No cloud credentials, resource provisioning,
remote writes, remote migrations, publication or load tests were used.

Passed:

- Standard Web API TypeScript compile with `types: []`, covering portable release
  application/GCS implementation and the quarantine contract.
- Node portable lane: **17 tests** (14 GCS adapter, 3 application composition).
- Focused release guard/R2/D1 checks; independent source review of release/GCS
  semantics found no blockers.
- Quarantine adapter/reconciliation: **29 tests**; lifecycle/erasure: **128 tests**.
  Final binding-capability hardening separately passed **8 adapter tests** and
  **1 health regression**, plus Worker TypeScript compilation.
- Root signed-feed and dogfood contract tests: **18 tests**.
- Dependency architecture: **539 production files / 2,131 imports**, zero debt
  edges. A scan finds one raw `env.QUARANTINE` access, in the composition root.

The broad Worker run completed with **1,043 passed / 3 failed** across 84 files.
It overlapped the final capability-validation edit: its three failures were the
new malformed-binding cases against the earlier compiled adapter. A fresh run
of the adapter and complete Worker route test files passed **83/83 tests**
against the settled source. This is not a claim of one uninterrupted green full-suite run.

`deploy:dry` stopped at the existing clean, committed release-tree requirement,
before Wrangler deployment compilation. The generated
`.release-build/public-release-site` is also absent in this worktree. Deployment
and staging gates remain unqualified; no release provenance checks were bypassed.
The local changes remain uncommitted for review.

The future-dated replay regression was verified failing before its fix. A new
R2 fault-injection test initially failed TypeScript because R2's overloaded
unconditional put signature excludes null; its deliberately invalid mock now
has an explicit cast, while the null-result rejection assertion is retained.
No tests or assertions were removed or weakened.
