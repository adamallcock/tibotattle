---
title: Cross-platform release trust
date: 2026-08-18
type: decision
status: maintained
---

# Cross-platform release trust

## Decision

TiboTattle will use one common release-evidence model across macOS, Windows,
and Linux, with a platform-native finalisation step for each artifact.

The common layer records the exact public source tag and commit, native build
identity, final artifact digest, and the verification result for the artifact's
distribution channel. Every official artifact is represented by a v1 manifest
entry. The `sbom` and `provenance` fields are always present and may be `null`;
when `sbom` is an object, its required `attestation` field is also present and
may be `null`. `null` explicitly means that evidence was not published for that
artifact. Non-null evidence is release-specific and must be verified for that
exact final subject. The native layer is deliberately different:

- macOS: Developer ID signing, hardened runtime, notarization, stapling, and
  the signed updater feed where applicable.
- Windows: Authenticode signing and trusted SHA-256 timestamping for final
  binaries/installers, or Microsoft Store package acceptance.
- Linux: the signing and repository/store controls of the selected channel,
  such as AppImage detached evidence, APT/RPM repository metadata, or Flathub.

A checksum, platform signature, and source/build attestation answer different
questions. Product and release copy must not collapse them into a claim that a
download is “safe.”

## Why this shape

There is no single trust root shared by all desktop operating systems. Apple
notarization is not a Windows or Linux verification mechanism, and a Linux
package repository signature does not establish the identity of a macOS DMG.
GitHub artifact attestations provide a useful common source/build evidence layer
but do not replace native platform signing.

The final bytes are the unit of evidence. Signing, notarization, stapling,
packaging, compression, and timestamp operations must finish before the final
artifact digest, SBOM subject, and provenance attestation are published. No
post-attestation mutation is allowed.

## Artifact and manifest contract

The release manifest uses one artifact entry per final downloadable subject.
Each entry should identify:

- channel: the transport class, currently `direct` or `store`;
- distribution: the concrete path within that class, such as `github-release`,
  `homebrew`, `mac-app-store`, `microsoft-store`, `flathub`, `snap`, `apt`, or
  `rpm`;
- platform, architecture, format, and version;
- source tag and source commit;
- final artifact filename, URL, byte length, and SHA-256;
- `sbom`, with `filename`, `sha256`, and an `attestation` object when an SPDX
  SBOM is published, or `null` when it is not;
- `provenance`, with its bundle filename and digest when published for this
  exact release and subject, or `null` when it is not;
- `sbom.attestation`, required inside a non-null `sbom` object and itself
  either a bundle/digest object or `null`; `null` explicitly means that the
  SBOM attestation was not published;
- signer identity, timestamp, notarization, repository, or Store evidence;
- update-feed key or manifest identity when updates are separate from the
  installer.

Store submissions remain separate subjects. A Store may rebuild or re-sign its
package, so its digest and provenance entry must not be presented as the same
bytes as a direct GitHub or website download. A Store entry may describe only a
final subject retrieved from that Store and hash-verified after delivery; it
must never describe an upload candidate. The finalizer must produce a
machine-generated `store-delivery-receipt-v1` document for that subject. The
receipt binds the provider and listing, release version/tag/commit/repository,
final artifact filename, byte count, and SHA-256, and must state
`subjectKind: store-retrieved`, `deliveryState: final`, and
`uploadCandidate: false`. The normalized manifest stores the receipt's
`format`, `schemaVersion`, filename, byte count, SHA-256, and artifact
`subjectSha256`; the full receipt is a release asset and its filename and
digest are included in `SHA256SUMS`.

The complete non-null evidence set—an SPDX SBOM, its non-null
`sbom.attestation`, and non-null provenance, all bound to the exact final
artifact digest and cryptographically verified by the trusted hosted
finalizer—is the **attested v1 profile/path**. A native/checksum-only artifact
is still an official v1 artifact when its nullable evidence keys are explicit
`null`; it may claim only the native and checksum evidence it actually carries.
The manifest shape is therefore v1 even when the attested profile is absent. A
legacy macOS `.dmg.release.json` receipt can support native signing, updater,
and checksum publication, but it is not source-to-binary provenance. Never
infer provenance from the public source tree, a plan, or a checksum.

## Distribution decisions

The manifest's `channel` is intentionally coarse: `direct` means a directly
downloaded artifact (including a GitHub release or Homebrew cask), while
`store` means a package delivered by an operating-system store or managed
repository. The `distribution` field names the concrete provider or delivery
path. Do not put a provider name in `channel`, and do not treat two
distributions as the same final subject merely because they share a channel.

### macOS

Retain the existing Developer ID/notarized DMG route and Sparkle update
signature. Separate arm64 and x86_64 artifacts are easier to identify and
audit than a universal image until there is a reason to add one. The direct DMG
and Mac App Store submission are separate manifest entries.

### Windows

Run a bounded MSIX feasibility check for package identity, clean install, and
updates. If the app's process visibility, startup, or host integration is
incompatible with MSIX, choose one direct installer format for v1: NSIS/EXE for
a per-user installation or WiX/MSI for an enterprise machine-wide route. Do
not publish MSIX, MSI, and NSIS concurrently before the installation contract is
settled.

Sign nested executables, DLLs, and native modules before signing the final
installer/package. Use a trusted SHA-256 timestamp. Azure Artifact Signing
through a protected GitHub-to-Azure identity is preferred when available; a
certificate file must not be placed in the repository or a general-purpose
secret. SmartScreen reputation is a separate adoption signal and cannot be
promised away by choosing EV.

### Linux

Start with one native x86_64 AppImage only after native install and host-access
checks pass. Do not describe a loose AppImage, DEB, or RPM as having a
distribution-wide trust root. Add one managed distribution only after its
permissions, update path, and signing controls are tested:

- Flathub if the sandbox supports the app's process/filesystem observation;
- APT or RPM only as a real signed repository, not a loose package download;
- Snap only after confinement requirements are explicit.

ARM64 Linux is a later matrix expansion after the x86_64 lane is stable.

## Release pipeline invariants

The protected release workflow must:

1. build each supported platform and architecture on a native controlled path;
2. start from an exact protected version tag and committed lockfile;
3. hand off artifacts by digest between build, platform-finalisation, and
   publication stages;
4. reject extra files, symlinks, path traversal, architecture mismatches, and
   digest drift at every handoff;
5. for each artifact claiming the attested v1 profile/path, create one SPDX
   SBOM, one provenance subject, and one `sbom.attestation` subject per final
   artifact; artifacts making only native/checksum claims must record explicit
   `null` evidence keys;
6. run fresh, credential-free verification after signing and before publication;
7. create a draft release, re-download every asset, and verify the manifest;
8. publish immutable release metadata and only then update feeds or Store
   metadata;
9. pin production actions to immutable commit SHAs;
10. keep signing credentials in protected environments and never run untrusted
    pull-request code in the signing job.

Reusable workflows can improve builder isolation, but a workflow's YAML shape
alone is not SLSA Level 3. Any stronger claim must be backed by the actual
runner isolation and input-boundary evidence.

## Rollout

1. Generalise the current macOS release manifest and verification guide to the
   artifact-entry schema above. Keep the website's hero compact and put
   commands and caveats in the docs.
2. Finish native Windows x64 qualification, select one installer, add
   Authenticode/timestamp evidence, and verify clean install, upgrade, and
   uninstall.
3. Qualify a native Linux x86_64 AppImage and its update/no-update boundary.
4. Add Store channels and additional architectures only as separate subjects
   after their native gates pass.
5. Add GitHub artifact attestations and trusted workflow constraints to each
   final artifact once the pipeline can publish and independently verify them.

## Claims policy

The website may say that TiboTattle is open source and that a particular
published artifact is signed for its platform only when the release metadata
supports that statement. It may show build provenance, SBOM, or attestation
language only for the specific release and subject that publishes those
artifacts. It must not imply source-to-binary provenance unless the trusted
hosted workflow generated/finalized and cryptographically verified the exact
final bytes. A complete non-null evidence set is the attested v1 profile/path;
explicit `null` fields mean that the corresponding evidence was not published.

The canonical `release-manifest.json`, SPDX SBOM, and artifact-specific bundles
live on the GitHub release. The website may expose availability and the
installer digest through its own site manifest, but that site manifest is not a
substitute for the release assets. Sparkle's sanitized, content-addressed
updater receipt is a separate updater subject and must not be confused with
the canonical cross-platform release evidence.

The website and documentation must never say:

- a SHA-256 hash proves that software is safe;
- Apple signing proves source-to-binary identity;
- a plan or source tree is evidence that Windows/Linux is released;
- a Store binary has the same bytes as a direct download;
- every release has a GitHub attestation when the release has not published one.

See docs/verify-release.md for the independent verification commands and
authoritative platform references.
