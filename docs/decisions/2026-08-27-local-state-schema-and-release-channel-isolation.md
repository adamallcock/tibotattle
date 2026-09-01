---
title: Local state schema and macOS release-channel isolation
date: 2026-08-27
type: decision-record
status: accepted
---

# Local state schema and macOS release-channel isolation

> **Current schema amendment:** the Preview/stable identity boundary in this
> decision remains current. Its schema-10 target is a predecessor to the
> accepted [schema-11 cleanup-index decision](./2026-08-28-local-unified-index-v11-cleanup-indexes.md),
> which is the physical format for the final 0.1.17 candidate.

## Context

An ad-hoc `preview_distribution` build of TiboTattle 0.1.16 was installed at
the stable `/Applications/TiboTattle.app` path. It shared the stable bundle
identifier, URL scheme, preferences, state root, and updater feed, while its
sealed updater policy prohibited automatic-update opt-in. Separately, that
older binary supported unified-index schema 8 and refused a healthy schema 9
index created by newer code. The UI reduced the generic refusal to blank charts
and zero-looking accounting cards. The refusal offered no byte-preservation
guarantee: 0.1.16 opened the file writable and selected SQLite
`journal_mode=DELETE` before it validated and rejected the unsupported schema,
so it could touch the index while refusing it.

The installed preview used `CFBundleVersion` `1`. Retained signed artifacts
also show a legacy stable value of `0.1.16` and a same-identity internal-dogfood
value of `1022`. A replacement ordering scheme therefore has to clear all
three histories, not just the preview build.

The retained index was not empty or corrupt. Copy-based inspection found a
healthy generation with 623,104 usage events, 842,959 quota occurrences, and
800,028 typed tool facts. A transactional schema 9 to 10 migration and a
generation-bound accounting rebuild on the copy preserved those counts. The
shipping upgrade path must also begin from the schema-8 format actually emitted
by 0.1.16. This decision accepted schema 8 or 9 as recognized transition
inputs; the final schema-11 candidate additionally accepts schema 10.

## Decision

### One stable identity, one isolated preview identity

Stable TiboTattle retains its existing application name, bundle identifier,
URL scheme, preferences, state directory, and stable Sparkle feed. A preview
uses a visibly different application name and every machine identity is
separate:

| Boundary | Stable | Preview |
| --- | --- | --- |
| Application | `TiboTattle.app` | `TiboTattle Preview.app` |
| Bundle identifier | `com.usagemonitor.local` | `com.usagemonitor.local.preview` |
| URL scheme | `usagemonitor` | `usagemonitor-preview` |
| State directory | `Usage Monitor` | `Usage Monitor Preview` |
| Keychain service namespace | `app-usagemonitor.*` | `app-usagemonitor.preview.*` |
| Keychain account | `installation` | `preview-installation` |
| Updater | Signed stable/dogfood policy | No automatic opt-in; never replaces stable |

The preview installer refuses stable destinations even when replacement flags
are supplied. Its plist seals the reviewed Keychain namespace/account pair to
the preview bundle identifier, and the companion accepts no arbitrary pair. A
preview may not read, migrate, reset, delete, write, or claim stable state.

### Schema versions are compatibility contracts

`PRAGMA user_version` remains the physical schema revision. Beginning with
0.1.17, the unified index also stores explicit format, minimum-reader, and
minimum-writer versions in its metadata. Compatibility-aware code inspects both
layers through a read-only handle before opening an existing file writable.

- A known older version is never modified in place. The app either migrates a
  staged copy transactionally or, when source-identity semantics changed,
  rebuilds a validated current-schema stage from readable raw history.
- A newer format or a reader/writer requirement above the running binary is a
  typed `local_unified_index_schema_newer` outcome.
- A newer-schema refusal is byte-for-byte non-mutating. The app never stamps
  older compatibility metadata over a newer writer's contract.
- There is no automatic downgrade. A bad release is repaired by a newer
  compatible build or an explicit, receipt-bound recovery operation.
- Migration tests cover every supported predecessor, rollback on injected
  failure, and non-mutation for future schema metadata.

These guarantees do not apply retroactively to the shipped 0.1.16 binary. Once
schema 8 or 9 has migrated to schema 10, 0.1.16 must not reopen that index: it
lacks the typed newer-schema outcome and may touch SQLite journal mode before
its generic rejection. Rollback therefore uses a preserved pre-migration copy,
a newer compatible build, or the explicit receipt-bound recovery path; it does
not point 0.1.16 at migrated v10 state.

The same boundary applies after the final schema-11 migration. Schema 10 is a
supported input to the newer compatibility-aware migration; it is no longer
the final 0.1.17 physical format.

This is normal embedded-database practice: forward migrations are expected;
silent downgrade and arbitrary cross-version writes are not.

### Missing evidence is unavailable, not zero

The local companion carries the typed newer-schema reason to the browser. A
terminal compatibility failure does not say indexing is still advancing. Cost,
weekly, timeline, and tool values that cannot be justified are marked
unavailable.

The companion may persist one bounded, owner-only last-authoritative dashboard
snapshot. It is eligible only when it is generation-bound to the unified index
and its displayed fields meet their evidence contracts. A later incompatible
or failed refresh may show those values as retained, including their original
coverage time and a terminal warning; it may not relabel them as current.
Corrupt, oversized, partially written, or non-owner-only snapshots are ignored.

### Recovery is copy-first and explicitly applied

The supported recovery path has separate prepare and apply phases:

1. stop the application writer before preparation and keep it stopped;
2. make a consistent, owner-only rollback copy and prove the source did not
   change around that copy;
3. build or migrate a separate candidate;
4. validate SQLite integrity, foreign keys, schema compatibility, generation
   attestation, and declared versus actual counts;
5. write a content-free owner-only receipt binding source, rollback copy, and
   candidate identities; and
6. only after explicit path and stopped-app confirmation, acquire the apply
   lock, revalidate every identity immediately before an atomic replacement,
   and preserve the exact pre-replace file as rollback material.

The command never deletes raw Codex history. Retired build residue is a
separate, destructive lifecycle operation and is not part of schema repair.

### Release identity is monotonic

`CFBundleShortVersionString` follows the package SemVer. Signed builds that
retain the stable bundle identifier use an explicit, checked-in monotonic
allocation: 0.1.17 internal dogfood is `CFBundleVersion` `1023`, and the
0.1.17 stable final is `1024`. Both clear the observed shared-identity
dogfood build `1022`; the stable final also orders after the dogfood candidate.
Release tooling refuses a signed version/channel without an owner-reviewed
allocation, and an environment value can only assert the exact allocation.

#### Allocation amendment, 2026-08-31

The `1023` paragraph above records the first 0.1.17 dogfood allocation. RC2 used
build `1023`, RC3 used `1023.1`, and the signed, notarized, installed
startup-recovery RC4 used `1023.2`. The integrated RC5 allocation is now
`1023.3`; stable remains reserved at `1024`. Each increment retains the same
production bundle identity and therefore must be monotonic. RC4 evidence applies
only to its frozen source and is not inherited by RC5 or stable.

#### Allocation amendment, 2026-08-31 (RC6)

RC5 build `1023.3` was subsequently signed, notarized, installed, and then
failed its real full-accounting refresh gate because the ordinary five-minute
deadline terminated a healthy v0.14 cache rebuild. The corrected RC6 dogfood is
allocated `1023.4`, strictly after installed RC5 and before reserved stable
`1024`. RC5 artifact evidence remains evidence for RC5 only; it cannot qualify
RC6 or stable.

#### Allocation amendment, 2026-09-01 (RC7)

RC6 build `1023.4` was subsequently signed, notarized, installed, and refreshed
against preserved schema-11 state. Its real accounting rebuild ran past five
minutes and reached terminal refresh success, proving the RC5 deadline defect
was corrected. The installed result then exposed an inherited
`recent_7d_indexing` legacy checkpoint suppressing otherwise-authoritative
unified accounting. RC7 removes only that retired collector checkpoint while
retaining the fail-closed `unifiedGenerationAuthoritative` predicate and all
generation, completeness, resource, and atomic-publication guards. Its monotonic
internal-dogfood allocation is `1023.5`, strictly after installed RC6 and before
reserved stable `1024`. RC6 artifact evidence remains evidence for RC6 only;
RC7 requires fresh exact-source, R7, artifact, replacement, and installed checks.

The separately identified Preview app uses the deterministic migration epoch
`(2000 + major).minor.patch`, so preview package `0.1.17` maps to
`2000.1.17`. That keeps local preview builds deterministic and valid within
Apple's component bounds without advancing or stranding the stable Sparkle
line, because Preview has a different bundle identifier and feed. A zero-first
legacy stable value is admissible only as a previous-manifest migration input;
new candidates and feeds use Apple's strict positive-first release-build
grammar.

## Consequences

- Installing a stable compatible upgrade advances local data through a staged
  migration or staged rebuild; no reset or database deletion is expected.
- Compatibility-aware builds report a newer index actionably and, when
  available, may show a clearly retained projection. Shipped 0.1.16 is excluded
  from this guarantee and must not be reopened against migrated schema 10 or 11.
- Development and preview work can no longer overwrite or silently share the
  stable application or its state.
- Source fixes, a locally built artifact, signed installation, appcast
  publication, and a proven N to N+1 update remain distinct gates under the
  existing release-recovery policy.

## Related documents

- [macOS stable release runbook](../runbooks/macos-stable-release-runbook.md)
- [Unified local index schema](../reference/unified-index-schema.md)
- [Local unified-index recovery](../runbooks/unified-index-recovery.md)
- [Local unified index v11 cleanup indexes](./2026-08-28-local-unified-index-v11-cleanup-indexes.md)
