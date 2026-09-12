---
title: Accountless upload ownership migration review
date: 2026-09-05
type: review
status: approval-required
---

## Purpose and boundary

This is a source-only review artifact. It describes the least misleading
shape for a future accountless upload authorization bridge; it is not a
migration file, has not been applied to any database, and does not authorize
a remote D1 migration, deployment, production data access, live traffic, or
a hosted configuration change.

The goal is narrow: let an already enrolled installation use the existing
device upload and v1.1 encrypted staging pipeline. It must not create a
social sign-in, browser session, pairing, explicit-consent event, or a second
quota/retry journal.

The automated review rejected the earlier migration attempt because it would
drop and restore core tables and admission triggers while carrying sensitive
telemetry and credential-related rows. Its stated reason was:

> This migration performs a broad, difficult-to-reverse schema rebuild that
> drops core tables, views, and many integrity/admission triggers while
> restoring sensitive telemetry and credential-related data; the user
> authorized fixing contributions but not this exact high-blast-radius
> destructive database operation.

## Correction to the previous draft

The previous illustrative SQL is withdrawn. It is incomplete and must not be
copied into an executable migration.

It proposed `participants.consent_version = 'accountless-policy-v1'` and an
empty `participants.consented_at` sentinel. That still places a policy record
in a field named as social consent and violates the decision record's
requirement not to invent a consent timestamp or consent evidence.

It also left the existing non-null social fields unexplained:

- `participants.access_token_id` and `access_token_hash`;
- `participants.recovery_token_id` and `recovery_token_hash`;
- `participants.consent_version` and `consented_at`.

Generating inaccessible random values for those fields would only make
synthetic social credentials. It is not an acceptable bridge. The prior
snapshot list covered the `device_credentials` cascade but not all tables
that reference `participants`, so it could not safely rebuild the parent
table either.

## What the current schema permits

The enrollment ledger in migration `0046` is deliberately upload-free. It
holds a stable installation `device_id`, the hash of that installation's
32-byte device secret, a policy/version tuple, an active-or-revoked state,
and a fixed expiry. That installation identifier is legitimate: it identifies
the enrolled installation, not a person or social account.

The existing upload pipeline instead requires both a participant and a device
credential:

- `device_credentials.paired_via_pairing_id` is non-null, unique, and
  references `device_pairings`.
- `device_pairings.issued_by_session_id` is non-null and references
  `web_sessions`.
- device admission requires an active social pairing and ongoing social
  consent.
- upload authorizations, v1 journals, v1.1 staging, predecessor tokens, and
  v1.1 domain heads refer to the existing participant/device identities.

An additive accountless table by itself cannot satisfy those foreign keys. A
synthetic pairing or web session would fabricate authority. A new parallel
upload journal would violate the requirement to reuse the existing v1.1
accounting, quota, deduplication, and retry path.

## Designs considered

| Design | Result | Reason |
| --- | --- | --- |
| Direct accountless owner inside the existing pipeline | Viable only with a carefully reviewed, currently rebuild-based migration | It preserves the existing upload, receipt, v1.1 staging, domain, quota, and attribution pipeline. It must make the social-only participant fields nullable for `owner_kind = 'accountless'` and make the direct accountless device credential explicit. |
| Dedicated accountless owner/credential tables plus an owner-key bridge | Not smaller; do not use for this change | SQLite cannot enforce a foreign key to either `participants` or a new owner table. Generalizing every child table to a new unified owner key would rebuild the same hot tables, views, and triggers, and adds a second identity/accounting model. |
| Dedicated tables with a synthetic legacy participant, pairing, session, access token, recovery token, or consent value | Rejected | The missing social fields would be fabricated. This is precisely the authority and consent fiction the policy prohibits. |
| Separate accountless upload/journal stack | Rejected | It splits replay, quota attribution, encrypted envelope handling, and retention from the established v1.1 pipeline. |

The first design is the smallest honest design, but it is not a small D1
migration. The dedicated-table approach becomes attractive only as a future
deliberate rewrite of the whole contribution principal model, outside this
accountless bridge.

## Correct data-model contract

The retained table name `participants` would become an internal contribution
principal carrier, with an explicit `owner_kind`. It does not make an
accountless principal a person.

| Field group | `owner_kind = 'social'` | `owner_kind = 'accountless'` |
| --- | --- | --- |
| Social access/recovery IDs and hashes | Required, unchanged | `NULL` |
| `consent_version`, `consented_at` | Required, unchanged | `NULL` |
| Social identity-link/cooldown/deletion-session fields | Existing social rules | `NULL` |
| Stable internal principal ID | Existing participant ID | Fresh internal owner key, never returned to the client |
| `created_at` | Existing timestamp | Actual creation timestamp, not consent evidence |
| Attribution namespace | Existing trigger/table | Existing trigger/table, used only for the private v1.1 account namespace |

The fresh internal owner key is a database reference for one installation. It
is not an access token, recovery token, social account identifier, pairing,
or session. The existing ledger `device_id` remains the authenticated
installation identity, and the client never receives either the internal
principal key or a second secret.

The same migration would make `device_credentials` typed rather than inferred:

| Field | Social credential | Accountless credential |
| --- | --- | --- |
| `authority_kind` | `social` | `accountless` |
| `paired_via_pairing_id` | Required | `NULL` |
| `accountless_enrollment_device_id` | `NULL` | Required active ledger ID |
| `social_verified_at` | Required | `NULL` |
| `expires_at` | Existing bounded social lifecycle | Exact ledger expiry; no sliding renewal |

Two dedicated policy tables remain necessary:

- `accountless_upload_owners` binds one ledger installation to one internal
  principal and one direct device credential. It records the fixed policy
  version, authorization basis, actual policy-authorization time, and
  active/revoked state.
- `accountless_v11_device_authorizations` binds that same pair to the fixed
  v1.1 telemetry schema, field dictionary, and privacy contract. It is a
  policy authorization record, never a consent record.

All shape checks must require the complete social or accountless form. An
accountless row may never acquire social fields, and a social row may never
acquire accountless fields. Existing social rows must be restored byte for
byte in their original semantic columns.

## Required protected-path behavior

Every protected operation must identify the credential authority first. For a
social credential, retain the current social verification and ongoing-consent
predicates unchanged. For an accountless credential, require all of:

1. matching ledger device ID and constant-time device-secret hash;
2. ledger state `active` and its fixed expiry later than the operation time;
3. active, matching `accountless_upload_owners` row;
4. active, matching v1.1 policy authorization for v1.1 operations; and
5. active accountless principal and direct credential.

That check is needed for device authentication, upload-authorization
issuance, upload claim/receipt update, manifest admission, chunk admission,
predecessor issuance, and domain activation. It cannot be only an ownership
grant check.

The ownership endpoint must be Device-authenticated against the ledger. Its
strict four-field request and closed receipt remain as implemented in the
non-routed Worker contract module. An identical retry returns the original
unexpired receipt; a mismatched request conflicts; an expired or revoked
ledger never recreates an owner. Accountless credentials cannot enter social
pairing, session, recovery, rotation, public-source, or legacy v0.1/v1.0
paths.

Ledger revocation must revoke the accountless owner, direct device
credential, and unused/consuming upload authorizations in the same D1
transaction. Accountless principal erasure must revoke the ledger first, so
deletion remains authoritative even if an old device bearer is retried.

## D1 `ALTER COLUMN` capability probe

Upstream SQLite now supports `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`:
the [official SQLite ALTER TABLE reference](https://www3.sqlite.org/lang_altertable.html#alter_column)
states that this was added in SQLite 3.53.0 on 2026-04-09. That upstream fact
does not establish the capability of the D1/workerd runtime used by this
project.

On 2026-09-05, the installed local Worker test stack
(`@cloudflare/vitest-pool-workers` 0.18.8, Miniflare 4.20260722.0, workerd
1.20260722.1) was given a fresh reset D1 binding and the existing migrations
through `0046`. The
disposable fixture seeded a social `participants` → `web_sessions` →
`device_pairings` → `device_credentials` graph, then tried the first real
direct alteration:

```sql
ALTER TABLE participants ALTER COLUMN access_token_id DROP NOT NULL;
```

`D1Database.exec` rejected it before any candidate DDL ran with:

```text
D1_EXEC_ERROR: ... near "ALTER": syntax error
```

The D1 binding also rejects `SELECT sqlite_version()` as an unauthorized
function, so a SQL version string is unavailable there. The
parser result is the relevant capability evidence: the currently installed
local D1/workerd runtime does not accept `ALTER COLUMN DROP NOT NULL`. No
remote D1 was inspected. The temporary fixture and probe were discarded.

Adding an owner-kind column with a column `CHECK` and creating shape triggers
would be additive in principle, but neither can make a required social column
nullable when the runtime rejects the prerequisite `ALTER COLUMN` syntax.
Complex social-versus-accountless row shape also requires reviewed
insert/update triggers rather than a new table-level `CHECK`. Reconsider this
smaller path only after the exact D1/workerd target accepts the statement in a
fresh synthetic parity test; do not assume Node's SQLite capability transfers
to D1.

## Why this is currently a broad migration

For the tested D1 runtime, making the accountless social fields nullable still
requires rebuilding `participants`; the direct upstream SQLite alternative is
not available. That parent table has dependent foreign keys in the existing
contribution, identity, device, upload, v1/v1.1, attribution, admission,
recovery, community, and cache tables. Rebuilding `device_credentials` adds
its own dependent upload, rotation, v1/v1.1, predecessor, and domain graph.

Before any executable migration is written, the exact local post-`0046`
schema must be inventoried with `PRAGMA foreign_key_list` and every dependent
table, trigger, index, and view must be classified as one of:

- copied and restored with an explicit column list;
- recreated unchanged, verified against the current source; or
- changed by a short reviewed owner-kind predicate.

The earlier device-only snapshot list is insufficient. A candidate migration
must snapshot and compare all pre-existing rows that reference either rebuilt
parent, including social identity/session/recovery records and all retained
telemetry, not merely the tables used by the new accountless path.

## Verified post-0046 dependency inventory

On 2026-09-05, a local `node:sqlite` `:memory:` database applied only the
existing migrations `0001` through `0046_accountless_enrollment_ledger.sql` in
order. It did not create a new migration, start a Worker, contact D1, or use
any non-synthetic data. Foreign keys were enabled and `PRAGMA
foreign_key_check` returned no rows.

That fresh schema contains 67 tables, 5 views, and 86 triggers. A static scan
of the stored view and trigger definitions finds 48 objects that reference one
or more of the ownership roots below: 3 views and 45 triggers. The fresh
schema has zero rows in every ownership/upload root listed here. It does have
the normal migration seed/control rows in ten unrelated tables, so these are
schema observations, not claims about any existing D1 database or its row
counts.

`PRAGMA foreign_key_list` gives this direct-child inventory. Counts are direct
foreign-key children of the root in the first column; a table can correctly
appear in more than one row.

| Root table | Direct children | Exact child tables |
| --- | ---: | --- |
| `participants` | 30 | `attribution_enrollments`, `community_allowance_fit_cache`, `community_analytical_input_versions`, `community_model_composition_cache`, `contributions`, `device_credential_rotations`, `device_credentials`, `device_pairing_events`, `device_pairings`, `device_upload_authorizations`, `enrollment_grants`, `participant_community_eligibility`, `recovery_retry_receipts`, `telemetry_contribution_admission_windows`, `telemetry_contributions`, `telemetry_records`, `telemetry_transport_floor_rollbacks`, `telemetry_transport_participant_floors`, `telemetry_v11_chunks`, `telemetry_v11_day_manifests`, `telemetry_v11_device_consents`, `telemetry_v11_domain_heads`, `telemetry_v11_domain_predecessors`, `telemetry_v11_domains`, `telemetry_v1_chunk_admission_windows`, `telemetry_v1_chunks`, `telemetry_v1_device_consents`, `telemetry_v1_records`, `upload_authorizations`, `web_sessions` |
| `device_pairings` | 2 | `device_credentials`, `device_pairing_events` |
| `device_credentials` | 10 | `device_credential_rotations`, `device_upload_authorizations`, `telemetry_v11_chunks`, `telemetry_v11_day_manifests`, `telemetry_v11_device_consents`, `telemetry_v11_domain_predecessors`, `telemetry_v11_domains`, `telemetry_v1_chunk_admission_windows`, `telemetry_v1_chunks`, `telemetry_v1_device_consents` |
| `device_upload_authorizations` | 4 | `contributions`, `telemetry_contributions`, `telemetry_v11_chunks`, `telemetry_v1_chunks` |
| `telemetry_v11_day_manifests` | 3 | `telemetry_v11_chunks`, `telemetry_v11_domain_days`, `telemetry_v11_records` |
| `telemetry_v11_chunks` | 1 | `telemetry_v11_records` |
| `telemetry_v11_records` | 0 | None |
| `accountless_enrollment_ledger` | 0 | None |

The zero direct children for `accountless_enrollment_ledger` confirm that
`0046` creates an enrollment boundary only. There is no current foreign-key
path from a ledger credential to device upload authorization, v1.1 manifest,
chunk, receipt, quota, or retry state. A routed ownership grant therefore
cannot truthfully become upload authority without an approved schema change.

The critical non-FK dependency surface includes the existing active-principal
and consuming-upload guards (`device_credentials_require_active_pairing`,
`device_upload_authorizations_require_active_device`,
`contributions_require_active_participant`,
`contributions_require_consuming_upload`,
`telemetry_contributions_require_active_participant`,
`telemetry_contributions_require_consuming_upload`,
`telemetry_v1_chunks_require_active_participant`,
`telemetry_v1_chunks_require_consuming_upload`), the v1.1 consent/manifest/
chunk/record admission and immutability triggers, and the three relevant
views: `telemetry_analytical_chunks`, `telemetry_v11_active_records`, and
`telemetry_v11_current_predecessors`. The candidate review must enumerate the
other 37 matching trigger definitions as well, including community,
attribution, withdrawal, domain, identity-cooldown, transport-floor, and
session guards; an FK-only restore plan would omit them.

For a later approved local rehearsal, record actual target counts before the
candidate migration with an explicit query such as the following, then retain
the resulting IDs, hashes, digests, and canonical payload bytes alongside the
row-count receipt. This is review-only SQL and has not been run against any
non-synthetic database.

```sql
SELECT 'participants' AS table_name, COUNT(*) AS row_count FROM participants
UNION ALL SELECT 'device_pairings', COUNT(*) FROM device_pairings
UNION ALL SELECT 'device_credentials', COUNT(*) FROM device_credentials
UNION ALL SELECT 'device_upload_authorizations', COUNT(*) FROM device_upload_authorizations
UNION ALL SELECT 'contributions', COUNT(*) FROM contributions
UNION ALL SELECT 'telemetry_contributions', COUNT(*) FROM telemetry_contributions
UNION ALL SELECT 'telemetry_v1_chunks', COUNT(*) FROM telemetry_v1_chunks
UNION ALL SELECT 'telemetry_v11_day_manifests', COUNT(*) FROM telemetry_v11_day_manifests
UNION ALL SELECT 'telemetry_v11_chunks', COUNT(*) FROM telemetry_v11_chunks
UNION ALL SELECT 'telemetry_v11_records', COUNT(*) FROM telemetry_v11_records
UNION ALL SELECT 'accountless_enrollment_ledger', COUNT(*) FROM accountless_enrollment_ledger;
```

## Required local rehearsal evidence

The sole allowed target after explicit approval would be a fresh,
disposable Miniflare D1 database. No remote database is involved.

1. Apply migrations through `0046`; seed social rows spanning the full
   participant/device dependency graph, including v1.1 encrypted usage and
   quota chunks, upload receipts, and a domain head.
2. Record per-table row counts plus canonical IDs, hashes, digests, and
   canonical byte values for social records before the candidate migration.
3. Apply the candidate only to that disposable database. Verify every
   preserved table, `PRAGMA foreign_key_check`, and all recreated
   trigger/view definitions.
4. Run the existing social device, replay, consent, domain, recovery,
   erasure, and public-source tests unchanged.
5. Through real Worker `handleRequest` and synthetic bindings, run enrollment
   → Device-authenticated ownership → sync capabilities → encrypted v1.1
   usage/quota upload → lost-response duplicate retry → activation. Verify
   quota attribution uses the same installation namespace and no public
   selector includes the accountless owner.
6. Revoke and expire the ledger, disconnect the device, and erase the owner.
   Each operation must reject every protected path listed above; a renewal or
   duplicate request must not recreate a revoked owner.

The rollback for a failed rehearsal is deletion of the disposable test
database. No production rollback is proposed because no production operation
is in scope.

## Approval needed before executable work

No executable `0047` migration or routed ownership endpoint should be added
under the original narrow approval request. The correct design requires an
explicitly reviewed source migration that rebuilds `participants`,
`device_credentials`, and every dependent local D1 object needed to preserve
the social graph. Any future authorization must state that it permits source
SQL and rehearsal only against fresh synthetic Miniflare/D1 fixtures; it must
continue to exclude remote D1, deployment, live traffic, credentials, and
hosted activation.
