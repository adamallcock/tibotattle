---
title: Hosted migration lineage reconciliation for 0.1.18
date: 2026-09-04
type: review
status: reviewed
---

# Hosted migration lineage reconciliation for 0.1.18

## Scope and evidence boundary

This review records the source-lineage decision for the local
`codex/release-0.1.18` branch and the coordinating release task's retained,
read-only metadata observations on 2026-09-04. It does not authorize or prove
remote migration, deployment, new consent, or publication. The maintained
[production operations runbook](../runbooks/production-operations.md) remains
the operating authority.

The production migration ledger and the former checked-in sequence diverged at
`0041`. The two filenames describe different schemas, not a rename or alias.
Preserving applied history and adding a uniquely numbered forward sequence
resolves the inspected lineage without changing the exact-prefix fail-closed
deployment policy.

## Verified source provenance

The historical `0041_community_model_composition_cache.sql` was introduced by
`4519b3494a0cdd4e746bea08d492a0a294190cb2`. Its Git blob is
`c2bfe59f10ca4bef2e51ff33cb4824165fb045b0`; deployed source
`b4c8f103bf697fb530434e6de196f2c187645661` contains that same blob. It adds the
nullable `model_observations_json` column to `community_allowance_fit_cache`,
creates the singleton `admin_community_allowance_preview_refresh_state` table,
and seeds its initial retry timestamp.

The coordinating task also compared all restored primary SQL files `0001`–
`0041` against that deployed source: **41 of 41 files matched byte-for-byte**,
with zero mismatches. This establishes the inspected source prefix; it is not
a substitute for rechecking a target's applied ledger before migration.

The distinct `0041_community_model_composition.sql` was introduced by
`7402aa23860e5f44dc0965550375171daaab6f59` and hardened by
`7f2f1b102a2f7c996fecf3306f3334b30308b448`. The hardened SQL blob is
`7b6cd496cd011e3ad2babf9335651b5846e02dce`. It creates the per-participant
`community_model_composition_cache`, the aggregate
`community_model_composition_days`, and the
`community_model_composition_day_withdrawal` privacy trigger. The following
analytical-fencing migration alters these new tables, so the historical `0041`
cannot substitute for this migration or allow it to be skipped.

## Read-only environment observations

The coordinating release task retained and reviewed metadata-only receipts:

- Production had 41 sequential ledger rows, ending with the historical
  `0041_community_model_composition_cache.sql`.
- The new composition tables and withdrawal trigger were absent; attribution
  schema-presence flags were `0`. Those absence flags are not consent settings
  or an instruction to change collection state.
- The project-scoped database inventory showed the production database, the
  independent deletion ledger, and the separate dogfood release-guard database.
  The configured staging databases were absent from that inventory.
- Every inspected SQL receipt reported `rows_written: 0`. No remote state was
  changed by this investigation or local reconciliation.

These observations cover only the inspected account, project resources, and
configuration at that time. They do not establish that unknown independent
deployments or other accounts have no alternative applied history. Read-only
receipts remain local; this review includes no database IDs, payload rows,
credentials, or private account metadata.

## Accepted local forward sequence

Restore the historical `0041` with its exact original filename and SQL bytes.
Move the four unapplied source migrations forward one number without changing
their SQL bytes:

| Previous source filename | Reconciled source filename |
|---|---|
| Historical applied migration, absent from the former source sequence | `0041_community_model_composition_cache.sql` |
| `0041_community_model_composition.sql` | `0042_community_model_composition.sql` |
| `0042_analytical_input_fencing.sql` | `0043_analytical_input_fencing.sql` |
| `0043_attribution_transport_staging.sql` | `0044_attribution_transport_staging.sql` |
| `0044_attribution_domain_activation.sql` | `0045_attribution_domain_activation.sql` |

The primary source sequence is now `0001`–`0045`. Unique numeric prefixes avoid
the inconsistent tie ordering that two different `0041` filenames would create
across the production guard, staging inventory, and migration runner. The
independent deletion-ledger sequence is unchanged.

Do not modify an applied ledger, create a generic alias exception, ignore an
unknown filename, or relax ordered-prefix validation. An environment that
already applied any of the former new `0041`–`0044` filenames must stop for a
separate exact-history reconciliation before this sequence can be used there.

## Qualification and remaining gates

The local implementation must retain byte-identity checks, fresh-schema replay,
and a production-shaped upgrade rehearsal starting with `0001`–`0040` plus the
historical `0041`. Regression coverage must prove exact pending `0042`–`0045`
discovery, rejection of the alternative ledger, the new composition deletion
and withdrawal protections, and the attribution schema and staged-consent
boundaries. Historical plan results and published 0.1.17 release text retain
their original numbering; maintained instructions use the reconciled sequence.

On 2026-09-04, the three focused script files (`staging-readiness.check.mjs`,
`production-deploy.check.mjs`, and `release-preflight.check.mjs`) passed all
59 tests against the local reconciled tree, including the hermetic real-Wrangler
fresh migration and no-op rerun of both D1 streams. The initial sandboxed run
failed at the local runtime's bind-permission boundary; the identical suite
passed with local execution permission. No test was skipped or weakened, and
the fixture explicitly rejects remote migration or deploy commands. The
documentation check also passed (143 Markdown and 658 source/config files).

These local results do not prove the full Worker gate or a migrated service.
Exact pre-apply remote ledger/schema inspection, separately authorized production
migration with backup/rollback analysis, post-migration verification, Worker
deployment, and publication remain distinct gates. Source renumbering does not
activate v1.1, grant consent, or qualify a public release.
