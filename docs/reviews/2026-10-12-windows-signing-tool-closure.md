---
title: Windows signing tool closure and provisioning review
date: 2026-10-12
type: review
status: draft
---

# Windows signing tool closure and provisioning review

This is the source review and provisioning boundary for finding 1 in the
[security triage](./2026-10-12-security-findings-triage.md). The reviewed baseline
is `d6df06572aafbeea0258e96c58ca488e2025567c`. The remediation adds a staged NSIS
signing pipeline with separate preparation and signing jobs. Its reviewed
offline signing toolchain starts at `provisioning_required`: no production
signing-tool hashes, publisher approvals or successful Windows execution are
supplied by this record. Source wiring is not end-to-end release qualification.

The [release publication runbook](../runbooks/2026-08-18-cross-platform-release-publication.md)
remains the operational authority. This review does not authorize a workflow
dispatch, Azure authentication, signing, release, or publication. It does not
establish that a dependency was compromised.

## Staged signing source and open qualification

The [main workflow](../../.github/workflows/electron-windows-signing.yml) defines
four preparation/signing pairs followed by unprivileged installed
qualification. Each signing pass calls the
[minimal reusable signer workflow](../../.github/workflows/electron-windows-sign-subjects.yml).
The [stage helper](../../scripts/prepare-electron-windows-signing-stage.mjs)
owns build execution, signed-byte transfer and the NSIS continuation.

| Unprivileged preparation | Isolated signing pass | Following boundary |
|---|---|---|
| Native candidate, exact source receipt and native-module journal | `sign-native` | Verify returned native bytes and rebind before packaging. |
| Staged application executables and libraries | `sign-application` | Verify and apply returned signatures before NSIS preparation. |
| Generated NSIS uninstaller and saved continuation | `sign-uninstaller` | Verify the signed uninstaller and resume the digest-bound NSIS checkpoint, without rerunning candidate preparation in a credential job. |
| Final outer installer | `sign-installer` | Verify returned final bytes, regenerate the outer blockmap and update metadata, write operation evidence, then run installed qualification without OIDC. |

The resumed NSIS compilation preserves the pinned builder's output-error and
installer-size checks before admitting the outer signing subject. Finalization
uses the pinned builder's `buildBlockMap` to regenerate the `.exe.blockmap`
sidecar from the final signed installer, then verifies that the installer bytes
are unchanged. It writes `latest.yml` from the same final bytes. The existing
`differentialPackage: false` contract for the inner archive remains unchanged.

The [direct signer](../../scripts/sign-electron-windows-subjects.mjs) uses
admitted SignTool and the signing Dlib rather than either gallery module. Its
`/dlib`, `/dmdf` and metadata fields (`Endpoint`, `CodeSigningAccountName`,
`CertificateProfileName`, `ExcludeCredentials`) follow
[Microsoft's documented SignTool integration](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations).
That interface documentation does not validate the chosen binary or publisher
pins.
The signer verifies fixed-stage subjects and the complete tool inventory before
requesting a federated token, then rechecks the tool inventory before each
signing invocation. It treats candidate files as data and does not execute
them. The legacy finalizer's `--sign` and `--prepare-builder-host` modes are
retired and fail closed.

The [tool policy](../../config/windows-signing-toolchain.json) contains
`status: provisioning_required`, `tools: null` and an empty file list. The
[policy validator](../../scripts/lib/windows-signing-toolchain.mjs) rejects that
state. A reviewed policy requires exact paths, sizes, SHA-256 digests and source
URLs; every `.exe` and `.dll` additionally requires a publisher-certificate
digest. No production pins are invented to make the lane pass.

The [signing egress policy](../../scripts/windows-signing-egress.ps1) saves the
disposable runner's prior firewall state, disables existing outbound allow
rules and enables default outbound blocking. It allows TCP 443 to resolved
addresses for the exact GitHub OIDC host, `login.microsoftonline.com`,
`eus.codesigning.azure.net` and `timestamp.acs.microsoft.com`; TCP 80 is limited
to resolved timestamp addresses. DNS is limited to the configured resolvers.
These are address-level rules, not hostname filtering. The reusable signer
applies them before signing and restores prior state both in `finally` and an
`always()` cleanup step.

The full stage architecture and network policy are present in source.
Provisioning, native publisher verification, exact Windows runtime behavior
and authorized OIDC execution remain open. Source policy does not establish
actual registry denial, certificate revocation-check availability or successful
firewall restoration on the hosted runner. The initial Node interpreter,
PowerShell/.NET, operating system and commit-pinned GitHub action runtimes
remain explicit hosted-runner trust assumptions. These limits prevent an
operational or released-fix claim from portable tests alone.

## Build bootstrap admission

The [unprivileged build composite](../../.github/actions/windows-unprivileged-build/action.yml)
uses the [repository bootstrap policy](../../config/windows-build-bootstrap.json)
instead of Corepack installation or `setup-node`. It selects the official Node
26.2.0 Windows x64 ZIP by exact URL, size and SHA-256, and the pnpm 11.9.0
archive by exact URL, size and SHA-512. The policy also commits the npm registry
public key and signature over the pnpm name, version and integrity value.
That registry signature is distinct from a package-author signature. Node
archive admission does not claim Authenticode or upstream release-signature
verification.

The [bootstrap preparer](../../scripts/prepare-windows-build-bootstrap.mjs)
refuses signing authority, verifies those values, validates pnpm's bounded
archive paths and complete file set, and writes a `verified_not_executed`
receipt. It runs on the hosted runner's existing Node interpreter. The
[Windows expander](../../scripts/expand-windows-build-bootstrap.ps1) uses the
runner's PowerShell/.NET, rechecks the Node ZIP digest through a held stream,
and validates all extraction entries before writing files. Only afterward
does the composite execute the admitted Node runtime and pnpm entrypoint to
install the frozen workspace lockfile with lifecycle scripts disabled.

This covers the selected downloaded bootstrap artifacts. It does not remove
the runner substrate trust assumption or qualify actual Windows extraction,
compiler behavior, signing-tool dependencies or end-to-end execution.

## Baseline executable closure

The [Windows signing workflow](../../.github/workflows/electron-windows-signing.yml)
at the baseline performs preparation and signing in one job with
`id-token: write`. Versions, action commit pins, the frozen dependency lockfile,
ignored lifecycle scripts, exact source checks and the protected environment
reduce substitution opportunities. They do not independently admit every tool
byte executed in that privileged job.

| Boundary | Verified baseline selection | Admission requirement |
|---|---|---|
| Workflow and host | Commit-pinned checkout, setup-node, Azure login and Artifact Signing actions; `windows-2025`; Node 26.2.0 x64 | Review the exact action implementations and host boundary. Record the runner image and runtime identities used for qualification; a moving runner label alone does not establish reproducible tool bytes. |
| Package-manager bootstrap | Registry-installed Corepack 0.34.0; Corepack prepares pnpm 11.9.0 | Prepare without signing identity. Admit the executable bootstrap and its runtime files through reviewed digests before restoring them to a signer. |
| Repository tools | `pnpm install --frozen-lockfile --ignore-scripts`; electron-builder and patched app-builder-lib 26.15.7 | Preserve the lockfile integrity and patch identity. Cover the actual installed dependency tree and any executable caches used by the signer. |
| Native preparation | npm-bundled node-gyp, the Windows compiler toolchain, repository filesystem-binding builder, and staged keytar 7.10.6 | Keep building in the unprivileged lane; bind admitted candidate bytes to the exact source and preparation evidence. Inventory build-host tool identities separately from signer tools. |
| Builder signing | TrustedSigning 0.5.0 prepared by the patched app-builder-lib host preflight | Admit the whole module, its nested modules and its resolved SDK, client and .NET command dependencies. The signer must refuse missing dependencies instead of installing them. |
| Native-module signing | Azure Artifact Signing action at `c7ab2a863ab5f9a846ddb8265964877ef296ee82` independently installs ArtifactSigning 0.1.8 | Cover this second module and dependency closure, or remove this download-capable action from the signer in favor of the admitted local tool invocation. |
| Packaging utilities | Builder-selected winCodeSign 2.6.0, NSIS 3.0.4.1, NSIS resources 3.4.1 and 7zip 1.0.0; the locked package includes archive SHA-256 pins | Preserve those existing integrity checks and inventory the unpacked executable closure and caches. Preparation success alone is not proof that a later packaging branch is offline. |
| Candidate execution | Generated NSIS uninstaller and final installed-app qualification execute while the baseline job has OIDC permission | Keep candidate execution outside the privileged signing boundary. A candidate's source binding does not make its runtime a signing authority. |

The repository-owned selection is in
[the lockfile](../../pnpm-lock.yaml),
[the builder patch](../../config/patches/app-builder-lib@26.15.7.patch), and
[the signing finalizer](../../scripts/finalize-electron-windows-signing.mjs).
The baseline builder preflight verified expected command switches; that was an
interface check, not an independent byte or publisher check.
The locked builder's `out/toolsets/windows.js` and `out/toolsets/7zip.js`
contain archive digest checks for the named packaging helpers. The finding is
not an assertion that all downloaded build tools lack integrity checks.

Passive package inspection on 2026-10-12 found two distinct dependency sets:

| Module | SDK package | Signing client | .NET command package |
|---|---|---|---|
| TrustedSigning 0.5.0 | Windows.SDK.BuildTools 10.0.22621.3233 | Microsoft.Trusted.Signing.Client 1.0.53 | sign 0.9.1-beta.24469.1 |
| ArtifactSigning 0.1.8 | Windows.SDK.BuildTools 10.0.26100.4188 | Microsoft.ArtifactSigning.Client 1.0.128 | SignCLI 0.9.1-beta.26227.3 |

These values come from each package's `NugetInstall/NugetInstall.psm1` and, for
the second module, the exact
[Artifact Signing action source](https://github.com/Azure/artifact-signing-action/blob/c7ab2a863ab5f9a846ddb8265964877ef296ee82/action.yml).
The package sources are
[TrustedSigning 0.5.0 dependency code](https://www.powershellgallery.com/packages/TrustedSigning/0.5.0/Content/NugetInstall%5CNugetInstall.psm1)
and
[ArtifactSigning 0.1.8 dependency code](https://www.powershellgallery.com/packages/ArtifactSigning/0.1.8/Content/NugetInstall%5CNugetInstall.psm1).
Both download through package installation and .NET tool installation and can
reuse dependencies based on their presence. Neither package was executed for
this inspection. Catalog or signature files found in an archive are not a
cryptographically verified publisher result; Windows verification remains
required.

## Required separation and admission

Preparation must run without OIDC permission, the protected signing
environment, Azure state or signing credentials. It acquires and stages the
complete build closure and candidate inputs. A fresh signing job may restore
only the minimal signing closure that an independently reviewed repository
manifest admits. The manifest must not be generated and trusted automatically
from the same downloaded bundle. The complete baseline inventory identifies
what must stay outside that privileged boundary as well as what it may admit.

Admission binds the exact source and reviewed manifest to the bundle bytes and
the files restored from it. Each admitted file needs its relative path, size
and digest; executable publisher evidence must be verified where available,
with a reviewed explanation for unsigned components. Reject extra or missing
files, duplicate or escaping paths, unsupported file types, links/reparse
points and digest or publisher mismatches. A version string, download URL or
hash emitted by the downloader is not independent admission.

The signing host must select only the restored tool roots. Remove module,
NuGet, .NET tool, package-manager and builder fallback installation from the
privileged path. A missing or changed tool is a failure, including a cache that
was populated during a prior run. Use a minimal child environment and explicit
tool locations; do not silently inherit another module search path or cache.
Constrain signing subjects to the reviewed candidate files, and constrain
network access to required authentication, signing and timestamp services.
Host utilities and GitHub action runtimes remain explicit trust assumptions
and require their own qualification evidence.

The initial `provisioning_required` state is intentional. It must reject entry
to the privileged signing operation until reviewed production pins exist.
Failing closed is a source containment result; it is not an operationally
qualified replacement signer.

## Provisioning and qualification gates

1. On a disposable Windows host without signing identity, resolve the complete
   selected closure and exercise every required packaging branch. Retain a
   content-free inventory of exact sources, file digests, package integrity
   metadata and tool identities. Include embedded scripts and runtime files,
   not only the top-level executable.
2. Independently verify applicable Authenticode, catalog and package publisher
   evidence. Confirm expected publisher identity, signature validity and
   applicable trust policy on Windows. Review any unsigned components and
   downloader behavior. Do not copy unverified observed hashes into an
   approved manifest.
3. Review and commit the immutable trust manifest with its exact source scope,
   supported tool versions and closure identity. Keep production approval
   absent until every required value and evidence record is present. Define
   deliberate replacement and revocation of a tool pin; do not accept
   automatic version upgrades.
4. Rehearse restoration on a fresh Windows host. Prove that missing, changed,
   extra and wrongly signed files fail before privileged admission; prove
   unavailable network/package registries cannot cause a reinstall. Exercise
   cold and reused caches and verify the selected tool paths. Verify registry
   denial, required certificate checks and service connectivity under the
   outbound policy, plus restoration after success, failure and interruption.
   A successful preparation job is not a substitute for this rehearsal.
5. With separate authorization for the exact candidate and signing resource,
   run the protected signer. Preserve its fixed subject inventory, bounded
   credential selection, operation ledger and content-free failure reporting.
   Verify the final signatures, publisher, digest algorithms, timestamp and
   exact artifact bytes without publishing them.
6. Complete native-module rebinding before final installer packaging, then
   qualify the exact final installer and installed app on Windows. Preserve
   the separate final-byte, clean-install, upgrade, credential and cleanup
   gates. Publication and updater qualification remain separate outcomes.

## Evidence boundary

Portable tests can establish manifest validation, workflow privilege ordering,
offline-fallback refusal and rejection of synthetic tampering. They cannot
establish Windows publisher trust, runner network enforcement, Azure resource
authorization, native-module signature validity, final installer bytes or
installed behavior. Those gates remain open until their exact native receipts
exist. This review contains no real signing result or release authorization.
