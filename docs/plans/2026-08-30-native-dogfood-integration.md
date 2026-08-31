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
| Native menu history retained during refresh and popup dismissal | Concurrent appbar task | Await owned commit/PR and validation handoff |
| #87 local cache-drop thread links | Draft at `ce0aacd6`; owner completing CI/UI checks | Owner to merge source-only when ready; final integrated R7 remains here |
| #86 participant self-service deletion retirement | Explicitly excluded after owner handoff | Draft has remaining root/benchmark gates and separate hosted/privacy decisions; no inclusion absent a later ready handoff |
| #75 stacked native popup PR | Native popup already ported into release source | Do not merge excluded Electron ancestry |
| #73, #74, Electron delivery, Linux integration and Claude Code integration | Excluded | No scope expansion without a new decision |
| Credential-lifetime branch | Unreviewed, uncommitted work remains | Do not silently absorb into this candidate |

Take a fresh PR/main snapshot before freezing. Identify newly included source
explicitly; do not indefinitely follow unrelated active branches.

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
compact-accounting changes have been transferred without altering the shared
checkout. The appbar owner is resolving a compiled native smoke failure before
handoff. The #87 owner will not run a competing R7 generation or app install.
No candidate tests, R7 regeneration, signing, migration, installation or release
publication have been completed for this source set. Private state records and
release inputs remain local and outside tracked docs.
