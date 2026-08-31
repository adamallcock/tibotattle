---
title: Silent native Keychain migration with explicit approval fallback
date: 2026-08-31
type: decision-record
status: implemented-pending-qualification
---

# Silent native Keychain migration

The owner approved a compatibility migration before the public native 0.1.17
release, with a few silent attempts before an explained, user-initiated fallback.
This record defines the change and its verification boundary. It is not evidence
that a signed candidate or an existing user's Keychain has been migrated.

## Contract

- A small native helper retains the legacy packaged Node reader's code-signing
  identity. It does not restore keytar, a general interpreter credential reader,
  arbitrary Keychain queries, or a broad app/Team ACL.
- The helper accepts only the existing four logical capabilities. Its storage
  identity is derived from its authenticated native parent (stable or Preview),
  never from an untrusted service, account, path, or environment argument.
- The private descriptor channel authenticates the live sender using the kernel
  audit token and the exact signed native/helper identities. Requests, replies,
  lifetime, retries, and buffers are bounded. Secrets never use argv, environment,
  ordinary stdout/stderr, disk, diagnostics, or UI.
- Every automatic read explicitly forbids Keychain interaction. Three attempts
  use short backoff and a shared app-lifetime budget, so companion restarts and
  refreshes cannot manufacture an unbounded retry loop or a permission prompt.
- Adoption is create-if-absent, compare-exact, and readback-verified. Failure
  preserves the existing key and history; migration never invents a replacement
  identity, overwrites a conflicting modern value, or broadens access.
  The legacy copy remains available for recovery. Failed readback can roll back
  only the modern item created by that attempt, using its persistent reference.
- Exhaustion produces a quiet native Settings/menu action. Only an explained,
  deliberate native approval may enable an interactive legacy read. The local
  companion protocol cannot approve migration or reset the retry budget.
- Native contract smokes remain synthetic and must not access the login Keychain.

## Qualification

The inspected signed 0.1.16 and 0.1.17 Node readers have matching designated
requirements, unlike Node versus the new native app reader. Apple's
[code-signing guidance](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)
describes designated-requirement continuity between cooperating components.
This is a basis for implementation, not proof that every historical item's ACL
will permit a silent upgrade. Locked Keychains, older development readers, and
custom access controls remain possible approval cases.

Required evidence includes exact-secret synthetic migration, delayed success,
exhaustion, denial/cancellation, conflicts, process/transport failures, malformed
frames, unauthorized callers, Preview isolation, and repeated companion/app
lifecycle behavior. A separate signed probe must exercise a disposable Keychain
without changing the login Keychain, default Keychain, or search list. Source
tests, signed synthetic tests, installed-user upgrade, and public release remain
separate gates.

## Implementation and results

The isolated implementation is based on source
`3d9055fc8e58c84f8ba71feb5deb58b52c532138` (the installed 0.1.17 RC2 source).
It adds the fixed native helper, exact-signature release checks, three silent
attempts with 250 ms/750 ms backoff, and the native Settings explanation in
English, Spanish, and Simplified Chinese. The helper's kernel lifetime timer
also covers a blocked read after parent death; this is not a hard time bound
on every synchronous Security call in the parent. Auth/protocol rejection ends
silent retries. Interactive admission and post-read adoption are both fenced
against a retired companion.

Initial source validation on 2026-08-31 (before the approved follow-up below):

- Retained native artifact gate: 86/86, including compiled broker and approval
  state smokes, real missing/modified helper rejection, Preview isolation,
  deterministic development builds, and lifecycle watchdogs. Signing operations
  in the release-policy tests are mocked; development artifacts use ad-hoc
  signatures, not the Developer ID signing key.
- Native source lane: 75 passed, three designated artifact exclusions, no
  failures; its separate localization and documentation prerequisites passed.
- Socket transport, lane and inert signed-runner tests: 34/34 with normal local
  socket permissions. The sandboxed invocation had three `EPERM` listener
  failures; the unchanged supported-environment rerun passed.
- Standalone compiled native smoke: 1/1 with normal desktop permissions. The
  sandboxed run terminated a native subprocess; the exact cause was not proven.
- Browser UI: 416/416; fixed migration-recovery copy names the actual native
  controls in all three locales, without translating raw errors or diagnostic
  identifiers.
- Native layout: 24 synthetic AppKit cases passed across three locales,
  light/dark appearance, three migration states, and attached explanation
  sheets. Measured labels/buttons fit; Cancel is the actual default in all six
  sheets. The extracted app/localization source hashes match this checkout.
  This is geometry/state evidence only: PNG exports were incomplete and the
  read-only desktop capture timed out. Visual and physical interaction signoff
  remain open; no approval action or Keychain access occurred in this harness.
- Architecture: 367 production files, 1,447 imports, zero approved debt edges.
  Documentation/preflight passed.
- Full root: 3,247 tests, 3,225 passed, five failed, 17 designated skips, no
  cancellations; exit 1 in 575.6 seconds. Two failures were missing Worker
  `jsonc-parser` imports in the isolated checkout, resolved by its locked
  `npm ci`. One was the new artifact test's missing static-caller inventory
  entry, fixed by registering its three existing build/release imports. Those
  affected suites then passed 12/12. The remaining two failures are retained R7
  `workloadCodeSha256` freshness checks. The full-root command is **not green**;
  no assertion, timeout, or receipt was weakened or regenerated.
- The nine signed-probe fixture compositions compiled against a frozen copy of
  the actual shared migration source. This initial check did not sign or execute
  them; the subsequent signed qualification is recorded below.

The retained RC2 DMG checksum and receipt's source/payload/signing-policy
digests were independently rechecked. Its previous-only compatibility exception
cannot qualify a current candidate without the helper.

## Approval history and remaining release gates

The safety review initially withheld two operations pending explicit owner
approval:

1. **Explicit reset semantics.** The initial generic broker `delete` removed only
   the modern generation. Retaining a legacy recovery copy means it could be
   imported again after such an explicit reset. Extending the deliberate reset
   path to remove that same capability's legacy copy was initially not applied. Migration
   must not silently delete that recovery copy; resolve the separate reset
   behavior and its regression tests before release.
2. **Signed synthetic verification.** The prepared probe uses the existing
   Developer ID signing key and create/delete one owned disposable Keychain. Its
   invocation was rejected before execution. Do not bypass that boundary or
   treat compilation/ad-hoc tests as evidence about historical Keychain ACLs.

The owner subsequently gave explicit approval for both operations on
2026-08-31 and requested a rebuilt native dogfood. That authorization covers
the signed disposable-Keychain fixture and the deliberate-reset implementation;
it does not authorize resetting real installed credentials. Qualification
results must still be recorded before release.

## Approved follow-up qualification

The signed synthetic probe subsequently completed successfully with the existing
Developer ID signing key. The creator and helper preserved the inspected legacy
Node designated requirement; native hosts used the app's distinct requirement.
The direct app read of the legacy item was denied, while the authenticated helper
silently recovered the exact synthetic value. Shared adoption, readback, repeat
adoption, conflict preservation, and legacy retention passed. A differently
built replacement with the same app identity then read the modern item directly
without the helper and without changing the value. Unauthorized parents, invalid
frames/values, deadline expiration, child reaping, and orphan lifetime passed.
The helper remained unable to read the modern app-owned item. No fixture
entitlements or broader credential ACL were introduced.

The disposable Keychain was deleted after verification, and the default and user
search-list selections remained unchanged. No installed application credential
was accessed. This is signed Security-API/default-ACL evidence, not proof about
every existing user's customized ACL or a notarized installed-app replacement.

The first signed attempt exposed a fixture ownership-bookkeeping defect: a
legitimate Security database write replaces its inode. The fixture now retains
an immutable baseline and verified, bounded before/after write receipts; unknown
or incomplete changes still fail closed. The pure ownership reducer passed 26
assertions. Its earlier orphaned synthetic Keychain was removed only by a
separately reviewed metadata-pinned cleanup, preserving the original failed-run
receipts. The cleanup's POSIX canonical-path predicate has eight passing pure
assertions and avoids Foundation's `/private/var` path abbreviation. See the
[fixture contract](../../test/fixtures/macos-keychain-migration/README.md).

The deliberate broker reset now removes its own capability's legacy recovery
copy before its modern copy. Legacy failure preserves modern; a partial modern
failure is retryable. Generation claims prevent delayed helper/approval results
from restoring a reset credential. Compiled synthetic cases cover both storage
identities, all four capabilities, protocol-v1 isolation, partial failure, and
approval/reset races. Independent review also reproduced a separate native
full-reset composition race: completion ran before queued broker teardown.
The repaired lifecycle now keeps detached companions in a retirement registry,
awaits every current/retiring writer barrier before reset, and fences repeated
reset, new launches, and stale callbacks. The independent exact-source,
memory-only composition probe passes for an absent child, pending termination
handler, and draining broker: no credential is restored, callbacks run once,
and retained companions are released. No real Keychain access occurs in these
regression probes. The observer's initial snapshot is also ordered before later
state-change notifications.

The post-reset-fix native artifact gate passes 88/88 with no skips or
cancellations (exit 0, 230.7 seconds). The source lane passes 77 native checks
with its three designated artifact exclusions; documentation and localization
prerequisites pass 19/19 and 7/7. Full Swift typechecking passes for the actual
macOS 14 target. The browser suite at that point passed 416/416.

A fresh English AppKit capture verifies the complete migration explanation
and both buttons in the actual attached native sheet; Cancel remains the default.
That inert harness made no approval call and accessed no Keychain. It does not
qualify other locales' visual rendering or the installed signed candidate.
Subsequent on-screen checks paused when the Mac locked; no unlock, password
entry, or security-dialog automation was attempted. Final installed-app visual
and interaction checks require the owner to unlock the Mac.

The first authorized R7 attempt
on 2026-08-31 passed its six synthetic phases but exited 1 during the shared
real-history phase with a source-plan bundle integrity failure. The generator
automatically recovered its incomplete transaction; at that point all ten
retained receipts were unchanged and stale. That failed run is not release
evidence and is not relabeled as successful by the retry below.

The original error discarded its underlying cause, which cannot be recovered
from the preserved progress log. A diagnostic-only correction now records a
closed operation/provider/reason at the actual source-plan failure boundary,
without retaining raw errors, paths, plans, or secrets. The generator prints
that validated context to stderr and marks successful source-plan freezing.
Integrity checks, successful projections, receipt formats, and genuine resource
error behavior are unchanged. The four owning synthetic suites pass 62/62 with
normal process/RSS access; architecture and tool inventory also pass. The fresh
canonical R7 retry completed with exit 0 at 16:38 UTC on 2026-08-31, regenerating
all ten validated receipts. Its 335-file workload fingerprint is
`8be3813e1f9cc787652bf6c718715d91e245e90df6f5eff1bcef5ad1cd16832a`.
Independent retained-evidence checks then passed 2/2 on Node 24.14.0 and 2/2
on Node 26.2.0. The correction and successful retry do not establish the cause
of the first failure. Both release decisions still say `release_open` with
19 unresolved resource-ceiling dimensions, as in the baseline; fresh receipts
are not stable/public resource-ceiling qualification.

Review of all ten receipt diffs found no change to operation outcomes, policy
limits, schema fingerprints, privacy/preservation results, or promotion states.
Real-history discovery increased from 3,096 to 3,123 sources (the additional
discovery is Claude-only); both runtimes still produced 436,557 records and
518,442,273 decoded export bytes. The encoded export is 938 bytes smaller.
Bundle identities include source commitments and an ephemeral per-run secret,
so changed artifact hashes do not by themselves establish changed logical rows;
the retained aggregates also cannot prove baseline row-by-row equality.
Same-runtime repeat comparisons still pass, while the existing whole-lifecycle
cross-runtime limitation remains. Peak real scan RSS is 1,170,735,104 bytes on
Node 24 and 1,254,391,808 bytes on Node 26, both below the unchanged
1,610,612,736-byte ceiling. Three individual synthetic RSS samples failed, as
in the baseline count but at different operations; their successful sample
counts remain recorded. Neither measurement drift nor sample failures are
silently promoted to stronger resource or runtime qualification.

The final automatic-flow review also found and corrected two residual paths.
The native launcher now requires the credential broker and its private endpoint
before any companion resource access or spawn; failed setup cannot fall through
to a separately resolved legacy credential reader. A synthetic actual-launch
probe verifies construction/endpoint failure, a valid-channel control, cleanup,
and once-only stop callbacks without accessing a Keychain. Nine focused tests,
Swift compilation, and independent review pass. The complete retained native
artifact gate was then rerun on the final combined source: 88/88, no skips or
cancellations, exit 0 in 240.3 seconds.

Current web copy no longer prepares users for password prompts or recommends
Always Allow. Denied access now renders a neutral upload pause before the
destructive-recovery classifier, retaining the session, consent, credential,
and history. Genuine unusable/conflicting-credential recovery remains separate.
The final web suites pass 223/223 focused tests, 419/419 full UI tests, and 7/7
localization inventory tests. A loopback-only synthetic browser harness using
the current renderer, fixed copy, catalogs, and styles visibly passes connecting
and denied-access states in English, Spanish, and Simplified Chinese: readable
wrapping, neutral status styling, no reset/approval controls, and no current-page
console warnings or errors. The harness has no credential, account, history,
or upload connection and does not qualify the installed native app.

The final integrated root command then passed: 3,277 tests, 3,260 passed,
17 designated skips, zero failures or cancellations, exit 0 in 453.7 seconds.
This is a new complete run, not a selective retry of the earlier failed root
command. Final architecture (367 production files, 1,447 imports, zero debt),
20/20 documentation/preflight tests, and 77/77 release-trust tests also pass.
The shared migration source remains byte-identical to the signed synthetic
probe: SHA-256
`67043f3de7f803f007b5e33412e59bfe4398380c358780e782c15d885eae4bb0`.

The follow-up also makes unexpected Keychain prompts a release-blocking policy
in root/native/script agent guidance, with a regression check and an updated
release runbook. Automatic flows stay non-interactive; the previously approved,
explained native recovery action remains an exceptional deliberate fallback.
The retained 2026-08-19 first-pairing investigation now has an explicit
superseded boundary: its original Always Allow/reset advice is historical,
not a current instruction. The documentation index routes to this contract.
No blanket ACL grant, plaintext storage, security bypass, or identity reset is
an acceptable prompt-avoidance workaround. The next dogfood allocation is
`1023.1`, strictly after RC2 `1023` and before reserved stable `1024`.

With the source and R7 freshness gates complete, the signed candidate still needs the
authorized old-to-new installation check and complete native visual/interaction
QA. No real TiboTattle Keychain item, installed app, application history, consent,
or hosted deployment has been changed by these implementation and synthetic
qualification steps. No release is established by this decision.
