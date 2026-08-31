---
title: Native 0.1.17 signed dogfood integration
date: 2026-08-30
type: plan
status: in-progress
---

# Native 0.1.17 signed dogfood integration

Prepare one testable native macOS candidate through the existing
`internal-dogfood` lane. This is not a stable publication, hosted deployment,
Electron release, or new signed-Preview workflow. Source integration, tests,
state migration, signing, installation, and native verification are separate
gates; none is complete merely because an earlier gate passed.

## Source boundary

The last installed Preview was built from `b7112217` (PR #80, with #81 already
included). The initial refreshed integration base is `origin/main` at
`1e696691`. The shared working checkout contains concurrent native work and
must remain untouched by integration.

| Change | Initial disposition | Gate before candidate freeze |
| --- | --- | --- |
| #80 published speed-mode API accounting and #81 native release preparation | Already in last build | Retain; revalidate integrated behavior |
| #83 orphaned-fork lineage guard | In current main | Include and run ingestion regression coverage |
| #84 dark cache tooltip | In current main | Include and verify rendered contrast |
| #85 internal tool-history warning | In current main | Include and verify dashboard state |
| Compact accounting headings, five-column cache table, quieter partial-coverage copy | Local task changes | Review, test, commit, PR and merge |
| #88 native menu history retained during refresh and popup dismissal | Merged as `41c02dd2`; integrated | Revalidate the signed native artifact, including physical clicks |
| #87 local cache-drop thread links | Explicitly included; merged as `a864d159` from `ce0aacd6` | Reconcile five-column compact layout, test transient name lookup and native handoff; final integrated R7 remains here |
| #86 participant self-service deletion retirement | Ready/merged handoff supersedes draft-only exclusion; include `9b121b7d` | Reconcile integrated source and native/consent checks; no hosted deployment or production deletion is authorized here |
| #75 stacked native popup PR | Native popup already ported into release source | Do not merge excluded Electron ancestry |
| #73, #74, Electron delivery, Linux integration and Claude Code integration | Excluded | No scope expansion without a new decision |
| Credential-lifetime branch | Unreviewed, uncommitted work remains | Do not silently absorb into this candidate |

Take a fresh PR/main snapshot before freezing. Identify newly included source
explicitly; do not indefinitely follow unrelated active branches.

The selected source set is now frozen through main's `9b121b7d` (#86), including
#87 and #88, plus this task's compact-accounting changes. Further unrelated PRs
are not automatically included in the retained validation run.

## Execution and acceptance

1. Reconcile PRs and local work into an isolated integration checkout. Preserve
   unrelated changes and coordinate file ownership with the active tasks.
2. Run focused UI, ingestion, companion and native tests. Resolve integration
   regressions before the expensive retained gates. Inspect the real rendered
   target; a browser result alone does not qualify the native shell.
3. Freeze the candidate source. Run the retained root, Worker, macOS and contract
   gates as required by the release runbook. Check R7 freshness and regenerate
   the protected dual-runtime receipts only on the integrated source. Capture
   explicit exits and unresolved decision dimensions.
4. Follow the maintained migration runbook: stop the stable-state writer,
   preserve the exact database, salt and provenance, and rehearse forward
   migration against a disposable copy. Compare integrity, generation, counts,
   accounting and cursor coverage. Do not copy Preview state into stable.
5. Commit and merge the reviewed result, then create one exact annotated
   `tibotattle-internal-dogfood-0.1.17-rcN-source-YYYYMMDD` tag. Use the reviewed
   channel allocation (build `1023`), clean source and retained release finalizer.
   Signing and notarization are authorized; public updater/release publication
   and hosted deployment are not part of this task.
6. Install only the verified signed artifact with a recoverable prior-app and
   state backup. Verify actual native menus, refresh retention, accounting,
   signature, source identity, loopback health and Keychain-backed review
   preparation. Do not approve consent, pair or upload on the user's behalf.

## Operational authorities

- [macOS release runbook](../runbooks/macos-stable-release-runbook.md)
- [Unified index preservation and recovery](../runbooks/unified-index-recovery.md)
- [R7 receipt maintenance](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md)
- [Native app lifecycle and distribution](../../apps/macos/README.md)

## Evidence and remaining gates

Fresh main/PR inventory and isolated integration checkout established. Local
compact-accounting changes were committed as `309eae90` after 27 focused and
376 full UI tests, documentation checks and preflight passed. PR #87 is merged
and reconciled with that layout; all 396 combined UI tests passed. PR #88 is
integrated, and the native source gate passed 54 tests with its three designated
artifact exclusions. Their protected R7 freshness failures belong to this final
integrated gate. The source-only native timeout retry and physical click-through
limitation remain distinct from release qualification. On 2026-08-31 UTC the
#86 owner supplied the verified merged-source handoff; its earlier draft-only
exclusion is superseded. Source integration does not retire the live hosted
endpoint, and the separate owner-access, privacy-intake and retention cutover
requirements remain in force.

At the initial frozen head `04a88f2c`, the combined UI gate passed 412/412,
the companion gate 274/274, and the retained native gate 65/65. The complete
Worker gate passed, including 422 Worker tests, 174 script tests and both
dry-run bundles, after legitimate no-installer public-site inputs were prepared
from the clean tree. Earlier dirty-tree and missing-generated-site refusals
were setup failures, not passing dry runs. No hosted deployment occurred.

The first complete root run reported 3,199 passes, five failures and 21 skips
from 3,225 tests. Two failures were stale protected R7 receipts. The other three
were permission-fixture setup failures caused by launching tests under an
owner-only umask; their unchanged test files passed all 35 tests under the
normal fixture umask. Preserve owner-only log creation separately from the test
process umask. After the context-pricing correction and protected R7
regeneration, the final full root run exited zero: 3,210 passed, 17 designated
skips, no failures or cancellations, from 3,227 tests in 410 seconds. No
assertion, timeout or test was weakened.

Copy-first schema-9 to schema-11 migration and the subsequent accounting
rebuild completed successfully on `04a88f2c`, with SQLite integrity, generation
provenance, source-cursor and original-backup checks passing. Fixed-cutoff
historical usage aggregates and every UTC-day aggregate were identical; the
collector observation aggregates were unchanged. A third-copy incremental
replay completed without a cold rebuild or any removed/changed prior usage
event. Late-discovered source segments explain its additions exactly; this is
not a claim that the changing live corpus has identical whole-period totals.

The final projection comparison then exposed a genuine context-pricing gap:
the full-history headline/timeline omitted reported input context and used a
different missing-context fallback from the replay-safe cache. The narrow
projection correction now passes 155 focused tests, including same-generation
full-snapshot/history/timeline parity. It preserves the existing `legacy_zero`
policy and does not change price cards, cache semantics, ingestion or schema.
The corrected real-copy projection comparison exited zero on `1335a548`:
all four periods agree on event counts, token components and parent Standard
API-equivalent totals against the same-generation cache. Existing per-model
rounding can still differ by one millionth of a dollar; this is not a claim
that every rounded subfield is byte-identical. Covered overhead subtotals remain
available and the one local-order coverage gap remains explicit. The final
companion gate passed 276/276; architecture, installed Codex contract and
release-note checks also passed. The retained native gate then passed 65/65
with no skips or cancellations in 197 seconds on this corrected source.

Protected R7 regeneration completed on 2026-08-31 UTC with exit zero after
approximately 39 minutes. All ten receipts were regenerated and validated;
freshness tests passed 2/2 separately on the exact pinned Node 24.14.0 and
26.2.0 runtimes. Outcomes, operation statuses, retained boundary matrices,
privacy, preservation and network-evidence states are unchanged. Each
runtime's repeated projections agree, but whole artifact hashes differ across
runtimes as they did previously. The source-scan projection hashes counts,
completion and providers, not logical rows; it does not prove baseline
row-level identity. Source-plan identity, runtime provenance and encoded-byte
measurements also participate in artifact hashes.

Both R7 decisions remain `release_open`, with 19 unresolved decisions each;
the retained promotion limits are not waived by fresh receipts or passing
tests. Three operations recorded one failed RSS sample each while retaining
successful samples and lifetime-peak enforcement. An unexplained Node 26
pressure-scan lifetime-RSS increase from 580,190,208 to 1,073,233,920 bytes
remains below the 1,610,612,736-byte ceiling. Record this measurement drift
without calling it either a proven regression or harmless noise. This is
internal-dogfood evidence, not stable-release qualification.

Existing Developer ID and notarization configuration authenticated successfully
without signing or submission. The prior signed 0.1.16 dogfood DMG and receipt
were located and its checksum matched. A schema-9 preservation copy alone is
not a working rollback for an old reader that only supports schema 8; do not
launch that reader against the newer state. Before normal installed launch,
check whether existing consent, pairing or a pending sign-in can automatically
resume contribution. Normal installed launch is held for the owner's direction
about any automatic pairing or upload; do not alter consent as a workaround.
Credential-free, empty-profile artifact smokes do not qualify real Keychain or
normal signed-in operation.

Signing, installation and release publication have not yet been completed for
this source set. Private state records, comparisons, UI captures and release
inputs remain local and outside tracked docs.
