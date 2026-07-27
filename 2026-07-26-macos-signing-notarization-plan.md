---
title: macOS Signing and Notarization Plan
date: 2026-07-26
type: plan
status: active
---

# macOS signing and notarization

## Outcome

Turn the exact reproducible unsigned macOS arm64 local-review candidate into a
separately versioned Developer ID signed and Apple-notarized distribution
without overwriting the reproducible base, weakening artifact verification, or
authorizing external participants.

Credential use, residual-risk acceptance, and release authorization remain
human-owner actions.

## Current readiness

This Mac has:

- Apple `codesign`, `spctl`, `notarytool`, and `stapler`;
- a valid Developer ID Application identity in Keychain;
- the upstream Node runtime already signed by the Node.js Foundation with the
  hardened runtime; and
- the Keytar native addon carrying only an ad-hoc linker signature.

The existence of the identity is not authorization to use it. Notary service
credentials and a successful Apple submission have not been verified.

The latest non-mutating preflight is bound to the exact private-remote
clean-clone archive and manifest in the
[clean-clone artifact receipt](./2026-07-26-clean-clone-local-review-artifact-verification-receipt.md).
Its state is `owner_authorization_required`; the technical path is ready, but
no signing or notary credential use has occurred.

## Distribution decision

Use a signed and notarized disk image rather than a flat installer package.
The disk image preserves the current explicit-target installation and exact
receipt uninstall model; it does not silently choose a system install path or
claim package-manager ownership.

The disk image will contain a signed successor of the materialized local-review
tree plus the user-facing verification instructions. It will not merely wrap
an opaque tar file that Apple cannot meaningfully inspect.

## Signed-successor pipeline

1. Require the exact unsigned archive SHA-256 and manifest SHA-256 from the
   network-audited receipt.
2. Extract into a new owner-only `.release-signing` workspace; never mutate
   `.release-repro/c`.
3. Reverify the complete unsigned manifest before any signing mutation.
4. Require an exact Developer ID certificate fingerprint selected by the
   owner; never select by an ambiguous display-name substring.
5. Sign the Keytar Mach-O addon with hardened-runtime-compatible Developer ID
   options and a secure timestamp.
6. Preserve and verify the upstream Node Foundation Developer ID signature
   rather than replacing it unnecessarily.
7. Regenerate a signed-successor manifest, checksums, provenance, and SBOM
   relationships that bind the parent unsigned archive and every post-signing
   byte.
8. Run the complete local lifecycle and network-attempt smoke against the
   signed tree before packaging.
9. Create a deterministic-layout read-only disk image. Signing timestamps make
   final signed bytes non-reproducible; the unsigned parent remains the
   reproducible anchor.
10. Sign the disk image with the exact owner-selected Developer ID identity.
11. Submit that exact disk-image SHA-256 through an owner-approved Keychain
    notary profile, wait for acceptance, and retain the submission identifier
    only in a private release receipt.
12. Staple and validate the ticket, then run `codesign`, `spctl`, and
    `stapler validate` against the final bytes.
13. Repeat install, doctor, inspect, export, verify, deletion, and uninstall on
    a genuinely clean macOS arm64 account or machine with network denied.

## Fail-closed rules

- Never sign a dirty source build or an archive whose digest differs from the
  approved parent.
- Never overwrite the unsigned reproducible candidate.
- Never print certificate hashes, Team IDs, notary profile names, Apple
  credentials, or submission logs containing account data.
- Never read or store Apple credentials in repository files or process
  arguments.
- Refuse zero or multiple matching Developer ID identities until the owner
  supplies an exact fingerprint.
- Refuse an ad-hoc, Apple Development, Mac App Distribution, or 3rd Party Mac
  Developer identity for the external Developer ID route.
- Refuse notarization unless every nested Mach-O passes strict code-signature
  verification first.
- Do not describe submission as notarized until Apple accepts it and the final
  disk image passes stapler and Gatekeeper validation.
- Signing and notarization do not authorize volunteers, uploads, or public
  collection.

## Immediate implementation slice

Add a non-mutating readiness command that:

- binds itself to the exact unsigned archive and manifest digests;
- verifies artifact integrity and required Apple tools;
- reports only bounded booleans and fixed blocker codes;
- counts valid Developer ID Application identities without exposing them;
- distinguishes the upstream signed Node binary from the ad-hoc Keytar addon;
- records that notary credentials are unverified; and
- writes an owner-only, no-clobber readiness receipt.

The actual signing command remains disabled until the owner explicitly
authorizes use of the selected Developer ID identity and notary profile.
