---
title: GCP A2 private v1.2 test journey and exact-owner cleanup
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP A2 private v1.2 test journey and exact-owner cleanup

This receipt records the 2026-09-25 **test-project** run in `tibotattle`,
`us-east1`. It proves one isolated synthetic v1.2 journey through real Cloud
Run, Cloud SQL PostgreSQL 17, and Cloud Storage, ending in an exact-owner
cleanup. The service is IAM-private and the maintenance Scheduler is paused.
Production Cloudflare continues to serve. This is not a production cutover or
full application qualification.

## Pinned source and isolated resources

- Integration branch `codex/gcp-cutover-integration-20260924` included the A2
  smoke, discovery, cleanup, deployment gate, and Cloud Run build-context fix
  through commit `d610b8f3`. The source archive content digest was
  `188a93f8d1ee1b367546ad898aa763c7e302df64723e1c6f7b7ec723f3ceb4d6`;
  its SHA-256 was
  `2421aeaae3c84854ea55d1d13ab9b487232af61e42f711063d932baafa80123e`.
  The create-only source object had generation `1790330260693118`.
- Regional Cloud Build `378411b8-3b8b-446b-8fa8-d338f3dd2c30` succeeded at
  2026-09-25 09:59:29 UTC. The immutable image digest was
  `sha256:c15153012a565c607bee69da2dc390744f060d6a75718267ca29cbeec47758e3`.
  An earlier build of a different archive failed because the context omitted
  an imported maintenance gate; commit `d610b8f3` fixed that omission and
  added an archive regression. The failed build was not deployed.
- New primary schema `tibotattle_v12_a2_20260925`, separate ledger schema
  `tibotattle_ledger_v12_a2_20260925`, and bucket
  `tibotattle-gcs-test-cleanup-20260925-a2` isolated this run from prior
  synthetic fixtures. The bucket birth receipt's SHA-256 was
  `31409130f6973dc6ff523943a1f50b1608b7141ca54a499b3190487b72b14f06`.
  It pinned creation, empty initial inventory, generation
  `1790327360230523586`, metageneration `1`, uniform access, enforced public
  access prevention, versioning disabled, and soft-delete retention zero.
  The receipt is locally held, not cryptographically signed. A conditional
  custom IAM role limited the runtime identity to this bucket and the
  `telemetry/v12-` object prefix.
- Successful on-demand pre-migration Cloud SQL backups were primary
  `1790328665387` and ledger `1790328666708`. This did not test restore.

## Database and private service

- Migration execution `tibotattle-test-database-migrate-hzcfm` succeeded. Its
  structured readback reported 36/36 primary migrations, ending at 0036 with
  checksum
  `136645a7a262d756813c43f305930c8cf5435ab5415ef8bad3c38a6c3e07dee8`,
  and 6/6 ledger migrations, ending at 0006 with checksum
  `1e964efc4a6cdf849e4eb14355956ac3c4e16255d2d3e4ea714a9d098e3f7298`.
  It applied and read back scoped runtime-role privileges; the migration
  history remains read-only to that role. Earlier schemas were untouched.
- Activation execution `tibotattle-v12-test-activate-hdc6l` succeeded at
  primary version 36. It enabled the legacy and typed test runtimes under
  degraded controls: enrollment disabled, upload registration and processing
  enabled, publication disabled. This was a test control state, not a public
  activation.
- The source-provenance deploy gate returned `deployed` with no blockers and
  verified anonymous access denied. Independent readback found revision
  `tibotattle-test-app-00028-6rb` serving 100% of private test traffic from
  the immutable image above, under the test runtime service account and exact
  A2 database/bucket target. The active revision no longer contains the
  earlier test-only `ADMIN_IDENTITY_LINK_KEY` variable. Historical revision
  configurations were not audited in this run.

## Synthetic journey and cleanup

- Smoke execution `tibotattle-v12-smoke-gz47z` succeeded. Its structured
  receipt reported a synthetic owner, staged and exactly replayed v1.2
  manifest/chunk, activated and exactly replayed domain, and
  `postgresReadback=true`, `effectiveRecordReadback=true`, and
  `gcsReadback=true`.
- Read-only discovery execution `tibotattle-v12-synthetic-discovery-nkpz5`
  returned `ready` for that exact synthetic target: one owner, one referenced
  GCS object, one registered pending reference, and zero unattributable
  pending references.
- Exact-owner cleanup execution `tibotattle-v12-synthetic-cleanup-jfnf8`
  succeeded with `status=complete` and `objectsDeleted=1`. The adapter's
  completion path requires the participant to be absent and its primary
  owner-erasure receipt to exist before recording terminal completion in the
  independent ledger. It uses the bucket birth receipt and object generation
  checks before deleting. A later read-only discovery execution
  `tibotattle-v12-synthetic-discovery-tdth5` failed with the expected
  `SYNTHETIC_DISCOVERY_TARGET_OWNER_INVENTORY_MISMATCH`: the target owner was
  no longer present.
- A retry of the same pinned cleanup Job, execution
  `tibotattle-v12-synthetic-cleanup-kxwvr`, succeeded with
  `status=already_complete` and `objectsDeleted=1`. No additional live or
  versioned object appeared in the bucket. This qualifies the completed
  operation's retry path for this one synthetic target.
- Independent bucket listing found no live objects and no versioned objects.
  The current bucket still had metageneration `1` and zero soft-delete
  retention. The provider rejected a soft-deleted-object listing because no
  soft-delete policy exists; that command was not counted as a successful
  negative inventory. The exact-object adapter and retained bucket settings
  provide the deletion evidence for this one test object.

## One-off maintenance probe

The manually invoked `tibotattle-a2-maintenance-once` Job pinned the same
image, A2 schemas, bucket, and runtime identity, with one task and no retry.
Execution `tibotattle-a2-maintenance-once-cvhf9` exited nonzero by design.
Its structured result was `outcome=partial`, `status=incomplete`,
`code=POSTGRES_MAINTENANCE_INCOMPLETE_UNSUPPORTED_PHASES`, and
`complete=false`: it acquired the PostgreSQL advisory lock, completed the
primary and ledger identity-expiry scans with zero rows purged, and completed
the bounded pending-object reconciliation. Device lifecycle, owner-erasure
jobs, restore replay, telemetry and tombstone retention, and analytics
maintenance all remained explicitly incomplete. The bucket remained empty
and the recurring test Scheduler remained `PAUSED` after this probe. This
proves the supported phases run against the isolated test resources and the
Job does not silently report full readiness.

## Validation and cutover boundary

The full `npm run product:worker:check`, `npm run architecture:check`, and
`npm run test:preflight` passed on the pinned source. Focused A2 smoke,
discovery, cleanup, migrator/deploy/bucket-proof and disposable PostgreSQL 17
tests passed. The private deployment proves only this test harness and
synthetic target. It does not supply production D1/R2 data, scheduled identity
and analytics work, public/admin route parity, general owner-authorized
erasure, restore/rollback, or a matched hosted 10-times graph-speed result.
The test maintenance Scheduler remained `PAUSED` at post-run readback.
