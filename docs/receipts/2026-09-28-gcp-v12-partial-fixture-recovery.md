---
title: GCP synthetic v1.2 partial-fixture recovery
date: 2026-09-28
type: receipt
status: snapshot
---

# GCP synthetic v1.2 partial-fixture recovery

This receipt records one test-only recovery in project `tibotattle`, region
`us-east1`. It documents exact cleanup of the partial owner left by a failed
synthetic v1.2 smoke. It does not qualify the public v1.2 GET journey or a
production cutover.

## Pinned source and build

- Source commit: `8358543c7d9c415eb78720106cbc639b92982779`.
- Canonical source content digest:
  `47d8460e17fa7c54b15d4bdd0d1744d220b751bfec2a56cfc4184e103c674056`.
- Source archive SHA-256:
  `da8b70e25c0ea4073595fc122f3b5c4044aaac32a247ccab837a690af8185f48`.
- Create-only build-source object generation: `1790568387744473`.
- Regional Cloud Build reference `sha256:beb11ad5e588707b` succeeded with
  provenance for that exact source generation. Immutable image digest:
  `sha256:b8bdd3eb2fbac1caf54ee4f0ff6d4cce47dd4341d44e47c2e508df38c97f0c5d`.

## Exact cleanup

- Antecedent smoke: build reference `sha256:60b9cb01ad42d7ee`, source digest
  prefix `9ca797a…`, image digest prefix `sha256:d12a38f…`, and smoke execution
  reference `sha256:ec5a602e5e8180b7`. It failed at the public day-candidates
  GET with safe code
  `SMOKE_V12_DAY_CANDIDATES_FAILED_BACKEND_STORAGE_UNAVAILABLE` after manifest
  staging and replay, before creating a GCS object.
- First bounded cleanup attempt reference `sha256:bbb54a9b5af64fdc` failed with
  `SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED`. The erasure path rejected the
  zero-rotation family before the owner fence or any mutation; no object
  deletion was attempted.
- Only `tibotattle-v12-synthetic-cleanup` changed, from generation 14 to 15,
  using the immutable image above. Its command, test target pins, runtime
  service account, one-task limit, zero retries, and 600-second timeout were
  read back. The other two synthetic Jobs and both test Services were unchanged.
- The cleanup used the exact bounded creation-time window for the failed smoke
  execution. No participant ID was added to the Job configuration or included
  in this receipt.
- Cleanup execution reference `sha256:148741258234a531` completed
  successfully. Its structured receipt reported `status=complete`,
  `objectsDeleted=0`, `attempts=2`, and `replayStatus=already_complete`.
- The Cloud Storage JSON API `objects.list` request with `versions=true`
  returned zero object versions after cleanup. The apparent single line from
  the CLI listing was the bucket root, not an object.

## Validation and boundary

The recovery accepts a zero-rotation owner only for the exact early synthetic
shape: one staged manifest expecting one chunk, no chunk references, one
revision-zero input-version row, a generation-one active device credential,
and no upload authorizations or transport-floor rows. A zero-rotation owner
with a chunk is refused before fencing. The same recovery also verifies an
exact idempotent replay.

Validation on the committed source passed: focused PostgreSQL 17 cleanup tests
11/11, `pnpm run test:preflight` 20/20, Worker TypeScript typecheck, and the
Cloud Run host bundler's `node build.mjs --check`.

The preceding smoke execution failed at the public v1.2 day-candidates GET
with `BACKEND_STORAGE_UNAVAILABLE`, before an upload object was created. The
deployed backend has a `POSTGRES_SOURCE_NAMESPACE` value configured. The
candidate reader requires both global typed v1 and v1.1 admission pins to
match that configured namespace and its encoded namespace ID. The prior A2
activation receipt says the typed test runtime was enabled, but does not
record these database-pin readiness booleans. The live database booleans were
not queried because no existing safe read-only test Job or local connector was
available. This receipt proves cleanup and replay only; keep source-pin
readiness explicitly unverified and do not weaken the guard based on this
smoke failure.
