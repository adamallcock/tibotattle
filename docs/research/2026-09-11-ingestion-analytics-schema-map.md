---
title: Ingestion and analytics schema boundary inventory
date: 2026-09-11
type: research
status: source-verified
---

## Scope and conclusion

This is a local source inventory, not a migration, deployment, or live-database
receipt. The baseline is revision `3de7ccd0a293e1d9b95ce14b591dbf5f1c2d1f2b`,
with migrations `0001` through `0060` applied in order to disposable SQLite.
The separate typed-ingestion, analytics, and routing directories are new
implementation work and are excluded from the baseline count. The
[storage isolation plan](../plans/2026-09-11-d1-typed-storage-isolation.md)
defines the intended work; existing production and privacy runbooks remain the
operational authorities.

The split cannot be implemented by moving every `community_*` table. Upload
admission and whole-domain activation depend on some of those tables, and
existing ingestion triggers directly change analytics publication state.
Retain the authority/domain transaction on ingestion; replace its analytics
side effects with a transactional change journal only after every public read
can refuse an obsolete authority projection. Read compatibility views can ease
consumer migration, but cannot by themselves replace the writable raw tables.

Local introspection found **94 tables (including `sqlite_sequence`), 168
triggers, 6 views, and 95 explicitly declared indexes**. Counts exclude SQLite
autoindexes. The exact table inventory below accounts for all 94 tables.

## Transaction boundaries that must survive

### Admission, transport and domain authority

The ingestion owner consists of participant state, device/enrollment authority,
consents, upload claims, replay/admission receipts, transport floors, raw records,
chunk/day journals, domain predecessors, domains, domain membership and the
active head. Keep these colocated, with their foreign keys, uniqueness and
admission/immutability/delete guards. Routing hints and copied analytics owner
rows cannot authorize an upload.

`telemetry-v11-repository.ts` stages the chunk and every record in one batch.
The chunk trigger rechecks the exact consuming upload claim, envelope digest,
lease, device, participant, accepted transport floor, social consent or the
accountless owner/ledger/grant chain, and membership declared by the staged day
manifest. Record admission then checks chunk/manifest/stream/day and the declared
record count. The ready-manifest transition checks completion; none of these
checks belongs in the asynchronous analytics consumer.

`activateTelemetryV11Domain()` in
[telemetry-v11-domain.ts](../../apps/worker/src/telemetry-v11-domain.ts)
atomically inserts the domain, its day vector and the head. The final
`telemetry_v11_domain_complete_before_insert` definition in
[0058](../../apps/worker/migrations/0058_accountless_upload_ownership.sql)
checks current predecessor authority/revision/head, complete contiguous days,
chunk/record counts, duplicate occurrences across days, and exact preservation
of old v1 winning occurrences and previous v1.1 base semantics. It refuses a
v0.2 cutover without a supported preservation proof. Retain those proofs at the
write boundary, not as an eventually consistent analytics validation.

Two misleadingly named dependencies are especially important:

- `community_analytical_input_versions` is used by predecessor creation and
  `telemetry_v11_current_predecessors` as source revision/CAS authority. Keep it
  ingestion-local initially; a later explicit rename can separate its name from
  its function. Route generation must never substitute for this revision.
- `community_snapshot_mutation_control` supplies the mutation epoch read by
  `loadV11SourcePin()` and the v1 scoped-update transaction.
  `community_graph_update_scope` records the exact old/new chunk and authorized
  claim inside the v1 batch. Preserve this control pair until source pinning and
  append-versus-withdrawal semantics have explicit replacements. The global
  analytics epoch cannot silently become an owner route epoch.

The v1 repository also performs supersession, old-record deletion, new-chunk
insertion, new records and scope-marker deletion in one batch; it verifies the
exact chunk through `RETURNING`. Both formats must roll back entirely when the
same-batch owner write fence fails.

### Withdrawal and erasure

The final [0060](../../apps/worker/migrations/0060_public_contribution_sources.sql)
`community_public_source_owners` view admits active social participants, and
accountless participants only through the exact nonrevoked ledger, owner,
device, grant and current domain-head/device chain. Policy/dictionary/privacy
versions and expiry-field identity must match. Retained-data eligibility does
**not** require renewable upload expiry to be later than now; new uploads do.
Enrollment without an accepted head does not make a public source.

The eleven `community_public_source_*_withdraw_*` triggers cover ledger, owner,
device, grant and participant UPDATE/DELETE, plus head DELETE. They capture OLD
identity/membership before authority disappears. They retire pending analysis,
hard-invalidate publication, subtract eligible prepared metadata once, enqueue
rebuilds and withdraw published daily/weekly rows. They do not merely bump an
allowance epoch. Existing daily readers deliberately serve activity without
allowance, selecting `release_state = 'published'` in
[community-daily-aggregates.ts](../../apps/worker/src/community-daily-aggregates.ts).
Consequently, gating only the allowance endpoint leaves withdrawn activity
visible during delivery failure.

[participant-erasure.ts](../../apps/worker/src/participant-erasure.ts) first
revokes accountless enrollment, obtains the participant deletion fence, records
an independent deletion-ledger tombstone, handles retained objects, and finishes
fenced parent deletion through [repository.ts](../../apps/worker/src/repository.ts).
The baseline relies on participant/device foreign-key cascades for raw and
prepared data. Cross-database copies lose those cascades: they need explicit
owner-erasure events, projection deletion/withdrawal, durable completion evidence,
and restore-time tombstone replay. The independent deletion ledger stays
separate; a catalog move or deletion of a migration copy is not owner erasure.

## Exact trigger coupling to remove deliberately

The following are live definitions after the full migration chain, not every
historical definition bearing the same name. Brace notation enumerates the
literal suffixes; it is not permission to ignore other triggers on the table.

| Ingestion mutation | Coupling in the current schema | Required split treatment |
|---|---|---|
| v1.1 head INSERT/UPDATE | `telemetry_v11_head_{insert,update}_publish` consumes predecessor, increments source revision, mutates global epoch and enqueues current-domain days | Keep predecessor consumption/revision atomic; journal exact activated generation and affected scope in the same batch; analytics performs its own queue changes |
| v1.1 head INSERT/UPDATE/DELETE | `community_model_history_successor_{insert,update,delete}` and `community_model_history_dependency_successor_{insert,update,delete}` alter composition/dependency state | Reproduce from ordered source changes; never project staged chunks as an active domain |
| legacy telemetry INSERT/UPDATE/DELETE | `community_analytical_input_legacy_{insert,update,delete}`, `community_model_history_legacy_{insert,update,delete}`, `community_model_history_dependency_legacy_{insert,update,delete}`, plus contribution deletion snapshot triggers | Preserve source revision and deletion semantics on ingestion; derive caches independently |
| v1 chunk INSERT/UPDATE/DELETE | `community_analytical_input_v1_{insert,update,delete}`, `community_model_history_v1_{insert,update,delete}`, `telemetry_v1_chunks_enqueue_daily_rebuild` | Preserve scoped accepted correction versus withdrawal distinction; emit ordered owner changes |
| v1 record INSERT/UPDATE/DELETE | `telemetry_v1_quota_fit_rows_{insert,update,delete}`; UPDATE/DELETE also `community_prepared_source_record_{update,delete}` | Quota-fit acceleration and prepared invalidation move with readers, rather than remaining synchronous raw-write cost |
| participant INSERT/state change | `community_analytical_input_participant_{created,state}`, `community_current_analysis_participant_state`, snapshot/daily/composition/model-history participant triggers | Retain source revision creation and admission state; event carries authority change separately from analytical progress |
| accountless authority/head removal | The eleven 0060 withdrawal triggers described above | OLD owner plus durable authority epoch and withdrawal/erasure event must commit even if analytics is unavailable |
| mutation epoch change | `community_allowance_input_mutated` changes allowance status, hard-invalidation epoch/reason and admin-preview cache | Do not leave this trigger pointing at tables removed from ingestion; replace its analytics effects only with a read-fenced delivery path |

Analytics has its own downstream trigger graph: fit/model cache changes drive
`community_current_analysis_{fit,model}_*`,
`community_publication_{fit,model}_*`, and
`community_refresh_{fit,model}_*`; source-version changes drive
`community_current_analysis_revision_*`; prepared heads drive
`community_preparation_progress_*`. Those dependencies must be migrated together
with their tables. A copied cache alone does not include its queue, publication
membership, source fingerprint, method/policy version or generation fence.

The schema also has authority, transport, immutable-record, active-record-delete,
quarantine and upload-consumption triggers that are **not** analytics hooks.
Preserve them. In particular, the `telemetry_v11_{manifest,chunk,record}_*`,
`telemetry_v11_domain_*`, `telemetry_v11_head_*_guard`,
`telemetry_v11_active_*_delete_guard`, `accountless_*_admission`,
`device_credentials_*`, `device_upload_authorizations_*`, and social-only
format/session guards cannot be dropped to make copying or view writes work.

## Can compatibility views replace raw storage?

The useful existing read seams are `telemetry_analytical_records` and
`telemetry_analytical_chunks`. They select the participant-wide active v1.1
generation when a head exists and otherwise v1; they never union old v1 history
with a successor. `telemetry_v11_active_records` exposes v1-shaped typed columns
through JSON extraction and uses the original record `rowid` as `id`.

The new [typed repository](../../apps/worker/src/typed-telemetry-repository.ts)
preserves original namespace/format/source-row identity and reconstructs a
canonical record plus legacy projection in bounded pages. It is a storage
primitive, not a drop-in SQL view or HTTP admission path. Its surrogate row IDs
must not replace legacy cursor identities. The following prevent a views-only
cutover:

1. Existing repositories INSERT/DELETE physical raw rows and depend on triggers,
   constraints, FKs, exact `RETURNING` and supersession rollback. An ordinary view
   supplies none of those write contracts; an INSTEAD OF trigger redesign would
   itself be an admission implementation requiring proof.
2. Domain closure compares `record_json`, `legacy_record_json`, occurrence IDs
   and JSON-with-attribution-removed in SQL. Reconstructing equivalent JavaScript
   objects outside the transaction does not prove that those current guards still
   run. Preserve canonical representation and NULL/zero/unknown semantics in a
   typed SQL proof or an equally strong transaction-bound substitute.
3. [prepared-v1-evidence.ts](../../apps/worker/src/prepared-v1-evidence.ts) reads
   `telemetry_v1_records INDEXED BY telemetry_v1_records_participant_stream_observed`
   with `(observed_at,id)` keyset cursors. A same-name view cannot provide that
   physical index. [quota-analysis-v11.ts](../../apps/worker/src/quota-analysis-v11.ts)
   and staged-chunk replay also directly read raw records, bypassing the generic
   analytical view. Preserve bounded reads and cursor identity explicitly.
4. `telemetry_v1_quota_fit_rows` has a cascading FK to raw record IDs. Prepared
   row families cascade through `community_prepared_source_days`; many caches,
   work rows and members cascade directly from participants. Cross-database
   compatibility views cannot implement those FK relationships.
5. D1 bindings are separate query/transaction domains. A view in analytics does
   not join a live ingestion binding. Analytics needs a source-bound projection
   and watermark protocol, or bounded remote materialization through application
   code. Routing lookup is not a cross-database join.

A read adapter can preserve the analytical DTO/selection contract while changing
physical reads. It must prove identical memberships, canonical values, stable
cursors and query budgets. Keep v0.2 separately: the new typed codec covers v1 and
v1.1, while retained v0.2 remains an explicit domain-cutover blocker.

## Smallest coherent next implementation slice

Implement one isolated v1.1 **activation-to-daily-projection** path in local tests,
with the existing single-shard adapter and complete unchanged admission guards:

1. Add a same-ingestion-batch journal event to successful domain activation and
   authority withdrawal; retain source revision, current head and OLD authority
   identity. Failed journal/fence insertion must roll back activation.
2. Apply a bounded, generation-pinned projection into analytics, committing data,
   source cursor and event identity in one analytics batch. Test duplicate delivery,
   crash before acknowledgement, missing source evidence and changed revision.
3. Gate every public daily/allowance/history read on authoritative withdrawal
   watermark agreement, including in-flight read races, while allowing ordinary
   accepted append lag under the existing publication policy. Never acknowledge
   revocation as publicly safe merely because a queue notification was sent.
4. Add exact erasure/deletion-ledger replay through the projection and test delayed
   old events after withdrawal. Preserve source data and do not activate a split.
5. Then replace this slice's synchronous analytical effects; expand across v1,
   legacy, prepared/current/history consumers before changing production bindings.

The new [analytics delivery primitive](../../apps/worker/src/analytics-delivery.ts)
has same-batch event preparation, ordered/idempotent application and an authority
watermark comparison. At this snapshot, `index.ts` has no imports of that module,
the typed repository, or storage routing. The primitive does not yet implement
raw-to-public projection, all-public-read fencing or distributed erasure.
A pre-read watermark comparison alone is not proof against a concurrent revoke;
qualify the complete response/publication lifecycle. No distributed transaction
is claimed.

Remaining blockers are explicit role-specific authority/schema migration;
transactional typed admission and domain preservation proofs; indexed reader
adapters; projection/watermark integration for every public surface; multi-store
erasure/restore completion; bounded old-to-new copy plus final-delta cutover; and
per-database capacity reservations that account for retained source copies.
These are implementation gates, not reasons to weaken current guards.

## Complete baseline table inventory

“Keep initially” describes the minimal safe split, not a permanent placement
mandate. Global control and unrelated service tables are deliberately left alone.
Analytics tables cannot be removed until the trigger/read dependencies above are
replaced. Table names in this inventory were checked against the fully migrated
local `sqlite_master`.

### Authority, admission, retention and claims: keep initially (29)

`accountless_enrollment_issuance`, `accountless_enrollment_ledger`, `accountless_upload_owners`, `accountless_v11_device_authorizations`, `attribution_enrollments`, `collection_controls`, `device_credential_rotations`, `device_credentials`, `device_pairing_events`, `device_pairings`, `device_upload_authorizations`, `enrollment_grants`, `identity_link_secret_configuration`, `identity_reenrollment_cooldowns`, `participant_community_eligibility`, `participants`, `pending_quarantine_objects`, `quarantine_reconciliation_state`, `recovery_retry_receipts`, `retention_state`, `telemetry_contribution_admission_windows`, `telemetry_transport_floor_rollbacks`, `telemetry_transport_formats`, `telemetry_transport_participant_floors`, `telemetry_v11_device_consents`, `telemetry_v1_chunk_admission_windows`, `telemetry_v1_device_consents`, `upload_authorizations`, `web_sessions`.

### Accepted raw evidence and domain journals: ingestion (13)

`contributions`, `telemetry_contribution_occurrences`, `telemetry_contributions`, `telemetry_records`, `telemetry_v11_chunks`, `telemetry_v11_day_manifests`, `telemetry_v11_domain_days`, `telemetry_v11_domain_heads`, `telemetry_v11_domain_predecessors`, `telemetry_v11_domains`, `telemetry_v11_records`, `telemetry_v1_chunks`, `telemetry_v1_records`.

### Source/CAS controls with analytical names: keep initially (3)

`community_analytical_input_versions`, `community_graph_update_scope`, `community_snapshot_mutation_control`.

### Derived analytics, policy and work state: move together after decoupling (38)

`admin_community_allowance_preview_cache`, `admin_community_allowance_preview_refresh_state`, `admin_metric_snapshots`, `admin_metrics_history_cache`, `community_aggregate_exclusions`, `community_allowance_fit_cache`, `community_allowance_publication_state`, `community_analysis_work`, `community_analysis_work_parts`, `community_analysis_work_stage`, `community_current_analysis_queue`, `community_current_analysis_queue_state`, `community_daily_aggregate_rebuilds`, `community_daily_aggregates`, `community_model_composition_cache`, `community_model_composition_days`, `community_model_history_dependencies`, `community_model_history_results`, `community_model_history_work`, `community_model_history_work_parts`, `community_model_history_work_stage`, `community_preparation_progress_counters`, `community_prepared_fit_rows`, `community_prepared_plan_rows`, `community_prepared_source_days`, `community_prepared_usage_bins`, `community_prepared_usage_rows`, `community_public_source_bootstrap`, `community_publication_changes`, `community_publication_generation`, `community_publication_members`, `community_refresh_lanes`, `community_snapshot_builders`, `community_snapshot_policy`, `community_weekly_snapshot_rebuilds`, `community_weekly_snapshots`, `telemetry_v1_quota_fit_backfill`, `telemetry_v1_quota_fit_rows`.

### Unrelated/global service state: no change in this slice (11)

`admin_action_audit`, `apple_signin_handoffs`, `diagnostic_error_events`, `github_distribution_snapshots`, `github_distribution_sync_state`, `github_release_asset_snapshots`, `github_release_snapshots`, `google_signin_handoffs`, `sign_in_start_admission_windows`, `sparkle_appcast_guard_nonces`, `sqlite_sequence`.

The six baseline views are `community_public_source_owners`,
`telemetry_analytical_chunks`, `telemetry_analytical_records`,
`telemetry_v11_activatable_domains`, `telemetry_v11_active_records`, and
`telemetry_v11_current_predecessors`. `telemetry_v11_activatable_domains` and
`telemetry_v11_current_predecessors` must remain available to ingestion guards; analytical selection views require a
same-database projection or an explicit reader adapter after the split.
