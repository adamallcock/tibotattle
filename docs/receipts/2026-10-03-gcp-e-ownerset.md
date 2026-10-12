---
title: GCP saved owner sets (E-OWNERSET)
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP saved owner sets (E-OWNERSET)

This is a 2026-10-03 receipt for stream E-OWNERSET on branch
`claude/gcp-fp-e-ownerset`, cut from `claude/gcp-fastpath-final` at
`c2726984`: the first commit (`0b832030`) and the review-fix commit on top of
it (section "Review fixes"). The text describes the branch after both. It records **local, synthetic** evidence only: one macOS arm64
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
    `provenance` 1 to 4, run and kernel stamps): S(d), only growing;
  - `analytics_v2_daily_contributions` (day, owner, `version`, the folded
    daily values with their schema, full and stable digests, devices,
    `price_kernel_id`, `first_revision`, stamps; `evidence_fp` and
    `price_basis_id` stay NULL until the memo and K-PERCARD record them):
    versioned, the highest version current;
  - `analytics_v2_daily_owner_set_bootstrap`: one content-free receipt for
    every day whose set is recorded: how it began (provenance), its size and
    revision and, for a frozen-window day (2 or 3), Cloudflare's
    `contributingParticipants`, the frozen export's sha256 and its window. A
    day without a receipt has no recorded set.
  - Triggers: no UPDATE or TRUNCATE; DELETE of a set or contribution row only
    when the transaction sets `tibotattle.analytics_v2_offline_purge` to that
    row's owner; versions contiguous and each at a later revision; a member
    always has a contribution and a contribution its member, and a member's
    day a receipt (checked at commit). The receipt is immutable, verified (2)
    exactly when the counts agree, and names a frozen export and a window
    holding the day exactly for 2 and 3.
- **Fold** (`compute-community.ts`): a queued, unblocked day folds S(d) plus
  every computed owner with non-empty values on d. Computed owners fold
  exactly as before, in owner-digest order; a member this run did not compute,
  or a computed member whose read for d is empty (counted as
  `contributionRetainedEvidenceAbsent`), folds its current stored contribution
  in its digest position; a member excluded on d (N-EXCL) folds nothing and
  stays a member, on or off the roster: a member that left keeps its
  exclusions, mapped through its owner link in any state. A contribution the
  run's kernel cannot fold (its values schema or price identity is not
  current, so K-REPRICE must reprice it after cutover) blocks the day
  (`memberContributionUnavailableDays`), and so does a member off the roster
  with no owner link left, whose exclusions cannot be read
  (`memberLinkUnavailableDays`); either keeps the prior head: never a zero,
  never a dropped member, never a fold that skips an exclusion. With no saved
  set the fold is the computed-owners fold byte for byte.
- **First recording** (round 7, which replaces the design's archival
  reconstruction): every day's first recording writes its receipt. Inside the
  frozen Cloudflare window (C-IPR's export, verified exactly as the route
  verifies it, read only when such a day is queued) it records the
  participants at GCP's first publication, provenance 2 when their count
  equals Cloudflare's `contributingParticipants` for the day and 3 otherwise
  (including a day Cloudflare did not publish); outside it, 1. A day that
  already has a head published without a set (an older image, or heads that
  predate the migration) is adopted the first time a run queues it, at the
  head's own revision when its content is unchanged: provenance 4, listed in
  `bootstrapAdoptedDays`, never compared with Cloudflare's count. Members
  added to a recorded day take 1.
- **Reader** (`owner-sets.ts`, statement families `owner_sets.*`): each queued
  day's set with every member's current version, devices, values digest and
  owner-link participant (any link state), whether the day is recorded and
  whether it has a head; the window the receipts recorded. The values are
  loaded during compute a chunk at a time, only for the members a fold needs,
  each checked against its stored digest and charged to the output account
  (no fixed count). Refusals: a schema without the owner-set tables or the
  interim table, or a first recording inside the recorded window while the
  frozen row is absent (`ANALYTICS_V2_SOURCE_UNAVAILABLE`); an unverifiable
  frozen row, receipts naming two exports, a row that disagrees with them, or
  a member without its day's receipt (`ANALYTICS_V2_SOURCE_CONFLICT`).
- **Store** (`store-owner-sets.ts`, inside the one write transaction): a
  recorded day's stored set must be the one the fold read (every stored
  member named, a saved or retained member at its current version), and a
  candidate names its first recording exactly when the day has no receipt,
  and an adoption exactly when it had a head; else the whole run is refused
  with `ANALYTICS_V2_OWNER_SET_CHANGED` and nothing is written. New members
  and changed contributions are appended at the publication's revision; any
  other unchanged day, and a blocked day, records nothing.
- **Single publication helper**: `nextPublishedRevision` in
  `store-publication.ts` (the name REV-SEED's design gives it) decides every
  published revision, and the owner-set rows take their `first_revision` from
  the revision it assigned, so REV-SEED's floor reaches them through that one
  function.
- **Inventory**: `ANALYTICS_V2_OWNER_SCOPED_TABLES` in `contract.ts` lists
  every analytics_v2 table holding an owner, in purge order (contributions
  before sets). The online owner-retirement module is retired (SIMP-1), so
  this is the offline purge's (PURGE-1) inventory; a PG17 case compares it
  with the migrated catalog. The online-erasure absence gate
  (`scripts/online-erasure-absence.check.mjs`) fails when any production
  module under `src` or `cloud-run` names the offline-purge setting or
  deletes in a module that names a saved-set table, its contract key or this
  inventory, and pins the protected tables to the migration's triggers.
- **Kernel**: the owner-set rule is part of the orchestration method, so
  `ANALYTICS_V2_METHOD_VERSION` is `analytics-v2-method-v2` and
  `owner-sets.ts` joins the compute-closure roots. `kernel-registry.json`
  gains entry 3 (closure `d22c5c4a…` after the review fixes, first
  `a2db78fb…`; vendored manifest `b40d075f…`), pinned in the registry check,
  which now follows the method the code declares. Entry 3 was never
  registered in any database (the migration is staged), so it was re-derived
  in place. If another stream registers kernel 3 first, the integrator
  renumbers this one.
- Contract `analytics-v2-contract-v0.6`; the run row's `publication` and the
  Job receipt gain a content-free `ownerSets` summary (counts and days).

## Review fixes

Seven findings of the 2026-10-03 review were checked against the code. All
seven held; none was rejected. What changed for each:

1. **A departed member's exclusion (medium).** The run mapped exclusions for
   listed owners only, and compute refused any other key, so an excluded
   member that left the roster folded its stored contribution again whenever
   its day was re-queued; the comment "an unlinked participant is in no
   aggregate" no longer held. Now the reader joins each saved member's owner
   link in any state (`storage_v11_owner_links`: one immutable, unique digest
   per participant), the pipeline maps the active exclusions of every saved
   member off the roster through it, and compute accepts exclusion keys for
   saved members. A member off the roster with no link row left (its
   participant deleted outside the offline purge) cannot have its exclusions
   read, so its days are blocked (`memberLinkUnavailableDays`) instead of
   folded blind.
2. **Heads published before the migration (low).** A day with a head and no
   recorded set got no set while its content stayed the same, and a later
   departure re-folded it over the computed owners only. Now every first
   recording writes the day's receipt (provenance 1 to 4), a day with a head
   and no receipt is adopted the first time a run queues it (4: at the head's
   own revision when unchanged, no new revision; at its new revision when
   republished), and the store requires a first recording exactly when the
   day has no receipt and an adoption exactly when it had a head. A member's
   day must have its receipt (checked at commit). The cutover runbook (H.8)
   now requires `bootstrapAdoptedDays: []` in the production receipt line and
   states the ordering that guarantees it.
3. **No frozen export (low).** A first recording inside the frozen window
   became provenance 1 when the export was missing. Now 2 and 3 receipts keep
   the export's digest and window; with the row gone, a first publication
   inside that window refuses the run (`ANALYTICS_V2_SOURCE_UNAVAILABLE`); a
   missing interim table refuses too; receipts naming two exports, or a row
   that disagrees with them, conflict. H.8 step 3 now follows round 12 (the
   row is kept, inert), which the earlier text contradicted. Remaining: a
   first production run with no row and no receipt would still record 1; the
   H.4 gates (`CUTOVER_INTERIM_READ_NOT_LOADED`) prevent that state, and
   REV-SEED's per-day floor can make it a refusal at integration.
4. **Untested refusals (low).** Added cases for a tampered digest, a tampered
   payload and an evidence date the export's window does not end on
   (`ANALYTICS_V2_SOURCE_CONFLICT`); a first recording against a size-0
   receipt (`ANALYTICS_V2_OWNER_SET_CHANGED`); malformed owner-set reads
   (`ANALYTICS_V2_REFRESH_OWNER_SETS_INVALID`) and outputs without the
   owner-set summary (`ANALYTICS_V2_REFRESH_OUTPUTS_INVALID`).
5. **The 100,000-key load cap (low).** Removed, with its wrong code. Compute
   loads 1,000 keys at a time and charges each chunk to the output account
   before reading the next, so the output budget is the bound
   (`ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED`).
6. **No ratchet on the purge setting (low).** The online-erasure absence gate
   now scans every production module under `src` and `cloud-run` (checks,
   specs and type declarations excepted) and fails on the setting's name or
   on a SQL delete in a module that names a saved-set table, its key or the
   purge inventory; a check pins the protected tables to the migration's
   triggers. `contract.ts` no longer names the setting, and its claim that
   the service never deletes from the owner-scoped tables (it replaces a
   computed owner's derived rows) is corrected.
7. **Stale guidance (low).** H.8's "published revisions restart" is replaced
   with REV-SEED's wording (revisions continue above Cloudflare's floor), and
   the refresh reader's exclusion comment describes how saved members are
   folded and excluded.

## Evidence

The first commit's evidence is kept below; the review-fix commit's follows
it.

### First commit (`0b832030`)

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

### Review-fix commit

Same machine, cluster and limits as above, in database `eownerset_fix_7c41a2`
(created for this commit and dropped afterwards).

| Check | Result |
|---|---|
| Q-1 rehearsal, the same command (`--owner-reference`, `--staged-primary 0931_analytics_v2_owner_sets.sql`) | `status: pass`, every gate true. Served body sha256 `87cf3ad8…` (396,767 bytes) and stored preview `b3722cc9…`: identical to `c2726984` and to the first commit. First run: 168 days published, 672 members, 672 contributions, 168 receipts (`daysRecorded`), none adopted; second run: no new revision and no owner-set row |
| `analytics-v2:check` | 18 files, 202/202; `owner-sets.spec.ts` 15/15 (added: a departed member stays excluded and is not loaded; a member off the roster without a link blocks its day, a roster owner's does not; provenance 1, 2, 3 and 4; exclusion keys for saved members accepted and any other refused; 2,500 members load in three chunks and a 1 MiB output budget refuses before the third) |
| `postgres-test/analytics-v2-owner-sets.spec.mjs` | 7/7. Added: a member without its day's receipt refused at commit; the receipt's provenance and frozen-field checks; the reader's links (a withdrawn link still names its participant), receipts and heads; a first publication inside the recorded window refused while the frozen row is absent; a tampered digest, a tampered payload and a wrong evidence date refused; receipts naming another export or window refused; a missing interim table refused; 100,001 keys read without a cap; adoption of an unchanged head at its revision and of a changed one at its new revision, with three wrong first-recording claims refused atomically; a first recording against a size-0 receipt refused; new closed-validation cases |
| `postgres-test/analytics-v2-refresh.spec.mjs` | 54/54. The end-to-end owner-set case now also blocks a departed member without a link (`memberLinkUnavailableDays`) and folds it once linked. New: a member excluded and then withdrawn (link `withdrawn`, off the roster) stays out of the day, unchanged, also when every day is re-queued; revoking folds it back to the first content. New wiring case: the off-roster mapping, seven malformed owner-set reads and three outputs without the summary refused, and a pipeline without either reader refused |
| Mutation checks | With the pipeline's off-roster mapping removed, the excluded-then-withdrawn case fails. With the offline-purge setting and a saved-set key added to `store-derived.ts`, the online-erasure absence gate fails on both |
| Affected PG17 specs together (the twelve listed for the first commit) | 175/175 |
| Worker gates, serially, every step of `npm run check` except the Wrangler ones (`types:check`, `deploy:dry`, `staging:check`) | pass: `postgres:migrations:check`, `append-only:absence:check` (22, with the three new online-erasure cases), `postgres:source-transfer:check`, `postgres:accountless-retention-import:check`, `postgres:analytics-transfer:check`, `postgres:object-transfer:check`, `workspace-packages:check`, `deployment:endpoints:check`, `typecheck`, `scripts:check`, `gcp:origin-smoke:check`, `npm test` (182 files, 2,411/2,411), `test:node` (2/2), `vendor:kernels:check`, `v0x:admission:check`, `postgres:retired-readers:check`, `catalog:manifest:check`, `analytics-v2:check`, `gcp:fastpath:scripts-check` (the kernel-registry check 5/5 on the re-derived entry 3) and cloud-run `npm run check`; node:test across them 1,850 pass, 14 skipped (PostgreSQL-gated cases; these gates ran without the PostgreSQL variables), 0 failed |
| E12 (`edge-origin-e2e.spec.mjs`, Node 22.16.0 `--experimental-strip-types`, `EDGE_E2E_GOLDEN=analytics-v2-test/golden`) | 15/15, 395 s |
| Root `npm run architecture:check` | pass (960 production files, 4,108 imports, 0 debt edges) |
| Root `npm run test:preflight` | 21/21 |

The first refresh of the Q-1 rehearsal took 20.6 s (one sample, shared
machine).

## Not done, and open gates

- **Promotion**: the integrator assigns the primary number, regenerates
  `src/postgres-runtime-schema.ts` and moves the file; the specs and the
  rehearsal find it by its suffix.
- **REV-SEED** (parallel): its floor goes into `nextPublishedRevision`; no
  other change is needed here for `first_revision` to follow it. Both streams
  rewrite the same H.8 paragraph, in the same words for the revision
  sentence. Once the floor is merged, a first recording of a day the floor
  names could refuse when the frozen counts cannot be read, closing the
  first-run gap in review fix 3 independently of the H.4 gates.
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
- A departed member whose owner link row is gone blocks its days until the
  offline purge removes it; nothing republishes them meanwhile.
- Live, staging and production state were not read or changed.
