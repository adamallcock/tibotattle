---
title: TiboTattle 0.1.27 client release qualification
date: 2026-10-03
type: plan
status: in-progress
---

# TiboTattle 0.1.27 client release qualification

## Scope and authorization

The user asked on October 3 to work through the remaining 0.1.27 items and ask
about unresolved decisions. The user explicitly deferred the optional app-side
Codex dashboard reader to the next release. The supported model/client changes
and subsequent dashboard cleanup/token-mix changes form this release's scope.

On October 3 the user approved the entire proposed release process and asked
for the next version to be released while away for ten hours, explicitly
authorizing subagents. This includes the exact reviewed temporary security
exception, protected local R7, source push/PR/merge/tag, native builds, signing,
notarization, installed qualification, and four-platform publication/readback.
Proceed through the established gates without asking again for those approved
outcomes. A failed or unavailable required gate still prevents publication.
The existing hosted owner retains its cutover and post-cutover compatibility
lane; this approval does not transfer ownership or waive its compatibility proof.

## Candidate and ownership

- Base: main `396204d306c927d8c51d22df9396f7f9a534da8c`.
- Local branch: `codex/release-0.1.27` in a clean managed release worktree.
- Product version: `0.1.27`; both Mac architectures use `CFBundleVersion`
  `1035`. Candidate provenance build number: `2026100301`.
- Preserve the original dirty checkout, September 30 dots notes and separately
  owned dashboard/plugin prototype. Do not import their unreviewed diffs.
- Root coordinates integration, source freeze, R7, candidate and release gates.
  Narrow workers own Pro Max ledger/provenance, packaging dependency remediation
  and version/build allocation. The dashboard owner retains the deferred work.

## Ordered work and acceptance

| Item | Status | Acceptance |
|---|---|---|
| Scope | Full four-platform release authorized; dashboard reader remains deferred | Exact client scope and publication boundary recorded |
| Pro Max release contract | Passed source/released/installed vocabulary checks and focused tests | Current released/installed binary and upstream evidence reviewed; ledger lifecycle/provenance agree; required-binary contract check passes without claiming authoritative allowance/window capacities |
| Packaging dependencies | Approved exception active at bdc56099; independent review, live guard, recursive OSV and focused negative tests passed | Prefer a compatible published fix; otherwise review the exact patch and narrow temporary exception with owner authorization; focused negative tests and fresh dependency proof pass |
| Version/build allocation | Passed allocation/admission/export checks; four coupled runtime manifests also aligned to 0.1.27 after actual staging exposed drift | Product 0.1.27, unique valid Mac allocation, separate provenance build number and truthful release notes; version/admission tests pass |
| Hosted compatibility | Pro Max admission and unknown-model correction gaps confirmed; publication held for qualified post-cutover alignment | Local-only functionality and old/new hosted protocol behavior qualified; new performance activation is not inferred from a merge or health response |
| Source freeze | Reviewed export repair integrated at ad51936f; R7 runtime inputs frozen; final dated publication source/tag await a concrete release window | Scoped diff reviewed and committed; candidate HEAD and dependencies clean and pinned |
| Retained R7 evidence | Additive manifest v0.3 and deletion-journal v0.2 repair reviewed; complete fresh protected retry ready | Complete protected dual-runtime matrix regenerated locally against final source/lockfiles; all ten receipts and their freshness tests validated; unresolved historical resource decisions remain explicit |
| Complete source/surface gates | Focused client/shared gates passed; complete gates pending repaired frozen inputs | Owning client/shared/release gates run; failures fixed without weakening tests; broad gate limitations reported exactly |
| Production candidates | Earlier Mac source stages retained; Apple notarization blocked by an unsigned/expired developer agreement; new-byte native gates pending | Exact Node 26.2.0 staging receipts, fresh packaged inspection and target-specific installer/updater/credential qualification |
| Delivery | End-to-end publication authorized; required compatibility and final-byte gates remain | Candidate handoff or authorized exact four-platform publication/readback; source, signed artifact, installed result and public availability remain distinct |

## Invariants and decision limits

Keep the raw `pro` identity/history and accepted Pro 10x / Pro Max 25x expected
ratios. API-equivalent prices and included-allowance weighting stay separate.
Unsupported price combinations remain unavailable. Dots exclusion requires a
verified activity/billing discriminator; no broad model or descendant exclusion.
The prior performance-authorization recovery fix remains part of the candidate.

Migration 0013 and hosted activation are independent of offline model/pricing
support. Do not apply a remote migration or publish a Worker to make client
checks pass without a concrete separately authorized operation.

R7 reads protected local historical corpora only on the owner machine. Keep
private source material, identifiers, paths, credentials and raw logs out of
fixtures, commits, reports and external tools. Retained evidence regeneration
must use the reviewed generator and exact hash-pinned Node 24.14.0/26.2.0 pair.

## Current authority and progress

Follow [macOS candidate qualification](../runbooks/macos-stable-release-runbook.md),
[R7 maintenance](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md)
and [cross-platform publication](../runbooks/2026-08-18-cross-platform-release-publication.md).
The October 3 readiness review identified provisional `promax`, stale R7
fingerprints and missing successor/final-artifact evidence. This plan records
new execution; the earlier review is a dated snapshot, not release proof.

## Verified progress and remaining decisions

- Required-binary Pro Max checks pass against reviewed stable Codex 0.160.0 and
  its exact released source. The maintained ledger separates vocabulary proof
  from unverified provider capacity/window semantics. Focused contract,
  generator, schema-mirror and documentation checks passed.
- Version allocation, closed export compatibility schema/artifacts, candidate
  notes and stale sharing help are updated. Focused allocation/admission,
  export, release-note and preflight checks passed.
- The exact upstream max-stale mitigation passes installed-byte and synthetic
  adapter tests. Fresh OSV proves only the selected root advisory remains and
  that a root exception does not suppress an identical child-lock finding.
  The [security decision packet](../decisions/2026-10-03-v0-1-27-http-cache-advisory-exception.md)
  was approved by the user for this candidate on October 3 and activated at
  `bdc56099`. Independent review, the live guard, focused negative tests and a
  fresh recursive OSV scan passed. Hosted Ubuntu workflow execution remains
  a separate PR-CI gate.
- Paused-sharing copy is cause-neutral in all three locales, because the
  renderer receives no cause. Both Community and Settings have focused
  rendering coverage; canonical i18n checks pass. Native rendering is pending.
- Exact old/current synthetic parser and scheduler execution confirms old
  production rejects Pro Max quota/attribution synchronously before durable
  hosted persistence. The client pauses usage uploads without dropping local
  evidence or advancing acknowledgments; later uploads also remain held. Old
  server prices and plan normalization lack the reviewed release updates.
- The existing clean `claude/release-candidate-d43c8f92` descendant preserves
  production lineage and carries the reviewed release changes. Its October 2
  receipt assigns these changes to GCP after cutover and prohibits Cloudflare
  deployment. Do not modify or deploy that separately owned candidate.
- The user authorized messages to “Coordinate GCP parity handover” on October 3.
  Coordination has requested the exact hosted compatibility gate and a safe
  window for R7; no remote writes were requested or performed by this task.

Delivery scope and the exact temporary security exception are approved.
R7 regeneration, broad source/surface gates, final packages, installed native
journeys, hosted compatibility and publication/readback remain outstanding.

## Historical Sol 6.1 upgrade acceptance

The user asked whether records collected before Sol 6.1 catalog/pricing support
are repaired. Current source and executed synthetic regressions establish:

- A completed detailed refresh reparses discoverable older logs once using
  parser v19, restores the exact model ID and preserves token/occurrence
  evidence. Ordinary archived-session discovery remains supported.
- Detailed refresh ingests before rebuilding accounting. Normal Electron
  startup requests detailed refresh after onboarding and analysis locks permit
  it; the main Refresh action also requests it. Installation or quick polling
  alone is not completion evidence. Startup cannot reuse an old snapshot's
  matched flag to skip required collection.
- Canonical usage rows retain model and quantity facts, not authoritative USD.
  An exact preserved model with sufficient time/context/token evidence can be
  repriced independently of the original file; authoritative replay still
  requires compatible source provenance.
- A missing original source cannot repair an earlier model collapsed to unknown.
  Such facts retain their historical provenance; mixed generations can withhold
  complete accounting rather than guess. Old official-price caches are withheld
  and incompatible registry/method/generation caches cannot be current authority.
- Recognized records outside a reviewed card's effective interval, or with
  unsupported speed/context combinations, remain explicitly unpriced.

Executed checks: 57/57 model ingestion, pricing and Ultrafast regressions, plus
the targeted older-price-cache refusal regression. See
[test/codex-usage-compatibility.test.js](../../test/codex-usage-compatibility.test.js),
[test/local-api-pricing.test.js](../../test/local-api-pricing.test.js) and
[test/replay-safe-accounting-cache.test.js](../../test/replay-safe-accounting-cache.test.js).
Fresh installed-byte qualification must additionally confirm completion of
refresh and corrected display; source tests do not establish that result.

The GCP owner confirmed the frozen cutover candidate retains the old deployed
contracts. The reviewed model/plan catch-up remains a separate post-cutover
R-MERGE lane, without a qualified live successor yet. Required hosted readback
includes Pro Max intake, exact price cards, four-plan normalization and
public/admin publication compatibility. The optional desktop dashboard reader
deferral does not defer the separately owned website reader prerequisite.
The hosted owner released the local resource slot and retained it for the complete
R7 diagnosis and retry, with a 24 GiB free-disk floor and no heavy benchmark overlap.

## Runtime version closure

Actual production-source preparation at `0547e06f` refused the accounting
workspace manifest: the root release was 0.1.27 while four coupled runtime
packages still declared 0.1.26. No candidate receipt or runtime manifest was
created. The existing deterministic runtime-staging regression reproduced this
refusal, then passed after all four manifests advanced to 0.1.27. Independent
i18n and Worker versions remain unchanged; the frozen lockfile did not change.

Six focused package and staging suites passed 44/44, canonical telemetry and
whitespace checks passed, and direct workspace runtime capture now returns all
four packages at 0.1.27. This changes protected R7 workload inputs, so receipt
regeneration must use the final manifest-aligned source. Production-source
preparation subsequently passed for both Mac architectures; native installed
qualification remains pending.

## Hosted historical model correction

The follow-up upload audit found a separate contract gap. Local parser repair
preserves occurrence identities and historical day changes trigger manifest
revalidation and reupload; a lost activation response or replay does not itself
duplicate usage. This does not establish that repaired model identities can
activate on the server.

The current accountless composition prefers v1.2 when separately authorized
and can fall back to v1.1. The closed v1.1 compatibility contract allows the
reviewed null-to-known total repair, but a stable occurrence's model change is
rejected atomically with `TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE`. The
previous accepted generation remains active. There is no unknown-model
exemption. Existing v1.1 correction tests cover model-change refusal and
preservation of the prior head. In contrast, v1.2 can activate a complete
successor through its separate CAS/head contract; retained-generation effective
readers still treat the changed model as conflicting evidence. Upload acceptance
is therefore distinct from corrected analytical selection.

Legacy v1 chunk replacement has different mutation semantics. When its typed
correction runtime is active, correction archives and effective readers
reconcile original assertions, and the model participates in their base digest. Unknown-to-Sol
assertions become one `base_conflict` occurrence with no effective analytical
record, rather than newest-wins precedence or two counted occurrences.

Executed evidence includes 12 focused local parser/sync/publication checks and
28 Worker correction-admission/reconciliation/effective-reader tests. An exact
synthetic unknown-to-`gpt-6.1-sol` reducer probe covered all three wire families,
both arrival orders, replay and streaming; root additionally held the provider
constant and changed only the model, with the same conflict result. These are
source/synthetic proofs, not live submission or published-result qualification.

The GCP owner acknowledged this dependency and retains the hosted remediation
in the separate post-cutover alignment lane. Preserve accepted occurrences,
original assertions and current cutover parity. A future bounded correction
contract needs matching activation and effective-reader rules, provenance and
compatibility proof, unknown-to-known positive tests, known-to-known and
contradictory-evidence negative tests, replay/order/account-scope coverage,
atomic failure/head preservation, and qualified hosted/public readback. Do not
broaden acceptance or replace contributions in the client release lane.

The owner reports production website source `94a9b9d7` now supplies the tolerant
reader, while hosted intake/pricing retain old semantics. That scoped website
publication does not release the client compatibility hold. Candidate notes and
user help must separate local repair from hosted synchronization.

Both Mac architectures successfully completed unsigned production-source
preparation at `b2cefc8d282b4be8518671fbaf613a8f822c370e`. No signing,
notarization, installation or publication occurred. Worker copied workspace
packages were refreshed through the owning npm install and all three exact
copy guards passed. Worker lock metadata is also aligned for the three local
packages without changing external dependency resolutions; the root lockfile
remains unchanged. Final release evidence requires the approved exception
activation, R7 resource slot, hosted compatibility and remaining artifact gates.

## October 4 execution update

The first protected R7 attempt started at 02:34 UTC on clean `bdc56099`.
All six synthetic runtime/profile runs passed. The first real-history lifecycle
stopped at `internal_export_set_manifest_validation`; no complete receipt set
was installed. The generator completed its owned cleanup, its journal was absent,
and the driver had exited. The tracked source remained clean.

An aggregate-only run through the same bounded source-plan API confirmed 5,281
source files for the frozen 31-day selection. The reviewed runtime permits
100,000, but the immutable export-set v0.2 manifest permits only 5,000. A tiny
synthetic manifest reproduces the exact failure at 5,001. The mismatch dates to
PR #39's runtime capacity increase, rather than the 0.1.27 compatibility tuple.
The repair must add export-set v0.3 for the existing runtime capacity, preserve
v0.1/v0.2 schema bytes and readers, and qualify verification, receipts, deletion
and resume. Do not change resource ceilings, shorten the historical interval or
reuse partial R7 results. A complete fresh matrix follows the reviewed repair.

Apple's existing notarization profile returns HTTP 403 because a required
developer legal agreement is missing or expired. The owner has been asked to
review and accept it on return. Signing preparation, Windows/Linux source work
and other independent checks continue; no notarization or publication is claimed.

The hosted correction owner confirmed no concrete client wire/source prerequisite
for the bounded server-only repair. Tagging can proceed after the local source
gates; hosted implementation and unchanged-client-flow qualification still block
publication. Separately, a reviewed Linux runner is being prepared to exercise
the ordinary final AppImage FUSE launcher and exact published 0.1.26 replacement.
It must prove the full native lifecycle before asserting clean-install success,
while retaining the separate unqualified physical-desktop scope.

The full baseline client/shared suite at `6e2e7a5f` recorded 5,847 passes,
47 existing skips and four failures: two stale-R7 assertions and two tool
inventory omissions. The missing temporary exception-guard entry and Mac
qualification caller are now registered, with exact inventory totals retained;
all six inventory tests pass. The complete source gate must still run against
the repaired format and fresh R7 receipts.


The product gate then exposed two local-server assertions for deliberately
retired dashboard recovery controls. They now preserve the legacy route's
closed codes, redaction and no-mutation checks while requiring the current
accountless control and absence of retired pairing/reset presentation. The full
local companion lane passes 407/407; current dashboard/help contracts pass
25/25. The macOS transition source lane passes 127/127 with pinned Sparkle tools.

A current-source audit also found stale guidance directing credential-migration
failures to absent Electron Settings controls. The fixed dialog, maintained help,
privacy/API references and native comments now say to quit, preserve credentials
and app data, and contact support with the fixed code. Retry only repeats the
silent check. Historical AppKit qualification is explicitly bounded; no new
migration authority, prompt, credential reset or runtime behavior is introduced.
Fifty focused native storage/broker tests and documentation/preflight checks pass;
installed-byte validation remains separate.

The hosted owner additionally confirmed the post-cutover public v1.4/admin v0.4
reader must ship before the new backend response contracts and client publication
qualification. The current live reader retains activity but cannot retain all
new allowance/model/plan breakdowns. This sequence does not block the independent
client source freeze or tag, and does not authorize changing the parity cutover.


The reviewed export repair is integrated at `ad51936f`: manifest v0.3 admits
only the existing 100,000-source runtime limit, old schema bytes and limits remain
unchanged, and retained verification/deletion/recovery/retry checks pass. The
packaged local-review runtime passed all 12 lifecycle invocations with no covered
network attempts and byte-identical same-epoch builds. The subsequent full root
suite recorded 5,874 passes, 44 existing skips and only the two expected stale-R7
failures. Worker script lanes and all 2,019 Vitest tests passed; the final local
dry-run staging step needs the missing generated public release site. No service
was deployed. The complete R7 retry starts only after these test processes exit.

The hosted owner confirmed four independent human decisions still precede cloud
measurement; the Sunday-night parity target is conditional, and post-cutover
contract/correction qualification has no committed release window. Final release
notes must match the actual UTC publication date. Preserve the clean reviewed
client source and complete local evidence now; do not guess that date or reserve
an immutable final tag before Apple and hosted prerequisites establish the window.
