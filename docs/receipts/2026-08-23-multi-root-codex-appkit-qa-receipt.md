---
title: Multi-root Codex AppKit QA receipt
date: 2026-08-23
type: receipt
status: verified
---

# Multi-root Codex AppKit QA receipt

## Claim boundary

The multi-root Codex source flow was exercised end to end in a disposable
native/AppKit development build with a dedicated bundle identity and synthetic,
owner-only Codex roots. The exercise covered selection, persistence, refresh,
partial availability, recovery, removal, reset, cancellation, and companion
process lifecycle behavior.

This receipt qualifies the local development flow and its aggregate, path-free
dashboard behavior. It is not release, signing, notarization, contribution,
account-equivalence, or live-auth evidence.

## Initial and final aggregate evidence

- The disposable app presented a distinct bundle identity from the installed
  app. Its two synthetic roots were owner-only and contained no live account or
  authentication state.
- With both roots selected, the initial corpus produced 2 events and 350
  tokens: 300 input and 50 output.
- The final synthetic append-only corpus produced 3 events and 580 tokens.
  The resulting coverage was `ready`, 2/2 roots available, and
  `pathsIncluded=false`.
- Installed-app process IDs were unchanged before and after the exercise
  (`63251` and `63254`); the disposable app's process tree exited at close.

## Native/AppKit journey

- Settings showed the primary root and the secondary root with native status
  text, including the same-user/account guidance.
- Adding the second root visibly triggered a serialized companion restart.
  The first observation exposed a lifecycle defect in which the old
  `CompanionProcess` was not retained while stopping; that defect was fixed and
  the journey was rerun.
- A process watcher recorded a minimum companion count of 0, a maximum of 1,
  and a final count of 1. Root controls were disabled during the transition
  and recovered after the companion was ready.
- A final lifecycle audit then identified the narrower Quit-during-stop race:
  termination still looked only at the active slot after ownership had moved
  to the stopping slot. The production termination hooks now share the same
  stopping-first selector, cancel the pending restart, and refuse a late
  replacement launch once Quit begins.
- A compiled bundle regression forced `active == nil` while a real companion
  was stopping, attached both the Settings and Quit stop callbacks, and
  observed an intentional stopped child with the restart cancelled. The
  independent re-audit reported no remaining finding at any severity.
- Selecting a different primary root persisted across relaunch.
- Removing a root, changing that root while it was unconfigured, and
  refreshing did not re-import it: the retained aggregate stayed at 2 events
  and 350 tokens.
- Reset removed the launcher settings while retaining the indexed 2-event,
  350-token history.
- Add, Set Primary, and Remove cancellation paths were non-mutating.

## Availability and recovery

- With the secondary root unavailable, native Settings showed
  `Temporarily unavailable`; onboarding reported partial 1/2 coverage, while
  retained history remained visible.
- With the primary root unavailable, native Settings showed
  `Temporarily unavailable`; onboarding again reported partial 1/2 coverage,
  live quota was unavailable, and the retained aggregate stayed at 2 events
  and 350 tokens.
- Both missing-root paths emitted partial coverage with
  `retainedHistory=true` and did not expose filesystem paths in the public
  evidence.
- Deliberately removing the disposable runtime produced
  `UM_MACOS_BUNDLE_INCOMPLETE`. Root controls re-enabled after the failed
  transition. Restoring the exact runtime passed strict code-signature
  verification, and Retry recovered the companion from 0 to 1 process.
- The packaged recovery UI then exposed a second defect: a ready receipt did
  not override a stale partial onboarding result. The source was fixed and the
  final rebuilt package visibly cleared the warning from 1/2 to 2/2.

## Build identity and verification

- Visually exercised development-build payload SHA-256:
  `251f2ca5a345b8a312dac5dc9ff5616a490ac0f6dcc777b558f9d53c8dbfb9bc`.
- Visually exercised development-build source SHA-256:
  `7c7b3627c2458388e65fa4df6e77b5f583fba7e61a20972f6e068067a0df047b`.
- Post-audit development-build payload SHA-256:
  `6ae5a9cc8156f9ac5a1f2bd1d786c1b75dcf9a2da98ded66c63464442ab436dc`.
- Post-audit development-build source SHA-256:
  `0b5013c8e5f3203e0069541a7414e998012cf63c1f277174c10f14953e7481f6`.
- The disposable bundle was ad-hoc signed for local QA. Restoring the runtime
  passed strict code-signature verification.
- No contribution, pairing, identity, keychain, notification, login-item,
  update, app-link, or live-auth action was performed.
- The disposable build was not used as release or notarization evidence.

## Result

The isolated AppKit journey passed after the lifecycle and recovery fixes were
applied. Multi-root selection, primary persistence, retained-history behavior,
partial-root recovery, reset/removal semantics, path-free aggregate output,
and serialized companion ownership were visibly exercised against synthetic
owner-only data. Production release and notarization remain separate gates.
