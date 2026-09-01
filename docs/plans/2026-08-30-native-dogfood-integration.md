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

The current candidate state is the RC7 amendment at the end of this plan.
Earlier RC4, RC5, and RC6 sections preserve their checkpoint evidence and are
not current build allocations.

The installed RC4 source is `735a59ce`, build `1023.2`. Its prompt-free Keychain
foundation, approved recovery boundary, and qualification are recorded in the
[silent-migration decision](../decisions/2026-08-31-silent-keychain-migration.md).
RC4 is signed, notarized, and installed, but it was intentionally frozen before
account/plan PR #94 and therefore does not qualify current main or stable. The
integrated release-preparation base is `origin/main` at `3b0f2d23` (PR #96).
Its current R7 workload-source closure now has fresh protected receipts, whose
decision remains `release_open`; native/allocation source review and RC5 artifact
evidence are outside that closure and remain separate and pending.

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
| #87 local cache-drop thread links | Explicitly included; merged as `a864d159` from `ce0aacd6` | Reconcile five-column compact layout, test transient name lookup and native handoff; revalidate against the fresh R7 workload receipts |
| #86 participant self-service deletion retirement | Ready/merged handoff supersedes draft-only exclusion; include `9b121b7d` | Reconcile integrated source and native/consent checks; no hosted deployment or production deletion is authorized here |
| #75 stacked native popup PR | Merged into the Windows/Electron branch, not main; native functionality already ported by #81 | Verified native parity on `c111fded`; do not merge excluded Electron ancestry |
| #89 server-computed per-model allowance series | Merged into main as `c111fded` after the first candidate was signed | Include source and rerun the complete Worker gate; hosted activation remains a separate deployment |
| #90 compact accounting, context-pricing parity and retained R7 evidence | Merged as `d13b19ef` | Preserve completed validation and build the final candidate from the subsequently updated source |
| #91 purchased-credit research analyzer | Opened after the native freeze; standalone research, not a packaged native dependency | Exclude from this candidate; separate source/privacy review remains necessary |
| #94 local plan-era attribution, staged telemetry v1.1 and device continuity | Merged as `20f449ff`; not present in installed RC4 | Include in RC5; the R7 workload closure is fresh, while empirical coverage/resource review and installed artifact gates remain open. Hosted migrations, activation and new consent remain separate |
| #95 prompt-free Keychain migration | Merged as `a3c85036`; foundation of RC4 and current main | Retain the bounded three-attempt automatic path and Settings-only explained fallback; unexpected prompts block release |
| #96 late native startup recovery | Merged as `3b0f2d23`; current release-preparation base | Include in RC5 and revalidate delayed readiness on the exact installed artifact |
| #73, #74, Electron delivery, Linux integration and Claude Code integration | Excluded | No scope expansion without a new decision |

Take a fresh PR/main snapshot before freezing. Identify newly included source
explicitly; do not indefinitely follow unrelated active branches.

PR #90 closed the initial source freeze through main's `9b121b7d` (#86),
including #87 and #88 plus this task's compact-accounting changes. The owner's
subsequent request reopened the freeze to include newly merged #89 at
`c111fded` and verify #75 parity. PR #92 supplied the retained replacement
validator; PR #95 supplied prompt-free migration; frozen RC4 then added startup
recovery without PR #94. The final integrated freeze is reopened only through
merged PR #94 and PR #96 at base `3b0f2d23`. Further unrelated PRs are not
automatically included in the retained validation run.

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
   channel allocation from `scripts/macos-bundle-version.js`, clean source and
   retained release finalizer. Earlier candidates used `1023`, `1023.1`,
   `1023.2`, `1023.3`, and `1023.4`; corrective RC7 uses `1023.5`. Stable
   remains `1024`.
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

PR #90 merged as `d13b19ef` with a tree identical to its tested final head.
The annotated `tibotattle-internal-dogfood-0.1.17-rc1-source-20260831` tag
identifies that first candidate. Its retained finalizer and independent DMG
validation both exited zero: Developer ID, hardened runtime, app and DMG
notarization/stapling, Gatekeeper, and empty-profile checks passed. The artifact
remains preserved and was not installed. It predates #89 and is not the final
updated-source candidate.

The subsequent actual replacement check refused the previous 0.1.16 dogfood's
pre-policy source tag. Its checksum matches the original receipt, and its
embedded build manifest also predates source seals. The follow-up supports
only that exact previous artifact through a module-private, expiring capability,
retaining all native trust and payload checks and leaving candidate/public/signing
validation strict. Actual artifact validation additionally identified the old
normalized Keytar binary and two absent Keychain plist identity fields. Both
compatibility rules are previous-only, with exact historical inventory pins;
current candidates still require the current inventory and explicit identity.
The actual 1022-to-1023 replacement gate then passed, including both DMGs and
their native signature, notarization, Gatekeeper and empty-profile smokes.
An intervening candidate-mount refusal was resolved by detaching the operator's
already-mounted test image; no validation rule was relaxed. Neither old receipt
nor tag was rewritten. Both installed old-app bundles have content- and signature-
verified private ZIP backups; neither original has been replaced or removed.

On `c111fded`, #89's complete Worker gate exited zero: 429 Worker tests,
174 script tests, workspace-copy guards, endpoints, generated types,
TypeScript, and default/staging dry-run bundles passed. Fresh pinned Worker
dependencies and legitimate no-installer public-site inputs were used. The
first dependency refresh was sandbox-refused; its authorized unchanged retry
completed. No Worker deployment or migration occurred. The retained R7
freshness tests still pass 2/2 because this merge does not change their workload
closure. Recheck both pinned runtimes after the final repair rather than
regenerating protected evidence without a source-provenance need.

Read-only #75 parity inspection verified that #81's `91735527` port retained
the native popup/pace implementation, its native render harness and all three
locale catalogs. Subsequent #88 changes add refresh retention and dismissal.
No native implementation port is needed; this is source parity, not the
remaining physical signed-app interaction check.

The final replacement repair passed all five focused policy/forgery regressions
and the retained native gate, 67/67 without skips or cancellations. The full
root repeat reported 3,213 passes, 17 designated skips and one Preview-build
cancellation, with no failed assertions; it was not a passing root run. The
macOS power log records a 950-second system sleep during that run. With a
temporary keep-awake assertion, the unchanged Preview test passed in 136 seconds
within the retained native gate. No timeout, assertion or test was weakened.
The final full-suite rerun then exited zero in 441 seconds: 3,214 passes,
17 designated skips, no failures or cancellations, from 3,231 tests. Both
pinned-runtime R7 freshness checks passed 2/2 again and all ten receipts remain
unchanged. The
private backup, atomic-swap and old-app-retirement guard tests passed 27/27 using
synthetic directories only; actual installation and retirement have not run.
Final preflight passed 18/18 and architecture passed with 369 production files,
1,449 imports and zero approved debt edges. Existing Developer ID availability
and notarization-profile authentication were checked without changing credentials.

A schema-9 preservation copy alone is not a working rollback for an old reader
that only supports schema 8; do not launch that reader against the newer state.
Before normal installed launch,
check whether existing consent, pairing or a pending sign-in can automatically
resume contribution. Normal installed launch is held for the owner's direction
about any automatic pairing or upload; do not alter consent as a workaround.
Credential-free, empty-profile artifact smokes do not qualify real Keychain or
normal signed-in operation.

Final updated-source tagging, signing, replacement validation, installation
and physical native checks remain. Public release/updater publication is not
part of this internal dogfood. Private state records, comparisons, UI captures
and release inputs remain local and outside tracked docs.

## RC4 handoff and integrated RC5 boundary (pre-RC5 snapshot)

This section records the gate state before RC5 was frozen and built. The later
RC5 installed-refresh finding and RC6 amendment below supersede its present-tense
candidate status; the open PR #94 empirical boundary remains unchanged.

Frozen RC4 source `735a59ce2ec01df0e381fb1aa878c5c7a39edcd8`, build
`1023.2`, was subsequently signed, notarized, and installed. That artifact is
valid evidence for its exact source only. It excludes PR #94 and cannot qualify
the current release-preparation base `3b0f2d23775c0ca1f092fe3eb48f0c3166c8461a`
or stable 0.1.17.

The integrated current-main candidate is RC5 build `1023.3`. It includes merged
PRs #94, #95, and #96. Its current R7 workload-source closure regenerated and
validated all ten protected receipts on 2026-08-31 against 359 files / workload
SHA-256 `4c3058b3453bda2696e946952d18e81310f26eb0187074d410c730e44162f1d6`.
The reconstructed R7 decision remains honestly `release_open`, and PR #94's
fixed-corpus empirical review remains open. RC5 has not yet been frozen, tagged,
built, signed, notarized, installed, or physically qualified; root/Worker/native
gates and clean source review still apply. The native UI and allocation files are
outside the R7 closure and rely on those separate gates. Stable build `1024`, the `v0.1.17`
tag, GitHub release, appcast, updater, and public artifacts remain separate later
gates.

The owner-only fixed-window PR #94 diagnostic attempted on 2026-08-31 failed
closed before comparison with `codex_rollout_content_invalid` in the strict
baseline scan. Its supported resource benchmark independently stopped at
`benchmark_cold_rebuild_incomplete` on both exact revisions. No empirical
comparison receipt exists, and RC5 may be built only as an explicitly open-gate
test candidate rather than an empirically signed-off or stable-ready artifact.

A read-only service observation on 2026-08-31 returned HTTP 200 from deployment
source `304f3d736b6f9451d32a616bf3046ea628e828a3`. That Worker predates PR #94's
device-continuity protocol, so an already registered Mac can fail a fresh
three-step pairing attempt even though its prior local binding remains valid.
The current source repair requires both the newer desktop path and compatible
hosted Worker behavior. Worker migrations/deployment, telemetry v1.1 activation,
and new consent are protected operations outside this internal artifact build;
desktop installation alone cannot establish end-to-end pairing repair.

## RC5 installed-refresh finding and RC6 correction (historical checkpoint)

RC5 source `ff506dc3`, tagged for internal dogfood and allocated build `1023.3`,
subsequently passed source, protected R7, Developer ID, notarization, stapling,
Gatekeeper, state-preserving replacement and first-launch checks. The exact
installed artifact then failed the required real refresh check. Its current
schema-11 index was reusable, but the v0.14 accounting semantics required a
full cache rebuild. That rebuild remained active below the fixed memory ceiling
until the ordinary five-minute controller deadline aborted it; the previous
cache remained intact and no partial result was published. Repeating RC5 would
restart the same uncheckpointed work and is not an acceptable handoff.

Corrective RC6 uses monotonic build `1023.4`. The runner now emits its fixed,
count-free accounting marker only after the authoritative cache reuse check has
failed and immediately before a real full rebuild. The controller accepts that
exact marker once and extends the run to the existing four-hour total cold-work
ceiling. Cache hits, malformed progress and repeated markers retain the normal
five-minute deadline. Browser and native polling remain attached through the
server ceiling plus one minute, and cancellation is rechecked immediately before
atomic cache publication. Existing resource, generation, size, privacy and
killable-child guards are unchanged.

At this checkpoint, RC6 still had to rerun the exact source gates and protected
R7 after source freeze, then repeat signing, notarization, replacement
validation, state-preserving install, and physical checks. The real full-
accounting refresh had to reach terminal success and publish current generation-
matched v0.14 figures; the two-limit popover also remained an installed
interaction check. The later section records the RC6 result and superseding RC7
allocation. No hosted Worker deployment, migration, stable tag, appcast, or
public artifact was authorized by this correction.

## RC6 installed result and RC7 correction

RC6 source `e59115d41958f6b23496a65c9732a6a9944fdde0`, build `1023.4`,
subsequently completed its exact source gates, protected R7, Developer ID
signing, notarization, stapling, Gatekeeper, state-preserving replacement, and
installed launch without an observed Keychain prompt. Its real refresh ran
past five minutes and reached terminal success, proving the RC5 lifetime fix.
The result nevertheless did not publish current advanced accounting because an
inherited `recent_7d_indexing` legacy checkpoint suppressed otherwise-
authoritative unified accounting.

RC7 removes only that retired collector checkpoint. It continues to require
`unifiedGenerationAuthoritative`, matching generations, complete accounting
provenance, resource ceilings, cancellation fencing, and atomic publication.
Its monotonic build is `1023.5`, strictly after installed RC6 and before stable
`1024`. The source change invalidates RC6's workload receipts for RC7, so fresh
exact-source gates and protected R7 must precede a new tag, signed/notarized
artifact, state-preserving replacement, and installed refresh and two-limit
popover checks.

PR #94's fixed-real-corpus comparator remains **OPEN / NOT RUN**. RC7 may be
used only as an explicitly open-gate internal dogfood; stable and public
qualification remain blocked until that comparator is closed or deliberately
resolved. No hosted Worker deployment, migration, stable tag, appcast, or
public artifact is authorized by this correction.
