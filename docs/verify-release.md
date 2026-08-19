---
title: Verify a TiboTattle release
date: 2026-08-18
type: guide
status: current
---

# Verify a TiboTattle release

This guide explains how to verify a TiboTattle artifact downloaded from the
official website, GitHub release, Homebrew, or an operating-system store. The
checks answer different questions:

- a checksum proves that the bytes you received match the published bytes;
- a platform signature proves that the operating system or package channel
  accepted the publisher signature;
- a GitHub artifact attestation, when the release actually publishes one,
  constrains the source repository, source ref/digest, and signer workflow;
- an SBOM records the dependency inventory that was published for that exact
  artifact.

Together these checks provide useful release evidence. None proves that the
software is vulnerability-free or universally “safe.”

## Current availability boundary

The public website currently exposes only the macOS download lane, and it may
remain unavailable until a signed release is published. Release v0.1.12
predates the v1 evidence policy: verify it with its published SHA-256 and
Apple's native signature/notarization checks, but do not infer a GitHub
source-to-binary attestation that it does not publish. Windows and Linux are
qualification targets in the repository's cross-platform release plan; a
Windows or Linux build is not a supported release merely because code or a
plan exists. For releases published under the v1 policy, treat the release
page and its release manifest as the source of truth: if a platform,
architecture, format, channel, native assurance, or digest is not listed
there, do not download or describe that artifact as an official TiboTattle
release. Evidence fields may be explicitly `null`; that means the release
makes no claim for that evidence, not that the artifact is unofficial.

### Important: v0.1.12 is a legacy release

Release `v0.1.12` predates the v1 evidence policy and repository release
immutability. GitHub's release-level verification commands below are intended
for releases published after immutability was enabled and may fail for
`v0.1.12`; do not interpret that failure as evidence that its published DMG
changed. Verify `v0.1.12` with its published SHA-256 and Apple's native
signature/notarization checks in Section 3. The immutable-release setting is not
retroactive.

GitHub artifact provenance is also release-specific. The commands below apply
only when this artifact's v1 manifest entry publishes non-null provenance and
`sbom.attestation` bundles. A native/checksum-only artifact may have explicit
`null` evidence fields and is still an official v1 artifact; in that case there
is no source-to-binary claim to verify. Never infer one from the source tree,
plan, or checksum.

For a published cross-platform release, the GitHub release is canonical for
`release-manifest.json`, any non-null SPDX SBOM, and any non-null artifact-named
provenance or SBOM-attestation bundles. The website exposes availability and
the installer digest; its `release-site-manifest.json` is not a replacement for
those release assets. Sparkle may also publish a sanitized, content-addressed
updater receipt for the signed feed; that separate updater subject is not
general release evidence.

## 1. Identify the exact artifact

Use the download link from the official website or the GitHub release for the
same version. Before running verification, record these values from the release
manifest:

| Field | Why it matters |
| --- | --- |
| Channel (transport) | `direct` and `store` artifacts can be different final bytes. |
| Platform and architecture | A macOS arm64 DMG is a different subject from a Windows x64 installer. |
| Format | DMG, EXE/MSIX, AppImage, DEB/RPM, and Store packages have different native checks. |
| Release tag and source commit | The source identity the build is expected to use. |
| Final artifact SHA-256 | The exact bytes whose signature and provenance are being checked. |
| SBOM digest | The dependency inventory for this final artifact, when `sbom` is non-null; `null` means it was not published. |
| `sbom.attestation` reference | The SBOM attestation, when non-null; `null` means it was not published. |
| Provenance reference | The build claim, when non-null; `null` means this release makes no provenance claim. |
| Platform assurance | Notarization, Authenticode, repository signature, or Store acceptance as applicable. |

Do not substitute a checksum from another architecture, an older release, or a
Store submission for the direct-download entry.

## 2. Verify the common GitHub evidence

Install a current GitHub CLI and authenticate only if the release requires API
access. Replace the artifact path and source commit with the values recorded
from the release manifest.

~~~bash
REPO="adamallcock/tibotattle"
VERSION="vX.Y.Z"
ARTIFACT="./TiboTattle-X.Y.Z-platform-arch.ext"
COMMIT="<40-character source commit from the release manifest>"
SIGNER_WORKFLOW="<signer workflow path from the release manifest>"
SIGNER_DIGEST="<trusted signer-workflow commit from the release manifest>"
PROVENANCE_BUNDLE="./<artifact-filename>.provenance.bundle.json"
SBOM_BUNDLE="./<artifact-filename>.sbom.bundle.json"

gh release verify "$VERSION" --repo "$REPO"
gh release verify-asset "$VERSION" "$ARTIFACT" --repo "$REPO"
~~~

For a v1 release, download every published asset into a fresh directory and
then validate the local manifest, artifact bytes, and checksum file without
any further network access:

~~~bash
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tibotattle-release-verify.XXXXXX")"
gh release download "$VERSION" --repo "$REPO" \
  --dir "$VERIFY_DIR" --pattern "*" --clobber
npm run release:evidence:validate -- \
  --manifest "$VERIFY_DIR/release-manifest.json" \
  --artifacts-dir "$VERIFY_DIR" \
  --sha256sums "$VERIFY_DIR/SHA256SUMS"
~~~

The `gh release download` step is the only network operation in this sequence;
the `release:evidence:validate` command reads the fresh directory only.

For releases published after repository release immutability was enabled,
these checks verify the immutable release and that the local file is one of
its published assets. A release-level or asset-level GitHub attestation is an
additional assurance, not a prerequisite for a native/checksum-only v1
artifact whose manifest evidence fields are explicitly `null`.

When this artifact's manifest entry has non-null provenance and
`sbom.attestation`, verify both bundles with all of the recorded identity
constraints. These are two separate commands:

~~~bash
gh attestation verify "$ARTIFACT" \
  --bundle "$PROVENANCE_BUNDLE" \
  --repo "$REPO" \
  --predicate-type "https://slsa.dev/provenance/v1" \
  --signer-workflow "$SIGNER_WORKFLOW" \
  --signer-digest "$SIGNER_DIGEST" \
  --source-ref "refs/tags/$VERSION" \
  --source-digest "$COMMIT" \
  --deny-self-hosted-runners

gh attestation verify "$ARTIFACT" \
  --bundle "$SBOM_BUNDLE" \
  --repo "$REPO" \
  --predicate-type "https://spdx.dev/Document/v2.3" \
  --signer-workflow "$SIGNER_WORKFLOW" \
  --signer-digest "$SIGNER_DIGEST" \
  --source-ref "refs/tags/$VERSION" \
  --source-digest "$COMMIT" \
  --deny-self-hosted-runners
~~~

The first command verifies the SLSA provenance bundle; the second verifies the
SPDX attestation bundle. The repository, signer workflow, and signer digest must
be the values chosen by the release policy, not a workflow guessed from the
current default branch. The source ref must be the exact protected release tag,
and the source digest must be the exact commit recorded in this release's
manifest. If a reusable workflow produced the attestation, verify the reusable
workflow's repository and path instead of treating the caller workflow as the
signer. Append `--format json` to either command when saving the verified
certificate and transparency-log details for review. If either non-null bundle
fails verification, fail closed on the corresponding attested claim.

The workflow controls much of each attestation predicate. The certificate
identity and transparency-log/timestamp evidence are the parts that are not
simply free-form text supplied by the workflow. A trusted, isolated release
workflow is therefore part of the security boundary.

## 3. Verify the platform artifact

Run the commands for the platform artifact you actually downloaded. Replace
the example paths with your file.

### macOS direct DMG

Compare the DMG with the manifest, then verify the disk image and installed app:

~~~bash
shasum -a 256 "/path/to/TiboTattle.dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 "/path/to/TiboTattle.dmg"

spctl --assess --type execute --verbose=4 /Applications/TiboTattle.app
codesign -dv --verbose=4 /Applications/TiboTattle.app
codesign --verify --deep --strict --verbose=2 /Applications/TiboTattle.app
stapler validate /Applications/TiboTattle.app
~~~

A passing result should identify the expected Developer ID signer and
notarization state. Sparkle updates have a separate Ed25519 feed/signature
check; a valid DMG does not by itself verify a future update feed.

### Windows direct installer or MSIX

Compare the installer with the manifest and inspect its Authenticode signer
and timestamp in PowerShell:

~~~powershell
Get-FileHash .\TiboTattle-Setup.exe -Algorithm SHA256
Get-AuthenticodeSignature .\TiboTattle-Setup.exe |
  Format-List Status,SignerCertificate,TimeStamperCertificate
signtool verify /pa /all /v .\TiboTattle-Setup.exe
~~~

Use the same checks for the final MSIX path when the release publishes MSIX.
The signature must cover the final installer/package bytes and include a
trusted SHA-256 timestamp. SmartScreen reputation is separate from signature
validity: a new correctly signed direct-download binary may still display a
reputation warning while its reputation is established.

A Microsoft Store package is a separate `store` channel subject. Microsoft may
re-sign it, so compare it with the Store release entry and its `distribution`
value, not with a direct EXE or MSIX digest.

### Linux AppImage

Linux has no single desktop-wide Gatekeeper equivalent. For a direct AppImage,
compare the bytes and, only if the release publishes a detached signature,
verify that signature using the published key:

~~~bash
sha256sum ./TiboTattle-x86_64.AppImage
gpg --verify ./TiboTattle-x86_64.AppImage.asc ./TiboTattle-x86_64.AppImage
~~~

The GPG command is conditional: do not invent an .asc file or treat an
unverified key as trusted. AppImage signatures are not universally displayed
or enforced by desktop environments, so the release manifest and GitHub
evidence remain important.

### Linux package repository

A real APT or RPM repository signs its repository metadata. A loose .deb or
.rpm downloaded from GitHub does not gain repository trust automatically.

~~~bash
sudo apt-get update
apt-cache policy tibotattle
rpm --checksig --verbose ./TiboTattle-X.Y.Z-1.x86_64.rpm
~~~

Replace `X.Y.Z-1` with the exact RPM filename recorded in the release manifest;
do not use a wildcard when verifying a downloaded package.

APT should reject invalid or unsigned repository metadata under its normal
secure configuration. RPM should report a valid package signature when a
signed RPM is supplied. A future Flathub or Snap publication must be verified
through that store's publisher and repository controls and listed as a
separate release channel.

## 4. Direct downloads and Stores are separate subjects

The release manifest should contain one entry for every final downloadable
subject. For example:

| Distribution (channel) | Evidence to use | What not to assume |
| --- | --- | --- |
| `github-release` (`direct`) | Final digest, GitHub release/asset verification, a release-specific artifact attestation when published, native platform signature | A Homebrew checksum proves source provenance. |
| `homebrew` (`direct`) | The cask's URL and SHA-256, plus the linked GitHub release evidence | Homebrew changes the app's source or signs the DMG. |
| Mac App Store: `mac-app-store` (`store`) | Store publisher identity plus a `store-delivery-receipt-v1` for the final retrieved subject | The Store binary has the same bytes as the direct DMG, or an upload candidate is the delivered subject. |
| Microsoft Store: `microsoft-store` (`store`) | Store publisher identity plus a `store-delivery-receipt-v1` for the final retrieved subject | The Store package has the same bytes as an EXE/MSIX direct artifact, or an upload candidate is the delivered subject. |
| `flathub`, `snap`, `apt`, or `rpm` (`store`) | The distribution's publisher/repository metadata and the listed release entry | A loose package copied outside the distribution retains repository trust. |

For every `store` subject, inspect the full `store-delivery-receipt-v1` release
asset as well as the normalized `artifact.store.receipt` manifest metadata. The
receipt must bind the provider, listing, source version/tag/commit/repository,
final artifact filename, bytes, and SHA-256, and must state
`subjectKind: store-retrieved`, `deliveryState: final`, and
`uploadCandidate: false`. The manifest metadata records the receipt filename,
bytes, SHA-256, and artifact `subjectSha256`; `SHA256SUMS` includes the receipt
filename and digest. If the receipt is missing, mismatched, non-final, or marks
an upload candidate, reject that Store subject.

The update channel is another subject. Sparkle's signed feed, a Windows update
manifest, or a Linux repository index must be verified against its own key and
final bytes. Do not use the initial installer checksum as an update-feed
signature.

## 5. What the evidence does and does not mean

A SHA-256 checksum proves integrity: your local file has the same bytes as the
published file. It does not prove safety, publisher intent, source provenance,
or absence of vulnerabilities.

A platform signature proves that the platform signer accepted the final bytes
under its policy. Apple notarization, Windows Authenticode, and a Linux
repository signature establish different trust boundaries; none is a
universal safety guarantee.

A GitHub/Sigstore attestation, when independently verified with the repository,
source ref/digest, signer workflow, signer digest, runner policy, and the
artifact's own bundle, provides evidence about the claimed build relationship.
It does not turn a build into a guarantee of vulnerability-free software. The
complete non-null set of `sbom`, `sbom.attestation`, and `provenance` is the
attested v1 profile/path. If any of those fields is `null`, the release makes no
corresponding source/build claim; say that the source is public and the artifact
is signed/checksummed where applicable, but do not say that the binary is
cryptographically proven to come from that source. That provenance claim is
valid only when a trusted hosted workflow generated/finalized and
cryptographically verified the exact final bytes.

## 6. Maintainer release invariants

Every official artifact must have a v1 manifest entry. For each non-null
evidence field, the release pipeline must:

1. Build each platform and architecture on a native, controlled path.
2. Start from a protected, exact release tag and committed dependency lockfile.
3. Generate the final platform artifact before computing its published digest.
4. Ensure signing, notarization, stapling, packaging, compression, and timestamp
   operations are complete before the final artifact is attested.
5. For an artifact claiming the attested v1 profile/path, publish one SPDX SBOM,
   one provenance subject, and one `sbom.attestation` subject, plus their
   artifact-specific bundles, for that final artifact. For a
   native/checksum-only artifact, write explicit `null` values instead.
6. Keep direct-download and Store outputs as separate manifest entries.
7. Verify installation, upgrade, updater, rollback, and uninstall on clean native
   machines before publication.
8. Create a draft release, re-download and verify every asset, then publish an
   immutable release.
9. Pin production actions to immutable commit SHAs and keep signing credentials
   in protected environments.
10. Publish only the claims that the release's manifest and verification output
    actually support.

## Authoritative references

- [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [GitHub gh attestation verify](https://cli.github.com/manual/gh_attestation_verify)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub release-integrity verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)
- [SLSA build provenance](https://slsa.dev/spec/v1.2/build-provenance)
- [Apple notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Microsoft code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [AppImage signatures](https://docs.appimage.org/packaging-guide/optional/signatures.html)
- [Debian apt-secure](https://manpages.debian.org/bookworm/apt/apt-secure.8.en.html)
- [RPM signing](https://rpm.org/docs/6.1.x/man/rpmsign.1)
- [Flathub verification](https://docs.flathub.org/docs/for-app-authors/verification)
