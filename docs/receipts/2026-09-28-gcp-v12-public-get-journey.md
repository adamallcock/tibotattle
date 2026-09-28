---
title: GCP synthetic v1.2 public GET journey
date: 2026-09-28
type: receipt
status: snapshot
---

# GCP synthetic v1.2 public GET journey

This records one synthetic end-to-end v1.2 journey in the isolated GCP test
project `tibotattle`, region `us-east1`, on 2026-09-28. The test exercised the
fixed public test gateway, private Cloud Run backend, PostgreSQL, and the
private GCS bucket. It does not qualify production cutover or full application
parity.

## Pinned smoke runner

- Smoke source commit: `fe3b80162db0682f152522b67001efb2dde4f3c4`.
- Canonical source content digest:
  `f8af991491538b4c36848f5d564e187809c8ecba9940df4631d7f61fefa4c196`.
- Source archive SHA-256:
  `f43cdade0af00485ec162f68d78acdc3bfd31f6cef8b5aa62b35bbeae8ae0a9f`.
- Build configuration SHA-256:
  `a6dd372a20429ab6b3e9b11b738514d201c6b5b0ca8e395e6c69bb0b166dbc12`.
- Create-only source object generation: `1790584160056598`.
- Cloud Build `e7183cbc-7312-4502-b649-2ef5c549f0a9` succeeded and produced
  immutable image digest
  `sha256:fa11d5e4000bc6cd3bccaaccc7ca0e09c624a17d285cccd1118b089c6ea538d9`.
- Only the smoke Job image changed, generation 25 to 26. Its operational
  configuration, target, service account, resources, task count, retries, and
  timeout were read back unchanged. The GCS all-version listing was empty before
  execution.

## Journey and readback

Smoke execution `tibotattle-v12-smoke-8f4dv` completed successfully from
09:33:27Z to 09:34:04Z. Its closed CLI receipt reported:

- `deviceRequestPath=public_test_gateway` and
  `publicReadPath=fixed_test_gateway`;
- `v12DayManifestRead=single_staged_manifest_for_device`;
- manifest, chunk, domain, and device credential operations were replay-safe;
- PostgreSQL, effective-record, and GCS readbacks all passed; and
- publication remained withheld by the verified degraded test controls.

The smoke receipt was retrieved from the exact execution time window. Its closed
schema contained no owner-identifier or token fields, and the log scan found no
bearer- or JWT-like token.

For this test only, the private backend source namespace was temporarily set to
the already-pinned A2 synthetic namespace. The backend remained on image
`sha256:7913cec341f72acc6d14b9bf8520f9df58729c2f926da536096fef9405fdbc9e`.
It was ready on revision `tibotattle-test-app-00049-sr7` at 100% traffic during
the test. The service was restored from its captured pre-test configuration:
the original source setting matches exactly, the same image is ready, and one
ready revision receives 100% traffic (`tibotattle-test-app-00050-96x`). The
public test gateway was unchanged on its prior image and revision throughout
this journey.

## Bounded cleanup and final state

The first cleanup execution, `tibotattle-v12-synthetic-cleanup-rbt84`, used a
stale 60-second selector window from 09:17:50Z to 09:18:50Z. It failed closed
with `SYNTHETIC_CLEANUP_RECOVERY_CANDIDATE_NOT_UNIQUE` before mutation; that
window did not overlap the smoke execution. The bucket had zero object versions
before the smoke and one after its successful upload.

Cleanup execution `tibotattle-v12-synthetic-cleanup-vm2d9` used the corrected
55-second marker-and-time selector window from 09:33:20Z to 09:34:15Z. The
selector resolved the exact synthetic owner inside the cleanup process; no
participant ID was placed in a Job setting or receipt. Its structured receipt
reported `status=complete`, `objectsDeleted=1`, `attempts=2`, and
`replayStatus=already_complete`. The second attempt verified idempotent replay.

A final Cloud Storage JSON API listing with `versions=true` returned zero
object versions. The smoke, discovery, and cleanup Jobs had zero active
executions. The test backend's original source setting and serving image were
verified restored, and the gateway remained unchanged.

## Validation and boundary

The smoke CLI receipt checks passed 20/20. The PostgreSQL 17 cleanup-selector
checks passed 31/31 with no skipped cases, including the ready one-chunk
recovery shape. After adding this receipt, `pnpm run docs:check` passed and
`pnpm run test:preflight` passed 20/20.

This evidence covers one synthetic journey through the fixed test gateway and
its private backend. It does not cover browser OAuth sign-in, real participant
data, all application routes, production services, production Cloudflare,
production migrations, or a traffic cutover. The temporary test-only service
setting was restored exactly; no production resource was changed.
