---
title: Native dogfood startup recovery
date: 2026-08-31
type: plan
status: implemented-pending-integrated-candidate
---

# Boundary

The corrective RC4 was intentionally frozen before account/plan PR #94. The
owner later merged #94 into main at `20f449ff`, and PR #96 carried the startup
fix to newer main as merge `3b0f2d23`. Preserve the artifact boundary: installed
RC4 source `735a59ce` is based on `a3c85036` plus only the startup fix; it does
not contain or qualify PR #94. The integrated current-main candidate is a new
RC5, not a relabel of RC4.
The signed PR #95 candidate reproduced `UM_MACOS_DASHBOARD_READY_TIMEOUT` on
normal launch with existing schema-11 history. A replacement companion later
reported a ready snapshot and returned the overview in 51 ms; the native window
remained on its timeout screen. Open Dashboard restored real data. The first
companion exit's cause is not established by these observations.

No index wipe, schema change, credential reset, consent change, hosted deployment,
or public release is part of this correction.

## Changes

- [x] Select the companion's existing bounded `startup` projection. Preserve
  attested last-good data and explicit incomplete coverage; the normal refresh
  supplies eventual full results.
- [x] Render the primary local result before optional contribution/onboarding
  requests finish, without breaking consent ordering or async-load fencing.
- [x] Make native readiness observation document-generation-fenced and bounded.
  A slow-load threshold must not discard the page or initial-refresh intent;
  true failure and a hard deadline remain explicit. Late readiness refreshes
  once and clears the stale timeout diagnostic.
- [x] Add executable startup/retention, delayed-readiness, cancellation, stale
  callback and optional-service regressions. Keep every existing safety gate.
- [x] Validate the combined corrective source and retained R7 freshness. Allocate
  its monotonic native build and freeze the source separately from newer main.
- [x] Sign, notarize, preserve state and the prior app, and install frozen RC4
  build `1023.2`. This qualifies only source `735a59ce`.
- [x] Re-run exact-source artifact gates and verify native startup, refresh,
  restart, and prompt-free behavior on integrated RC5 build `1023.3`. Its real
  refresh failed at five minutes, leading to RC6.
- [x] Repeat the source, R7, signed-artifact, replacement, startup, and real
  refresh gates on RC6 build `1023.4`. The lifetime correction passed; the
  installed run exposed the separate legacy accounting checkpoint recorded
  below.
- [x] Repeat the exact-source, R7, signed-artifact, replacement, native startup,
  prompt-free, and existing local binding/diagnostic checks on RC7 build
  `1023.5`. End-to-end pairing repair remains unqualified until a compatible
  hosted Worker is deployed. Its installed refresh ingested generation 44 but
  exposed the separate fit-metadata defect below.
- [ ] Repeat the exact-source, R7, signed-artifact, replacement, native startup,
  refresh, pairing-repair, prompt-free, and accounting checks on RC8 build
  `1023.6`.

## Acceptance

The corrective RC4 allocation is build `1023.2`, strictly after installed RC3
`1023.1` and before the reserved stable `1024`. The short version stays `0.1.17`.

The installed native app must show saved local evidence without waiting for full
history accounting or optional hosted work, retain honest partial labels, recover
from a delayed ready result without manual reload, and start only one initial
refresh. Navigation replacement, companion replacement and teardown must fence
old callbacks. Unexpected Keychain prompts remain a release blocker.

Source tests, isolated smokes, signed artifacts, real-data native interaction and
public promotion are separate proofs. Fresh R7 receipts retain their actual open
promotion/resource decisions; they are not a stable-release claim.

## Frozen-source validation

These observations apply to corrective source `735a59ce`, based on `a3c85036`,
not to the later main integration described below.

- Full root suite: 3,312 tests, 3,291 passed, zero failures or cancellations,
  21 existing platform skips; exit 0 in 318.2 seconds.
- Browser owning gate: 449/449; local companion owning gate: 277/277.
- Complete retained native gate: 89/89, no failures or skips; exit 0 in
  237.8 seconds. Documentation preflight: 20/20; release trust: 77/77;
  architecture: 367 production files, 1,447 imports and zero approved debt.
- Focused native source/migration tests: 78 passed with the three designated
  artifact exclusions. The compiled test-profile smoke executes the actual
  readiness policy (early and late readiness, one-shot completion, cancellation,
  stale generations and the hard deadline) and passes. It does not establish
  physical WebKit callback scheduling or installed-artifact behavior.
- R7 freshness: both retained-receipt checks pass against this source. The
  correction does not change the R7 workload closure; no protected receipt was
  regenerated or edited.
- Rendered browser QA used a read-only loopback proxy serving the frozen web
  source and the installed companion's real primary read responses. Optional
  requests were held open, and every mutation was blocked. Overview and Usage
  and costs rendered; readiness was true with no first-run curtain or visible
  dialog, and no browser warning/error. A 962 by 541 screenshot was inspected.
  Aggregate proxy counters confirmed no writes forwarded. The QA tab and proxy
  were closed afterward; private response bodies were not retained as fixtures.
- Independent frozen-web review found no concrete blocker in readiness,
  asynchronous publication fencing or consent ordering. Optional preview
  discovery retains its existing local queue-bookkeeping semantics; it does
  not itself upload. A primary read that never settles still reaches the
  native hard deadline rather than being presented as successful.
- RC4 signing, notarization, state-preserving replacement, and installation were
  completed later for this exact frozen source. That evidence is not inherited
  by the integrated PR #94 tree or stable release. Browser QA remains distinct
  from physical native qualification.

## Source-only main integration

The startup fix was cherry-picked unchanged onto main `20f449ff` as `d0dddc9e`.
There were no textual conflicts, and the complete PR #94 delta has the same
stable patch identity before and after integration. This branch includes PR #94;
the separately frozen RC4 source and its artifact do not.

Integrated source checks passed: browser 473/473, local companion 295/295,
native source 78 passed with three designated artifact exclusions, architecture,
and offline Codex, telemetry-schema, browser-mirror and i18n contracts. No full
root gate or native artifact gate was run for this combined tree.

Both protected R7 freshness checks fail on the current workload digest and file
count. The integrated workload provenance was recomputed from every main Git
blob and matches this tree exactly; all ten retained receipts also match main
byte-for-byte. These failures are inherited from main, not introduced by the
startup fix. No protected receipt was edited or regenerated. At the time of
this checkpoint, main-source merge remained review-gated, separately from the
RC4 signed-artifact qualification.

## Merge and integrated-candidate amendment

PR #96 subsequently merged the source-only startup correction into `main` as
`3b0f2d23775c0ca1f092fe3eb48f0c3166c8461a`. That release-preparation base
includes PR #94 and PR #95. The earlier stale-R7 statement remains the accurate
checkpoint for that pre-merge review. The current RC5 R7 workload-source closure
subsequently regenerated and validated all ten protected receipts on 2026-08-31
against 359 files / workload SHA-256
`4c3058b3453bda2696e946952d18e81310f26eb0187074d410c730e44162f1d6`.
The reconstructed decision remains `release_open`; this is current evidence,
not a claim that R7's standing promotion ceilings or PR #94's empirical gate are
closed. The native startup and RC5 allocation files are outside that workload
closure and remain subject to their separate native and artifact gates.

Installed RC4 source `735a59ce2ec01df0e381fb1aa878c5c7a39edcd8`, build
`1023.2`, is signed and notarized but excludes PR #94. At that checkpoint, the
next integrated dogfood used monotonic RC5 build `1023.3`; it had not yet been
built, signed, notarized, or installed. Stable build `1024` remained separately
reserved.

RC5 was subsequently built, signed, notarized and installed, then failed its
separate real full-accounting refresh gate at the ordinary five-minute timeout.
The corrective RC6 allocation is `1023.4`; none of RC5's artifact or startup
evidence qualifies that later source.

## RC6 installed follow-up and RC7 boundary

RC6 source `e59115d41958f6b23496a65c9732a6a9944fdde0`, build `1023.4`,
was subsequently signed, notarized, installed, and launched against preserved
schema-11 state without an observed automatic Keychain prompt. Its real refresh
ran beyond five minutes and reached terminal success, so the RC5 lifetime defect
is corrected. Native startup recovery also remained successful on that artifact.

The same installed run exposed a separate inherited `recent_7d_indexing` legacy
checkpoint suppressing otherwise-authoritative unified accounting. RC7 removes
only that retired collector gate and retains the fail-closed
`unifiedGenerationAuthoritative` decision. RC7 is allocated build `1023.5`,
strictly after installed RC6 and before stable `1024`; it still requires fresh
exact-source gates, protected R7, signing, notarization, state-preserving
replacement, and installed native verification. PR #94's fixed-real-corpus
comparator remains **OPEN / NOT RUN**: an explicitly open-gate internal dogfood
may be tested, but stable and public qualification remain blocked until that
gate is closed or deliberately resolved.

## RC7 installed follow-up and RC8 boundary

RC7 source merge `87e07be350582713d815a21b4db470ed84aae037`, build
`1023.5`, passed protected R7, the full source gate, signing, notarization,
stapling, and state-preserving installation. Startup recovery remained healthy.
The first installed refresh ingested generation 44, then the strict v0.14 cache
validator rejected inconsistent fit metadata. The fit correctly excluded an
early diagnostic-only transition, but the projection copied that rejected row's
eligibility onto the reset fitted from later eligible rows.

RC8 keeps the strict validator and starts reset fit-metadata projection at the
first eligible row. Build `1023.6` is allocated strictly after RC7 and before
stable `1024`, but it has not yet passed exact-source R7, artifact, replacement,
installed-refresh, or physical-native gates. PR #94's formal comparator remains
**OPEN / NOT RUN** and blocks stable/public qualification; explicitly open-gate
internal dogfood testing may continue.
