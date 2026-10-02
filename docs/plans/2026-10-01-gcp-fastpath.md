---
title: GCP fast path for the analytics-refresh rehearsal and cutover backlog
date: 2026-10-01
type: plan
status: in-progress
---

# GCP fast path

## Status and claim boundary

- This is an in-progress plan for the overnight build that started on
  2026-10-01 at about 03:30 UTC (23:30 EDT on 2026-09-30). Its architecture
  and backlog sections describe intended work. What the night delivered is in
  [Results on 2026-10-01](#results-on-2026-10-01), with the evidence in the
  [local rehearsal receipt](../receipts/2026-10-01-gcp-fastpath-local-rehearsal.md)
  and the [final-integration receipt](../receipts/2026-10-01-gcp-fastpath-final-integration.md).
- Tonight's deliverable is a local, synthetic, production-oracle parity
  rehearsal. It is not a GCP deploy, a production change or a cutover-readiness
  claim. Production cutover is estimated at 2 to 4 working days after tonight;
  that figure is an estimate, not a measurement.
- Nothing in this plan touches production (OD-9). Any write to the GCP test
  project needs the owner's explicit authorization in chat (OD-7).
- The plan depends on the
  [append-only contributions decision](../decisions/2026-09-26-append-only-contributions.md),
  which the owner approved in chat on 2026-09-30. Where this plan relies on
  it, the dependency is named.
- The [GCP source integration plan](./2026-09-24-gcp-source-integration.md)
  keeps its cutover gate board and checkpoints as dated evidence. With the
  decision accepted, this plan replaces that plan's analytics publication
  approach and its independent erasure-ledger approach on the GCP line.
- Work-item IDs such as IN-, EP-, PT-, OPS-, SIMP-, CR- and HX- refer to the GCP
  planning workspace (plan-v4) and to tonight's package list. Register IDs
  A01 to H07 and X01 to X05 refer to the 2026-09-28 analytics redesign plan on
  the Codex analytics line, which is not on this branch.
- [Alignment with the OpenAI September 29 release](#alignment-with-the-openai-september-29-release)
  maps that release's plan (the release owner's working copy in its Codex
  worktree and the copy committed on GitHub `main`) to this line. The line
  stays on `d43c8f92` parity until the release reaches Cloudflare production.

## Source lines

| Line | Commit | Role tonight |
|---|---|---|
| GCP integration (claude line) | `cfd7dc39` on `claude/gcp-parity-integration` | Canonical base (OD-1). `claude/gcp-fastpath-base` adds the 28 wave-1 branches |
| Production Worker (as recorded by the fast-path analysis) | `d43c8f92` | Source of the vendored analytics kernels and the Q-1 oracle. It is 48 commits not on GitHub `main` |
| Codex GCP line | `183dbf44` on `codex/gcp-next-image-integration` | Read-only reference. Not merged tonight (19 trial-merge conflicts) |

Recorded read-only by the fast-path analysis at the start of the night:

- On the merged tree (cfd7dc39 plus all 28 wave-1 branches): 0 textual
  conflicts, `tsc` exit 0, PostgreSQL 17 suite 166/166, Worker vitest 224/224
  plus 7/7.
- The origin refuses production. `isPostgresWorkerRequestPathSupported()` in
  `apps/worker/src/backend-composition.ts` returns `false`, and
  `apps/worker/cloud-run/server.mjs` refuses to start outside its test modes.
- The Cloud Run host serves 29 of the 51 route-registry paths. Nineteen
  application routes are unported, including the v1.1 upload family that
  shipped clients still use.
- The PostgreSQL schema already holds every source table analytics needs. The
  legacy effective reader still reports usage as unavailable.
- The GCP project holds test resources only. There are no production
  resources.

## Owner decisions and defaults

| ID | Choice | State |
|---|---|---|
| D1 to D6 | No withdrawals; Variant B offline erasure; incremental analytics before the cutover cadence; database scaling deferred; Cloudflare stays the edge and release host; simplify the GCP line | Owner decisions; the record was accepted on 2026-09-30 (OD-6) |
| OD-1 | The claude line is canonical; the Codex GCP line is a read-only reference | Default taken |
| OD-2 | The 2026-09-26 SIMP-0, SIMP-1 and SIMP-4 briefs supersede the 2026-09-27 ones. The integration lead is the only migration-numbering authority (0057 ISO-1, 0058 ISO-2, 0059 analytics_v2; later numbers assigned at landing) | Default taken; no SIMP code tonight |
| OD-3 | Production-parity eligibility: `community_public_source_owners` as production computes it. The gap from D1 is documented | Default taken |
| OD-4 | Owner-run, read-only production checks: the correction-runtime row; owner counts by source routing; owners whose 101-day window exceeds 120,000 usage rows | Owner action; Claude does not run production reads |
| OD-5 | Serve production's `community-allowance-breakdowns-v1.1` contract. Serving v1.2 after the OpenAI September 29 release is the open OD-OAI-3 ([alignment](#alignment-owner-decisions)) | Default taken |
| OD-6 | Approve the decision record text | Approved in chat on 2026-09-30 |
| OD-7 | The D-1 test-project deploy stretch, on new test-only resources only | Relayed to the final integration as owner-approved for the `tibotattle` test project, including seeding `tibotattle_fastpath`. D-1's tooling is merged and checked locally; nothing was deployed or seeded during the integration |
| OD-8 | Whether v0.1 and v0.2 intake retire at cutover | Open. v1.0 and v1.1 intake are required either way |
| OD-9 | Nothing touches production; ingestion-side D1 schema on Cloudflare stays frozen until the seal | In force |
| OD-10 | Optional read-only export of published (day, revision) pairs so GCP revisions continue above them | Open |
| OD-11 | Raise the GCP caps significantly and prove parity with production's native path for owners beyond them | Owner decision in chat on 2026-10-01; delivered on `claude/gcp-fp-caps` (see [Cap raise](#cap-raise-later-on-2026-10-01)) |
| OD-12 | Model dates: production withholds a 14-date block until every member has a result, or publish per date with refused owners counted | Owner decision in chat on 2026-10-01: per-date publication is accepted. Recorded as D7 in the [decision record](../decisions/2026-09-26-append-only-contributions.md#d7-model-dates-publish-per-date-with-refused-owners-counted); the parity compare accepts exactly the oracle's withheld dates (see [Dense-owner parity](#dense-owner-parity-later-on-2026-10-01)) |

## GCP-native analytics architecture

The target keeps every published output contract and every intake contract.

### Edge

- A thin Cloudflare Worker proxies to an IAM-private Cloud Run origin. EP-4 and
  EP-5 build it; neither is written yet.
- Hostnames are unchanged. Admin stays behind Cloudflare Access. Release and
  appcast hosting and download analytics stay on Cloudflare (the EP-3 split).
- The Worker attaches a Google ID token for the edge-invoker service account,
  and Cloud Run's front end verifies it. The EP-6 origin boundary accepts only
  the EP-0 `x-tibotattle-*` contract. Verifier service accounts may only
  `GET /api/health` and `/api/ready`.
- The edge sets `x-real-ip` to Cloudflare's Worker placeholder on its
  subrequests to Google. An owner-authorized probe on 2026-10-02, from a
  `workers.dev` Worker, found that no header carrying the visitor's address
  reached a Cloud Run service. The recommendation for OD-E6 is therefore to
  keep the direct `*.run.app` topology with that override, with no
  proxied-hostname rework. The owner-run rerun of the probe from the
  `tibotattle.com` zone passed on 2026-10-02
  ([decision record, section 5](../decisions/2026-10-01-thin-worker-edge-proxy.md#od-e6-recommendation-and-gate);
  [receipt](../receipts/2026-10-02-gcp-edge-ip-probe-production-zone.md)),
  so that gate is met.

### Origin

One Cloud Run service, generalized from the existing PostgreSQL test dispatch.
The production refusal stays in place until cutover. Two new seams:

1. **Route-module registry with an override list.** Module routes can replace
   the named built-ins `/api/v1/community/daily` and
   `/api/v1/upload-authorizations`. A module that claims any other built-in, or
   a path outside the route registry, fails at startup.
2. **Envelope-version handler registry** inside the PostgreSQL contributions
   handler. The shared preamble stays where it is: bearer auth,
   upload-authorization claim, transport floor and receipt (the tombstone
   check left with the deletion ledger, LEAD-SIMP).
   v1.2 is registered tonight. The v1.1, v1.0 and v0.1 handlers and the
   upload-authorization formats plug in as registry entries, not as new routes.

### Database

- One Cloud SQL PostgreSQL 17 instance (decision D4).
- The `primary` role holds everything, including the new analytics tables.
- There is no `ledger` role: LEAD-SIMP removed it, and the canonical runner
  refuses it (`POSTGRES_MIGRATION_ROLE_INVALID`). The frozen ledger migration
  files stay on disk, read by nothing, until owner action OA-4. There is no
  second instance.

### Analytics job

One Cloud Run Job, `analytics-refresh` (`dist/analytics-refresh.mjs` on the
same image), triggered by Cloud Scheduler. Each run:

1. Takes a `pg_try_advisory_lock`.
2. Reads accepted evidence directly from the existing typed source tables
   through a new occurrence adapter. The adapter is a PostgreSQL port of
   production's per-observed-day candidate SQL plus the vendored
   `reconcileGroups` and `genericOccurrence`. There is no separate
   canonical-fact store.
3. Lists owners and per-owner source routing with production's `hasEffective`
   rule, filtered by `community_public_source_owners`.
4. Runs the production kernels unchanged, vendored from `d43c8f92` together
   with that commit's `accounting`, `quota-analysis` and `telemetry-contract`
   packages, in one process:
   - `prepareSharedAnalyticsDay` per owner-day;
   - `evaluateSharedScalarDate` for today;
   - `evaluateSharedModelDate` for 70 dates, each over a 101-day window;
   - `evaluateSharedCacheDay` with the 7-day carry, for every day from the
     first evidence day (production builds every delivered day and its `all`
     window has no lower bound);
   - a cross-owner fold using the vendored `publicInputs`;
   - `buildCommunityDailyPayload`;
   - `selectCommunityAllowanceAnalysisFits` and the summarizers;
   - `buildCommunityModelCompositionDay` and
     `buildAdminCommunityAllowancePreview`.
5. Writes everything in one transaction to `analytics_v2_*` tables in the
   primary role: runs, owner-day, cache bands, owner fits, owner model dates,
   published daily, preview and the journal cursor.

The job follows these rules:

- Published days are the days named by `storage_ingestion_changes` events
  (queue semantics), plus existing heads.
- A conflict row blocks every day it appears on, and that day keeps its prior
  revision. On a fresh start the blocked day is absent and the refusal is
  recorded.
- A revision increases only when the payload digest changes.
- Dense or unrepresentable owners and non-effective sources become explicit,
  reasoned refusals tonight.

### Public read

`GET /api/v1/community/daily` is served by a route module that reproduces
production's `handleCommunityDaily`:

- only `from` and `to`, at most 366 days apart;
- `PUBLICATION_DISABLED` through the collection controls;
- the production `Cache-Control` values;
- `projectPublicAllowanceGraph` over the stored preview at request time;
- the four cache windows composed at read time with production's pooled and
  by-model `GROUP BY` over the cache bands.

The clock can be injected only in test mode.

### Modes

- Tonight runs full recompute only.
- The first optimization after measurement is a digest-keyed owner-day memo:
  one `jsonb` table keyed by owner, day, method version and input digest, with
  the digest computed in SQL, plus a dirty-owner cursor over
  `storage_ingestion_changes` and a nightly full sweep. Decision D3 requires it
  before the cutover cadence is set.

### Erasure

Variant B offline purge, with a do-not-restore digest list applied at import
(decision D2). The purge also deletes the owner's `analytics_v2` owner-level
rows and never retracts published rows. Opt-out, disconnect and expiry only
stop future uploads.

### Tonight's slice

Everything above except the edge, production mode, the v1.0 and v1.1 intake
ports, the dense-owner path and the memo. It is proven locally, end to end,
against a production-code oracle.

## Redesign register on GCP

The redesign register has 43 core rows (A01 to H07) and 5 conditional rows
(X01 to X05). On Cloud Run Jobs over Cloud SQL, with no withdrawals and no
online erasure, the rows that exist only for D1 and Worker limits or for
online withdrawal and erasure are dropped: A03, A04, C02, C06, C07, D03 (as
stored reuse), E02, E03, G03 and G05, plus the H01 and F03 fence machinery.
The rest become one job, one transaction and about eight tables.

| Row | Requirement (short) | GCP form |
|---|---|---|
| A01 | Closed admission and complete-source activation | Stays. v1.2 is live on GCP; v1.1, v1.0 and v0.1 arrive as envelope handlers (IN-2, IN-3) that invent no fields |
| A02 | Occurrence identity, reconciliation and corrections | Simpler. Recompute each owner from source rows with the vendored `reconcileGroups` and correction accumulator; persist no effects or provenance. Bucket by production's per-observed-day candidate selection; crossed-day conflicts block |
| A03 | Canonical facts and partition manifests | Unnecessary. The accepted PostgreSQL typed tables already are the append-only canonical store |
| A04 | Compute units independent of protocol and owner | Unnecessary. The owner stays the compute unit and the deduplication and quota scope |
| A05 | Contributor and device membership | Trivial. A PostgreSQL port of the three-branch contributing-device count, with the clock pinned |
| B01 | One normalized input per occurrence | `prepareSharedAnalyticsDay` once per owner-day per run; the scalar re-pricing path is unchanged |
| B02 | Durable shared day features | Deferred. After measurement, one `owner_day_features` table (owner digest, day, method version, input digest, features); no parts, leases or compare-and-swap. No memo tonight |
| B03 | Fair preparation of recent and historical days | A cold full run; no fairness lanes |
| B04 | Price-independent quantities and selective repricing | A price or method change bumps the method version and triggers a full rerun |
| B05 | Early activity and API contributions | Owner-day values merged with the vendored `publicInputs` (lexical top-200 cells, so merge order cannot change the result) |
| C01 | Source-owned mutation metadata | Later: a per-owner-day input digest computed in SQL with the reader's predicate, a journal cursor and a nightly full sweep. None tonight |
| C02 | Durable dependency summaries | Unnecessary |
| C03 | Selective invalidation | Later: the digest comparison yields the dirty owner-days |
| C04 | Reverse links from corrections | Conservative: any correction or cross-day link marks the whole owner dirty. A 2026-09-29 receipt found zero live correction facts |
| C05 | Empty-range, runtime, policy and clock dependencies | A UTC-rollover run with the pinned clock |
| C06 | Consumers use maintained validation | Unnecessary |
| C07 | Capability fallback, metadata retirement and erasure | Unnecessary |
| D01 | Ordered quota and priced usage features | The vendored `d43c8f92` kernels, unchanged |
| D02 | Resumable model-date batches | An in-memory loop over 70 dates with 101-day windows; no model-block store, no analytics migrations 0030 and 0031, no checkpoints |
| D03 | Rolling-window reuse | Covered by the in-memory loop; nothing stored |
| D04 | Statistical finishers | Unchanged: whole-window refusals, joint NNLS, medians and percentiles. Windows and days beyond the shared reducers' bounds take production's native path in memory (OD-11); an owner over the job's memory budget is an explicit `memory_budget` refusal |
| D05 | Adoption into publication | Everything is written in the run's single transaction |
| E01 | Cache preparation and the 7-day carry | `evaluateSharedCacheDay` with the exact carry, recomputed in full |
| E02 | Session-neighbor index | Unnecessary: recomputing days d to d+7 is exact by construction |
| E03 | Reversible pair contributions | Unnecessary |
| E04 | Community cache counters and windows | Per-owner band rows (owner, day, model, effort, band, 7 counters); the four today-inclusive windows are composed at read time; no rollover trigger |
| F01 | Idempotent replacement | One transaction upserts every output, advances the cursor and inserts the run row, so a retry cannot double count |
| F02 | Completion at an accepted watermark | A published day is a journal-named day whose eligible owners are all prepared or explicitly refused; a conflicted day keeps its prior revision |
| F03 | Permission to publish | No withdrawal or erasure fences (decision D1); only the `PUBLICATION_DISABLED` serving gate |
| F04 | Output contracts and last-good continuity | Identical contracts: `community-daily-read-v1.0`, `community-daily-aggregate-v1.0`, allowance breakdowns v1.1 (OD-5), `community-cache-retention-v1.0`, admin preview v0.3. Last-good continuity comes from MVCC |
| G01 | Idempotent work keys and leases | `pg_try_advisory_lock` plus idempotent upserts |
| G02 | Dirty-work index and repair sweeps | A journal cursor plus a nightly full run |
| G03 | Fair lanes and capacity reserves | Unnecessary |
| G04 | Parallel execution | Single-threaded tonight. Later, worker threads per vCPU, then Cloud Run task sharding by owner hash, each only if measured |
| G05 | Statement metering and deadlines | Replaced by the job's timeout and memory limit |
| G06 | Retirement and cleanup | Upsert in place, so there are no versions to retire |
| H01 | Erasure and deletion-safe restore | The Variant B purge deletes the owner's `analytics_v2` owner rows and leaves published rows unchanged; disclose that a later recompute drops the owner |
| H02 | Admin visibility | One `analytics_v2_runs` row per run (counts, refusals by reason, durations) feeds the admin panel later |
| H03 | Instrumentation | Run timings only |
| H04 | Correctness qualification | The Q-1 oracle golden plus the Q-2 parity compare |
| H05 | One frozen candidate and review | One frozen image |
| H06 | Migration rehearsal and isolated qualification | A test-project rehearsal |
| H07 | Production cutover | An owner-authorized cutover |
| X01 | Object fact store and catalog | Not needed: GCS holds only exports and backups |
| X02 | Ordinary CPU or container workers | Adopted: Cloud Run Jobs |
| X03 | Replica acquisition | Not needed: scaling is deferred (D4) |
| X04 | Physical source sharding | Not needed: scaling is deferred (D4) |
| X05 | Solver and index optimization | Deferred. It is the lever if dense-owner model dates dominate the cold build |

## Analytics history is recomputed, not imported

- Every community output derives from ingestion evidence plus policy. The
  analytics D1 is derived state. GCP recomputes daily, allowance, model and
  cache history from the transferred evidence; the analytics D1 is not
  imported. No runtime reads R2 object contents.
- **Recomputed past values may differ from the values Cloudflare published.**
  Causes include late evidence, stale per-owner fits that production served
  (`inputs_current=0`), method versions, Cloudflare-era withdrawals and
  erasures, and the eligibility semantics chosen under OA-2. The owner either
  accepts and discloses the differences or requires a frozen published
  snapshot for pre-seal dates.
- Published revisions restart unless OD-10 is approved, so
  `community-daily:<day>:r<rev>` aggregate IDs change at cutover. The site
  renders totals and is unaffected; an external consumer keyed on aggregate IDs
  would see new IDs.
- Recompute removes the analytics D1 import and history proof (HX-1, HX-2,
  HX-3, HX-5, HX-6), the GB-2 to GB-8 and AN-2 to AN-8 ports, OJ-6's analytics
  verification, the analytics half of PT-5b, EP-8's analytics-drain
  precondition and the `analytics_runtime_sources` no-go. AN-10 and AN-11
  survive only as canonicalizer inputs. HX-4 stays as the dense-path oracle
  tool.
- Public reads need an interim answer between the flip and the first GCP
  publication: a frozen `community_daily` served from the frozen Cloudflare
  data or from a frozen export, with its evidence date labelled.
- A production cold recompute is estimated at 1 to 3 hours on 8 vCPU. It has
  not been measured on real data. A nightly full run is viable; sub-hour
  freshness needs the memo.

## Tonight's scope

| Package | Delivers | Base | Lands |
|---|---|---|---|
| INT-0 | `claude/gcp-fastpath-base`: the 28 wave-1 merges, 19 registered PostgreSQL specs, ISO renumbered to 0057 and 0058, the retired-readers allowlist fix, staged 0047 to 0058 and ledger 0007 promoted with a regenerated runtime schema, the analytics-v2 contract, plan-v5 numbering and vitest excludes | `cfd7dc39` | H+1:00 |
| A-0 | Vendored `d43c8f92` kernel closure and its three packages, with a blob-digest manifest check and an export-only patch for five module-private functions | `cfd7dc39` (new paths) | H+2:00 |
| Q-1 | Production-oracle golden: `d43c8f92` Worker code under the Workers test pool over a four-owner synthetic corpus, with D1 seeded directly and the publishers called directly | `d43c8f92` | H+4:30 (go or fallback decision at H+2:30) |
| DOC-1L | This plan and the decision record | `cfd7dc39` | H+2:00, after OD-6 |
| A-1 | PostgreSQL occurrence adapter, owner routing, device counts and queued days; read-only | fastpath-base | H+4:30 |
| A-2 | Single-threaded compute core for effective owners; dense and non-effective owners become refusals | fastpath-base | H+5:00 |
| A-3 | Staged analytics_v2 migration 0059 and the full-mode `analytics-refresh` job: advisory lock, one transaction, idempotent | fastpath-base | H+5:00 |
| A-4 | `community/daily` route module over analytics_v2 with an injected test clock | fastpath-base plus the IN-1 seam | H+4:00 |
| T-1 | Minimal identity and authority copy into the rehearsal schema | fastpath-base | H+5:30 |
| T-2 | v1.2 importer into a `typed_legacy_transfer_rehearsal_target_` schema | fastpath-base | H+5:30 |
| IN-1 | Route-module override seam, contribution envelope registry, upload-authorization format registry and a loopback-only fastpath test origin mode | fastpath-base | Seam at H+1:30; lands at H+5:00 |
| Q-2 | Integration lead: land packages, promote 0059, add build entries, run the rehearsal and parity compare, freeze and write the receipt | fastpath-base, producing `claude/gcp-fastpath` | Freeze at H+6:30; receipt at H+8:00 |
| IN-2, IN-3 | v1.1 intake family; v1.0 and v0.1 envelopes plus upload-authorization formats | Branch-only, outside the freeze | Status notes at H+8:00 |
| D-1 | Stretch: deploy the frozen candidate to new test-only resources | Only with OD-7 | Not before H+6:30 |

Out of scope tonight:

- any production write: Cloud SQL, service, secrets, D1 export or seal, writer
  fence, edge mode switch or DNS;
- merging IN-2 or IN-3 before the freeze;
- EP-4 and EP-5, EP-10, EP-12, the PT-2 seal, the PT-3 full identity importer,
  the PT-4 v0.x importer, the PT-7 copy, the PT-8 orchestrator, the
  deletion-digest projection and the production plan render;
- the dense-owner path, the memo, a worker pool and lifting capacity ceilings;
- porting the v1-only, mixed and v0.2 graph paths (recorded as refusals unless
  OD-4 shows such owners exist);
- admin, export, security-reset, performance and Apple route ports; switching
  the allowance contract to v1.2; syncing GitHub `main` into the GCP line;
  merging the Codex GCP line;
- SIMP-0 amendments, SIMP-1 deletions and SIMP-4 code removal.

### Gates

Done means: the branch `claude/gcp-fastpath` is frozen at H+6:30, and one
command runs the rehearsal:

```sh
PG_TEST_SOCKET=<local PostgreSQL 17 socket> PG_TEST_PORT=<port> \
  node apps/worker/scripts/gcp-fastpath-rehearsal.mjs \
  --golden apps/worker/analytics-v2-test/golden \
  --per-date-expected apps/worker/analytics-v2-test/golden-q1-node/per-date-expected.json
```

(`npm run gcp:fastpath:rehearsal` in `apps/worker` runs the same. The
per-date expectation was added on 2026-10-02: under OD-12 the rehearsal
accepts the fast path's publication of the oracle's withheld model dates
only with exactly the values the oracle's per-date expectation holds, and
fails without it.)

The command:

1. creates a fresh `typed_legacy_transfer_rehearsal_target_fastpath_<random>`
   schema and applies every promoted migration, including 0059;
2. loads the Q-1 D1 dump through T-1, the existing typed-legacy,
   usage-correction and ingestion-journal importers, and T-2;
3. runs `dist/analytics-refresh.mjs --mode=full` under Node 22.16.0, the image
   runtime line, with the golden's pinned time;
4. serves `GET /api/v1/community/daily` through the in-process fastpath origin;
5. diffs the response against the `d43c8f92` golden after normalizing
   revision, release time and aggregate ID.

It passes when every in-scope owner (effective and not dense) shows zero
unexpected diffs, every refusal is listed by reason, and a second run produces
zero new revisions.

The same frozen tree must also pass:

- `tsc`;
- the full `postgres:domain:check`, including the 19 newly registered specs and
  the new analytics-v2 specs;
- the default Worker vitest run, with no regressions against `cfd7dc39`;
- OPS-6's migration-numbering and CI PostgreSQL suite checks;
- the retired-readers check and the vendor manifest check;
- the Cloud Run build, including the `analytics-refresh` entry;
- `npm run architecture:check` and `npm run test:preflight`, or each failure
  is recorded as a named gap with its cause.

A dated receipt, planned as
`docs/receipts/2026-10-01-gcp-fastpath-local-rehearsal.md`, names the commit,
commands, counts and remaining gates. It must keep local synthetic evidence
separate from GCP and production evidence.

Tonight's parity claim covers effective, non-dense owners on synthetic data
only. It excludes dense owners (the largest real owner, about 2.52 million
records, always takes the dense path), v0.2-only and mixed owners, and
disconnected or contained owners.

### Schedule

| Time | Milestone |
|---|---|
| H+0:00 | OD-1, OD-2, OD-3 and OD-5 defaults. INT-0, A-0, Q-1 and DOC-1L start |
| H+1:00 | `claude/gcp-fastpath-base` published with gates green. A-1 to A-4, T-1, T-2 and IN-1 start |
| H+1:30 | IN-1 seam-interface commit; A-4 merges it |
| H+2:00 | A-0 lands. DOC-1L lands only after owner approval (OD-6) |
| H+2:30 | Q-1 go or fallback decision; corpus and dump published. IN-2 and IN-3 start branch-only. The owner reports the OD-4 checks |
| H+4:00 to H+5:30 | A-4, then A-1, then A-2, A-3 and IN-1, then T-1 and T-2 land. The lead promotes 0059, regenerates the runtime schema and adds the build and image entries |
| H+6:00 | First full local rehearsal and parity compare |
| H+6:30 | Code freeze; fix-forward only, each fix with a test. D-1 decision (OD-7) |
| H+7:00 | Full gates; D-1 in parallel only if authorized |
| H+8:00 | Receipt, IN-2 and IN-3 status notes and the next-day backlog |

## Results on 2026-10-01

Local and synthetic only: one macOS arm64 workstation, a local PostgreSQL 17
cluster and the Q-1 oracle's four-owner corpus. Nothing was pushed, deployed
or seeded on GCP or Cloudflare, and no production data was read.

- **Delivered.** `claude/gcp-fastpath` (frozen at `8d2cb423`) lands A-0 to
  A-4, IN-1, T-1, T-2, the Q-1 golden and the 0059 promotion.
  `claude/gcp-fastpath-final` adds this record and the accepted decision
  (DOC-1L), the D-1 deploy and seed tooling, the D-1 hand-offs and the cache
  history horizon. It then merged the IN-2 and IN-3 intake composition
  (`claude/gcp-fastpath-intake`, primary 0060 and 0061) and added primary
  0062, which pins 0011's active-participant trigger to its schema. That
  evidence is local only and is recorded in the final-integration receipt.
- **The one-command rehearsal** ran as the Gates section expects, with one
  exception: it exits 1 because model-days differ. (Later that day the
  compare accepts exactly the oracle's withheld dates under OD-12 and the
  rehearsal exits 0; see
  [Dense-owner parity](#dense-owner-parity-later-on-2026-10-01).) Every importer completes
  (owner roster 4/4, public source owners and owner revisions equal to D1);
  analytics-refresh publishes 168 days with 2026-04-17 and 2026-04-18 blocked
  (owner (a)'s crossed-day conflict) and 15 refusals listed by reason; the
  fastpath-test origin serves `community/daily` with 200; a second run
  creates no revision.
- **Parity with the d43c8f92 oracle.** Equal: every daily payload (168 days),
  the allowance breakdowns, the preview apart from its model days, and the
  cache-retention structure. Different: 14 model dates
  (2026-07-24 to 2026-08-06) that the oracle withholds as a block and the fast
  path publishes per date with the refused owner counted
  (`refusedParticipantCount`). Cache counts are informational by the oracle's
  parity basis. The final integration reproduced the frozen tree's served
  response and preview byte for byte.
- **Cache history.** The fast path now keeps cache bands from the first
  evidence day, as production does; the earlier today-162 default is gone.
  The 70 model dates, the 101-day windows and the 366-day read range stay:
  they are production method and contract constants.
- **Open owner decisions.** Port production's block-and-withhold model-day
  rule or accept and disclose per-date publication. (Decided later that day:
  per-date publication is accepted, OD-12.)
- **Not yet attempted.** A Docker build of the image, the D-1 test-project
  deploy and seed, the edge, production volumes, dense owners, the native
  dense fallback and the memo. (The dense path followed later that day; see
  below.)

### Cap raise, later on 2026-10-01

Local and synthetic only, on `claude/gcp-fp-caps`; the evidence and gates are
in the [cap-raise receipt](../receipts/2026-10-01-gcp-fastpath-caps.md).

- The d43c8f92 shared reducers' 20,000-occurrence and 32 MiB day bounds, the
  120,000-row and 1,024-page window bounds, the optional quota and usage day
  preparation bounds and the quota fold refusal no longer refuse an owner.
  `src/analytics-v2/native-path.ts` computes those days and windows the way
  production's `advanceStorageEffectiveAnalysis` and daily lane do, from the
  same exported kernel steps; the vendored files are unchanged.
- A per-owner memory budget replaces them as the job's real limit. Each
  effective owner's exact evidence counts are read first; an owner whose
  deterministic estimate exceeds the budget is refused as a whole
  (`memory_budget`) and never read. The job reads and computes one owner at a
  time, so the heap holds the largest owner, not the corpus.
- Defaults fit an 8 GiB Cloud Run task with a 6,144 MiB heap (budget
  4,608 MiB, day backstop 250,000 occurrences and 256 MiB); each value can be
  raised by Job environment within its bounds.
- Parity: for six synthetic dense shapes, one beyond each bound, the scalar
  fit and model compositions equal d43c8f92's `advanceStorageEffectiveAnalysis`
  over the same occurrences; a dense day's daily values equal production's
  one-record fold. The Q-1 rehearsal's served bytes are unchanged.

### Dense-owner parity, later on 2026-10-01

Local and synthetic only, on `claude/gcp-fastpath-dense` (the cap raise and
the dense production-code golden merged); the evidence, measurements and
gates are in the
[dense-owner parity receipt](../receipts/2026-10-01-gcp-dense-owner-parity.md).

- Per-date model publication (OD-12) is recorded as decision D7. The parity
  compare accepts exactly the oracle's withheld dates, and only their
  publication; every shared date stays byte-equal. The Q-1 rehearsal exits 0.
- The dense golden's corpus went through the importer chain and the raised
  caps. Every family equals production: the 168 published days, the
  allowance breakdowns and preview against the per-date expectation, and per
  owner the fits, all 70 model dates, every owner-day's daily values and
  cache bands, and the refusals. The dense owner's fits and model results
  equal production's native path exactly, with no refusal.
- The read was quadratic in owner size (45 of the dense run's 54 minutes).
  The v1.2 expansion now probes the owner's manifests per batch, with
  byte-identical occurrences; the dense refresh takes about 11 minutes, with a
  peak resident set of at most 2.5 GiB.
- Sizing: the dense corpus fits the standard Job (2 vCPU, 8 GiB). The
  largest real owner needs the new `dense` profile (4 vCPU, 16 GiB, heap
  12,288 MiB, budget 10,752 MiB, 4 h). The seed and test deploy select the
  dense corpus and profile with `--corpus=dense`; only a dry run was made.
- Review fixes (2026-10-02; the receipt's
  [Review fixes](../receipts/2026-10-01-gcp-dense-owner-parity.md#review-fixes-2026-10-02)).
  The parity compare holds the values on accepted model dates to the
  per-date expectation and fails closed without it. The preview is withheld
  while any effective owner lacks a current fit, as production's preview
  publication requires, and a model date on which every member was refused
  is published with all of them counted (D7 amended; the owner accepted both
  on 2026-10-02). The day backstop now applies before the evidence digest. The
  owner-parity compare fails closed on fits references, and a PostgreSQL case
  pins the v1.2 expansion's exclusions. Disclosed, not fixed: the reader
  variant bound divergence in every family, the memory estimate's growth with
  retained history, the fixed heap reserve for held outputs, the snapshot's
  xmin hold and the absence of a time guard.
- C-REFRESH (2026-10-02; [receipt](../receipts/2026-10-02-gcp-c-refresh.md))
  closed three of those: history before the analysis horizon loads in 60-day
  segments (memory model v2), held outputs are charged to an output account
  against the heap the run leaves (reclaiming the per-owner budget its
  largest admitted owner does not need), and a time guard refuses before the
  task timeout. It also added the production and staging target contract,
  which the OPS-2 render is pinned to. The reader variant bound divergence
  and the xmin hold remain disclosed; MEAS-3 recalibrates the models.

## Cutover backlog

Sizes are relative effort labels from the 2026-10-01 transfer and cutover
analysis: S, M, L and XL. They are estimates, not measurements. Each item
still needs its own qualification.

| Item | Size | Delivers | Blocks |
|---|---|---|---|
| IN-2: v1.1 intake family | L | Consent, day-manifests, domain-predecessor and domain-activate routes plus the `telemetry-envelope-v1.1` handler, matching `d43c8f92` statuses, bodies, idempotent replay and successor negotiation | The flip: shipped clients route v1.1 consent to the v1.1 uploader |
| IN-3: v1.0 and v0.1 envelopes | M | The v1.0 handler; the v0.1 handler or the documented retired-format refusal (OD-8); upload-authorization formats for v1.0 and v1.1 | The flip: shipped clients route v1.0 consent to the v1 uploader |
| Admin, export, performance and Apple routes | Decision S (owner); each port M; XL if all are ported | The six admin routes (AR-1, AA-1) must work at the switch (OD-CR-2). C-ADMIN ported them as unregistered modules ([receipt](../receipts/2026-10-02-gcp-c-admin.md)); the overview answers 503 until three of its blocks have sources, and the console cannot act while it does, so D-CRB registers the family only after the owner answers the receipt's open questions. `me/export` (PP-1) is retired. Decide the rest per route from observed traffic: `me/security-reset` (PP-2), performance telemetry (PF-1, PF-2), Apple start, callback and result (A1) | The flip, for every route that is kept |
| CR-7: production host composition | XL | Production route registry and Worker-order handler, the `isPostgresWorkerRequestPathSupported` flip, EP-6 dispatch wired into the host. Fast-path re-scope with CR-6, RD-2 (`/api/ready`, gap F8) and RD-3 (`/api/health`): one production host mode composing only the ported families behind EP-6, unported routes answering 503 `POSTGRES_ROUTE_NOT_PORTED`, and Worker-shaped health and readiness without the deletion ledger. Required by OPS-10's expand-and-contract roll: the host's migration receipt fence must admit a history that extends its image's manifest only by reviewed expand-compatible migrations (its manifest as an exact prefix, each later migration in OPS-10's `CONTRACT_MIGRATIONS` or classified expand-only). Today's only fence (`readSchemaReceipt` in `cloud-run/postgres-test-dispatch.mjs`) requires an exact match, so behind it the previous revision answers its storage-gated routes 503 from migrate until the roll; if CR-7 keeps that fence, the OPS-10 runbook must treat migrate-to-roll as a write outage and keep it short. Not started; it follows the SIMP residue and the owner's per-route decisions (OD-E4, OD-8) | Any gcp-mode flip and any production-shaped smoke test |
| EP-4 and EP-5: edge proxy | L | EP-4 classification, Access check, admission, forwarding, failure mapping and distribution merge; EP-5 worker, fenced and gcp modes with the release-guard nonce D1. Built as E4 and E5 on `claude/gcp-fp-edge` and proven locally end to end by E12 ([edge receipt](../receipts/2026-10-01-gcp-edge-proxy-local.md)); not yet cherry-picked to an edge-port line (OD-E1). The 2026-09-26 device-sync admission patches are withdrawn: production does not run them | The thin proxy and the flip |
| EP-10 and a rollback-clean window | M each | Typed edge-mode deploy and verify, or an owner-run overlay deploy; an origin flag that refuses authority-plane writes for an initial window, plus an EP-9 matrix change, if the owner wants gcp-to-worker rollback. E10 builds the typed edge-mode deploy, reconcile and endpoint checks (dry runs only) | Fence and flip execution; a data-safe rollback |
| PT-2-lite: seal plus deletion digests | M | Fenced export of the ingestion and ledger D1s, `node:sqlite` rebuild, integrity check, per-table counts against remote aggregates, bare-name migration ledgers and digests; the content-free deletion-digest projection as the do-not-restore list. Built locally on a synthetic seal by W2-SEAL and integrated on `claude/gcp-fp-w2-integration` ([receipt](../receipts/2026-10-02-gcp-wave2-integration.md)): `assertNoSealedParticipantDeletionMatches` hashes every sealed participant whatever its state and refuses a match with `CUTOVER_ERASED_PARTICIPANT_PRESENT`; verify-fence refuses an EP-8 receipt without a 40-hex production commit; the default Wrangler transport removes its configs on every path. The provider has never been contacted, so the real export shapes are unverified. The read-only pre-fence quiescence check is `apps/worker/scripts/cutover-quiescence-check.mjs` ([receipt](../receipts/2026-10-02-gcp-e-quiesce.md)): it imports PT-3's participant predicate and the projections module's tombstone intersection, reads exported or sealed D1 files or saved read-only Wrangler output, and reports counts and opaque references only | The cutover window, estimated at 1.2 to 3.2 hours of authenticated-route outage |
| PT-3 identity and authority importer, with PT-5a's v1.2 mapping | L | Credential and rotation hashes, owner links, the identity-link pin, consents and grants, accountless state and collection controls, with production target modes built on PT-1. Built locally by W2-SEAL; its enrollment-grant migration is promoted as primary 0063 (`0063_enrollment_grants_erased_redeemer.sql`, PT-3's 0075), and OPS-10 reviews it as a contract migration. Before any write it refuses a sealed participant that is not `active` or still carries a deletion fence (`CUTOVER_PARTICIPANT_ERASURE_PENDING`), and it enforces the do-not-restore rule (decision D2) itself: it reads the same seal's deletion-ledger digests in memory and refuses any sealed participant whose deletion digest is among them (`CUTOVER_ERASED_PARTICIPANT_PRESENT`, through `assertNoSealedParticipantDeletionMatches`), whether or not PT-8-lite composes it; its receipt records the digest count and the projection's sha256. Replaying a completed stage writes no application row. Identity cooldowns and retention markers are excluded. PT-1 still needs its interim ledger pool until the SIMP residue lands | Import, and device authentication after the flip |
| PT-4: v0.x importer | M | v0.x contributions and admission windows, or an owner decision to retire v0.x backed by traffic evidence. Waits for OD-8; if kept, it follows PT-3's production-mode stage pattern | Completeness of raw evidence |
| PT-8-lite: orchestrator | L | One disposition per sealed table keyed on the live ledger; the deletion-digest exclusion count (through `assertNoSealedParticipantDeletionMatches`); the identity-pin fingerprint check; a history-digest and manifest-digest parity sample between D1 and PostgreSQL. It composes PT-3, whose quiescence and do-not-restore refusals cover participants (PT-8-lite still reports the exclusion count; PT-3's receipt carries the projection sha256 it can match), and owns pending erasure jobs, erased links and the excluded and target-missing dispositions. Follows PT-4 or OD-8, PT-5a's production target modes and the SIMP residue | The go/no-go, and avoiding a fleet-wide re-upload storm |
| Dense-owner path | M (remaining, estimate) | Delivered in memory on `claude/gcp-fp-caps` (OD-11) and proven equal to production's native path through the importer chain and the real readers on the dense golden (`claude/gcp-fastpath-dense`). Remaining: the cloud measurement with the `dense` refresh profile (4 vCPU, 16 GiB) and a recalibration of the memory model, output model and time rates on the Cloud SQL seed (MEAS-3); the T-2 importer's quadratic reader verification before the seal. Bounded history, the output account, the time guard and the v1/v1.1 expansion at legacy-owner volume were done locally in C-REFRESH | Cutover: the largest real owner always takes this path |
| Non-effective sources | Depends on OD-4 | v1-only, mixed and v0.2 graph paths, needed only if the production check finds such owners | A parity claim for those owners |
| Memo mode | M (estimate) | The digest-keyed owner-day memo, the dirty-owner cursor and the nightly full sweep, measured on real data | The cutover cadence (decision D3) |
| OPS-2 to OPS-5, with OPS-10 | L | Built locally as dry runs on `claude/gcp-fp-w2-integration` ([receipt](../receipts/2026-10-02-gcp-wave2-integration.md)); nothing was built, migrated, rolled or applied in any project. OPS-2 renders, reads back, plans and applies (create and update only, under `--authorize=<planDigest>`) one Cloud SQL PostgreSQL 17 instance with no ledger instance, the service and its IAM, the secrets, the bucket birth with its proof, the runtime's conditional `tibotattleQuarantineStore` bucket grant, the `production-migrate` job and the analytics-refresh job in the production refresh-job contract (dense profile until MEAS-3; C-INFRA, [receipt](../receipts/2026-10-02-gcp-c-infra.md)). The desired state is committed (`apps/worker/cloud-run/infra/`): staging in the shared test project, production with OWN-5 placeholders. Apply creates the trigger and pauses it before granting the scheduler the job, never resumes it, and `gcp-infra.mjs scheduler-probe` signals a resumed trigger paused for 6 h or more. The verifier account carries the operator's token-creator grant once the owner names the operator. OPS-10 is the primary-only production migration job (`dist/production-migrations.mjs`, whose `PRODUCTION_MIGRATION_JOB` OPS-2 imports) and the rollout CLI (preflight, build, migrate, roll), which reads its target from OPS-2's `rolloutTarget(environment)` and its readback from `gcp-infra.mjs readback --require-clean`. Its expand-and-contract review (`CONTRACT_MIGRATIONS`) covers the SQL a serving previous revision issues, not that revision's receipt fence: with today's exact-history fence every migrate, 0063 included, refuses the previous revision's storage-gated routes (503) until the roll, so `secondsSinceMigrate` is a write-outage window until CR-7 provides a fence that admits a reviewed expand-only extension (CR-7 row). One runtime-grant policy (`cloud-run/postgres-runtime-grants.mjs`) serves the test migrations, OPS-10 and `scripts/gcp-test-database.mjs`. OPS-2's readback has never parsed real `gcloud` output. Still to do: OPS-3 pause-all and resume-all, OPS-4 probes after the SIMP residue, OPS-5 monitoring after CR-6 and CR-7 | Production origin deploy and operation |
| SIMP-0, SIMP-1 and SIMP-4 code | M | Landed locally on `claude/gcp-fp-c-simp` (C-SIMP, 2026-10-02; [receipt](../receipts/2026-10-02-gcp-c-simp.md)) and reaches the final line through `claude/gcp-fp-c-simp-recon`, which reconciles it with C-ADMIN, C-MAINT and C-REFRESH (C-SIMP-RECON, [receipt](../receipts/2026-10-02-gcp-c-simp-recon.md)). C-SIMP merges LEAD-SIMP's `claude/gcp-fp-w3-simp` with the owner's answers: the forward primary migration `0064_append_only_residue.sql` (name and number final, OD-1) is reviewed into OPS-10's `CONTRACT_MIGRATIONS`; the five online-erasure modules, the ledger authority and every tombstone call site, the ledger jobs and transfer, the PT-1 ledger stages, CR-1 FC-11 and the ledger pool are gone; the quarantine bucket's birth proof is re-admitted as `GCS_QUARANTINE_BUCKET_HISTORY_PROOF` in CR-3, EP-7 and OPS-2 (OD-2); maintenance reports the erasure items as constant true, marked not applicable, with no ledger key (OD-4); the A2 deployed-test tooling and the root GCP journey are retired, with no cloud resource deleted (OD-6, OA-4 later). The Variant B offline purge (PURGE-1) deletes the participant's objects first, then the participant. The `accountless-retention` stage (OD-3) and the analytics-history transfer scripts (OD-5) stay | OPS-10 no longer refuses `PRODUCTION_SIMP_RESIDUE_MISSING` for an image built from this line. CR-6, CR-7, RD-2, RD-3, OPS-4 and PT-8-lite follow it |
| R2-to-GCS copy (PT-7, reduced) | M | A post-flip copy from the frozen R2 bucket using the sealed reference set; pending quarantine objects empty or mapped at import | Decommissioning R2, not the flip |
| Production resources | S to M of owner time | One Cloud SQL PostgreSQL 17 instance (estimate: 2 to 4 vCPU, 8 to 16 GB, 50 GB or more SSD, point-in-time recovery, zonal); a private GCS bucket; runtime, migrator, scheduler, builder, edge-invoker and verifier service accounts; Artifact Registry; Secret Manager populated from the owner's custody. The identity-link secret must match the sealed pin and the envelope keys must be identical. OPS-2 produces the plan and its digest for the owner to apply; a disabled managed account or a custom role not at GA blocks apply. A rollout needs a verifier account the operator can impersonate | Every production step. Owner-run |
| OPS-9: privacy and disclosure | S | Privacy page, `SECURITY.md`, scoped guidance and the supersession notes on accepted decisions, in the cutover commit only | The flip |
| Interim public read | M | A frozen `community_daily` until the first GCP publication, with the evidence date labelled | Public continuity after the flip |
| Measured timings | S | D1 export duration and size, PostgreSQL import rows per second, recompute throughput | Sizing the maintenance window |

Next-day order: IN-2 and IN-3 landed before wave 2. Wave 2 (W2-INFRA,
W2-OPSDB and W2-SEAL) landed locally on `claude/gcp-fp-w2-integration`, with
primary 0063 promoted. Next: the SIMP residue (SIMP-0 items 1 to 6, SIMP-1
and SIMP-4); then CR-6 and CR-7 with RD-2 and RD-3, PT-5a's production target
modes and PT-8-lite. The dense path and the memo continue in their own
workstream. Merge order: `claude/gcp-fp-w2-integration` must not reach `main`
before the dense workstream moves its two analytics-v2 primary-chain pins
to 63 and `0063_enrollment_grants_erased_redeemer.sql`, or the two land
together; otherwise the PostgreSQL 17 suite fails 11 tests. On 2026-10-02
both landed together on `claude/gcp-fastpath-final`, which moved the pins in
the wave-2 merge. Owner-gated:
pinning the production line before the edge port (OD-E1) and any re-vendor;
OD-8 for PT-4; production resources.

### Minimum cutover sequence

1. Pre-stage an IAM-private, migrated, empty origin.
2. Fence with EP-8 and the production barrier build, then verify a 15-minute
   quiet window.
3. Seal the ingestion and ledger D1s.
4. Import and verify.
5. Smoke-test through the verifier service account.
6. Flip the edge to gcp mode.
7. Observe.
8. Start the analytics cold build.

Step 6 also needs a recorded pass of the edge IP probe from the
`tibotattle.com` zone (OD-E6). The owner recorded that pass on 2026-10-02
([receipt](../receipts/2026-10-02-gcp-edge-ip-probe-production-zone.md)).

Before the flip, rollback is redeploying the production Worker and running the
EP-8 release. After the flip, gcp-to-fenced is the brake. Gcp-to-worker is
allowed only inside an authority-write-free window, and only if the owner
approves that policy.

## Alignment with the OpenAI September 29 release

This section is a plan written on 2026-10-01 from source inspection and revised
the same day after review. No code on this line changes for the release yet. No
test exercised the release vocabulary, and nothing ran against GCP, Cloudflare or
production.

### Source documents

| Copy | Location and state | Identity |
|---|---|---|
| Release owner's working copy | `/Users/adamallcock/.codex/worktrees/bdc9/app-usagemonitor/docs/plans/2026-09-29-openai-release-update-plan.md`, read only. Untracked in a Codex worktree whose `HEAD` is `30c0feb0`. Front matter `status: in-progress`; last modified 2026-09-29 | 596 lines; SHA-256 `fde291926240989d202ec95da6e82a7fa22fd03e8e0c23b49c3197629fe98f66` |
| Committed copy | `docs/plans/2026-09-29-openai-release-update-plan.md` on GitHub `main` at `f0067d0f`, unchanged at `396204d3` (the local `origin/main` ref as last fetched). Not on this branch | 711 lines; SHA-256 `83ff24cb8464ccf0f5c85293fa57b68465ed805b7202d84e71fc3922141582a5` |

- The two copies differ only in the scope sentence (working-copy lines 14-15)
  and in three sections the committed copy inserts before working-copy line 30:
  the client PR boundary, client merge qualification and main Worker follow-up.
  Those sections record PR history and do not change the mapping, so the
  mapping covers both copies. Release-plan line numbers below are working-copy
  numbers; from line 30 on, the committed copy's numbers are 115 higher.
- Re-check trigger: OAI-2 recomputes both SHA-256 values. If either differs from
  the values above, the changed sections are re-mapped before any OAI item at P
  starts. The working copy belongs to the release owner's agent and is never
  edited from this line.

### Where the release stands

- GitHub `main` `f0067d0f` holds the client work (PR #257, merged as
  `e5250c86`) and the Worker publications for Pro 10x and Pro Max 25x
  (PR #258, implemented in `27967a9a` and merged as `f0067d0f`). The ten later
  commits up to `396204d3` change neither the release plan nor any vendored or
  intake source. Draft PR #223 (Pro Max 50x) is still open; #258's 25x policy
  replaces its product assumption.
- Cloudflare production still runs `d43c8f92`. It and `main` diverge at
  `960f75ab`: `main` lacks 48 production commits, production lacks 63 `main`
  commits, and no branch contains both.
- Counted by Git blob over the 132 vendored files, the release itself
  (`30c0feb0` to `f0067d0f`, PRs #257 and #258) changes 26: 8 Worker modules,
  2 web modules and 16 package files. It also changes `validation.ts`, the
  source of one of the three vendored type stubs, and adds
  `packages/quota-analysis/src/included-allowance-speed.js`, which the package
  rule would vendor. Another 28 vendored files differ from `main` only through
  the divergence. They include the three package `package.json` version bumps,
  which `main` made before the release; counted from the merge base `960f75ab`,
  the figure is 29. Twelve of the 28 do not exist on `main`: the shared
  analytics features, input and reducers, `storage-analytics-shared-features.ts`,
  the effective quota-day and usage-day modules and their storage,
  `typed-v11-chunk-completeness.ts`, `cache-retention-events.ts`,
  `storage-community-daily-pending.ts` and `analytics-model-block-contract.ts`.
  Vendoring `main` would therefore drop production code that the fast path
  runs.

### Alignment policy

1. The GCP line follows Cloudflare production, not GitHub `main`. Until the
   release is deployed to Cloudflare, the line stays on `d43c8f92` parity, and
   no part of the release is adopted piecemeal.
2. When the release is deployed, its production commit, called P here, is the
   only source. P must descend from `d43c8f92`, or the owner names the
   production changes it drops (OAI-2).
3. In one branch from the current GCP head, the alignment then:
   - re-vendors the kernels and the three packages from P with the generator
     (OAI-3);
   - moves this line's own workspace packages and its intake-side Worker
     modules to P's bytes (OAI-4);
   - ports the GCP-specific deltas listed below;
   - re-runs the Q-1 oracle on an extended corpus and the dense oracle, both
     at P (OAI-6, OAI-7);
   - passes the alignment gates (OAI-8).
4. Intake and kernels move together. All four intake versions validate through
   this line's own `@app-usagemonitor/telemetry-contract`, while
   `analytics-refresh` runs the vendored copy. If intake admitted `promax` while
   the kernels were still `d43c8f92`'s, Pro Max evidence would reach closed plan
   sets that lack it. Those sets are at `quota-analysis-v11.ts:80,206,428` and
   `quota-analysis-v1.ts:1007,1028` under
   `vendor/analytics-d43c8f92/apps/worker/src/`. The quota readers skip such
   rows (`:428`, `:1028`), and the usage-feature validator rejects them
   (`:206`). What follows for the owner's day has not been tested; this rule
   avoids depending on it.
5. Readers before writers. GCP intake reads what clients write. At `d43c8f92`
   parity it refuses any v1.0, v1.1 or v1.2 chunk that carries a `promax` plan
   (`packages/telemetry-contract/src/telemetry-v1.2.js:140,202`,
   `telemetry-v1.1.js:99,145`, `apps/worker/src/telemetry-v1.ts:122,253`), as
   Cloudflare production does today. The GCP origin must therefore run P's
   intake (OAI-4) before it serves any public client release that sends
   `promax` (OD-OAI-1). Inside the line, the kernels read what intake admits,
   which is why item 4 moves them together. Old clients keep working: OAI-4
   checks that old vocabulary is still admitted.
6. Membership of a published day never changes for the release. Republication
   follows the append-only decision (D1): see OAI-5 and OD-OAI-4.
7. At the seal, the vendored source commit equals the Cloudflare production
   commit. Whether the release can instead ship on GCP after a cutover at
   `d43c8f92` parity is OD-OAI-1. Serving the release's public contract is
   OD-OAI-3, because OD-5 names v1.1.

### Mapping of the release plan

Dispositions:

- **Inherits:** the re-vendor or the full recompute carries the item with no
  GCP-owned change.
- **GCP change:** an OAI item below.
- **Conditional:** needed only if an unported route family is ported.
- **Not applicable:** local client, Electron, website or release tooling.
- **Superseded:** replaced by the fast path.

Paths are on this branch unless marked `main`.

#### Accepted decisions

| Release item | GCP disposition | Evidence |
|---|---|---|
| 1. Separate money and allowance | Inherits for analytics: server pricing v0.6 and the new accounting cards arrive with the re-vendor. No hosted consumer applies the allowance speed weights. GCP change: every published day's spend block becomes stale, and older days regain current spend only through OAI-5 under OD-OAI-4. v0.1 intake prices with this line's own server pricing and stores the result (OAI-4) | `main` `apps/worker/src/server-pricing.ts:23`, `packages/accounting/src/price-registry.js:13`, `apps/worker/src/community-daily-spend.ts:8-9`; `apps/worker/src/server-pricing.ts:18`, `apps/worker/src/postgres-legacy-contribution-admission.ts:2023,2041-2062` |
| 2. Ultrafast as a third speed | GCP change for v0.1 intake, whose closed speed and tier lists gain `ultrafast` in the package (OAI-4). v1.0, v1.1 and v1.2 already accept bounded strings. PostgreSQL stores speed and tier as text or dictionary values, so no migration is needed. Analytics inherits. The performance enums are Conditional (OAI-10) | `main` `packages/telemetry-contract/src/telemetry-v0.1.js:201,208`; `apps/worker/postgres/migrations/primary/0011_retained_telemetry.sql:80-81,109-116`, `0025_typed_v12_normalized.sql:5-8`, `0030_legacy_typed_telemetry.sql:265-267` |
| 3. Keep Pro's identity and change the ratios | GCP change, in one branch: `promax` joins `TELEMETRY_PLAN_TYPES`, which every intake version checks (OAI-4), and the kernels' plan roster (OAI-3). Raw fits and history inherit: each full run refits every owner from source, and there is no era split to port. The fit method itself is unchanged, but the vendored fit-cache identity includes `SERVER_PRICING_METHOD_VERSION` and `APP_PRICE_REGISTRY_MANIFEST.sha256`, which the release changes, so fitted dollar capacities are repriced under v0.6 and v0.9. They are not renormalized: normalization applies at projection. No migration is needed, because plan types are text or dictionary values | `main` `packages/telemetry-contract/src/constants.js:29`, `apps/worker/src/community-allowance.ts:223`; `packages/telemetry-contract/src/telemetry-v1.2.js:140,202`, `telemetry-v1.1.js:99,145`; `apps/worker/src/telemetry-v1.ts:122,253`, `telemetry-validation.ts:3,55-63`; `vendor/analytics-d43c8f92/apps/worker/src/community-allowance.ts:114,121` |
| 4. Version the normalization, the public contract and the caches | Inherits once OD-OAI-3 allows it. The route serves whatever the vendored `projectPublicAllowanceGraph` emits, so it moves to `community-allowance-breakdowns-v1.2` and preview v0.4 with the re-vendor. Each run recomputes fits, model dates and the preview from source, and the route reads only the preview, the published days and the cache bands, whose method the release leaves unchanged. Nothing resumes under the old unit. A preview written by the old kernel fails the new validator and reads as `temporarily_unavailable` until the next run. The `analytics_v2` rows carry no kernel stamp; that matters only for a future re-vendor that changes a retained-row method (OAI-11). GCP changes: the route spec pins the v1.1 shape (OAI-3), and daily heads need OAI-5 | `apps/worker/src/analytics-v2/community-daily-route.ts:65-67,325-338`, `contract.ts:59-68`; `main` `apps/worker/src/public-allowance-breakdowns.ts:10-11`, `admin-community-allowance.ts:36-37,267-270` |
| 5. Exclude dots only on billing evidence | Not applicable now: the release has no hosted change and no wire field for dots. A future closed eligibility field would arrive through the same re-vendor and package sync. A new wire field would also need intake changes, and possibly PostgreSQL columns, at that time | Release plan, decision 5 |

#### Source inventory

| Release rows | GCP disposition |
|---|---|
| Model identity, pricing and local accounting: `price-registry.js`, `cost-ledger.js`, `local-api-pricing.js`, `model-catalog.js` (identity and the reasoning-effort mapping), `subscription-speed.js` and the accounting `index.d.ts` | Inherits through the vendored packages (OAI-3). The same bytes reach intake through OAI-4 |
| The table's other rows: export registries, tier normalization, parsers and collectors, speed baseline, companion usage model, replay-safe cache, primary allowance basis, calibration and mining, sensitivity and side-chat estimates, window breakdowns and reports | Not applicable: local client |
| Persistence: unified-index and export reparse, parser and checkpoint versions, inference timing and model-performance reports, generators | Not applicable: local client and tooling. The vendor copies package source, not generated mirrors |
| Persistence: `telemetry-v0.1.js`, package types and the v0.x schemas | GCP change: v0.1 intake (OAI-4) |
| Persistence: client v1 chunks and the v1.1 and v1.2 schemas | The client part is not applicable. The v1.1 schema change and the v1.2 validators reach intake through OAI-4. The release leaves the v1.2 field dictionary version unchanged; `0025_typed_v12_normalized.sql:14` pins it, so changing it would need a migration |
| Persistence: performance contribution, `telemetry-performance-v1*.js` and its types | Conditional: the performance routes are unported (PF-1, PF-2). If they are ported, OAI-10 applies |
| Retained R7 evidence goes stale when accounting sources change (lines 370-371) | GCP change in evidence only. R7 is already stale on this line: in this worktree at `b87dc931`, `test/r7-generated-release-evidence.test.js` fails both its tests on the `workloadCodeSha256` invariant. The receipts were last regenerated in `46784e94` (2026-09-22), and three later commits on this line changed workload sources, including `c88c0a9cd`. OAI-4 changes the R7 workload sources (`src/r7-release-evidence-schema.js:122-166`) again. The protected regeneration is not routine validation and is not part of any OAI item; OAI-8 runs root `npm test` and records these two failures as expected |
| Client, public website, admin and agent displays (13 rows) | Not applicable: the website and the admin UI stay on Cloudflare. Two constraints remain. The website reader must accept v1.2 before the origin emits it; `main` `apps/web/public/community-data.js:359-361` already accepts v1.0, v1.1 and v1.2. `community-data.js` is also vendored for the parity tests and inherits. Admin preview v0.4 matters only once the admin routes are ported |
| Optional quota windows and desktop behavior; the dots source boundary; the observed live public surface | Not applicable |

#### Hosted plans, estimates, storage and publication

| Release row | GCP disposition |
|---|---|
| Plan registry, provider-name ledger and drift check | The registry is OAI-3 and OAI-4. The ledger and drift check are root tooling: not applicable |
| Frozen `pro-20x` and `pro-10x-promo` variants; `community-snapshots.ts` | The v0.1 variants arrive with OAI-4 and keep their meaning. `community-snapshots.ts` serves only the v0.2 graph path, which the fast path refuses: not applicable unless that path is ported |
| `telemetry-v1.ts` and the closed plan enum of v1.1 and v1.2 | GCP change: OAI-4 for intake, with OAI-3 for the kernels. No migration |
| `admin-model-history.js` roster freeze | Inherits in the vendored package. The admin model-history route is Conditional on the admin route ports |
| `server-pricing.ts` and the `quota-analysis-v1.ts` pricing casts | Inherits for analytics (OAI-3). The intake copy is OAI-4 |
| Synthetic route types in `validation.ts` and `repository.ts` | Not applicable: the synthetic-preview path exists only in the Worker's `index.ts` and is not registered in the GCP envelope registry. The `validation.ts` type stub is regenerated with the re-vendor (OAI-3) |
| Typed codecs and typed migration 0001 | Inherits: these are dictionary values. The PostgreSQL `typed_telemetry_dictionary` accepts any value of 1 to 64 characters |
| `plan-attribution.js` and `model-composition.js` | Inherits; the release does not change them |
| `community-allowance.ts` fit, cache and normalization rows; scalar and composition calculations in `admin-community-allowance.ts` | Inherits (OAI-3) |
| The same-plan era refusal in `quota-analysis-v11.ts` | Inherits; the release does not change it |
| The four-plan v1.2 result in `public-allowance-breakdowns.ts` | Inherits under OD-OAI-3. The GCP route spec and the website-first order are GCP-owned (OAI-3, OAI-11) |
| `community-daily-spend.ts` and the daily readers | GCP change: OAI-5, spend fields only, under OD-OAI-4 |
| Graph, model-history and daily cache and checkpoint invalidation | Inherits for fits, model dates and the preview: the full recompute keeps no checkpoints. Daily heads need OAI-5 |
| Price-drift backfill and the 70-day allowance bound in `community-daily-aggregates.ts` | The typed-storage read never serves a daily allowance block (`community-daily-route.ts:383-386`), so only spend applies. Production republishes every stale head with no day bound; OAI-5 ports only the spend condition, and only with membership fixed |
| The 25 pp floor and the fit and publication thresholds; the shared pricer's missing `surface` | Inherits: these are kernel constants. Dots eligibility is not applicable yet |

#### Release order, recomputation and rollback

Working-copy lines 505-518.

| Release rule | GCP disposition |
|---|---|
| Prepare server readers before new client writers | Policy item 5. GCP intake reaches P (OAI-4) before the GCP origin serves a client release that sends `promax`; OD-OAI-1 records the dependency |
| Compatible web readers before a new public schema | OAI-11: the website reader that accepts v1.2 is live before the origin serves it |
| Define how old clients consume or decline newer data | Inherits: the origin serves P's public contract, so an old reader sees what production serves at P. OAI-4 checks that old vocabulary is still admitted |
| Estimate the queued recomputation scope; bounded resumable jobs; generation fencing | `analytics-refresh` is one full run under an advisory lock, with forward-only revisions (`0059_analytics_v2.sql:149-165`). It is not resumable. Before OAI-5 runs on any non-synthetic database, it records the number of stale heads and the owner-day reads they need; if one run cannot hold them, OAI-5 splits by day range |
| Additive source repair; explicit correction of misclassified tiers | Not applicable to GCP storage: source repair is client-side. Stored v0.1 rows keep the server pricing they were admitted with, labelled by its stored method version (OAI-4) |
| No blanket destructive rebuild; no relabeling of published history | OAI-5 never relabels. It adds a revision only when membership is provably unchanged, and otherwise leaves the head. The forward-only trigger forbids rewriting a revision |
| Rollback preserves newer data and freezes incompatible publication instead of running an older writer | OAI-11: rollback is a freeze. The previous image's `analytics-refresh` never runs over post-upgrade state |

#### GCP surfaces the release plan does not name

| Surface | GCP disposition |
|---|---|
| Thin edge | The release (`30c0feb0` to `f0067d0f`) changes neither `apps/worker/src/index.ts` nor `ingress-budget.ts`, the two production modules the edge entry imports; the edge files themselves exist only on this line. The edge deploys only from a branch that contains the live `DEPLOYMENT_SOURCE_COMMIT` ([edge decision §3](../decisions/2026-10-01-thin-worker-edge-proxy.md#3-edge-source-line)). Once P is live, the OD-E1 edge-port branch is cut from P instead of `d43c8f92`, and EP-0 to EP-3, EP-9, E4, E5 and the release-guard migration are re-ported blob-identical under OD-E1 and OD-E2. OD-E5's re-derivation of `EDGE_PRE_ADMISSION_GUARDS` applies only if `git diff d43c8f92 P -- apps/worker/src/index.ts` changes an admission call site. The edge-origin contract blob must be unchanged at P. OAI-8 checks both |
| D1-to-PostgreSQL transfer and rehearsal | `apps/worker/scripts/postgres-cutover-rehearsal.mjs:10-15` and `production-typed-schema.mjs:44-51` build the D1 source model from this line's D1 migration directories, which hold this line's isolation 0013 and 0014. If production applies `main`'s `0013_performance_ultrafast.sql`, production D1 no longer matches that model. OAI-9 rebuilds the model from P's applied D1 migrations. The seeded rehearsal checks that `promax`, `ultrafast` and `gpt-6.1-sol` transfer as text or dictionary values. `postgres-v12-transfer.mjs:358` pins the v1.2 field dictionary `telemetry-v1.2-registry-2026-09-20.1`, which the release leaves unchanged |
| GCP-only copies of kernel vocabulary | A re-vendor does not move them: the refusal reasons (`contract.ts` `ANALYTICS_V2_REFUSAL_REASONS` and the `0059_analytics_v2.sql:62-71` check), the cache band IDs (`0059_analytics_v2.sql:86-90`, `cache-windows-sql.ts`) and counters (`ANALYTICS_V2_CACHE_BAND_COUNTERS`), `ANALYTICS_V2_MODEL_DATES = 70` (`compute.ts:179`) and the route's `community-daily-read-v1.0` (`community-daily-route.ts:84`). OAI-3 checks each against P. A changed check set needs a PostgreSQL migration, which is an exception to OAI-4's no-migration expectation. The release changes none of the reducers or cache-retention files, so none of these moves now |
| Legacy built-in daily reader | `apps/worker/src/postgres-community-daily.ts:145` accepts only normalization `pro_x1_prolite_x4_plus_x20`, which the release changes. Outside `fastpath-test` it still serves the origin's `/api/v1/community/daily` (`cloud-run/server.mjs:610-616,757-770`). It must not be the mounted route at cutover; the analytics-v2 route replaces it |
| Kernel identity of retained rows | `analytics_v2` rows carry no kernel commit or method stamp. Cache bands of owners a run does not recompute are retained (`store.ts:751-774`, the owner-scoped block of `writeRunOutputs`) and read without a method filter (`cache-windows-sql.ts:92-99`). A re-vendor that changed the cache-retention method would serve old-kernel rows under the new label. This release changes no cache-retention file, so it is not reached now; OAI-11 settles a run kernel stamp before the first re-vendor that changes a retained-row method |

#### Superseded: the release plan's GCP section

The release plan's "Separate GCP / PostgreSQL candidate" section (working-copy
lines 475-490) reviews checkpoint `6bb1b5c3` on the Codex line
`codex/gcp-cutover-integration-20260924`. This line descends from that Codex
cutover history up to `1470f041`, which is `6bb1b5c3`'s parent and its merge
base with this line; `6bb1b5c3` is one later checkpoint commit (graph publisher
batching). Of the four modules the section lists,
`postgres-community-allowance-fits.ts` and `postgres-community-graph.ts` are
byte-identical here, and the daily publisher and the stream publisher differ.
For serving, the fast path supersedes each consumer:

- `postgres-community-daily-publisher.ts`, by the vendored daily payload and
  spend kernels in `analytics-refresh`;
- `postgres-community-allowance-fits.ts`, by `analytics_v2_owner_fits` and the
  vendored fit selection;
- `postgres-community-graph.ts` and
  `postgres-community-graph-stream-publisher.ts`, by the vendored model-date and
  composition kernels, with no checkpoints;
- the daily-publisher, roundtrip, graph-cohort and allowance-fit PostgreSQL
  tests, by the Q-1 and dense oracles at P.

The four modules remain on this line for benchmarks and diagnostics only. They
retire with the legacy daily publisher (see
[Discarded or deferred](#discarded-or-deferred)). That section's rule to keep
GCP work separate from the Cloudflare rollout still stands.

#### Validation matrix

| Release row | GCP disposition |
|---|---|
| Prices; unsupported combinations | Production's package and kernel tests, plus the kernel-parity specs the generator copies from P (OAI-3). OAI-6 adds Sol 6.1 Standard and Fast, Astra Ultrafast, and Sol 6.1 Ultrafast to the Q-1 corpus; Sol 6.1 Ultrafast must stay unpriced |
| Speed evidence; money versus allowance; dots; displays; desktop windows | Not applicable: local parsing, client-side weighting and display surfaces |
| Conservation and history | OAI-6 checks server values at P. OAI-5 republishes a stale head at most once, never changes its membership, and creates no revision on a second run |
| Plans | OAI-4 tests intake on PostgreSQL 17. OAI-6 adds a Pro Max owner and checks that an empty Pro Max cohort publishes no estimate |
| Fits and publication | OAI-6 and OAI-7; the thresholds are kernel constants |
| Transport and storage | OAI-4 round trips for v0.1, v1.0, v1.1 and v1.2 on PostgreSQL 17. No migration is expected; one is needed only if P changes the v1.2 field dictionary version or a GCP-only vocabulary copy |
| Performance | Conditional (OAI-10) |
| Operations | Production's bounded D1 backfills have no GCP counterpart: `analytics-refresh` is one full run, and OAI-5 records its scope first. The release plan's "real PostgreSQL tests for its candidate lane" become OAI-6 to OAI-8. Website and API consistency after a deploy remains a separate gate |

#### Implementation phases

| Phase | GCP disposition |
|---|---|
| 0. Reconcile the base | OAI-2: identify P, recheck both release-plan copies, then branch from the current GCP head |
| 1. Shared vocabulary and prices | OAI-3 and OAI-4 |
| 2. Semantic contracts | Adopted from P once OD-OAI-3 is decided; OD-5 names v1.1 until then |
| 3. Local pipeline and storage | Not applicable |
| 4. Hosted pipeline and public contract | OAI-3 to OAI-7. The phase's "PostgreSQL parity separately if in scope" gate becomes OAI-6 to OAI-8 |
| 5. All display surfaces | Not applicable. The website reader ships before the origin emits v1.2 (OAI-11) |
| 6. Dots qualification | Not applicable until a closed contract exists |
| 7. Release preparation | OAI-8, OAI-9 and OAI-11. Cloudflare release gates stay separate from GCP gates |

### Deltas outside the release plan

- **Untouched daily heads and the append-only decision.** Production
  republishes every head whose authority fields, containment epoch, spend
  `pricingMethodVersion` or `registrySha256`, device method or correction state
  is stale
  (`vendor/analytics-d43c8f92/apps/worker/src/storage-community-daily.ts:376-387`).
  `analytics-refresh` republishes only the days named by the journal and the
  days a previous run left blocked (`analyticsRefreshPublicationDays`,
  `apps/worker/cloud-run/analytics-refresh.mjs:502-509`). Its header
  (`analytics-refresh.mjs:25-31`) records why: untouched heads are never
  recomputed, so a roster change is not applied to published history (D1).
  A recompute always uses the run's current roster: `analytics-v2/owners.ts`
  requires an active participant, an active device and an active owner link,
  and the retained accountless scope keeps
  only `user_opt_out` revocations. Republishing every stale head would
  therefore drop disconnected, reset or contained owners from every republished
  day, which D1 forbids. The release changes both spend fields, so the
  question arises for every published day at once. The route drops a spend
  block that is not current (`community-daily-route.ts:371-386`), so after a
  re-vendor, older days serve no API-equivalent value (an explicit absence,
  never zero) until OAI-5 reprices them. At `d43c8f92` every head is current.
  OAI-5 ports only the spend condition, and only with membership fixed
  (OD-OAI-4). It does not port the authority, collection, containment,
  device-method or correction-state conditions: D1 and D5 remove containment
  epochs and controls-driven rebuilds, and `analytics_v2_published_daily` has no
  authority column (`contract.ts:98-100`). OAI-3 records whether P changes the
  daily device method or the correction state, because GCP would not follow.
- **Price registry version name.** `main` `f0067d0f` names the registry with the
  OpenAI cards `app-official-api-prices-v0.9`
  (`packages/accounting/src/price-registry.js:13`; this line and `d43c8f92` are
  at v0.8). The unmerged `claude/anthropic-price-review-0928` (`df1b7ff8`, not an
  ancestor of `f0067d0f`) uses the same name for different bytes: the withdrawn
  Sonnet 5 rise corrected, and new Claude Batch and Fast cards. If that branch
  merged under v0.9, or were folded into P without a new name, one version name
  would identify two registries. The Anthropic correction needs the next
  version (v0.10) or a distinct one inside P. GCP tests read P's exported
  `APP_PRICE_REGISTRY_VERSION`, `APP_PRICE_REGISTRY_MANIFEST.sha256` and
  `SERVER_PRICING_METHOD_VERSION` instead of pinning literals (OAI-4, OAI-6).
- **D1 migration number 0013.** `main` adds
  `ingestion-isolation-migrations/0013_performance_ultrafast.sql`. This line
  holds the unapplied `0013_v12_quarantine_admission.sql` and
  `0014_accountless_history_transfer_v12.sql`, pinned by
  `apps/worker/scripts/ingestion-isolation-sequence.check.mjs:33-35` and
  `apps/worker/src/telemetry-runtime-activation.ts:102-105`. Whichever file
  reaches production D1 first keeps 0013. This line already renumbered these
  files once, in `a0fc9e39` on 2026-09-26 (OAI-9, OD-OAI-2).
- **GCP-only package change.** This line's
  `packages/quota-analysis/src/quota-tracks.js` and `quota-calibration.js`
  differ from production (`c88c0a9cd`, a cumulative-cost cursor). OAI-4 keeps
  the change unless P supersedes it.
- **Line-pinned export patches.** The generator's five `export` patches name
  `d43c8f92` line numbers (`apps/worker/scripts/vendor-analytics-kernels.mjs:58`)
  and refuse moved text. OAI-3 rebases them onto P.
- **Q-1 corpus coverage.** The golden corpus holds only `pro`, `prolite` and
  `plus` owners and `standard` speed, so today's oracle exercises neither Fast
  nor the release's new plan, model and tier (OAI-6).

### Alignment backlog

Acceptance tests and owned files for each item are in plan-v5 under
`openAiReleaseAlignment`. The sizes are estimates.

| Item | Size | Delivers | Order |
|---|---|---|---|
| OAI-1 | S | This section, the plan-v5 entry and the coordination note for the release owner | Done in this change |
| OAI-2 | S | Identify P: check its ancestry from `d43c8f92` and that it carries #258, recompute both release-plan SHA-256 values, and record P in plan-v5 | First at P |
| OAI-3 | M | Re-vendor from P: generator constants and export patches, the new vendor directory and its importers, and the route spec's served contract. Audit every hand port against `git diff d43c8f92 P` for the production source it cites, including `storage-community-graph-publication.ts` and the dense native path's sources. Check every GCP-only vocabulary copy against P | At P, in one branch with OAI-4, after the dense branch lands and OD-OAI-3 is decided |
| OAI-4 | M | Move the workspace packages and intake-side Worker modules (`server-pricing.ts` at least) to P's bytes, keep the GCP-only package change, refresh the Worker package copies, audit every intake hand port against `git diff d43c8f92 P`, and add PostgreSQL 17 intake specs that read P's exported constants | At P, in the same branch as OAI-3 |
| OAI-5 | M | Reprice older days' spend without changing membership: the spend condition only; republish a stale head only over the owner set it was published with, and otherwise leave it | After OD-OAI-4 and the dense branch; before P |
| OAI-6 | L | Extend the Q-1 corpus (Pro Max owner, Sol 6.1, Fast and Ultrafast on subscription and API tiers) and regenerate the golden at P | After OAI-3 and OAI-4 |
| OAI-7 | M | Re-run the dense oracle at P | After the dense branch lands and OAI-3 |
| OAI-8 | M | Run the alignment gates at P and write a dated receipt | Last at P. Before the seal when P reaches Cloudflare before cutover |
| OAI-9 | S | Settle the 0013 conflict (renumber this line's unapplied D1 files after production's tail, or retire them, per OD-OAI-2) and rebuild the transfer and rehearsal D1 model from P's applied D1 migrations | Before either file 0013 reaches production D1 |
| OAI-10 | M | Port the performance schema in its post-`0013` shape: `ultrafast` in both closed checks, the 2026-09-29 dictionary pin, both cohort dictionary triggers and the grant-contract match. The pre-`0013` shape is never ported | Only if PF-1 and PF-2 are kept |
| OAI-11 | S | Kernel-upgrade order and freeze rollback (below), and a decision on a run kernel stamp | Before the first upgrade after cutover |

OAI-11 order for each kernel upgrade after cutover:

1. The website reader that accepts the new public contract is live.
2. Pause the refresh scheduler, so no run of the old Job image can start.
3. Point the Job at the new image and complete one run.
4. Roll out the service with the new image. It serves the new contract and
   admits the new vocabulary.
5. Resume the scheduler.

Between steps 3 and 4 the old service reads new-kernel state. A preview written
by the new kernel fails the old validator and reads as
`temporarily_unavailable`, and every day whose spend block the new run wrote
under new constants is served without spend. Both windows close at step 4.
Rollback is a freeze: pause the Job and its scheduler, keep serving the last
revisions, and roll forward with a fix. The previous image's `analytics-refresh`
never runs over post-upgrade state; it would republish every head under the old
constants and meet vocabulary its kernels do not know.

### Alignment gates

- At P:
  - OAI-2's ancestry check and the release-plan re-check;
  - the vendor manifest check against P;
  - the kernel-parity specs copied from P;
  - the one-command rehearsal against a golden regenerated at P on the
    extended corpus, with zero unexpected diffs, every refusal listed by
    reason and no new revision on a second run;
  - the dense oracle at P;
  - `tsc`, the full `postgres:domain:check`, the default Worker vitest run
    and the Cloud Run build;
  - root `npm test`, with the two `test/r7-generated-release-evidence.test.js`
    failures recorded as expected and the protected R7 regeneration not run;
  - the edge checks: no admission call-site change in `index.ts` (OD-E5) and
    an unchanged edge-origin contract blob;
  - the transfer rehearsal against P's D1 model (OAI-9);
  - `npm run architecture:check` and `npm run test:preflight`.
- Intake: the OAI-4 PostgreSQL 17 specs pass, old vocabulary is still
  admitted, and an unknown plan is still refused.
- History: after OAI-5's spend-only republication, an owner disconnected after
  a day was published still contributes to that day, and every payload field
  except the spend block and the revision fields equals the prior revision.
- Order:
  - intake and kernels land on the line in the same merge;
  - GCP intake runs P's bytes before the GCP origin serves a client release
    that sends `promax` (OD-OAI-1);
  - the website reader that accepts v1.2 is live before the origin serves v1.2;
  - each kernel upgrade follows the OAI-11 order.
- Seal: the vendored source commit equals the Cloudflare production commit.

Every gate here is local and synthetic unless it says otherwise. None of them
is a GCP deploy, a Cloudflare deploy, a production migration or a cutover.

### Alignment owner decisions

| ID | Question | Default |
|---|---|---|
| OD-OAI-1 | If the seal comes before the release reaches Cloudflare: delay the cutover until the release is deployed and re-vendored, or cut over at `d43c8f92` parity and ship the release on GCP afterwards, from a reviewed release commit that descends from `d43c8f92`, through OAI-3 to OAI-8. Under the second option, GCP must run P's intake before any public client release that sends `promax`; otherwise the owner accepts and discloses that Pro Max users' v1.0, v1.1 and v1.2 uploads are refused | None taken |
| OD-OAI-2 | The 0013 conflict: renumber this line's unapplied D1 0013 and 0014, or retire them if the fast-path seal no longer needs them | None taken. Proposed: renumber after production's tail once production applies its 0013, as `a0fc9e39` did |
| OD-OAI-3 | Serve the release's public contract: follow production to `community-allowance-breakdowns-v1.2` and admin preview v0.4 at P. OD-5 names v1.1, and a plain re-vendor cannot keep v1.1, because the vendored projection emits v1.2 | None taken. Until decided, OD-5 stands and OAI-3 does not land |
| OD-OAI-4 | How older published days regain current spend (OAI-5). (a) From OAI-5 on, record per published revision the owner digests it folded (a new `analytics_v2` table, or an equivalent proven from `analytics_v2_owner_day`); republish a stale head only over that set, reading each recorded owner's retained evidence whether or not the owner is still eligible, and only if every non-spend field is unchanged; leave heads without a record. (b) Use the owner-history eligibility contract that OA-2 settles, if it defines membership per published day. (c) Leave every stale head: older days serve no API-equivalent value. (d) Republish over the current roster, which requires amending D1 | None taken. Without a decision the line is in (c) |

## Discarded or deferred

| What | Why |
|---|---|
| The 2026-09-27 SIMP-0, SIMP-1 and SIMP-4 briefs | They keep the erasure, ledger, tombstone, cooldown and restore-replay machinery that the 2026-09-26 decisions remove (OD-2) |
| Analytics ports AN-2 to AN-8, GB-2 to GB-8, HX-1, HX-2, HX-3, HX-5, HX-6, VR-5, VR-6, OJ-6, AR-2 and probably AA-4 | The single `analytics-refresh` job over vendored kernels replaces them, and history is recomputed |
| The separate deletion-ledger instance, the ledger 0007 transfer, the ledger and analytics-history transfer scripts, the staged 0053 erasure fences and the online erasure modules | Decisions D1 and D2 remove them. Removed from the code by C-SIMP on 2026-10-02 (0064 drops the fences, with the OPS-10 guard enforcing D6's order), except the analytics-history transfer scripts, which a later cleanup removes (OD-5). The test ledger instance and the frozen ledger migration files wait for OA-4 |
| Register rows built for D1 rescans and Worker statement meters, analytics D1 migrations 0030 to 0035 and the Codex day catalogs | Cloud Run Jobs over PostgreSQL recompute exactly without them |
| The memo, the worker pool and task sharding | Measured optimizations. The memo is required before the cutover cadence |
| The v1-only, mixed and v0.2 graph paths | D1-coupled orchestration rather than pure kernels; ported next via the HX-4 oracle. Recorded refusals tonight. (The dense-owner native path was ported later on 2026-10-01, OD-11) |
| The legacy GCP daily publisher and its test jobs | Superseded by `analytics-refresh` and the route module once parity passes; retired later in its own change, with tests |
| Merging the Codex GCP line | The two lines are not reconciled tonight. Candidates to cherry-pick after review: the v1.1 capability failsafe, the gateway allowlist, the identity and social transfer rehearsals |
| Syncing GitHub `main`, switching the allowance contract to v1.2, lifting capacity ceilings | Each changes kernel packages or parity bases and needs its own owner decision; for v1.2 that decision is OD-OAI-3. GitHub `main` is never vendored ([alignment](#alignment-with-the-openai-september-29-release)) |

## Risks

- Cutover is not tonight. The remaining critical path covers intake, the edge,
  the importers and seal, the dense path and memo, and production resources and
  secrets from the owner's custody.
- The client-address result (OD-E6) passed from both a `workers.dev` Worker
  and the `tibotattle.com` zone on 2026-10-02
  ([receipt](../receipts/2026-10-02-gcp-edge-ip-probe-production-zone.md)).
  Neither run observed the token exchange or the case without the edge's
  override, so the override stays load-bearing. A change to the edge's
  topology needs its own passing probe, and a failure would reopen the
  fallbacks: a Cloudflare-proxied origin hostname (a contract, EP-7 and EP-9
  template and DNS change) or acceptance with a privacy-page disclosure.
- Dense owners were excluded from the night's parity gate. The cap raise
  proves dense analysis against production's native kernels with a stand-in
  reader on synthetic data; the dense-owner parity run then proves it through
  the importers and the real readers against the dense production-code
  golden. Production volumes, production's Worker-only cache refusals (which
  GCP does not reproduce), the T-2 importer's quadratic reader verification
  and a measured cloud run of the largest-owner task size remain open (see
  the cap-raise and dense-owner parity receipts). (2026-10-02: the reader
  verification's cost now follows the page and batch, on
  `claude/gcp-fp-v12-reader`; see the
  [v1.2 reader batch-cost receipt](../receipts/2026-10-02-gcp-v12-reader-batch-cost.md).)
- The oracle may not converge under the Workers test pool. The fallback is a
  kernel-composed golden, which proves glue, I/O and the route but not
  production publisher semantics.
- Vendored kernels are pinned to `d43c8f92` blob digests. Later production
  kernel changes must be re-vendored deliberately before cutover parity.
- The SIMP residue (0064) refuses a schema that still holds erasure
  residue, so a database that applied 0053's fences with real rows needs a
  reviewed decision before its next migrate (OD-7 recreates the disposable
  `tibotattle_fastpath`). The A2 test schema stays at 0063 (OD-6).
- The local runtime differs from the image. The dist bundle and the A-2 and A-3
  specs run under Node 22.16.0; the importers (Node 22.13 or later) and the
  HX-4 adapter (Node 24.10 or later) stay out of the image.
- Recomputed history will differ from what Cloudflare published (see
  [Analytics history is recomputed, not imported](#analytics-history-is-recomputed-not-imported)).
- The two GCP lines keep diverging while both receive commits.
