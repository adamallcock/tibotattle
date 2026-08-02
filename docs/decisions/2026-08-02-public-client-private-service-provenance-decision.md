---
title: Public Client and Private Service Source-Provenance Decision
date: 2026-08-02
type: decision-record
status: approved-private-transition
---

# Public client and private service source-provenance decision

## Decision

TiboTattle should be split into two repositories before the first public
installer release. Both repositories remain private throughout the transition;
the client repository's visibility changes only after the public-release gates
below pass and the owner explicitly approves that change.

| Repository | Visibility | Responsibility |
| --- | --- | --- |
| `tibotattle-client` | private during transition; public only after release approval | The complete, buildable macOS/local client; public-safe shared contracts; client tests; release workflow; release verification instructions. |
| `tibotattle-service` | private | Cloudflare Worker, D1 migrations, Cloud Run containment service, operator/admin UI, infrastructure configuration, operational scripts, private test fixtures, and service release credentials. |

The client repository is the source of truth for client code.  The private
service repository consumes an immutable public-client tag, initially as a
read-only Git submodule pin.  Private code must never be copied back into the
public repository as part of a release.  The client build must not import a
file that exists only in the private repository.

This is a transparency boundary, not a security boundary.  A native client is
inspectable by users whether or not its source is published.  Server security
therefore continues to rely on authenticated, authorized, rate-limited APIs,
least-privilege Cloudflare bindings, separate secrets, and reviewable public
API contracts; it must not rely on server implementation secrecy.

The existing `app-usagemonitor` repository remains the private service-side
repository while the extraction is completed. A new private `tibotattle-client`
repository will begin from a reviewed allow-list export, not from this private
repository's history. Making either repository public still requires an
explicit publication instruction.

## Initial content classification

The public repository should contain only the reviewed local-client product:

- `apps/local/` and `apps/macos/`;
- public customer-facing web assets in `apps/web/public/`, excluding the
  operator-only `admin.html`, `admin.css`, and `admin.js`;
- `src/` local collection, analysis, contribution-preparation, and client
  support code, after a redaction and import-boundary check;
- public-safe shared packages: `packages/accounting/`,
  `packages/identity-core/`, `packages/quota-analysis/`, and
  `packages/telemetry-contract/`;
- client build, package, updater, verification scripts and the tests that
  exercise them; and
- a public `README`, licence, `SECURITY.md`, API/telemetry contract, release
  verification guide, dependency lockfile, and release manifests.

The private repository retains at least:

- `apps/worker/`, including D1 migrations, worker tests, deployment scripts,
  generated binding declarations, and private service configuration;
- `apps/cloud-run/`, service templates, cloud resource configuration, and
  containment tests;
- operator/admin assets and all privileged operational tooling;
- raw fixtures, receipts, local observations, incident material, and any
  documentation that exposes internal identifiers or operating procedures; and
- all deployment, Apple-notarization, update-signing, identity-provider,
  encryption, and Cloudflare secrets.

The public API surface is intentionally an exception to the source split: the
public repository must carry a versioned, redacted API contract plus contract
tests.  It describes what the client may send and receive, but not service
implementation, internal data schema, resource identifiers, or abuse-control
thresholds.

## Why a separate repository instead of a public mirror

Do not attach a public remote to this private monorepo or periodically run a
blind history filter.  Both make it easy to publish a deleted secret,
operational receipt, or an unintended new path.

For the initial transfer, create a new repository with a reviewed initial
commit rather than publishing the private repository's history.  Generate a
candidate export in a disposable directory from an explicit allow-list, scan it
for secrets and forbidden paths, build and test it independently, then compare
its source manifest with the release checkout.  Once public, client changes are
made in `tibotattle-client`; the private repository only updates its pinned
client tag through a reviewed change.

This creates a single clear answer to "which source produced the app?": the
public tag named in the release manifest.  It also avoids two writable copies
of the same client source drifting apart.

## Release provenance: more than a checksum

A SHA-256 checksum proves only that a downloaded file equals a particular
release file.  It does **not** show which source or build process produced it.
Each public macOS release should therefore publish all of the following:

1. An immutable public Git tag, with the public source commit recorded in the
   release manifest.
2. A protected GitHub Actions release workflow triggered only from that tag,
   using the committed lockfile and pinned build tooling.  Code-signing and
   notarization access is restricted to a protected release environment.
3. A GitHub artifact provenance attestation for the signed DMG and an attached
   SPDX SBOM.  The attestation cryptographically records the public repository,
   commit, workflow, and build identity.  It is the primary code-to-artifact
   evidence, and GitHub documents verification with
   `gh attestation verify <artifact> -R <owner>/tibotattle-client`.
4. A release manifest containing the tag, commit SHA, application bundle
   version, client source-manifest SHA-256, unsigned payload SHA-256, signed
   DMG SHA-256, SBOM digest, workflow run URL, and attestation verification
   command.  The current macOS tooling already distinguishes the fresh source
   and payload digests from the final signed image.
5. Apple Developer ID signing and notarization evidence, plus the existing
   Sparkle Ed25519 update signature.  These establish macOS publisher/update
   integrity; they do not replace source-build provenance.

The DMG itself is not expected to be byte-reproducible across machines because
Apple signing, notarization, and disk-image metadata legitimately change it.
The public reproducibility target is instead: a deterministic client source
manifest and unsigned payload produced from the public tag, followed by a
verifiable attestation for the signed distribution artifact.  The release
manifest must state this limit plainly.

GitHub's documented attestation uses Sigstore and records repository, commit,
workflow, and triggering event.  GitHub notes that a public-repository
attestation is also recorded in a public transparency log.  Signed checksums
may be added as an offline-friendly convenience (for example, a keyless
Cosign bundle), but are supplementary to the build provenance attestation.

## Required public verification experience

The release page and `docs/verify-release.md` must let an independent user:

1. clone the public tag and inspect the exact source and release workflow;
2. download the DMG and compare its SHA-256 with the manifest;
3. verify the GitHub release asset and the artifact attestation;
4. inspect the attestation's repository, tag/commit, and workflow identity;
5. confirm the installed app's Developer ID signature and notarization; and
6. run a source-manifest/payload rebuild check on a documented macOS version.

The guide must explicitly say that provenance proves the relationship between
source, build instructions, and artifact; it is not a claim that the client or
hosted service is vulnerability-free.

## Delivery sequence and gates

1. **Classify and extract.** Add an allow-list export manifest, forbidden-path
   test, secret scanner, and client-to-private import test.  Produce a clean
   export and make its build/test suite pass without the private tree.
2. **Create the private client source history.** Seed a new private repository
   from that reviewed export, add the future-public documentation and licence,
   protect `main` and release tags, and configure vulnerability reporting. Do
   not transfer private Git history. Switch its visibility only after the
   verification and release gates pass.
3. **Make the relationship one-way.** Add the exact public client tag to the
   private service repository as a read-only submodule pin; update build paths
   and the service's public API contract compatibility check.  A private
   release cannot proceed with an unpinned or dirty client checkout.
4. **Move the client release pipeline.** Run its build in the public repository
   from a protected tag, generate provenance and SBOM attestations, sign and
   notarize only after the client build/manifest match, then publish an
   immutable GitHub release.
5. **Prove the first release.** Perform the public verification procedure on a
   clean machine/account; preserve the result as a redacted public release
   receipt.  The private Worker/service deploy remains a distinct, separately
   approved release gate.

## Acceptance criteria

- The public client builds and tests from a clean clone without private files
  or credentials.
- A CI test fails if the export contains a forbidden path, a likely secret, or
  an import that resolves only in the private service repository.
- The public release manifest names a public immutable tag and exact commit.
- `gh attestation verify` succeeds against the public repository for the
  downloaded DMG and its SBOM; its source/workflow fields match the manifest.
- The DMG hash, Developer ID signature, notarization result, and Sparkle
  update signature all verify.
- The public contract test demonstrates that the released client is compatible
  with the private service without making the service source public.

## Sources consulted on 2026-08-02

- GitHub: [Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
  and [using them for build provenance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).
- GitHub: [verifying immutable release assets](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity).
- Sigstore: [keyless blob signing and verification bundles](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/).
