---
title: macOS Signing Readiness Verification Receipt
date: 2026-07-26
type: verification
status: ready-for-owner-authorization
---

# macOS signing readiness verification

## Verdict

The exact unsigned local-review candidate is technically ready to enter an
owner-authorized Developer ID signing workflow on this Mac. The preflight was
non-mutating: it did not use a signing identity, access notary credentials,
submit bytes to Apple, create a signed successor, or authorize participants.

## Exact input

| Property | Value |
|---|---|
| Artifact | `usage-monitor-local-review-0.1.0-alpha.1-darwin-arm64` |
| Archive bytes | `146447872` |
| Archive SHA-256 | `22e0b6db6a0725eff48fa0d2179fd0f7b7f066f4a1aa9c299f9f329df5ebdc27` |
| Manifest SHA-256 | `2cdbb5f2ca6047fefaca2242b60fc634ee572cb7dda9a16ca159a73dff094022` |
| Unsigned build receipt | verified |
| Artifact self-verification | passed |
| Host | macOS arm64 |

## Readiness evidence

The bounded preflight verified:

- Apple `codesign`, `spctl`, `notarytool`, `stapler`, `hdiutil`, and `ditto`
  are available;
- exactly one valid Developer ID Application identity is available;
- no certificate hash, label, Team ID, or authority detail was written to the
  receipt;
- the bundled Node runtime retains its upstream Developer ID signature,
  hardened-runtime flag, and strict verification;
- the Keytar native addon has the expected valid ad-hoc baseline and requires
  Developer ID signing in the successor;
- the archive digest, byte count, manifest digest, unsigned build status, and
  participant-authorization status agree; and
- the owner-only receipt was created without overwrite.

Three focused parser/classification tests passed and proved that identity
summaries retain counts only, distinguish the upstream Developer ID signature
from ad-hoc code, and do not treat Apple Development or Mac App Distribution
identities as Developer ID Application identities.

## Fixed blockers

The receipt returned only these blockers:

1. `OWNER_SIGNING_AUTHORIZATION_REQUIRED`
2. `NOTARY_CREDENTIAL_NOT_VERIFIED`
3. `SIGNED_SUCCESSOR_NOT_BUILT`

There is no missing-tool, missing-identity, ambiguous-identity, wrong-host,
artifact-integrity, upstream-Node-signature, or Keytar-baseline blocker.

## Required next authorization

Before any credential is used, the owner must explicitly authorize:

- use of the single verified Developer ID Application identity for this exact
  archive parent;
- the exact Keychain-backed notary profile to probe and later use; and
- construction of a separate signed successor under `.release-signing`.

The successor must follow the [macOS signing and notarization
plan](./2026-07-26-macos-signing-notarization-plan.md). The reproducible unsigned
candidate must remain unchanged. A successful signature alone does not mean
Apple notarization, Gatekeeper acceptance, clean-machine compatibility,
volunteer authorization, or permission to collect data.
