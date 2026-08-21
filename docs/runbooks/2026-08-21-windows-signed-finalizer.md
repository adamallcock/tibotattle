---
title: Windows signed finalizer
date: 2026-08-21
type: runbook
status: activation-gated
---

# Windows signed finalizer runbook

This is the planned, protected Windows x64 finalizer sequence for TiboTattle.
It is an activation contract, not evidence that signing has run. It must only
be executed by a future protected native Windows workflow after the exact
qualification handoff, checkout, and credential authority have been verified.
It does not add or enable that workflow, acquire credentials, publish an
artifact, or turn on Windows production support.

The source qualification boundary is described by the
[Windows first Electron delivery goal](../goals/2026-08-18-windows-first-electron-delivery-goal.md).
The handoff is verified by
[`verify-windows-finalizer-qualification-handoff.mjs`](../../scripts/verify-windows-finalizer-qualification-handoff.mjs),
the authority data contract is
[`windows-production-authority-manifest.js`](../../src/platform/windows-production-authority-manifest.js),
and the native pre-sign primitive is
[`windows-native-presign.mjs`](../../scripts/windows-native-presign.mjs).

## Activation gates

Stop before this sequence if any of the following is true:

- the protected native Windows x64 warm-and-clean qualification has not passed
  on one exact revision, or its v2 handoff is missing, malformed, stale, or
  contains an unexplained skip;
- the current checkout is not the exact protected revision/version named by
  that handoff;
- the finalizer workflow is not a protected, manually authorized Windows x64
  workflow with pinned actions and content-free artifact retention;
- `productionSafe` or a production selector is being used to make signing
  pass; or
- the operator would need to place a credential, token, raw log, local path,
  user name, or provider response in the repository, receipt, artifact, or
  workflow summary.

As of 2026-08-21, these gates are not closed. The checked-in workflow set has
the manual portability qualification but no enabled production finalizer;
the current goal records a native SQLite qualification blocker; the presign
test is explicitly deferred on Windows; and `productionSafe` plus every
production selector remain false. No signed Windows artifact is accepted.

## 1. Verify the qualification handoff and artifact digests

The source qualification workflow produces two content-free receipts: one
`warm` and one `clean`. Before parsing either receipt, bind its raw bytes to
the corresponding workflow artifact API digest. Generate the v2 handoff with
the checked-in verifier, supplying only the fixed aggregate files:

~~~powershell
node ./scripts/verify-windows-finalizer-qualification-handoff.mjs `
  --output "$env:RUNNER_TEMP\windows-finalizer-handoff-v2.json" `
  --repository "adamallcock/tibotattle" `
  --revision "<40-lowercase-hex-source-revision>" `
  --ref "refs/heads/main" `
  --run-metadata "$env:RUNNER_TEMP\run-metadata.json" `
  --warm-receipt "$env:RUNNER_TEMP\warm-receipt.json" `
  --clean-receipt "$env:RUNNER_TEMP\clean-receipt.json" `
  --warm-artifact "$env:RUNNER_TEMP\warm-artifact.json" `
  --clean-artifact "$env:RUNNER_TEMP\clean-artifact.json"
~~~

The command must return the fixed passed status and a handoff containing both
cache modes. The handoff must bind, for each mode:

- the exact source revision, workflow run and attempt;
- the native security and Electron qualification aggregate statuses and
  counts;
- the reviewed Windows filesystem binding bytes and SHA-256;
- the raw receipt byte count and SHA-256; and
- the artifact id, `sha256:` artifact digest, size, and source revision.

The finalizer must independently check that the raw receipt hash equals the
artifact's recorded digest before trusting any receipt field. Keep the raw
handoff and receipt hashes as protected, content-free evidence; never retain
the workflow log, test output, source paths, or downloaded artifact contents
in a public release descriptor.

## 2. Lock the exact checkout and version

Materialize a fresh checkout at the handoff revision on the protected ref.
Before building, require all of the following:

~~~powershell
git status --porcelain=v1 --untracked-files=all   # empty
git rev-parse HEAD                                # exact handoff revision
node -p "require('./package.json').version"      # exact selected version
~~~

The finalizer must compare `HEAD`, the handoff revision, the selected package
version, the Electron staging metadata, and the version passed to the release
builder. A version mismatch, dirty tree, detached unreviewed commit, stale
lockfile, or changed native binding requires a new qualification handoff; do
not repair the checkout in place.

The planned authority contract uses the protected `main` ref and
`workflow_dispatch` for the signed finalizer. That is a contract value, not a
claim that `.github/workflows/windows-production-finalizer.yml` currently
exists. Do not create or dispatch it as part of this runbook.

## 3. Create fresh disposable Windows staging

Use a native Windows x64 runner and a new attempt-scoped workspace. The
reviewed release configuration fixes these roots:

~~~text
.release-build/electron-production/windows-x64/app
.release-build/electron-production/windows-x64/evidence
.release-build/electron-production/windows-x64/artifacts
~~~

The app and evidence roots must be newly materialized regular directories,
not symlinks or reparse points. The finalizer must reject an existing receipt,
temporary receipt, invalidation marker, or unexpected file before any signing
call. Do not recursively delete an unresolved path to make the check pass;
discard the complete disposable attempt only after its exact root has been
identified, then rebuild it from the verified unsigned source.

The staged tree must contain exactly the reviewed native pair at the fixed
paths:

~~~text
native/windows-filesystem/build/Release/windows_filesystem.node
node_modules/@github/keytar/prebuilds/win32-x64/keytar.node
~~~

Before signing, record only their bounded byte counts and SHA-256 values. The
filesystem module must match the qualified handoff binding. Keytar must match
the pinned digest in the presign contract. No source path, user home, token,
credential, or native diagnostic is permitted in a receipt.

## 4. Run the read-only TrustedSigning preflight

Run the exact preflight before loading or invoking the signing module:

~~~powershell
npm run preflight:windows:trusted-signing
~~~

Accept only `WINDOWS_TRUSTEDSIGNING_PREFLIGHT_PASSED`: exactly one installed
`TrustedSigning` module at version `0.5.0`. `unsupported`, `unavailable`, or
`invalid` is a hard stop. The preflight is read-only; it must not install a
module, import a module, invoke signing, or print module paths or PowerShell
diagnostics.

The release builder must also receive only the reviewed target, signing mode,
version, endpoint, account name, certificate profile name, and publisher
metadata. The release config rejects legacy certificate/password variables and
client-secret variables. Azure authentication must come from the protected
runner authority; it must not be placed in the input JSON, environment receipt,
source tree, or log.

## 5. Pre-sign the native pair and retain the receipt

Build a closed input object for
[`windows-native-presign.mjs`](../../scripts/windows-native-presign.mjs) using
the exact staging root, source revision, package version, v2 handoff hash,
qualified filesystem binding, pinned keytar SHA-256, and reviewed Azure
resource names. The input contains no client secret, token, certificate, raw
PowerShell output, or local diagnostic path. Invoke the fixed package alias
only on native Windows:

~~~powershell
npm run presign:windows:native -- --input "$env:RUNNER_TEMP\windows-native-presign-input.json"
~~~

The primitive signs exactly two fixed `.node` files, immediately re-hashes
each one before its irreversible signing call, invokes TrustedSigning 0.5.0
with SHA-256 file and RFC-3161 timestamp requests, and then checks each result
with both `Get-AuthenticodeSignature` and `signtool.exe verify /pa /all`. A
passing receipt must show, for each fixed module:

- unsigned and signed byte counts and SHA-256 values, with changed bytes;
- the exact package path and module name;
- `Authenticode` status `Valid`;
- the exact configured publisher;
- a present timestamp; and
- successful `signtool` `/pa` verification.

The canonical receipt is
`evidence/windows-native-presign-<revision>.json`. It is written with
no-clobber, synchronized temporary-file and hard-link publication. Retain its
raw-byte SHA-256 and bind that hash into the authority manifest. A successful
receipt does not by itself authorize production: it proves only this native
pre-sign stage and its bounded evidence.

### Invalidation and retry rules

The presign primitive creates
`.tibotattle-windows-native-presign-invalidated` before the first signing
operation.

- Any signer error, Authenticode mismatch, byte-identity mismatch, crash,
  receipt-write failure, marker cleanup failure, or interrupted job leaves the
  marker in place and taints the entire staging tree.
- Never retry a tainted tree, overwrite a receipt, remove only the marker, or
  sign the remaining module. Preserve the fixed failure status, discard the
  complete disposable staging attempt, and rebuild from the verified unsigned
  inputs.
- An existing receipt, temporary receipt, or invalidation marker is a
  pre-sign hard stop. A new attempt gets a new workspace and a new finalizer
  evidence directory; old evidence is never silently overwritten.
- A later packaging failure after native signing follows the same rule. The
  signed staging tree is not reused or re-signed.

## 6. Construct and validate the authority manifest

After the native receipt is complete and before electron-builder can mutate
any other bytes, construct the closed
`windows-production-authority-manifest-v1` snapshot with
`createWindowsProductionAuthorityManifest`. Bind all of these values:

- product, app id, Windows x64 target, package version, repository, and exact
  source revision;
- the v2 handoff schema and raw handoff SHA-256;
- both warm/clean qualification receipt hashes, artifact ids, artifact
  digests, source run ids, and attempts;
- the qualified filesystem binding bytes and SHA-256;
- both native modules' unsigned and pre-signed byte counts and SHA-256 values;
- the runtime manifest's fixed package path, bytes, and SHA-256;
- the exact finalizer workflow/repository/ref/event invocation identity; and
- the exact Authenticode publisher policy and the limited promoted/unavailable
  capability lists.

Validate and serialize the manifest using the module's closed schema. This
manifest is a content-free provenance snapshot, not an authority bit: it does
not inspect files, call Azure, validate Authenticode, or assert that the
finalizer run succeeded. The later finalizer receipt must bind its completed
run identity and final artifact bytes back to this snapshot.

## 7. Package with electron-builder without a second `.node` signing

Use only
[`electron-builder.release.config.cjs`](../../apps/electron/electron-builder.release.config.cjs)
for the production-shaped Windows packaging pass. Its reviewed contract is:

~~~text
electron-builder 26.15.7
win.signExts = [".dll", "!.node"]
publish = "never"
target = NSIS x64
~~~

The native pair is already signed by the presign stage. The builder may sign
the generated Electron executables, DLLs, uninstaller, and final installer,
but must not mutate either `.node`. The finalizer must prove this with all
three checks below:

1. verify the loaded release config has the exact positive-before-negative
   extension policy and no legacy certificate inputs;
2. compare the two native files' post-builder bytes and SHA-256 values with
   the presign receipt and authority manifest; and
3. retain a bounded signing-operation summary showing zero builder signing
   operations for either fixed `.node` path, while allowing the expected
   non-native PE signing operations.

Any native hash drift, unexpected third native module, second `.node` signing
operation, config drift, builder-version drift, or output mutation fails the
attempt. Do not rerun the builder against that staging tree.

## 8. Independently verify unpacked, installed, and installer subjects

Freeze all final bytes before generating attestation. Produce separate,
content-free inventories for:

1. the unpacked Windows application directory;
2. the final NSIS installer; and
3. the application after a clean install into a disposable Windows profile.

Each inventory must contain a canonical relative path, byte count, and
SHA-256, plus one aggregate subject digest. The installed inventory must be
read back from the actual install result; do not infer it from the unpacked
directory. The installer subject is the final `.exe`, not an upload candidate.

For every signed PE in each subject, independently require:

- `Get-AuthenticodeSignature` status `Valid`;
- the exact configured publisher subject;
- a present RFC-3161 timestamp; and
- `signtool.exe verify /pa /all` exit success.

Re-check the two `.node` files separately against the pre-sign hashes and
signature aggregates. The installed app must launch, reach the local
dashboard, perform a synthetic refresh, reject a second instance, preserve
synthetic credential/state data across relaunch, close cleanly, and leave no
companion descendant. Uninstall and data-retention results are separate
receipt fields; do not report them as proven if not run.

The existing
[`verify-electron-development-artifact.mjs`](../../scripts/verify-electron-development-artifact.mjs)
and Windows Electron contract tests can support the structural checks, but a
macOS or Linux run cannot substitute for these native installed/Authenticode
checks.

## 9. Attest and retain the frozen result

Only after the unpacked, installed, and installer subjects are frozen and
verified may the protected finalizer:

1. generate an SPDX SBOM whose subject is the final installer digest;
2. invoke the repository's protected
   [cross-platform attestation action](./2026-08-18-cross-platform-release-publication.md)
   once for that exact subject and SBOM;
3. bind the attestation bundle subjects to the final installer digest and
   authority manifest; and
4. retain the signed-module receipt, v2 handoff, authority manifest, final
   inventories, installer digest, Authenticode aggregate, no-second-`.node`
   summary, SBOM, and artifact-specific attestation bundles in protected CI
   storage.

Retention must be content-free and must not include source trees, installed
user data, raw logs, PowerShell output, account identifiers, tokens,
certificates, private paths, or credentials. If attestation fails after the
final bytes are frozen, retry attestation only against those unchanged bytes
in a new protected run; never re-sign or repackage to repair an attestation
failure. If any final byte changes, restart at fresh staging and create a new
authority manifest.

No GitHub release, update feed, Store submission, website publication, or
support claim is part of this runbook. Those are separate owner-authorized
release gates described in the
[cross-platform publication runbook](./2026-08-18-cross-platform-release-publication.md).

## Exit criteria

The signed-finalizer attempt is accepted only when every item below is present
and mutually bound on one exact revision:

- verified v2 warm-and-clean handoff with raw receipt hashes equal to the
  recorded workflow artifact digests;
- clean protected checkout and exact package version;
- fresh Windows x64 staging with no marker, reparse point, symlink, or stale
  output;
- exact TrustedSigning 0.5.0 preflight pass;
- passing native presign receipt for exactly the two fixed `.node` modules;
- valid authority manifest matching handoff, binding, version, and native
  signed bytes;
- successful electron-builder packaging with `!.node` and zero second native
  signing operations;
- independently verified unpacked, installer, and installed subject hashes;
- valid publisher, timestamp, and `signtool /pa` evidence for every signed
  PE and both native modules;
- successful disposable installed-app smoke and no orphaned companion;
- final SBOM and protected attestation bundles bound to the final installer;
- content-free retained evidence with no secret or raw diagnostic; and
- unchanged `productionSafe: false` and production selectors unless a
  separate, explicitly authorized security-promotion goal closes them.

Any missing item is a failed or incomplete finalizer attempt, not a partial
Windows support claim.

## What macOS can and cannot prove

macOS can run the portable contract tests for closed input validation,
deterministic serialization, injected signer behavior, digest binding,
no-clobber receipt publication, and invalidation semantics. It can also check
that the release configuration expresses `signExts: [".dll", "!.node"]`.

macOS cannot prove Azure Trusted Signing credentials or endpoint authority,
the installed TrustedSigning 0.5.0 module, Windows PE/AuthentiCode behavior,
`signtool.exe /pa`, Windows reparse-point and sharing races, Windows ACLs,
native Credential Manager behavior, actual Windows electron-builder signing,
or the installed Windows lifecycle. Those claims require the protected native
Windows x64 finalizer and its retained evidence.
