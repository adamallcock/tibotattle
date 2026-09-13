---
title: D1 shard continuity implementation
date: 2026-09-13
type: plan
status: in-progress
---

# D1 shard continuity implementation

The user approved implementation on September 13. Work starts from `ceeeca32e63923ba308e02c296d1d2aaf48c861d` in an isolated branch, preserving the pinned production recovery. This plan extends the [typed-storage isolation plan](2026-09-11-d1-typed-storage-isolation.md); it does not establish production deployment or change an active migration.

## Accepted outcome

Capacity expansion must not require a service-wide upload freeze. Assign each authenticated contribution owner to a stable ingestion shard, stop new assignments at **6,000,000,000 bytes**, and preserve the **9,000,000,000-byte operating budget per database**. Keep prepared spare capacity. Move growing owners before capacity becomes urgent. Credentials, opt-outs, telemetry provenance, replay and owner-only erasure survive routing changes.

Analytics processes new records independently per source into separate storage. Combine owner-level evidence with existing accounting/statistical semantics; no averaging shard medians or double-counting moved owners. Publish only a complete declared set of source checkpoints and routing/erasure generations. A stalled analytics shard must leave uploads and the prior complete public result available.

## Ownership and sequence

Sol High agents lead implementation; they may delegate bounded work to Luna Max agents. Root owns integration, operations, shared configuration, documentation and final validation. All cloud and credential operations remain with root.

| Stage | Scope and acceptance | State |
|---|---|---|
| 1. Routing and capacity | Actual enrollment, ownership, credential lifecycle and upload paths across two ingestion shards and a spare; concurrent enrollment converges; cutoff, stale capacity, replay and route fences tested | In progress |
| 2. Analytics and erasure | Independent source progress, complete combined publication, no moved-owner duplication; owner-only erasure covers current/prior sources and derived targets with completion receipts | In progress |
| 3. Owner movement | Background copy plus catch-up, brief owner-specific final fence, exact verification and routing switch; restart/reconcile every phase | Origin prerequisites under validation; copier pending |
| 4. Operations | Wrangler-managed qualified spare capacity, size/growth alerts, safe allocation and movement controls; per-writer headroom reservations | Per-write admission in parallel development; spare qualification pending |
| 5. Qualification | Integrated local HTTP journeys, real isolated cloud rollover and failure rehearsal, measured final pause, then reviewed production activation | Queued |

Each stage must integrate its runtime callers. Uncalled interfaces, isolated mock tests or a configuration flag alone do not close a stage.

## Contracts

- The server's authenticated owner is the routing boundary. Client installation IDs and credential-hash locators do not grant authority. Legacy account/device ownership remains intact.
- Existing single-database mode remains the default until the new mode is explicitly configured and its required schemas and bindings are qualified. Inventory legacy, admin, queue, cron and repair pathways before claiming catalog-mode coverage.
- Global controls, abuse admission and sign-in handoffs must not silently become per-owner state through an environment/database substitution.
- New assignments refuse a shard at or above 6 GB. Missing, stale or incompatible capacity observations refuse new allocation. Existing owners continue subject to write admission; stop-new-allocation alone does not prevent their growth.
- Reserve concurrent physical growth, including indexes, journals and authority. Once-per-owner reservations or the existing 16 MiB observed-size guard are not a proof of a strict physical cap.
- Route checks must share each mutation's shard-local atomic batch. Catalog updates and writes to different D1 databases are not one transaction. Record intent and reconcile ambiguous outcomes.
- Source namespaces and event identities are evidence provenance, not current routing locations. Changing the shard cannot recreate old contributions under new identities.
- Background owner copying must account for every mutable authority/consent/erasure transition as well as telemetry. The existing analytics journal is not presumed to capture all owner mutations.
- Qualify a final hosted-write pause under one minute for the largest representative synthetic owner. This is a target, not an existing guarantee. Verify immutable ranges during copying so final fencing does not require another full historical scan.
- Source bytes remain until verified, separately authorized retirement. Switching a route does not reclaim storage. Measure actual reusable capacity before releasing its reservation. Never use a stale source as fallback after destination writes.
- Independent analytics use bounded jobs and per-source cursors. Missing sources remain explicit; public requests read published results. Erasure generations may invalidate previously published results and must never be bypassed merely to serve stale data.
- A single owner approaching one shard's capacity, unavailable catalog, exhausted spare pool and incomplete erasure each need explicit bounded behavior. No silent data loss, unverified fallback or cross-database exactly-once claim.

## Validation and release boundary

Use synthetic local Miniflare/D1 tests first, including pre-migration refusal and post-migration behavior. Exercise concurrent enrollment, cutoff, renewal/revocation, retries after uncertain acknowledgement, stale routes, move interruption, duplicate delivery, shard outage and owner-only erasure. Test source and analytics storage independently, and inject small capacity thresholds instead of filling databases to 9 GB.

Run focused tests while iterating, then the owning Worker gate and applicable architecture/docs checks on the integrated source. Isolated cloud qualification must bind its exact code, schemas, resources and observed results. Production activation remains separate from source completion and must not alter the running recovery's source or journal.

Cloudflare's supported model is horizontal scale across smaller databases; each D1 has a fixed 10 GB maximum and each Worker invocation has bounded connection concurrency. Use bindings and bounded per-shard jobs. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

## Progress evidence

- September 13: isolated implementation branch created from the qualified parent-upsert fix. Runtime routing lead assigned; remaining evidence will be recorded here as integrated tests complete.
- Capacity monitor and its private scheduled entrypoint: nine local D1 tests passed, covering real size readback, failed measurements, over-budget pressure, preserved reservations/readiness, and default-disabled behavior. These are local source tests, not deployed monitoring.
- Movement prerequisite found during source review: typed v1/v1.1 admission state and active views currently assume one source namespace per physical database. Mixed-origin owner movement requires a forward schema/read-path change; copied history must never be relabelled to avoid that work. Distinct unmoved shards can be qualified first.

## September 13 implementation checkpoint

The local slice has separate synthetic Wrangler entrypoints for capacity and analytics, both disabled with no public route or credentials. The initial pool has ingestion A/B plus spare C and separate matching analytics targets, a routing catalog and a publication database. This is a bounded starting pool, not a claim that all configured databases are already provisioned or ready.

Implemented in the first local checkpoint:

- Accountless enrollment and ownership use a stable server-issued route. Encrypted typed v1.1 HTTP admission, replay, renewal/revocation and same-batch route fences have targeted local coverage.
- Actual size observations control new-owner placement. Missing or expired measurements close allocation; readiness and reserved bytes are preserved. Crossing 6 GB stops new assignments, while 9 GB remains the operating ceiling rather than a provider limit change.
- Independent source processing, complete cohort capture, retained-copy exclusion, exact combination of owner evidence and generation-bound publication are wired locally. A failed publisher preserves source-processing progress.
- Access-owner erasure resolves a retained participant locator, invalidates central publication, prepares all recorded physical/derived targets and resumes after partial failure. It requires no participant credential.
- The canonical ingestion role includes shard-local fences. The role/operator script suite, documentation governance and architecture checks passed. One native rollover fixture used an expired fixed timestamp; its clock now follows the D1 wall clock while retaining the expiry refusal assertions. The running recovery source was not changed.

Required before enabling catalog mode:

1. Complete the owning Worker gate on committed source and reconcile every unsupported legacy/admin/repair/public-read pathway.
2. Qualify the complete spare tuple: schema, analytics binding, replay, erasure, measured capacity and allocation policy. The synthetic 16 MiB enrollment reservation is not a production sizing decision.
3. Add namespace-aware admission/read paths and a resumable owner copier with exact verification, a short final fence and retained-source cleanup receipts.
4. Add per-write physical growth reservations and reconcile actual reusable capacity. Stopping new owners at 6 GB cannot constrain growth by existing owners.
5. Finish catalog-aware tombstone replay and existing-participant locator backfill; prove the integrated paths against isolated cloud resources before production activation. Carry the retained global issuance counts into a qualified catalog baseline before allocation. Never initialize that baseline from a guessed zero.

The existing production restore remains on its pinned source. Its continuation deadline, deployment journal, source preservation and final activation/canaries remain a separate workstream.

Integrated checkpoint validation: Worker typecheck and seven focused D1/HTTP suites passed (73 tests) on the frozen source. The earlier broad diagnostic run overlapped active edits and failed seven cases; their corrected paths pass the fresh focused run. The complete Worker gate remains required on the committed checkpoint. No catalog-mode cloud resource or deployment is claimed by these local results.

The first implementation checkpoint is `3cd9ff72`; release-tooling follow-ups `ea5f026a` and `bd085073` align the exact additive ledger inventory and closed synthetic fixture bindings. Targeted readiness, fixture and rehearsal checks pass. On clean `bd085073`, all 1,456 Worker tests and the script/type/role dry-build checks passed. The main dry build initially lacked the generated public-site input; unchanged retained assets were supplied and passed the official source-provenance verifier, after which the main and staging dry-build checks passed. No public asset manifest was edited. Follow-on runtime changes use `codex/d1-shard-continuity-next-20260913`, keeping that qualification source frozen.

The second local checkpoint implements global catalog issuance reservations (1,000 per day / 10,000 lifetime), device-digest conflict handling, uncertain acknowledgement recovery and midnight replay. A fresh catalog refuses issuance until a trusted historical-count baseline is initialized; the live extraction/qualification caller remains open. Reservations are permanent and cannot be silently released after an ambiguous local issuance.

Actual public daily and allowance HTTP readers now use the central publication database. They preserve response schemas, suppression and caching, continue serving the prior complete cohort during an unrelated source failure, and refuse an obsolete erasure generation. A healthy ingestion shard accepts encrypted telemetry while another source is unavailable. The integrated eight-suite D1/HTTP check passes 96 tests; the broader public-reader selection passes 92 tests. The complete owning Worker check passed on clean second-checkpoint commit `d931f4b0`: 125 test files, 1,466 tests, type/script checks and role, main and staging dry builds. This proves local integration and packaging, not hosted activation.

The third local slice integrates catalog deletion replay into scheduled maintenance. Accountless ownership publishes both immutable participant locators atomically before reporting success. Erasure requires the independent deletion-digest locator before invalidating publication or deleting source data. Replay follows exact current and retained route targets, recovers participant IDs through indexed local owner links and checks their deletion digest. An unavailable source or analytics target retains pending work; pending target receipts also prevent expired tombstones from being purged.

Root review found that limiting only successful suppressions would still visit too many already-erased owners. A forward deletion-ledger migration now retains a pagination cursor; each run processes at most eight digests, including owners with no restored rows. It advances past mapped offline targets, carries incomplete work across the cycle, requires a subsequent clean cycle and renews the lifecycle lease at unit boundaries. Tests cover more than one page, a later restored owner behind earlier completed owners, offline source and analytics retries, pending tombstone retention and repeated completion. Final third-slice qualification is recorded below.

Before catalog activation, apply routing migration `0005_participant_deletion_replay_locators.sql` and deletion-ledger migration `0005_catalog_deletion_replay_cursor.sql`, and complete a trusted backfill for every existing owner. The backfill must use exact catalog route history and local owner links, verify agreement before publishing digest-only locators, and refuse unexplained missing owners. No runtime shard scan or raw participant ID in the catalog is permitted. Retained physical source/analytics pairs remain capped at eight; future movement must enforce that bound. Root retains all hosted execution and the separately pinned recovery continuation.

The first third-slice gate on `9ad0f6dd` passed 1,468 tests and failed the fixed scheduled-query budget assertion. The fix combines ledger schema discovery into one query and retains the original 70-query limit. Independent review also found deletion failures before a source retry job existed, and restored-credential admission while only an expired target receipt remained pending. Catalog erasure now retains an exact pending marker atomically with its tombstone; purge and authorization both honor that marker and pending target receipts. Each attempt receives its own write-returned token, so interrupted or concurrent attempts cannot clear newer work. Central publication is invalidated before deletion authority is created; failure before that invalidation cannot start background deletion. These follow-ups pass TypeScript and 134 focused tests.

The complete Worker gate passed on clean commit `0e330fec`: 125 test files, 1,476 tests, type and operations checks, and capacity, analytics, main and staging dry builds. Sol High independently rechecked the final deletion changes and passed 37 D1/HTTP tests. This is local qualification of routing, combined analytics and resumable erasure; catalog activation, historical enrollment import, owner movement and physical growth admission remain open. Follow-on historical-reservation work uses the isolated `codex/d1-shard-historical-issuance-20260913` branch so it cannot change this qualification checkpoint or the production restore.

The fourth local slice preserves existing accountless issuance when introducing a routing catalog. Routing migration `0006_historical_accountless_issuance.sql` adds immutable historical reservations and a one-way import state. A trusted caller imports exact existing credential/owner associations, verifies a canonical roster digest against a stable revision, and finalizes the original global daily and lifetime counters. Counters may exceed retained rows after deletion, but cannot be lower than known historical and current reservations. A populated catalog must retain its existing baseline and counts; neither migration nor retry resets them. Allocation remains closed until finalization, and historical credential retries reuse their owner without another issuance charge.

The dedicated historical-import suite passes 12 tests and the eight-suite integration selection passes 109, including a populated-catalog upgrade, mismatched counters, changing rosters, conflicts, interrupted retries and finalizer replay after later issuance. TypeScript passes. The complete Worker gate passed on clean `2fca330a`: 126 test files, 1,488 tests, workspace/type/script checks and capacity, analytics, main and staging dry builds. Documentation, preflight and architecture checks also passed. These private runtime seams do not constitute a live importer: the exact source manifest, authoritative aggregate counter extraction, owner-data and participant/deletion locator backfills, and isolated cloud activation rehearsal remain required. Catalog mode stays disabled and the production restore remains unchanged.

The fifth local slice adds an immutable origin registry and namespace-specific owner and manifest memberships. Current HTTP writes remain pinned to one qualified origin. Private readers check exact original identifiers; participant erasure follows memberships for every retained origin in the physical database. Forward migrations refuse unexplained ownership rather than relabelling records. The adoption adapter checks record, owner and manifest namespaces before writing proof memberships, and scopes final counts to the original namespace. These changes are on a separate checkout and do not change the running production restore or its migration set.

This is a prerequisite for movement, not a completed move implementation. No runtime caller registers a retained origin, copies an owner or changes a route. The legacy v1 analytics scope explicitly refuses multiple origins until its reducer supports them; mixed-origin v1.1 generation projection also remains unqualified. The origin registry alone must not enable movement. Root integration, owning validation and the eventual copier, analytics and erasure journey are still required.

The sixth local slice adds shard-local observations and per-upload reservations in typed-ingestion migration `0006_write_capacity_admission.sql`. In catalog mode the final v1/v1.1 write batch contains its route fence, one capacity reservation and the original telemetry mutation. The trigger admits only against a fresh D1-clock observation plus concurrent unobserved reservations under the 9 GB budget. Sampling reads physical size and reservation progress together; versioned observations prevent an older acknowledgement from replacing a newer sample. An uncertain acknowledgement retains the reservation. Later physical-size reconciliation retires at most 100 receipt rows per call, without freeing reservations created after its sample.

The reservation amount is a conservative estimate covering serialized work, indexes, authority and journal overhead. It is not a mathematical upper bound on SQLite growth, and other authority/control mutations are not yet covered by this upload-specific reservation. Physical-growth calibration, all-writer coverage, spare readiness and movement operations remain activation gates. Known exact replay bypasses new allocation; single-database mode keeps its existing guard. The integrated namespace/capacity selection passes 86 tests across seven suites; complete owning qualification remains pending on the integrated source.

The first fifth-slice owning gate on `cae07493` passed 1,471 tests and failed 21 cases across three suites. The shared causes were legitimate zero-chunk manifests without typed memberships and an entirely empty first restore format without a namespace row. The integrated fix admits an empty ready manifest only through its exact current source, owner and device; only initial empty adoption can establish a missing namespace. Verification and populated histories still require existing provenance. All 49 tests in the five-suite regression selection pass, including every failing suite and negative identity checks. The failed full-gate log is retained; a fresh complete gate is still required.

The integrated gate on `a9528d15` passed 1,503 tests and exposed two additional restore-initialization failures: the new migration seeds an unused capacity clock. Initialization now accepts only its exact singleton with revision and reserved bytes both zero; a missing or used clock still refuses restoration. The 18-test restore regression selection passes, including three new refusal cases. The earlier failed gate remains preserved; complete requalification is pending.

The corrected integrated namespace/capacity source `222b7673` passed the complete Worker gate: 127 test files, 1,508 tests, workspace/type/script checks and capacity, analytics, main and staging dry builds. Documentation checks passed. This qualifies the fifth and sixth local slices; physical-growth calibration, other writer coverage, existing-owner activation, multi-origin analytics, movement and cloud rollover remain separate gates.


The seventh local slice imports an existing accountless installation population into the routing catalog. It extracts an immutable, bounded owner and credential manifest from a closed source, preserves the original issuance counters, and resumes exact catalog import in pages of at most 32 owners. The integrated core passes 72 tests across five suites and TypeScript. Imports reserve only separately configured future headroom per owner; retained physical bytes remain in the measured shard size and are not charged again.

The executable bootstrap operator prepares a disabled Worker with no HTTP or cron ingress, uses one private Queue consumer, freezes the exact authority tables, advances the import, and separately releases the source and cleans up its resources. Every mutation rechecks the existing containment lock. Temporary resource admission requires exact operation, database, bundle, configuration, version tag and consumer identities; after cleanup the ordinary inventory guard must pass. The journal pins the complete prepared package and refuses changed files or expired apply/release operations before remote calls. The 17-test integrated operator/provider selection passes, including real Miniflare import of three owners, real Wrangler dry builds, package tampering, stale capacity and threshold refusal, release authorization and isolation failures. Complete owning qualification and a cloud synthetic of the operator remain open; no production catalog or bootstrap was activated.


The eighth local slice reads an owner's qualified retained origins during v1 and v1.1 analytics. Composite cursors retain the original source namespace and record identity; legacy partial cursors without that identity refuse continuation. Daily preparation pins the exact origin set and rejects drift before publishing. Analytics migration `0017_v11_multi_origin_day_values.sql` adds the daily pins and requires any pre-existing unpinned typed partial work to be reconciled before migration.

Independent review found and corrected two integration defects: withdrawing a partial day must retain its provenance while retiring its rows, and pagination must limit the indexed read before collision checking. The corrected v1 paths use bounded indexed arms per origin; v1.1 avoids repeatedly materializing a whole day's records. The integrated seven-suite selection passes 66 tests and TypeScript. Complete owning qualification is still pending. This adds analytical prerequisites only: no owner copier, route switch, public export qualification for moved owners, or cloud activation is claimed.


Before cloud bootstrap, root compared the transport against retained responses from the completed isolated verification rehearsal. Cloudflare returns the Worker under `script` and delivery bounds under nested `settings`; the initial bootstrap fixtures used an older flat shape. Both runtime readback and containment now validate the observed representation, including exact queue identity, batch size, concurrency, timeout and retry settings. Synthetic refusal cases cover missing and contradictory fields. This closes the known response-shape mismatch; it does not replace the pending live bootstrap rehearsal.
