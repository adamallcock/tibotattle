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
| OD-5 | Serve production's `community-allowance-breakdowns-v1.1` contract | Default taken |
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

### Origin

One Cloud Run service, generalized from the existing PostgreSQL test dispatch.
The production refusal stays in place until cutover. Two new seams:

1. **Route-module registry with an override list.** Module routes can replace
   the named built-ins `/api/v1/community/daily` and
   `/api/v1/upload-authorizations`. A module that claims any other built-in, or
   a path outside the route registry, fails at startup.
2. **Envelope-version handler registry** inside the PostgreSQL contributions
   handler. The shared preamble stays where it is: bearer auth,
   upload-authorization claim, tombstone check, transport floor and receipt.
   v1.2 is registered tonight. The v1.1, v1.0 and v0.1 handlers and the
   upload-authorization formats plug in as registry entries, not as new routes.

### Database

- One Cloud SQL PostgreSQL 17 instance (decision D4).
- The `primary` role holds everything, including the new analytics tables.
- The frozen `ledger` role is an interim second schema on the same instance
  until the SIMP-4 code removes it. There is no second instance.

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
  is published with all of them counted (D7 amended; both await the owner's
  confirmation). The day backstop now applies before the evidence digest. The
  owner-parity compare fails closed on fits references, and a PostgreSQL case
  pins the v1.2 expansion's exclusions. Disclosed, not fixed: the reader
  variant bound divergence in every family, the memory estimate's growth with
  retained history, the fixed heap reserve for held outputs, the snapshot's
  xmin hold and the absence of a time guard.

## Cutover backlog

Sizes are relative effort labels from the 2026-10-01 transfer and cutover
analysis: S, M, L and XL. They are estimates, not measurements. Each item
still needs its own qualification.

| Item | Size | Delivers | Blocks |
|---|---|---|---|
| IN-2: v1.1 intake family | L | Consent, day-manifests, domain-predecessor and domain-activate routes plus the `telemetry-envelope-v1.1` handler, matching `d43c8f92` statuses, bodies, idempotent replay and successor negotiation | The flip: shipped clients route v1.1 consent to the v1.1 uploader |
| IN-3: v1.0 and v0.1 envelopes | M | The v1.0 handler; the v0.1 handler or the documented retired-format refusal (OD-8); upload-authorization formats for v1.0 and v1.1 | The flip: shipped clients route v1.0 consent to the v1 uploader |
| Admin, export, performance and Apple routes | Decision S (owner); each port M; XL if all are ported | Decide per route from observed traffic: six admin routes (AR-1, AA-1), `me/export` and `me/security-reset` (PP-1, PP-2), performance telemetry (PF-1, PF-2), Apple start, callback and result (A1) | The flip, for every route that is kept |
| CR-7: production host composition | XL | Production route registry and Worker-order handler, the `isPostgresWorkerRequestPathSupported` flip, EP-6 dispatch wired into the host | Any gcp-mode flip and any production-shaped smoke test |
| EP-4 and EP-5: edge proxy | L | EP-4 classification, Access check, admission, forwarding, failure mapping and distribution merge; EP-5 worker, fenced and gcp modes with the release-guard nonce D1; the V12P-4 to V12P-7 device-sync admission patches | The thin proxy and the flip |
| EP-10 and a rollback-clean window | M each | Typed edge-mode deploy and verify, or an owner-run overlay deploy; an origin flag that refuses authority-plane writes for an initial window, plus an EP-9 matrix change, if the owner wants gcp-to-worker rollback | Fence and flip execution; a data-safe rollback |
| PT-2-lite: seal plus deletion digests | M | Fenced export of the ingestion and ledger D1s, `node:sqlite` rebuild, integrity check, per-table counts against remote aggregates, bare-name migration ledgers and digests; the content-free deletion-digest projection as the do-not-restore list | The cutover window, estimated at 1.2 to 3.2 hours of authenticated-route outage |
| PT-3 identity and authority importer, with PT-5a's v1.2 mapping | L | Credential and rotation hashes, owner links, the identity-link pin, consents and grants, accountless state and collection controls, with production target modes built on PT-1 | Import, and device authentication after the flip |
| PT-4: v0.x importer | M | v0.x contributions and admission windows, or an owner decision to retire v0.x backed by traffic evidence | Completeness of raw evidence |
| PT-8-lite: orchestrator | L | One disposition per sealed table keyed on the live ledger; the deletion-digest exclusion count; the identity-pin fingerprint check; a history-digest and manifest-digest parity sample between D1 and PostgreSQL | The go/no-go, and avoiding a fleet-wide re-upload storm |
| Dense-owner path | M (remaining, estimate) | Delivered in memory on `claude/gcp-fp-caps` (OD-11) and proven equal to production's native path through the importer chain and the real readers on the dense golden (`claude/gcp-fastpath-dense`). Remaining: the cloud measurement with the `dense` refresh profile (4 vCPU, 16 GiB) and a memory-model recalibration on the Cloud SQL seed; the T-2 importer's quadratic reader verification before the seal; the v1/v1.1 expansion at legacy-owner volume; bounded loading of the history before the analysis horizon (the memory estimate grows with retained history), output accounting beyond the fixed 512 MiB reserve, and a time bound measured on Cloud Run | Cutover: the largest real owner always takes this path |
| Non-effective sources | Depends on OD-4 | v1-only, mixed and v0.2 graph paths, needed only if the production check finds such owners | A parity claim for those owners |
| Memo mode | M (estimate) | The digest-keyed owner-day memo, the dirty-owner cursor and the nightly full sweep, measured on real data | The cutover cadence (decision D3) |
| OPS-2 to OPS-5, with OPS-10 | L | Scripted infrastructure with plan, readback and apply; Cloud Run Jobs and Cloud Scheduler as code; probe jobs; monitoring and alerting; the production migration job and rollout | Production origin deploy and operation |
| SIMP-0, SIMP-1 and SIMP-4 code | M (estimate) | The 2026-09-26 briefs: amend the merged AN-1, OJ-2, AA-0, RD-1, PT-1, CR-1, CR-3, EP-7 and OPS-1 work; remove the online erasure modules, the ledger and analytics-history transfer scripts and the mandatory ledger pool | Must land before any non-disposable database applies staged 0053 or ledger 0007 |
| R2-to-GCS copy (PT-7, reduced) | M | A post-flip copy from the frozen R2 bucket using the sealed reference set; pending quarantine objects empty or mapped at import | Decommissioning R2, not the flip |
| Production resources | S to M of owner time | One Cloud SQL PostgreSQL 17 instance (estimate: 2 to 4 vCPU, 8 to 16 GB, 50 GB or more SSD, point-in-time recovery, zonal); a private GCS bucket; runtime, migrator, edge-invoker and verifier service accounts; Artifact Registry; Secret Manager populated from the owner's custody. The identity-link secret must match the sealed pin and the envelope keys must be identical | Every production step. Owner-run |
| OPS-9: privacy and disclosure | S | Privacy page, `SECURITY.md`, scoped guidance and the supersession notes on accepted decisions, in the cutover commit only | The flip |
| Interim public read | M | A frozen `community_daily` until the first GCP publication, with the evidence date labelled | Public continuity after the flip |
| Measured timings | S | D1 export duration and size, PostgreSQL import rows per second, recompute throughput | Sizing the maintenance window |

Next-day order: IN-2 and IN-3; the dense path and the memo; SIMP-0, SIMP-1 and
SIMP-4; EP-4 and EP-5; PT-2-lite, PT-3, PT-4 and PT-8-lite; production
resources.

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

Before the flip, rollback is redeploying the production Worker and running the
EP-8 release. After the flip, gcp-to-fenced is the brake. Gcp-to-worker is
allowed only inside an authority-write-free window, and only if the owner
approves that policy.

## Discarded or deferred

| What | Why |
|---|---|
| The 2026-09-27 SIMP-0, SIMP-1 and SIMP-4 briefs | They keep the erasure, ledger, tombstone, cooldown and restore-replay machinery that the 2026-09-26 decisions remove (OD-2) |
| Analytics ports AN-2 to AN-8, GB-2 to GB-8, HX-1, HX-2, HX-3, HX-5, HX-6, VR-5, VR-6, OJ-6, AR-2 and probably AA-4 | The single `analytics-refresh` job over vendored kernels replaces them, and history is recomputed |
| The separate deletion-ledger instance, the ledger 0007 transfer, the ledger and analytics-history transfer scripts, the staged 0053 erasure fences and the online erasure modules | Decisions D1 and D2 remove them. Deferred, not deleted tonight; the ordering constraint in D6 applies |
| Register rows built for D1 rescans and Worker statement meters, analytics D1 migrations 0030 to 0035 and the Codex day catalogs | Cloud Run Jobs over PostgreSQL recompute exactly without them |
| The memo, the worker pool and task sharding | Measured optimizations. The memo is required before the cutover cadence |
| The v1-only, mixed and v0.2 graph paths | D1-coupled orchestration rather than pure kernels; ported next via the HX-4 oracle. Recorded refusals tonight. (The dense-owner native path was ported later on 2026-10-01, OD-11) |
| The legacy GCP daily publisher and its test jobs | Superseded by `analytics-refresh` and the route module once parity passes; retired later in its own change, with tests |
| Merging the Codex GCP line | The two lines are not reconciled tonight. Candidates to cherry-pick after review: the v1.1 capability failsafe, the gateway allowlist, the identity and social transfer rehearsals |
| Syncing GitHub `main`, switching the allowance contract to v1.2, lifting capacity ceilings | Each changes kernel packages or parity bases and needs its own owner decision |

## Risks

- Cutover is not tonight. The remaining critical path covers intake, the edge,
  the importers and seal, the dense path and memo, and production resources and
  secrets from the owner's custody.
- Dense owners were excluded from the night's parity gate. The cap raise
  proves dense analysis against production's native kernels with a stand-in
  reader on synthetic data; the dense-owner parity run then proves it through
  the importers and the real readers against the dense production-code
  golden. Production volumes, production's Worker-only cache refusals (which
  GCP does not reproduce), the T-2 importer's quadratic reader verification
  and a measured cloud run of the largest-owner task size remain open (see
  the cap-raise and dense-owner parity receipts).
- The oracle may not converge under the Workers test pool. The fallback is a
  kernel-composed golden, which proves glue, I/O and the route but not
  production publisher semantics.
- Vendored kernels are pinned to `d43c8f92` blob digests. Later production
  kernel changes must be re-vendored deliberately before cutover parity.
- Promoting staged migrations, including 0053 and ledger 0007, is safe only on
  disposable databases until the SIMP work lands.
- The local runtime differs from the image. The dist bundle and the A-2 and A-3
  specs run under Node 22.16.0; the importers (Node 22.13 or later) and the
  HX-4 adapter (Node 24.10 or later) stay out of the image.
- Recomputed history will differ from what Cloudflare published (see
  [Analytics history is recomputed, not imported](#analytics-history-is-recomputed-not-imported)).
- The two GCP lines keep diverging while both receive commits.
