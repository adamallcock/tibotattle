---
title: GCP test journey for the reconciled candidate
date: 2026-09-25
type: receipt
status: recorded
---

# GCP test journey for the reconciled candidate

This is point-in-time evidence for the isolated `tibotattle` test project in
`us-east1` on 2026-09-25. It qualifies one exact-source image of candidate
`9c2a58617092fa957628fc7323bcfdde3c3625ab` on both test services and one
synthetic v1.2 upload, readback, and cleanup journey through the public test
gateway. It does not qualify production data, the full Worker route set,
browser sign-in, the new owner erasers, a release, or a traffic switch.

## Source and build

The candidate merges the migration-41 integration line and the live-tested A2
retry, and adds analytics owner retirement and the social owner eraser. Its
complete Worker gate, Cloud Run check (169/169), PostgreSQL domain suite, and
architecture check passed locally at that commit before this journey.

The reviewed archive has 437 members (436 sources plus the digest marker),
source digest
`299eedb36c6583910cf46ad975db4d471c20517bdddc6f37af96f24bd6fafa3f`, and
SHA-256 `41df5a0f0e28861b2c7904ac8870d0fd2ac562cd3258d1e4f52bb9c74722a434`.
It was uploaded create-only to the test build bucket and read back at
generation `1790376534896978`. Regional Cloud Build
`c6941444-67c7-4755-9d82-c5805a17e673` succeeded from that generation under
the test builder identity and produced image
`us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host@sha256:5ab5c1697293a48c422c682b97b1ec8503f0ba184cb02bd0612432313eb0f60e`.

The first gate run from the candidate clone refused with
`GCP_PRIVATE_TEST_SOURCE_CONTEXT_DIGEST_MISMATCH`: another session had begun
uncommitted accountless-eraser edits in that working tree after the archive
was built. The gate was rerun from a clean detached worktree at the same
commit, whose recomputed context digest equals the archive digest. Dependency
links in that worktree are outside the context allowlist and skipped by it.

## Deployment

The gated deployment returned `deployed` with no blockers, matching
archive, build, and image provenance, and an unauthenticated IAM denial. A
following `verify` returned `verified` with no blockers. IAM-private revision
`tibotattle-test-app-00047-hm6` serves 100% of backend traffic. The public
test gateway received an image-only update to revision
`tibotattle-test-oauth-gateway-00005-qj2`, also at 100%, with its runtime
identity, public ingress, and two-instance maximum unchanged.

Gateway health returned HTTP 200: status `ready`, PostgreSQL 17, primary
migration 44 and ledger migration 6 both current, and
`workerApplicationReady:false`. Unlisted `/api/v1/admin/overview`,
`/api/v1/admin/action`, `/api/ready`, and `/api/v1/me/export` returned 404,
as the [route parity review](../reviews/2026-09-25-gcp-route-parity-review.md)
predicts. The enabled `_Default` request-log exclusion still matched this
gateway's service name and request log. No fake callback probe was repeated
for this revision.

## Synthetic write, readback, and erasure

The smoke, discovery, and cleanup Jobs were pinned to the new image with zero
retries. Smoke execution `tibotattle-v12-smoke-g8bpz` reported `status=ok`
through the public test gateway: manifest and chunk staged and exactly
replayed, domain activated and replayed, credential rotated and replayed with
the old secret rejected, and effective-record, PostgreSQL, and GCS readbacks
true. Publication remained withheld under the verified degraded controls.

Read-only discovery `tibotattle-v12-synthetic-discovery-x7kln` found exactly
the newly tagged synthetic owner, one referenced GCS object, one registered
pending reference, and zero unattributable pending references. Exact-owner
cleanup `tibotattle-v12-synthetic-cleanup-rbrxb` returned `complete` with one
object deleted, and replay `tibotattle-v12-synthetic-cleanup-hq9t5` returned
`already_complete`. An all-versions listing of the isolated cleanup bucket
matched no objects. Its generation, metageneration 1, disabled soft delete,
and disabled versioning still match the bucket's birth receipt.

## Remaining gates

The analytics owner retirement and social owner eraser in this image are not
routed, so this journey does not exercise them. The production request path
remains disabled, and the
[GCP handover readiness catalog](../reviews/2026-09-25-gcp-handover-readiness.md)
lists the remaining work. Production Cloudflare was not changed.
