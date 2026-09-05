---
title: Release 0.1.18 publication preparation
date: 2026-09-04
type: plan
status: qualification-blocked
---

# Release 0.1.18 publication preparation

Prepare the combined Astra/Intel candidate to the publication boundary, starting
from clean `c5a10c6de76a6c5b9150832b3552ce35cb22a87c` on
`codex/release-0.1.18`. The [completed local qualification](../reviews/2026-09-04-paginated-export-qualification.md)
binds the implementation, fresh R7 receipts and ARM/Intel development artifacts.
It does not supply signed, installed, physical-Intel or hosted-release proof.
Public release, updater activation and website/Worker deployment remain held.

Local preparation was completed on source
`dc2d0d32a1e82f5b037b0a7094a37c1d4bfdef76`. The owner then approved combined
ARM/Intel RC2 tagging, signing and Apple notarization without installation or
publication, and subsequently authorized publication only if ready. Both
signed RC2 candidates now pass the [exact artifact and replacement checks](../receipts/2026-09-04-macos-combined-rc2-signed-candidates.md)
from clean frozen source `4ea16586d83c72d0a4af506b102a267251f45a2b`.
The local annotated RC2 tag exists; no push, installation, stable finalization or
publication occurred. Installed-runtime, hardware and remote gates remain open,
so the conditional publication authority has not been exercised.

The owner subsequently authorized the installed ARM upgrade with data and a
rollback copy preserved, and continuation up to the publication decision.
The [installed-upgrade review](../reviews/2026-09-04-installed-upgrade-readiness.md)
records a newer live starting point (stable 0.1.17/1024), verified full backups,
and a newly identified parser-upgrade deadline regression. Corrected source
requires fresh RC3 `1025.2`; the signed RC2 `1025.1` artifacts remain unchanged.
The publication gate is still open, not waived.

## RC3 continuation

The corrected parser deadline and RC3 allocation are committed in `a9220795`.
The complete affected local suite passes 305/305; the native suite passes
110/110, with no skips. Release trust plus release-note tests pass 89/89,
and retained R7 freshness passes 2/2 on each pinned Node runtime. The original
installed stable app also passes signed/stapled/Gatekeeper validation and the
validator's isolated fake-manager smoke. At that initial qualification point,
it had not yet been replaced or normally relaunched. The later RC3 replacement
is recorded below.

An isolated full-state copy has completed v11-to-v13 ingestion without a rebuild,
skipped sources, missing historical usage/tool keys or receding source coverage.
Copy-only accounting completes and binds to the new exact generation. Model
reclassification review found a real future-parent seed bug affecting two
paginated reset events; those sources have no own model or physical history base.
Parser v14 correction across rebuild/ingest/resume, fresh copy-only qualification
and complete R7 regeneration are required. The correction also closes
descendant tier/replay traversal beyond paginated history and chooses logical
parent authority from the resolved head rather than physical scan order.
Retired source facts remain counted. Earlier R7 freshness passes above
apply to the initial deadline-only source, not the new parser correction. These
observations do not authorize destructive replay against the working state.

The complete companion suite on the corrected v14 source passes 305/305 with
no skips. A fresh official-page check at 2026-09-05 00:12 UTC confirms all eight
Astra API tier/context rows remain unchanged, including the strictly-above-272K
long-context boundary and 1.25x cache writes. The
[Codex credit rate card](https://learn.chatgpt.com/docs/pricing#token-rates)
separately lists 250/25/1,250 credits per million input/cached/output tokens and
a 2.5x Astra Fast multiplier. This is not the API Fast multiplier (2x): the
app's dollar ledger explicitly uses API-equivalent prices, not subscription
credits or an inferred percentage-allowance conversion. No pricing code or
historical review timestamp was changed merely to record this recheck.

The reviewed v14 correction is frozen in local commit `014380c7`. Its owning
suite passes 238/238 and independent targeted regressions pass 30/30. The full
native suite passes 110/110. The complete Worker gate passes 183 script tests,
533 application tests across 43 files, type checks and default/staging dry runs;
the explicit production dry run also passes. The installed Codex contract
remains current on both available channels at CLI `0.153.0-alpha.5` with 17
PlanType values. No test skips, remote writes or installation are inferred.
Fresh R7 evidence remains pending. The subsequent copy-only v14 semantic review
and its distinct static-snapshot/active-append proofs are recorded in the
[installed-upgrade review](../reviews/2026-09-04-installed-upgrade-readiness.md).

The new copy-only verifier required an owner decision after safety review
refused correcting a draft assertion. The shared `model` dimension is unique
by `model_id` and retains its first recognition label; it cannot prove an
individual event's missing-versus-unrecognized state. The proposed replacement
requires missing model evidence from exact-occurrence seedless extraction and
an unknown stored model identity, with all counter/effort/tier/preservation
checks retained. The owner subsequently explicitly approved that correction,
fresh local R7 regeneration and receipt replacement, then signing and installed
qualification up to publication readiness. The approved helper correction is
now applied; it does not modify stored facts or waive any retention, counter,
effort or tier check. Independent R7 regeneration previously stopped after
the exact attempted operation on clean `c955fed1` was refused before execution:
safety review required fresh explicit authorization for reading the private
corpus and replacing the ten receipts on this corrected source. No workaround
was attempted. The fresh owner approval resolves those authority blockers.
The v14 isolated-copy ingestion preserves every historical occurrence and
source-coverage bound. All model/effort/tier and nullable-component changes have
now been independently explained and checked against exact raw occurrences.
Three actively appended sources have separate retained-prefix semantic proof;
their earlier non-passing static-snapshot result has not been relabeled. The
coordinator approved the exact generation's hash-bound semantic report. Copy-only
accounting completes in 71 seconds, publishing and reading back a v0.15 cache
bound to exact v14 generation 70 with complete source coverage and no skipped
sources. Original backup, cloned index, unrelated clone state and all four
speed-baseline windows remain unchanged; no network or credential operation
occurs. The approved R7 generation on clean `49486ba0` completed Node 24
synthetic semantics, then stopped in synthetic pressure with
`symlink_rejected`. It exited before receipt replacement; all ten retained
receipts remain unchanged, and no replacement journal or staging directory
remains. The failed log and empty summary are preserved. A separate bounded,
synthetic-only diagnostic observes the unmodified refusal; no unsafe entry is
accepted merely to obtain a passing run. Full fresh generation remains required.
That single diagnostic completed all 20 operations across the pressure profile's
two built-in passes without reproducing the refusal. Its injected refusal control
passed. A separate 10,000-iteration native synthetic unlink observation also
found no zero-link result. Neither establishes the original failure's cause or
supplies release receipts. The subsequent source change distinguishes fixed,
privacy-safe symlink refusal categories without changing which entries are
accepted, following links, retrying a refused sample or changing measurements.
All 97 filesystem/schema/synthetic-evidence tests pass on each pinned runtime,
including deterministic refusal precedence, redaction and unchanged accepted
one/two-link observations. Documentation and the 20-test preflight also pass.
The complete generation on clean `38aaeef4` then completed in 31.2 minutes,
including 25.0 minutes of real-history work, and installed all ten validated
receipts. Freshness and exact decision reconstruction pass 2/2 on each pinned
runtime. Independent review confirms all runtime/source bindings and sixteen
decision input links, with unchanged outcomes, preservation, privacy and gates.
Claude's frozen source prefixes grew by 498,628 bytes; source counts, output
record counts and decoded sizes are unchanged. Three synthetic operations
record one failed RSS sample each, without a failed operation or resource gate.
Both decisions remain `release_open`: nineteen unresolved resource decisions
and seven open promotion gates are not relabeled, and network absence is not
measured. The original aborted run's cause remains unproven.

The first complete root run recorded 3,854 passes, five failures and seventeen
existing native-Windows skips. Three failures came from the launcher's `077`
umask masking deliberately unsafe fixture modes; the permission guards are
unchanged. Two real bookkeeping omissions are corrected: the reviewed client
export now includes the Login Item release-validation CLI, and the tool
inventory records its builder import. All 44 owning tests, architecture,
inventory and preflight checks pass. R7 freshness remains valid because those
edits are outside its workload closure. The failed full-run log is retained;
the complete rerun uses `022` only in the test child while keeping its outer
log redirection owner-private. No test exclusions or new skips are introduced.
The complete rerun on clean `3a785e6d` passes: 3,859 tests, zero failures and
seventeen existing native-Windows skips, in 479.3 seconds. Those skips supply no
Windows qualification. Both pinned-runtime R7 freshness/reconstruction checks
and documentation governance also pass. RC1's four retained files and both RC2
DMGs/receipts match their recorded hashes; RC2's tester files have fresh
before-signing baselines without a claim about an unavailable earlier hash.
Both RC3 DMGs have now been finalized from clean `7701debf` under a new local
annotated RC3 source tag. Signing, notarization, exact final-artifact validation
and both same-architecture RC2-to-RC3 replacement checks pass; the
[RC3 receipt](../receipts/2026-09-04-macos-combined-rc3-signed-candidates.md)
binds the bytes. The final ARM app was Finder-installed with the verified full
rollback copy preserved and passes production installed-artifact validation.
The Mac locked before normal launch; the UI refused to proceed and a process
check found no TiboTattle process. Actual launch, refresh/migration and restart
remain pending an owner unlock. No security prompt was bypassed.
Publication remains held. Signing-key prompt approval, changes to
real credential protection, physical/manual proof and external deployment are
not inferred from source tests or this continuation.

The [hosted lineage review](../reviews/2026-09-04-hosted-migration-lineage-reconciliation.md)
records a separate live deployment blocker. Production applied the historical
`0041_community_model_composition_cache.sql`, not the independently authored
composition-table migration. Read-only schema probes confirm that the new
tables/withdrawal trigger and attribution schema are absent; all query receipts
report zero writes. No configured staging database exists in the inspected
project inventory. The local repair restores all 41 historical migrations
byte-for-byte and gives the four unapplied successors unique 0042-0045 names,
with unchanged SQL and exact-prefix refusal for alternative applied histories.
Fresh-schema and production-shaped synthetic regressions pass. The complete
Worker gate on clean `0cb0916f` passes 183 script and 533 application tests across
43 files, types and default/staging deployment dry runs. A fresh read-only
production ledger gate now recognizes the historical prefix and reports exactly
the four pending 0042-0045 migrations. No database
migration, deployment, source push, stable finalization or publication occurred.

## Completed RC2 local preparation

- [x] Recheck current Astra pricing and installed Codex contract. The
  [official pricing table](https://developers.openai.com/api/docs/pricing)
  still matches all eight short/long tier rows in the registry. The
  [model page](https://developers.openai.com/api/docs/models/gpt-6-astra)
  retains the strictly-more-than-272K long-context threshold and 1.25x cache
  writes. API documentation lists efforts through `max`; observed Codex
  `ultra` support is a separate client surface, not an inferred API promise.
  Both available installed channels pass with CLI `0.153.0-alpha.5` and
  seventeen PlanType values; two optional channels are absent.
- [x] Release-note validation and release-trust checks pass (78/78 tests).
- [x] Fix the Login Item release CLI's implicit ARM/stable selection and its
  v1 cross-architecture receipt-reuse gap; prove explicit Intel/dogfood
  propagation, source/payload/hardware-bound v2 receipts and fail-closed
  rejection without real credentials or Login Item changes.
  All four focused tests pass, including every missing lifecycle check and
  expected identity, old receipt refusal and cross-target reuse rejection.
- [x] Clarify the current RC2 allocation, Intel first-stable bootstrap and the
  strictly 0.1.17-only manual-matrix deferral in maintained guidance.
- [x] Complete Worker checks and local deployment dry runs, then rerun affected
  native tooling, documentation and R7 freshness gates. Preserve existing
  receipt bytes if the R7 workload closure is unchanged.
- [x] Freeze reviewed local source and record exact final results and remaining
  protected inputs. Do not describe unsigned development apps as signed RC2.

## Retained RC2 local evidence

| Check on the frozen source | Result |
| --- | --- |
| Focused Login Item regression tests | 4/4 pass, no skips; includes cross-target receipt refusal and every required field/check |
| Complete retained macOS suite | 110/110 pass, no skips; 246.6 seconds |
| Complete Worker qualification | Exit 0; workspace guards/types/TypeScript, 179 script tests and 533 application tests across 43 files pass |
| Default and staging deployment dry runs | Exit 0; staging remains `safe_unprovisioned`, with no configured resource identifiers or collection authorization |
| Explicit production deployment dry run | Exit 0; no deployment or remote migration |
| Architecture | 385 production files, 1,561 imports, zero approved debt edges |
| Documentation preflight | 20/20 pass, no skips; release-note validation passes |
| R7 freshness and exact decision reconstruction | 2/2 pass on Node 24.14.0 and 2/2 on Node 26.2.0, no skips; all ten receipts byte-identical to `ef2d26ac` |
| Independent implementation/documentation reviews | No remaining actionable findings; human-observation and final-DMG limitations explicit |

The source closure for R7 remains 362 files with SHA-256
`76ee96306c297f7e77279e7dc382411c801f6a020a0c26e61864f698d3e782af`.
The changes affect release qualification tooling/tests and documentation, not
the app/accounting workload. The earlier 3,815-pass full root run remains bound
to its earlier source/evidence snapshot; this turn reran the complete affected
native and Worker gates, not the entire root suite. No new signed artifact is
inferred from either test set.

An initial sandboxed Worker invocation stopped during dependency preparation
because registry access was blocked. The exact frozen-lockfile dependencies
were restored (no version/lockfile change). The first full Worker attempt then
passed its tests but correctly refused asset staging because concurrent local
qualification edits made the tree dirty. The complete clean-tree rerun and
explicit production dry run both passed; no clean-tree guard was bypassed.
Nonfatal missing-local-envelope-secret/sourcemap warnings and intentionally
unprovisioned staging are not represented as live-environment qualification.

Logs are retained only in ignored `.release-build/prepublish-*` files. A
read-only remote-ref check during local preparation found no release branch,
stable 0.1.18 tag or RC2 source tag matching this candidate. The subsequently
created local RC2 tag has not been pushed; no exact-head hosted CI claim is made.

## Protected continuation and evidence gates

The canonical [macOS runbook](../runbooks/macos-stable-release-runbook.md)
requires explicit operation/target authority. `--prepare-candidate` continues
into Developer ID signing and Apple submission; it is not a dry run. Obtain
explicit permission before that credentialed operation. The owner supplied
this authority for combined ARM/Intel RC2 `1025.1`, its new local annotated
source tag, signing and notarization; those operations are now complete with
fresh distinct outputs. Intel RC1 `1025`, source `18c7065b`, its DMG, receipt,
checksum, tester README and verified Node runtime were preserved. Installation
was excluded from that signing operation; the subsequent owner approval now
permits the installed ARM upgrade with preservation. Do not infer approval for
credential resets, broad access changes, destructive clean-profile exercises
on the owner's working profile, or publication before qualification.

| Boundary | Required proof before the corresponding claim |
| --- | --- |
| Signed RC2 — complete | One clean annotated dogfood source tag; independent ARM/Intel Developer ID, notarization, staple, Gatekeeper, exact-byte and same-architecture replacement receipts; not installed-upgrade proof |
| Corrected signed RC3 — complete | Common clean `7701debf` source/local annotated tag, build `1025.2`, independently verified new ARM/Intel final bytes and receipts; RC1/RC2 preserved |
| Installed ARM — in progress | Final ARM DMG app Finder-installed with rollback preservation; production installed-artifact validator passes. Normal launch/refresh/restart awaits unlocked UI; manual clean-profile/Login Item and failure-path matrix remains open |
| Physical Intel | Physical macOS 14+ clean install, discovery/offline accounting, lifecycle, silent Keychain and installed Intel A-to-B update; actual upload requires the tester's own consent |
| Stable artifacts | New common exact annotated `v0.1.18` source, reviewed release text, build `1026`, ARM previous-stable continuity and explicit Intel first-stable bootstrap; repeat final-byte native gates |
| Hosted model dashboard | Verified historical 0041 ledger/schema followed by reconciled 0042-0045; separately authorized pending migrations/deployment, scheduled warming and authenticated rendered model evidence; health alone is insufficient |
| Public release preparation | Authorized branch/tag push and exact-head CI/merge; native/checksum manifest with truthful null attestation fields, frozen signed appcasts, exact asset set and freshly verified draft downloads |

The model expansion introduces no additional SQL beyond the restored historical
0041 and reconciled schema through 0045. Its model history depends on the new
composition tables in 0042; a missing migration can
degrade to empty/stale history. The Intel authenticated appcast guard must be
deployed before an Intel feed is published. Optional v1.1 consent activation,
public Intel support and Intel Homebrew remain separate decisions/evidence.

The 0.1.17 clean-profile/Login Item deferral does not carry forward. If physical
Intel evidence remains unavailable, do not silently broaden supported platforms
or treat Rosetta as a substitute. Resolve the intended public architecture scope
with the owner before publication.
