---
title: GCP saved owner sets (E-OWNERSET)
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP saved owner sets (E-OWNERSET)

This is a 2026-10-03 receipt for stream E-OWNERSET on branch
`claude/gcp-fp-e-ownerset`, cut from `claude/gcp-fastpath-final` at
`c2726984`. It records **local, synthetic** evidence only: one macOS arm64
workstation shared with other agents, Node 26.2.0 (Node 22.16.0 for the
refresh and origin where the image runtime is named), and the fan-out
PostgreSQL 17 cluster on port 55433 with one uniquely named database created
for this stream and dropped afterwards. Nothing was pushed or deployed, no
gcloud or Wrangler command ran, and no provider was contacted.

## What it builds

The engine v2 design, section 6.1 to 6.3 (`engine-v2-design-2026-10-02.md` in
the parity home), under the owner's answers: round 2 (past contributions are
kept), round 7 (pre-switch sets are the participants at cutover; the offline
purge deletes an erased owner's contributions and republishes), round 13
(built before cutover on the full-recompute engine) and round 14 (REV-SEED's
per-day floor).

- **Staged migration** `postgres/staged-migrations/primary/0931_analytics_v2_owner_sets.sql`
  (placeholder number for the integrator; purely additive, no
  `CONTRACT_MIGRATIONS` entry; needs the run stamps, primary 0069):
  - `analytics_v2_daily_owner_sets` (day, owner, `first_revision`,
    `provenance` 1, 2 or 3, run and kernel stamps): S(d), only growing;
  - `analytics_v2_daily_contributions` (day, owner, `version`, the folded
    daily values with their schema, full and stable digests, devices,
    `price_kernel_id`, `first_revision`, stamps; `evidence_fp` and
    `price_basis_id` stay NULL until the memo and K-PERCARD record them):
    versioned, the highest version current;
  - `analytics_v2_daily_owner_set_bootstrap`: one content-free receipt per
    frozen-window day whose set GCP recorded first (set size, Cloudflare's
    `contributingParticipants`, the frozen export's sha256).
  - Triggers: no UPDATE or TRUNCATE; DELETE of a set or contribution row only
    when the transaction sets `tibotattle.analytics_v2_offline_purge` to that
    row's owner; versions contiguous and each at a later revision; a member
    always has a contribution and a contribution its member (checked at
    commit). The bootstrap receipt is immutable, and verified (2) exactly when
    the counts agree.
- **Fold** (`compute-community.ts`): a queued, unblocked day folds S(d) plus
  every computed owner with non-empty values on d. Computed owners fold
  exactly as before, in owner-digest order; a member this run did not compute,
  or a computed member whose read for d is empty (counted as
  `contributionRetainedEvidenceAbsent`), folds its current stored contribution
  in its digest position; a member excluded on d (N-EXCL) folds nothing and
  stays a member. A contribution the run's kernel cannot fold (its values
  schema or price identity is not current, so K-REPRICE must reprice it after
  cutover) blocks the day (`memberContributionUnavailableDays`), which keeps
  its prior head: never a zero, never a dropped member. With no saved set the
  fold is the computed-owners fold byte for byte.
- **Bootstrap** (round 7, which replaces the design's archival
  reconstruction): the first recording of a day inside the frozen Cloudflare
  window (C-IPR's export, verified exactly as the route verifies it, read only
  when such a day is queued) records the participants at GCP's publication,
  provenance 2 when their count equals Cloudflare's `contributingParticipants`
  for the day and 3 otherwise (including a day Cloudflare did not publish).
  Every other new member takes provenance 1.
- **Reader** (`owner-sets.ts`, statement families `owner_sets.*`): each queued
  day's set with every member's current version, devices and values digest;
  the values are loaded during compute only for the members a fold needs, each
  checked against its stored digest. A schema without the migration refuses
  (`ANALYTICS_V2_SOURCE_UNAVAILABLE`).
- **Store** (`store-owner-sets.ts`, inside the one write transaction): a
  published day's stored set must be the one the fold read (every stored
  member named, a saved or retained member at its current version, a
  bootstrap only on a first recording), else the whole run is refused with
  `ANALYTICS_V2_OWNER_SET_CHANGED` and nothing is written. New members and
  changed contributions are appended at the publication's revision; an
  unchanged or blocked day records nothing.
- **Single publication helper**: `nextPublishedRevision` in
  `store-publication.ts` (the name REV-SEED's design gives it) decides every
  published revision, and the owner-set rows take their `first_revision` from
  the revision it assigned, so REV-SEED's floor reaches them through that one
  function.
- **Inventory**: `ANALYTICS_V2_OWNER_SCOPED_TABLES` in `contract.ts` lists
  every analytics_v2 table holding an owner, in purge order (contributions
  before sets). The online owner-retirement module is retired (SIMP-1), so
  this is the offline purge's (PURGE-1) inventory; a PG17 case compares it
  with the migrated catalog.
- **Kernel**: the owner-set rule is part of the orchestration method, so
  `ANALYTICS_V2_METHOD_VERSION` is `analytics-v2-method-v2` and
  `owner-sets.ts` joins the compute-closure roots. `kernel-registry.json`
  gains entry 3 (closure `a2db78fb…`, vendored manifest `b40d075f…`), pinned
  in the registry check, which now follows the method the code declares. If
  another stream registers kernel 3 first, the integrator renumbers this one.
- Contract `analytics-v2-contract-v0.6`; the run row's `publication` and the
  Job receipt gain a content-free `ownerSets` summary (counts and days).

## Evidence

| Check | Result |
|---|---|
| Q-1 rehearsal (`scripts/gcp-fastpath-rehearsal.mjs --golden analytics-v2-test/golden --per-date-expected …/golden-q1-node/per-date-expected.json --owner-reference analytics-v2-test/golden-q1-node --staged-primary 0931_analytics_v2_owner_sets.sql`; Node 26.2.0 runner, refresh and origin on Node 22.16.0) | `status: pass`, every gate true. First run: 168 days published, 672 set members and 672 contributions, no bootstrap (no frozen export loaded); second run: no new revision and no owner-set row |
| The same rehearsal on a detached worktree at `c2726984` (node_modules cloned) | `status: pass`, every gate true |
| Published outputs, branch against `c2726984` | served `/api/v1/community/daily` body byte-identical (sha256 `87cf3ad8…`, 396,767 bytes), stored preview byte-identical (`b3722cc9…`), owner rows identical except their random run ids |
| `analytics-v2:check` | 18 files, 198/198 (17 files and 187 at `c2726984`; the added file holds 11) |
| New `analytics-v2-test/owner-sets.spec.ts` (in the above) | 11/11: the computed-owners fold unchanged with no saved set; a departed member and an empty-read member keep their contributions; an excluded member folds nothing; an unfoldable contribution (absent, foreign registry, old schema, wrong day, empty) blocks the day; bootstrap provenance 2 and 3 and the cases that take none; digests; frozen counts; closed input validation |
| New `postgres-test/analytics-v2-owner-sets.spec.mjs` | 6/6: the triggers (update, truncate, unnamed and wrongly named purge refused; contribution order; commit-time membership), the purge inventory against the catalog, the reader (absent migration refused, current versions, digest-checked values, absent versions refused, frozen export read only for a first recording inside its window), the store (revision seed reaches `first_revision`, unchanged days record nothing, departed member kept, `ANALYTICS_V2_OWNER_SET_CHANGED` atomically for four stale folds, a bootstrap written once, closed validation) |
| `postgres-test/analytics-v2-refresh.spec.mjs` | 52/52, including a new end-to-end case through the real fold, reader and store with a loaded frozen export: one verified and six disclosed bootstrap days, a departed member and an empty-read member republish with unchanged content and revision, and a foreign-registry contribution blocks its day. The retain case now expects the departed owner kept in the re-queued day (round 2) |
| Affected PG17 specs together (owner sets, refresh, staged-migrations harness, function search path, online-erasure absence, OPS-4 probe, community daily route, interim public read, occurrence source, append-only residue, catalog store, admin console) | 172/172 |
| Worker gates, serially, every step of `npm run check` except the Wrangler ones | pass: `postgres:migrations:check`, `append-only:absence:check`, `typecheck`, `test:node` (2/2), `vendor:kernels:check`, `v0x:admission:check`, `postgres:retired-readers:check`, `catalog:manifest:check`, `analytics-v2:check`, `gcp:fastpath:scripts-check` (the kernel-registry check 5/5), `deployment:endpoints:check`, `scripts:check`, `npm test` (182 files, 2,411/2,411) and cloud-run `npm run check`; node:test across them 1,647 pass, 7 skipped, 0 failed. `workspace-packages:check` first failed on the worktree's installed accounting and quota-analysis copies carrying a `test/` directory (the environment gap the final-gates receipt records); with those untracked copies removed it passes |
| E12 (`edge-origin-e2e.spec.mjs`, Node 22.16.0 `--experimental-strip-types`, `EDGE_E2E_GOLDEN=analytics-v2-test/golden`, rehearsal on Node 26.2.0; its rehearsal applies every staged migration) | 15/15, 394 s |
| Root `npm run architecture:check` | pass |
| Root `npm run test:preflight` | 21/21 |

The last code change (one merged import and one digest pattern, no
behaviour) came after the worker gates and E12; on it the kernel entry was
re-derived, the build, the registry check, the owner-set and kernel unit
specs (16/16), the owner-set and refresh PG specs (58/58) and the Q-1
rehearsal (pass, the same response and preview digests) ran again.

The first refresh of the Q-1 rehearsal took 19.2 s on the branch against
16.0 s at `c2726984` (one sample each on a shared machine): the owner-set
write and its digests. Not measured on the dense corpus or in the cloud.

## Not done, and open gates

- **Promotion**: the integrator assigns the primary number, regenerates
  `src/postgres-runtime-schema.ts` and moves the file; the specs and the
  rehearsal find it by its suffix.
- **REV-SEED** (parallel): its floor goes into `nextPublishedRevision`; no
  other change is needed here for `first_revision` to follow it.
- **K-REPRICE** (post-cutover): repricing stored contributions, the price
  inputs, `stable_sha256` on heads and trigger v2. Until then a member whose
  stored contribution is not current under the run's kernel blocks its day.
- **PURGE-1** (offline, decided later): the purge names the owner in
  `tibotattle.analytics_v2_offline_purge`, deletes its contributions then its
  set rows (the inventory order), and the affected days are republished over
  the smaller set. Not built.
- `evidence_fp` (the Tier-2 day fingerprint exists, K-READ) is not recorded:
  computing it per published member costs a second evidence read. NULL means
  unknown.
- A departed owner's community aggregate exclusions are not mapped (the
  exclusion read maps listed owners only), so such a member folds on every day.
- Live, staging and production state were not read or changed.
