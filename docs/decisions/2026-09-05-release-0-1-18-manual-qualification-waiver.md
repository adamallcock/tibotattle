---
title: Release 0.1.18 manual qualification waiver
date: 2026-09-05
type: decision-record
status: accepted
---

# Release 0.1.18 manual qualification waiver

## Decision and authority

On 2026-09-05 UTC, the release owner explicitly accepted the unavailable
disposable-profile and physical Intel tests and directed publication of
TiboTattle 0.1.18 for both macOS architectures. The owner reported that other
testers were running the app successfully. That statement is user-reported
feedback, not independently retained hardware-, source-, build- or
artifact-bound evidence. No test result or attestation is created by this
decision.

This is a release-specific acceptance of incomplete manual qualification for
native macOS 14+ Apple silicon and Intel, stable version `0.1.18`, build `1026`,
from the final annotated `v0.1.18` source. It permits publication only after the
non-waived gates below pass. It does not declare stable bytes already built,
signed, published or installed. It does not apply to private RC1/RC2/RC3
identities, later releases, Windows, Linux, Electron or a new Homebrew Intel
distribution path.

## Precisely waived evidence

- The unavailable disposable-clean-profile lifecycle and manual-v2 Login Item
  matrix on the final signed app, including the destructive/move/reinstall and
  sign-out/sign-in observations requiring that profile.
- The unavailable formal physical Intel install/runtime/lifecycle/update
  matrix and confirmed physical Intel contribution-upload result. Intel
  execution through Rosetta remains compatibility evidence, not physical
  hardware qualification.

The missing observations remain missing. The release owner accepts the residual
risk of unobserved device-specific behavior; existing synthetic and isolated
smoke checks must not be promoted to human passes. The architecture-, source-
and payload-bound v2 receipt validator remains unchanged. Do not supply a
fabricated receipt, reuse ARM evidence for Intel, mark a check true without
observation, or weaken the validator. This exception supersedes the normal
manual prerequisite in the [Login Item lifecycle decision](./2026-08-03-macos-login-item-lifecycle-decision.md)
and [platform evidence ladder](../reference/platform-support.md) only for the
absent observations listed above in this one release. It is not inherited from
the 0.1.17 deferral and does not carry forward automatically.

## Evidence retained, not upgraded

The [signed RC3 receipt](../receipts/2026-09-04-macos-combined-rc3-signed-candidates.md)
records the corrected common source, both private signed/notarized final DMGs,
artifact-bound validation, and the full source run with 3,859 passing tests.
Fresh R7 receipts and dual-runtime reconstruction checks are retained with
their existing open resource decisions and measurement limits; this waiver
does not turn those decisions into `release_ready`. The
[installed-upgrade review](../reviews/2026-09-04-installed-upgrade-readiness.md)
records copy-only parser-v14 preservation and accounting proof separately from
working-profile installed observation. Later direct observations belong in
their own source/artifact-bound receipt, not as retroactive edits to a pass.

## Non-waived release blockers

- Any observed data loss, corruption, incompatible state mutation, accounting
  preservation failure or unresolved integrity failure remains blocking.
  Preserve the last usable state and the compatible pre-upgrade app/state pair;
  never reopen upgraded state with an older writer.
- The available working-profile ARM launch, bounded refresh, published-index
  integrity/accounting and restart checks remain required. This decision does
  not waive a failure discovered while performing them.
- Unexpected automatic Keychain prompts remain release-blocking. Do not
  approve them, reset credentials, broaden ACLs or suppress macOS protection.
  Routine app access remains non-interactive and explicit recovery stays
  affirmative-only.
- Both stable `1026` artifacts need their own clean annotated source binding,
  exact architecture and payload identity, Developer ID hardened signing,
  Apple notarization/stapling, Gatekeeper validation and final digest checks.
  Private RC3 bytes must not be relabeled as stable.
- Architecture-correct updater identity, signed feed/manifest and replacement
  validation remain required. Retain ARM previous-stable continuity and the
  explicit first-public-Intel bootstrap boundary; waived physical observations
  do not waive updater integrity or permit cross-architecture updates.
- Normal source/CI, draft-release verification, final asset re-download,
  checksum/manifest verification and public download/update checks remain
  separate publication gates under the [macOS release runbook](../runbooks/macos-stable-release-runbook.md)
  and [release trust contract](./2026-08-18-cross-platform-release-trust.md).
  Publish only the evidence actually held; absent optional provenance or SBOM
  attestations remain explicit, not fabricated.

Hosted migrations, deployment, device pairing, contribution activation and
consent are not waived or activated by this desktop decision. Contributions
remain optional and require the contributor's own informed consent. No raw
history, credentials, private account identifiers or device-specific session
content belong in release evidence or tester reports.

## Disclosure and follow-up

The [release notes](../../release-notes/0.1.18.md),
[changelog](../../CHANGELOG.md) and [platform support reference](../reference/platform-support.md)
disclose the exception. Intel support begins with verified public 0.1.18
delivery, not with the private candidate or this decision alone. Record future
physical/manual observations honestly, and diagnose any report through the
normal preservation-first process. Future releases retain the ordinary
qualification policy unless the owner makes a new explicit, scoped decision.
