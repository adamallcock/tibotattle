---
title: Close the stranded v1.1 preview failure
date: 2026-10-12
type: plan
status: closed-preview-verified
---

Closed on 2026-10-13: the corrected origin serves production traffic and the
actual owner admin Preview succeeds. It examined six devices and reported two
eligible devices with 182 new days; no uploads were activated. Both schedules
are restored and public readiness returned HTTP 200. Activating recovered
uploads and verifying their later publication remain distinct operations under the
[recovery runbook](../runbooks/2026-10-11-stranded-telemetry-recovery.md).

## Verified starting evidence (2026-10-12 snapshot)

- This checkout starts clean at `7f521836fe7b6e8df7dbb88b53f04a2511dac6ba`.
- The public health endpoint on 2026-10-12 reports origin source
  `7a4bc73ebbc096754adb954fbb2051a6b28b8b35`. The live admin page shows
  the failed preview and disables activation.
- The origin composition reads `env.POSTGRES_RATE_LIMIT_SECRET`, but
  `createProductionWorkerEnv` deliberately excludes origin-only secrets.
  `cursorCodec` consequently refuses before any recovery database query.
- Existing correction `ac66eace2c01f1190e5974ec198dbf58dd8b2080` passes
  the already validated `keyHashSecret` directly into owner maintenance.
  Its regression exercises synthetic Access authentication, CSRF and a
  read-only preview through the shared runtime composition; it also checks
  that the secret remains outside Worker bindings and responses.
- Draft PR #289 preserves the earlier correction. Active follow-through PR #292
  contains its forward-port `ffc15661d8c5a35c99643e1a8ace793732b7c934`.
  Published head `0fdc0cfd1e5264d2b8b500ff16eedd134cfe30f3` has a failed
  Worker check and cancelled PostgreSQL check. The clean local follow-through
  head is `24cddab30e184d769011e86ebab2151b7d4a5e90`; complete checks remain
  with the existing integration owner.
- Cloud Run readback confirms revision `tibotattle-origin-00014-t7s` receives
  100% of traffic, image SHA-256
  `e3e75cfaddb936c08123aa6cb679ee13a72b5d47aa031ad9146da6599e09e112`.
  This binds the observed revision to an image; the source declaration alone
  does not attest image build provenance.
- The two patch-base blobs of `ac66eace2` exactly match the declared serving
  source. Its Docker image targets Node 22; local Node 22.16.0 is available.
  The deployed origin and edge source have identical edge-contract blobs.

## Narrow origin candidate assessment (2026-10-12 snapshot)

The existing integration owner assigned this lane the independent narrow
origin qualification. Branch `codex/stranded-v11-preview-hotfix-20261012` starts
at the exact serving source and contains both existing corrections. Its product
files match the reviewed `ac66eace2` and `83163549` blobs exactly. This is
independent of the broad main convergence and retains kernel 16.

The `831635490392351484ff4b5193dbf48317a746d9` correction aligns preview's
ten-minute quiet period with execution's existing 24-hour client-ownership
fence. New real-PostgreSQL assertions cover one millisecond before expiry,
exact expiry and one millisecond after expiry. Preview preserves the recorded
state, still-owned tokens never reach activation, and the two expired cases
each append exactly one accepted receipt and journal entry. The runbook now
describes the existing execution boundary accurately.

## Local qualification (2026-10-12 snapshot)

All database fixtures are synthetic, on a separately owned loopback-only
PostgreSQL 17.10 instance. No production recovery has run.

| Gate | Result |
|---|---|
| Actual runtime-constructor regression, Node 22.16.0 | Original wiring reproduced HTTP 503; fixed wiring returned HTTP 200 through synthetic Access and CSRF |
| Origin host and configuration, Node 22.16.0 | 21 host and 28 configuration cases passed |
| v1.1 recovery and v1.2 unchanged/replay, Node 22.16.0 | 18 PostgreSQL cases passed, including the ownership boundary |
| Admin console, Node 26.2.0 | 11 PostgreSQL cases passed; its D1 comparison needs Node 24.10 or newer |
| Complete Cloud Run source check, Node 26.2.0 | 575 passed, four database-environment skips; both owning files rerun with PostgreSQL: 33 passed, zero skips |
| Admin browser contracts | 105 passed |
| Worker adoption route | Nine passed |
| Worker TypeScript | Passed |
| Documentation, preflight, architecture | Passed; preflight 21/21 |
| Canonical origin build, Node 22.16.0 | All 13 bundles built, kernel 16 retained |
| Production rollout tooling, Node 26.2.0 | 640 passed with PostgreSQL, zero failures or skips |

The kernel closure remains
`d2e867213fe9656f6edf91d0ac991cb293a323f3b2cd84af7d79c0ac431f39f4`.
The migration tree, kernel registry, edge-origin contract and admin/web assets
are byte-identical to the serving source. No secret value or binding is added.

The first dependency-incomplete run is retained as an environment failure.
Node 22 source-tooling subprocesses cannot load bare TypeScript; the canonical
full tooling check therefore uses Node 26, while the runtime regression and
bundle build are also checked on Node 22. A direct Docker-only migration-path
check cannot run outside its `/app` image layout. The local Docker daemon is
unavailable; the protected Cloud Build and its image/provenance receipt remain
required before deployment. None of these local checks claims a built image
or a repaired live preview.

The independent read-only review found no actionable blocker. It checked exact
product-blob equivalence, secret and identity exclusion, the frozen-clock
boundary assertions, real predecessor/activation behavior and scoped changes.
Review is separate from the runtime results above and does not authorize release.

## Authorized rollout checkpoint (2026-10-13, before deployment)

The owner approved publishing the isolated branch, the guarded production
build and rollout, scheduler restoration, and a live read-only Preview check.
Recovered-upload activation remains a separate decision. The published runtime
candidate is `eacfad5a18373b62de60b210ca371c8a4b360a31`, tree
`34cfdad72eacef10e652699c45cc73e0278b8697`.

Cloud Build `3f1ac7f8-e232-4b1b-bf2b-4f576d5b7250` successfully built and
qualified image SHA-256
`06fc4bb450066e67dae179672f6b5f1bd2f14fc6a1e2f746cbbdf573c642ffe0`.
The archive includes the unchanged public assets: its 735-file context digest
is `4d9b28be1b86e74c1685f1fcf346be449a62838e4edfde21fad128ca7839d729`.
The backup audit is healthy, the fresh edge capture verifies `gcp` mode, and
the edge-origin contract blobs match.

Both scheduler triggers were recorded live `ENABLED`, then paused by the
guarded operator at 06:25 UTC. Preflight subsequently passed with one naturally
running analytics execution. Migration and traffic movement awaited its terminal
state. At that checkpoint the serving source remained `7a4bc73e`.

The separate operations change records the two already-enabled schedules in
the committed desired state; it changes no cadence, runtime code or image pin.
Its five-file patch passed 114 focused tests and independent review. Historical
first-apply fixtures retain `PAUSED`, and creation still pauses before granting
the executor role. This operations commit is
`bbcbc264d33faed3ee1d4c83d7ca21ef2d2ce797`, separate from the deployed runtime
source. Receipt-only restoration was the initial plan; the maintenance
timestamp refusal and explicitly reviewed restoration are recorded below.

## Deployment and live verification (2026-10-13)

The existing nightly analytics execution completed successfully at 08:17:39 UTC.
It was never cancelled or restarted. Fresh preflight then proved both triggers
paused, no running jobs, clean infrastructure and a healthy backup audit.

The guarded operator took a successful on-demand backup, executed the migration
job and verified its image-bound receipt at 08:41:00 UTC: 78 migrations, manifest
SHA-256 `4d2ade49a0cbea0d26fb8e54eb7a551cc51e53e5aa3293da64750ce8d7260284`.
No schema change was introduced by this candidate. A new 08:41:41 UTC edge
capture verified source `94bad7999fe1e7d998aa3739c2958b56ab22a53f` and matching
contract blob `c3a8b69cf7dd7ad471b3196df69d789921202d1d` before the roll.

The roll completed at 08:44:21 UTC under the shared deployment lock. The origin
and all three jobs were read back on the qualified image and `eacfad5a1` source.
The serving revision is `tibotattle-origin-00015-9r4`, with 100% traffic and the
same image digest confirmed independently from the revision. Kernel 16 and its
closure above are unchanged. The operator completed a maintenance pass before
checking the public health source.

The live admin Preview subsequently reported:

| Aggregate | Count |
|---|---:|
| Devices examined | 6 |
| Eligible for activation checks | 2 |
| New days | 182 |
| Accepted days kept | 33 |
| Syncing now, left to the app | 2 |
| On v1.2, left to the app | 1 |
| History outside this recovery scope | 1 |
| Covered-day replacement refusal | 1 |

The actual page displayed “Nothing was changed.” The saved screenshot
has SHA-256 `f8c0bd71fac6656206b843ee6fec175853fa9ec64f6f0a829ce69afefee33898`.
Only aggregate results and screenshot evidence were retained; no cursor or
participant identifier was copied into this record.

## Scheduler restoration and readiness

The original receipt resumed analytics at 08:46:57 UTC. Maintenance correctly
refused receipt-only restoration with `CHANGED_AFTER_PAUSE_ALL`: its recorded
`lastAttemptTime` advanced from absent to 06:25:16 UTC after the 06:25:14 UTC
pause receipt, while `userUpdateTime` remained unchanged. This does not prove
the cause of that late timestamp. The refusal and original receipt were kept.

Independent review confirmed the operator's documented explicit-target mode
for restoring that one managed trigger under the owner's existing restoration
approval. A fresh clean infrastructure check, successful maintenance execution,
healthy serving source, and exact one-trigger dry plan preceded the write.
The maintenance-only plan restored its prior `ENABLED` state at 08:48:14 UTC.
No guard, receipt, cadence, authentication target or runtime pin was changed.
The proposed interim restoration during the drain was never applied.

Final readback was clean with no reasons. Both triggers are `ENABLED` at their
original schedules: analytics `0 3 * * *`, maintenance `* * * * *`. Scheduled
maintenance executions completed successfully after restoration. The first
passes reported a reconciliation backlog, while the pre-pause pass had been
complete. Normal bounded maintenance cleared it: at 08:55:09 UTC, a cache-busted
public `/api/ready` returned HTTP 200 `ready`, with fresh lifecycle, matching
maintenance cycle, and completed retention, restore replay and reconciliation.
The separately delegated aggregate rebuild remains explicitly unconfirmed and
does not gate this readiness contract.

Cache-busted public health returned HTTP 200 and the exact deployed source.
The public page and crawler check also confirmed matching Open Graph/Twitter
images, `summary_large_image`, a real 1200-by-630 PNG, and permissive robots.

The private operator records retain the build, backup, migration, edge capture,
roll, both restoration receipts, final readbacks and screenshot hash. This is
production Preview qualification; it is not proof of recovered-data publication.

## Ownership and remaining authorization

The existing integration owner retains PR #292 and main, including its broader
checks and the additional monitoring-test expectation for committed `ENABLED`
schedulers. This lane published the narrow origin and operations commits and
completed their authorized production rollout.

Activation of the two eligible devices has not run. It requires the separate
owner decision already identified before deployment, a fresh Preview if the
current result expires, and the recovery runbook's audited activation and
journal/publication checks. Preview eligibility is rechecked at activation.

No new production reads of participant rows, temporary diagnostic jobs, secret
rotation, desktop release or data migration are needed to establish this cause.
