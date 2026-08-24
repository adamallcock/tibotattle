---
title: Windows signed finalizer
date: 2026-08-21
type: runbook
status: activation-gated
---

# Windows signed finalizer runbook

This runbook describes the protected Windows x64 signed-candidate sequence and
its activation gates. The checked-in
[`windows-production-finalizer.yml`](../../.github/workflows/windows-production-finalizer.yml)
remains a manual provenance, build, and read-only TrustedSigning preflight.
The separate
[`windows-production-finalizer-signed.yml`](../../.github/workflows/windows-production-finalizer-signed.yml)
now implements one protected, manually dispatched, two-job candidate flow. Its
untrusted `prepare` job has `contents: read` and `actions: read` only: it
validates the dispatch/source boundary, independently verifies the warm/clean
qualification receipts, and builds an unsigned staging tree. It emits only a
bounded, content-free canonical preparation manifest as sixteen-or-fewer
base64 chunks (each at most 24 KiB), together with the raw-byte count, encoded
length, and SHA-256 as job outputs. It never receives the signing environment
or an OIDC token.
The protected `sign` job requires `prepare`, repeats the REST/artifact and
qualification gates, independently rebuilds the unsigned tree, and compares
the carried manifest and digest before the late Azure login. Only that job has
`windows-production-signing` and `id-token: write`; because GitHub Actions
permissions are job-wide, code running in that approved `sign` job can mint an
OIDC token before the late login step. The late login controls when the Azure
CLI session is established, not when OIDC capability exists. There is no
upload-artifact, cache, release/feed, or binary handoff.

It has never run: no Azure session, OIDC token, native signing, release
publication, upload, or signed-artifact retention has occurred. The candidate
lane is deliberately unpublished and must remain separate from release
acceptance.

The source qualification boundary is described by the
[Windows first Electron delivery goal](../goals/2026-08-18-windows-first-electron-delivery-goal.md).
The handoff is verified by
[`verify-windows-finalizer-qualification-handoff.mjs`](../../scripts/verify-windows-finalizer-qualification-handoff.mjs),
the authority data contract is
[`windows-production-authority-manifest.js`](../../src/platform/windows-production-authority-manifest.js),
the content-free provenance join is
[`build-windows-production-finalizer-authority.mjs`](../../scripts/build-windows-production-finalizer-authority.mjs),
the source-run/artifact selector is
[`select-windows-finalizer-source-evidence.mjs`](../../scripts/select-windows-finalizer-source-evidence.mjs),
the runner-owned authority driver is
[`run-windows-production-finalizer-authority.mjs`](../../scripts/run-windows-production-finalizer-authority.mjs),
the offline authority-input producer is
[`build-windows-production-finalizer-authority-input.mjs`](../../scripts/build-windows-production-finalizer-authority-input.mjs),
the post-builder directory verifier is
[`verify-windows-production-packaged-artifact.mjs`](../../scripts/verify-windows-production-packaged-artifact.mjs),
the Authenticode inventory verifier is
[`verify-windows-production-authenticode-inventory.mjs`](../../scripts/verify-windows-production-authenticode-inventory.mjs),
the installer receipt verifier is
[`verify-windows-production-installer.mjs`](../../scripts/verify-windows-production-installer.mjs),
the final content-free receipt join is
[`build-windows-production-finalizer-receipt.mjs`](../../scripts/build-windows-production-finalizer-receipt.mjs),
the two-job preparation manifest producer is
[`build-windows-production-finalizer-preparation-handoff.mjs`](../../scripts/build-windows-production-finalizer-preparation-handoff.mjs),
the post-login Azure certificate-subject preflight is
[`verify-windows-production-certificate-subject-preflight.mjs`](../../scripts/verify-windows-production-certificate-subject-preflight.mjs),
and the signed-candidate workflow policy is
[`windows-production-signed-finalizer-workflow-contract.js`](../../config/windows-production-signed-finalizer-workflow-contract.js),
the closed installer/rollback policy is
[`windows-installer-contract.js`](../../config/windows-installer-contract.js),
and the native pre-sign primitive is
[`windows-native-presign.mjs`](../../scripts/windows-native-presign.mjs).

The selector and authority driver may write only inside a fresh, attempt-scoped
evidence root owned by the protected runner. That root must be exclusively
owned for the duration of each operation: no concurrent writer, symlink,
hard-link alias, reparse point, or pre-existing output is permitted. The
driver's identity checks detect replacement, but they are not a substitute for
the native Windows qualification of the runner-owned root.

## Activation gates

Stop before this sequence if any of the following is true:

- the protected native Windows x64 warm-and-clean qualification has not passed
  on one exact revision, or its v2 handoff is missing, malformed, stale, or
  contains an unexplained skip;
- the current checkout is not the exact protected revision/version named by
  that handoff;
- the finalizer workflow is not a protected, manually authorized Windows x64
  workflow with pinned actions, content-free receipts, and no artifact upload
  or signed-candidate retention;
- `productionSafe` or a production selector is being used to make signing
  pass; or
- the operator would need to place a credential, token, raw log, local path,
  user name, or provider response in the repository, receipt, artifact, or
  workflow summary;
- the exact Azure identity, protected environment, or external OIDC/RBAC
  governance supplied for this run has not been rechecked by the operator
  immediately before the first signing attempt;
- `AZURE_CODE_SIGNING_TIMESTAMP_URL` is not exactly
  `http://timestamp.acs.microsoft.com`; or
- any forbidden Azure, ARM, certificate, password, PFX/P12, or federated-token
  environment variable is present in the builder process; or
- `AZURE_CODE_SIGNING_SUBJECT_SHA256` is missing, not exactly 64 lowercase
  hexadecimal characters, or has not been checked against the live active
  Azure certificate profile after login; or

As of 2026-08-23, the preflight lane remains
`preflight_implemented_signing_inactive`, while the signed workflow policy is
`signed_candidate_implemented_unpublished`. The signed workflow exists but has
never run. Its signing job can reach the late Azure CLI login only after the
untrusted preparation job succeeds, the protected environment approval is
complete, and the offline provenance/evidence gates are repeated; no signing
operation or release has occurred. The final candidate posture remains
`production.ready: false`, `production.enabled: false`,
`production.distribution: "unpublished"`, and every installed-lifecycle field
is `not_run`. The separately qualified b37 candidate at revision
`b37bd4918f75995130f8a4ed6b123e61e48f9179` (run `32678463671`) remains
development-only historical evidence; its receipts do not qualify this current
integration. The current integration still requires a fresh native Windows x64
warm-and-clean qualification against one exact source/package boundary, and no
signed Windows artifact is accepted as a production release.

## Two-job handoff boundary

The preparation job writes a canonical manifest under its attempt-scoped temp
root and checks that it is content-free, regular, and no larger than 256 KiB.
The workflow base64-encodes those bytes into at most sixteen explicit 24 KiB
job-output chunks and publishes the raw-byte count, encoded length, lowercase
SHA-256, and chunk count. The chunks are not artifacts, cache entries, release
assets, or executable transfers. The signing job rejects missing, extra,
oversized, malformed, or tampered chunks; checks the exact chunk count and
encoded length; recomputes the SHA-256; reconstructs the manifest first under
its attempt-scoped root; and copies it into its fresh evidence root only after
the reconstruction is verified. It then asks the preparation-handoff producer to rebuild the same manifest from
the exact source revision, source run, qualification handoff, native binding
manifest, and unsigned staging tree. A mismatch stops the job before Azure
login.

The carried preparation-manifest SHA-256 is bound through the complete offline
evidence chain. The authority-input producer reads the exact canonical
preparation handoff, hashes it, and emits only a content-free `preparation`
projection. The closed authority manifest and final receipt both include
`preparation.handoff.sha256` plus the source ref/revision/run identity and
preparation-workflow run identity. Each layer rejects non-lowercase SHA
spellings, stale identity, and unexpected keys. The encoded transfer is capped
at 384 KiB in aggregate, with every individual output below the Windows
environment-variable limit, and is used only as an in-memory job boundary.

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
in a public release descriptor. It must also independently re-fetch and
validate the source workflow run through the GitHub REST response, including
the exact repository, workflow path, run id, attempt, ref, source SHA, event,
status, and conclusion. Run and workflow values copied from the handoff are
not sufficient on their own.

## 2. Lock the exact checkout and version

Materialize a fresh checkout at the handoff revision on the protected ref.
Before building, require all of the following:

~~~powershell
git status --porcelain=v1 --untracked-files=all   # empty
git rev-parse HEAD                                # exact handoff revision
node -p "require('./package.json').version"      # exact selected version
~~~

The finalizer must compare `HEAD`, the handoff revision, the raw bytes and
SHA-256 of the checked-out `package.json`, its parsed package name/version and
module metadata, the Electron staging metadata, and the version passed to the
release builder. A version or package-byte mismatch, dirty tree, detached
unreviewed commit, stale lockfile, or changed native binding requires a new
qualification handoff; do not repair the checkout in place. The raw
`package.json` bytes are passed to the content-free provenance join, which
hashes them before parsing and records the fixed `package.json` path, package
name, version, source revision, byte count, and SHA-256 in the authority
manifest's `sourcePackage` block.

The checked-in preflight uses the protected `main` ref and `workflow_dispatch`
for its manual provenance/build lane. Those values are not evidence of signed
promotion. Do not treat a successful preflight as a signed release or add
signing, OIDC, Azure login, or publication behavior to it without a separately
reviewed promotion change.

## 3. Create fresh disposable Windows staging

Use a native Windows x64 runner and a new attempt-scoped workspace. The
reviewed release configuration fixes these roots:

~~~text
.release-build/electron-production/windows-x64/app
.release-build/electron-production/windows-x64/evidence
.release-build/electron-production/windows-x64/artifacts
$RUNNER_TEMP/tibotattle-windows-production-finalizer-signed-<run>-<attempt>
$RUNNER_TEMP/tibotattle-windows-production-finalizer-signed-<run>-<attempt>/azure-config
~~~

The app and evidence roots must be newly materialized regular directories,
not symlinks or reparse points. The finalizer must reject an existing receipt,
temporary receipt, invalidation marker, or unexpected file before any signing
call. Do not recursively delete an unresolved path to make the check pass;
discard the complete disposable attempt only after its exact root has been
identified, then rebuild it from the verified unsigned source.

If the native pre-sign input builder emits
`WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_ATTEMPT_CLEANUP_REQUIRED` (or its library
error exposes `requiresAttemptCleanup: true`), the evidence root changed after
its temporary file was opened. A path-based helper cannot safely find that
displaced file again. Treat the complete attempt workspace as tainted, remove
only its already resolved attempt root in the outer workflow cleanup, and
rebuild from verified unsigned source. Never reuse either the replacement root
or the displaced root.

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

The finalizer evidence root is the place for its content-free receipts and
transient input documents. The reviewed leaf names are:

~~~text
.release-build/electron-production/windows-x64/evidence/
  windows-finalizer-handoff-v2.json
  windows-production-finalizer-preparation-handoff.json
  certificate-subject-preflight.json
  windows-native-presign-input.json
  windows-native-presign-<revision>.json
  selection-receipt.json
  source-run.json
  policy.json
  finalizer.json
  authority-input.json                 # transient driver-options document
  authority.json                        # authority-manifest driver output
  windows-signing-operation-ledger.json
  packaged-artifact-receipt.json
  installer-receipt.json
  windows-production-finalizer-receipt.json
~~~

These names are relative to the fresh evidence root. They are not caller-
controlled absolute paths, and an existing output, temporary output, symlink,
hard link, or reparse-point alias is a hard stop. The `authority-input.json`
file is an offline options document; it is not itself proof of authority or of
a successful build. The signed workflow removes the fixed production, native
build, source-evidence, download, handoff, Azure CLI, and attempt roots in its
unconditional cleanup step; it does not upload or retain the signed candidate.

## 4. Verify the supplied Azure identity and run the read-only TrustedSigning preflight

The external setup handoff currently records the following non-secret values as
supplied/configured: Artifact Signing account `tibotattlesigning`, profile
`tibotattle-windows-public`, endpoint
`https://eus.codesigning.azure.net/`, publisher `Adam Allcock`, timestamp URL
`http://timestamp.acs.microsoft.com`, and protected GitHub environment
`windows-production-signing`. It also records the expected Entra client,
tenant, and subscription IDs, the GitHub OIDC issuer/audience/subject, the
profile-scoped `Artifact Signing Certificate Profile Signer` role, and the
environment reviewer settings in the checked-in policy contract. This is
configuration supplied by the operator, not a live API or workflow
verification. No repository workflow run has yet used OIDC, called
`azure/login`, invoked TrustedSigning, or signed, uploaded, published, or
retained a production artifact. No secret is required in the protected GitHub
environment: the configured values are non-secret resource and identity
variables, while the signing authority is intended to arrive through the
protected OIDC/RBAC boundary. The signed workflow grants `id-token: write`
only to the protected `sign` job after environment review; the untrusted
`prepare` job cannot mint an OIDC token. That permission is job-wide, so the
approved `sign` job's target code can mint an OIDC token before
`azure/login`; the late login controls Azure CLI session establishment only.
Before the first signing attempt, recheck every value and stop if any differs;
do not infer that a successful Azure login proves the complete external
governance state.

The protected environment must also define the non-secret
`AZURE_CODE_SIGNING_SUBJECT_SHA256` variable as exactly 64 lowercase
hexadecimal characters. It is the owner-supplied SHA-256 of the exact UTF-8
certificate subject returned by the reviewed active Azure profile; the raw
subject/DN is never placed in a workflow variable, receipt, log, or source
file. The signed workflow checks the variable's shape before release-config
use, then, after `azure/login` and before any `Invoke-TrustedSigning`, runs
[`verify-windows-production-certificate-subject-preflight.mjs`](../../scripts/verify-windows-production-certificate-subject-preflight.mjs).
That read-only ARM query requires an active Public Trust profile with exactly
one active certificate and writes only the content-free
`certificate-subject-preflight.json` result. The result hash must match the
protected variable, `policy.json`, and the native pre-sign input before any
native signing call. Missing, malformed, stale, or mismatched subject proof
is a hard stop.

Run the exact preflight before loading or invoking the signing module:

~~~powershell
npm run preflight:windows:trusted-signing
~~~

Accept only `WINDOWS_TRUSTEDSIGNING_PREFLIGHT_PASSED`: exactly one installed
`TrustedSigning` module at version `0.5.0`. `unsupported`, `unavailable`, or
`invalid` is a hard stop. Each checked-in Windows lane installs that exact
module only to support its read-only verifier; installation is not signing.
The preflight lane never imports or invokes a signer or prints module paths or
PowerShell diagnostics. The signed candidate lane keeps the module check
before its late Azure CLI login, subject preflight, and native signing step.

Before importing electron-builder or the release config, the protected
workflow must perform two additional fail-closed checks. First, compare the
`AZURE_CODE_SIGNING_TIMESTAMP_URL` variable byte-for-byte with
`http://timestamp.acs.microsoft.com`. Second, enumerate the complete
`forbiddenBuilderEnvironment` list and the policy's forbidden patterns; fail
if any forbidden name is present, including any Azure/ARM client secret,
certificate, password, federated-token, CSC, PFX, or P12 variable. These checks
must run before the builder import so a contaminated process cannot cache or
consume an ambient credential. The four `TIBOTATTLE_ELECTRON_AZURE_*` resource
variables are then required to match the exact account, profile, endpoint, and
publisher values above.

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
PowerShell output, or local diagnostic path. The signed candidate workflow
places the verified canonical v2 handoff in the fresh fixed evidence root
using no-clobber publication, invokes the offline input builder, and passes
that generated file to the fixed package alias, only on native Windows:

~~~powershell
$evidenceRoot = Join-Path $PWD '.release-build\electron-production\windows-x64\evidence'
$handoffName = 'windows-finalizer-handoff-v2.json'
$inputName = 'windows-native-presign-input.json'

node ./scripts/build-windows-native-presign-input.mjs `
  --evidence-root $evidenceRoot `
  --handoff $handoffName `
  --output $inputName `
  --certificate-subject-sha256 $env:AZURE_CODE_SIGNING_SUBJECT_SHA256

npm run presign:windows:native -- --input (Join-Path $evidenceRoot $inputName)
~~~

The checked-in preflight-only workflow does not create this private evidence
root or run either command. The signed-candidate workflow contains these
steps, but it has never run and therefore has produced no native pre-sign
receipt.

The primitive signs exactly two fixed `.node` files, immediately re-hashes
each one before its irreversible signing call, invokes TrustedSigning 0.5.0
with SHA-256 file and RFC-3161 timestamp requests, and then checks each result
with both `Get-AuthenticodeSignature` and `signtool.exe verify /pa /all`. A
passing receipt must show, for each fixed module:

- unsigned and signed byte counts and SHA-256 values, with changed bytes;
- the exact package path and module name;
- `Authenticode` status `Valid`;
- the exact configured publisher SimpleName (`Adam Allcock`), extracted from
  the signing certificate with `X509Certificate2.GetNameInfo(SimpleName,
  false)`;
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

## 6. Build the closed authority input and validate the authority manifest

Once the canonical handoff and native pre-sign receipt exist, build the driver
options with
[`build-windows-production-finalizer-authority-input.mjs`](../../scripts/build-windows-production-finalizer-authority-input.mjs).
This is an offline, content-free join. It re-captures the selected source
evidence and staged runtime tree, validates that the evidence and staging
roots are disjoint and exclusively owned, and derives the native facts from
the validated pre-sign receipt. It does not call GitHub or Azure, import
electron-builder, invoke TrustedSigning, sign, upload, or publish.

The input producer reads these exact relative files from the evidence root and
staging root:

~~~text
evidence/selection-receipt.json
evidence/windows-finalizer-handoff-v2.json
evidence/windows-production-finalizer-preparation-handoff.json
evidence/windows-native-presign-<revision>.json
evidence/package.json
evidence/source-run.json
evidence/policy.json
evidence/finalizer.json
staging/electron-runtime-manifest.json
staging/package.json
staging/apps/electron/**
staging/apps/local/**
staging/apps/web/public/**
staging/config/**
staging/contracts/**
staging/generated/**
staging/native/windows-filesystem/build/Release/windows_filesystem.node
staging/native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json
staging/node_modules/**
staging/schemas/**
staging/src/**
~~~

`staging/<closed native/runtime inventory>` is not a shorthand that an
operator may fill in. The preparation handoff's `staged.files` array is the
complete, sorted file inventory captured from this exact closure; it binds
every relative path, byte count, and SHA-256, and its `staged.tree` row binds
the complete count, total bytes, and tree digest. The two fixed native rows
above must be present in that inventory. The `node_modules/**` row is the
staged dependency closure; the signing job must compare the complete handoff
inventory, not only the two native files or the runtime manifest.

The protected workflow supplies those names through the producer's closed
options shape (`--evidence-root`, `--staging-root`, `--selection`,
`--handoff`, `--native-presign`, `--checkout-package-json`,
`--source-run-metadata`, `--policy`, `--finalizer-metadata`, and `--output`).
The producer writes the transient `authority-input.json` through
no-clobber, identity-checked publication. Its validated output must then be
passed to
[`run-windows-production-finalizer-authority.mjs`](../../scripts/run-windows-production-finalizer-authority.mjs),
which writes the canonical `authority.json` manifest in the same evidence
root. A changed source file, replaced root, link alias, duplicate, stale
output, or noncanonical input invalidates the attempt; do not repair or reuse
that attempt.

After the native receipt is complete and before electron-builder can mutate
any other bytes, construct the closed
`windows-production-authority-manifest-v2` snapshot through
`build-windows-production-finalizer-authority.mjs`. Pass the join builder the
raw v2 handoff bytes, raw native pre-sign receipt bytes, raw checkout
`package.json` bytes, independently revalidated source workflow REST metadata,
the reviewed publisher, runtime manifest, and finalizer invocation facts. Do
not call `createWindowsProductionAuthorityManifest` with caller-supplied native
module rows; the join builder must parse and validate the native receipt and
project those rows itself. The builder hashes each raw subject before parsing,
requires canonical handoff and pre-sign bytes, and then invokes the closed
manifest contract. Bind all of these values:

- product, app id, Windows x64 target, package version, repository, and exact
  source revision;
- the fixed checkout `package.json` path and name, parsed version, source
  revision, bounded byte count, and raw SHA-256;
- the v2 handoff schema and raw handoff SHA-256;
- both warm/clean qualification receipt hashes, artifact ids, artifact
  digests, source run ids, and attempts;
- the qualified filesystem binding bytes and SHA-256;
- both native modules' unsigned and pre-signed byte counts and SHA-256 values;
- the native pre-sign receipt's raw SHA-256, schema, passed status, target,
  source revision, package version, and qualification-handoff SHA-256;
- the runtime manifest's fixed package path, bytes, and SHA-256;
- the exact finalizer workflow/repository/ref/event invocation identity; and
- the exact Authenticode publisher policy and the limited promoted/unavailable
  capability lists.

Validate and serialize the returned manifest using the module's closed
schema. This manifest is a content-free provenance snapshot, not an authority
bit: it does not inspect files, call Azure, validate Authenticode, or assert
that the finalizer run succeeded. The later finalizer receipt must bind its
completed run identity and final artifact bytes back to this snapshot.

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

The summary is written only to the fixed evidence leaf
`evidence/windows-signing-operation-ledger.json`. The pinned
`app-builder-lib` 26.15.7 seam records one finalized ledger with the exact
classes `exe`, `dll`, `node`, and `unexpected`; an accepted run requires
`node: 0` and `unexpected: 0`. The receipt contains counts and fixed identity
metadata only—no absolute paths, credentials, certificates, or raw signer
diagnostics. The ledger is finalized after the builder's asynchronous work,
including late NSIS installer/uninstaller targets; cancellation or any build
failure must not publish a ledger that looks complete.

The packaged-artifact verifier then consumes the raw ledger bytes and the
fixed post-builder PE file set. Its canonical
`evidence/packaged-artifact-receipt.json` binds the ledger byte count and
SHA-256 under `ledger`, and independently computes the ten-file PE aggregate
under `peInventory`: one main executable, six Electron DLLs, one NSIS
installer, and the two pre-signed native modules. The aggregate records
`count` and `signedCount` for that exact closure. It does not claim
Authenticode validity; the later in-process native collector supplies that
separate proof. Any ledger-byte drift or PE inventory mismatch taints the
attempt.

Any native hash drift, unexpected third native module, second `.node` signing
operation, config drift, builder-version drift, or output mutation fails the
attempt. Do not rerun the builder against that staging tree.

## 8. Verify the post-builder directory before installer/lifecycle work

After electron-builder returns, freeze the `win-unpacked` application tree
and run
[`verify-windows-production-packaged-artifact.mjs`](../../scripts/verify-windows-production-packaged-artifact.mjs)
with the raw, canonical v2 authority bytes, the exact pre-builder staging
directory, `resources/app.asar`, and its adjacent `resources/app.asar.unpacked`
directory. The verifier is read-only and emits only a fixed pass/fail status,
aggregate counts, byte totals, and SHA-256 digests.

It first validates the authority v2 manifest and takes the two expected native
paths, unsigned hashes, and signed hashes from that validated snapshot. It then
overlays the signed native rows over the unsigned runtime-manifest inventory.
The resulting closure must match the signed staging directory. In the package,
both `.node` files must be marked unpacked and must match the authority signed
hashes in `app.asar.unpacked`; no native payload may remain in `app.asar`.
The runtime manifest and Windows filesystem sidecar must remain in the ASAR
closure and match their unsigned/staged hashes. Missing, extra, relocated, or
case-colliding native paths, traversal spellings, symlinks/reparse-like links,
sidecar disagreement, or archive/unpacked inventory drift is a hard stop.

This gate proves only the content and layout of the post-builder directory. It
does not inspect Authenticode, prove the signing publisher, inspect the NSIS
installer, or replace the installed lifecycle checks below. A failure taints
the attempt; discard the disposable staging/output roots and start fresh.

## 9. Aggregate native Authenticode, installer, and final receipts

The signed-candidate workflow has one aggregate receipt step:

~~~powershell
node ./scripts/build-windows-production-finalizer-receipt.mjs
~~~

It does not run the Authenticode or installer verifiers as independent
production CLI steps. The aggregate process first calls
`collectWindowsProductionAuthenticodeInventoryForFinalizer()` on native
Windows x64. That collector seals the fixed roots, validates the authority
and native pre-sign binding, and probes every expected file with
`Get-AuthenticodeSignature` plus `signtool.exe verify /pa /all`, checking file
identity and digest before and after each probe:

~~~text
.release-build/electron-production/windows-x64/
  artifacts/
    win-unpacked/
  evidence/
~~~

The closed pre-install subject set is exactly:

- `artifacts/win-unpacked/TiboTattle.exe`;
- the Electron 43.2.0 DLL allowlist:
  `d3dcompiler_47.dll`, `ffmpeg.dll`, `libEGL.dll`, `libGLESv2.dll`,
  `vk_swiftshader.dll`, and `vulkan-1.dll`;
- `artifacts/win-unpacked/native/windows-filesystem/build/Release/windows_filesystem.node`;
- `artifacts/win-unpacked/node_modules/@github/keytar/prebuilds/win32-x64/keytar.node`; and
- `artifacts/TiboTattle-<version>-Windows-x64.exe`.

This is the fixed ten-file PE closure: one main executable, six Electron DLLs,
two native modules, and one installer.

The standalone `Uninstall TiboTattle.exe` is intentionally not in this
pre-install closure. Its Authenticode check remains deferred to the installed
lifecycle, where the actual installer result supplies the subject. The native
collector requires `probeMode: "native-windows"`; injected evidence is a
portable test seam and cannot qualify a release.

The collector returns an in-memory branded native receipt. The aggregate
process calls `assertNativeWindowsProductionAuthenticodeInventoryReceipt()`
and does not trust, read, or publish a serialized
`evidence/authenticode-inventory.json` leaf. A JSON object claiming
`probeMode: "native-windows"` is insufficient without that in-process brand.
The signed workflow rejects a pre-existing serialized Authenticode leaf before
this command and expects the native Authenticode projection to be embedded in
the final content-free receipt instead.

The aggregate then reads the canonical `authority.json`,
`windows-native-presign-<revision>.json`,
`windows-signing-operation-ledger.json`, and
`packaged-artifact-receipt.json` leaves. It derives the installer receipt from
the exact branded native inventory and authority bytes, verifies the exact
`artifacts/TiboTattle-<version>-Windows-x64.exe`, and writes
`evidence/installer-receipt.json` transactionally. Finally it joins the raw
subject bytes and writes `evidence/windows-production-finalizer-receipt.json`.
The aggregate receipt status is
`WINDOWS_PRODUCTION_FINALIZER_RECEIPT_VERIFIED`; the installer sub-receipt
status is `WINDOWS_PRODUCTION_INSTALLER_VERIFIED`.

The final receipt's `packagedArtifact` field binds the raw packaged-artifact
receipt, including its raw signing-ledger digest and fixed ten-file PE
aggregate.

The receipt must be read literally:

- `identity.status` and `staticConfig.status` are
  `policy_bound_not_inspected`; their product, app ID, upgrade GUID, and NSIS
  values are contract bindings, not runtime observations;
- every `staticConfig` value other than its status is `policy_only`;
- `lifecycle.installed`, `lifecycle.registry`, `lifecycle.uninstaller`, and
  `lifecycle.retention` are `not_run`;
- `nativeProof.status` is `not_run`;
- `retention.ordinaryUninstall` is `not_run`, while
  `retention.explicitPurge` is `policy_only`; and
- `signature.source` is `authenticode_inventory_native_windows`, which binds
  the receipt to the native Authenticode inventory rather than proving an
  installed lifecycle. The final receipt's `authenticode` field contains the
  branded inventory projection and its raw-byte digest; there is no separate
  production Authenticode leaf.

The final receipt also requires `production.distribution` to be
`"unpublished"`, `production.enabled` to be `false`, and `production.ready` to
be `false`. The signed candidate is not uploaded or retained: the workflow's
unconditional cleanup removes the fixed production, native-build, source,
download, Azure CLI, and attempt roots after the receipt step. No GitHub
release, update feed, Store submission, website publication, or support claim
is performed by this workflow.

The rollback policy is closed by
[`windows-installer-contract.js`](../../config/windows-installer-contract.js):
manual-only selection of an explicitly chosen previously signed artifact,
exact publisher/Authenticode/SHA-256 verification, explicit user/operator
confirmation, exact app ID and upgrade GUID matching, state backup before
replacement with app-state retention, and a required native installed-
lifecycle receipt. Automatic or silent downgrade, unsupported artifacts,
unsigned artifacts, and cross-identity replacements fail closed. Ordinary
uninstall preserves app state and Credential Manager entries; the separate
explicit purge remains policy-only and requires explicit confirmation.

Only a native Windows lifecycle run may replace the `not_run` fields. It must
install into a disposable profile, launch the installed app, reach the local
dashboard, perform a synthetic refresh, reject a second instance, preserve
synthetic credential/state data across relaunch, close cleanly, verify registry
and uninstaller behavior, and record uninstall/retention results. Do not count
the static installer receipt as installed-app proof.

The existing
[`verify-electron-development-artifact.mjs`](../../scripts/verify-electron-development-artifact.mjs)
and the post-builder verifier above support portable structural checks, but a
macOS or Linux run cannot substitute for native Windows Authenticode,
installer, ACL, sharing, or installed-lifecycle evidence.

## 11. Attest and retain the frozen result

The signed-candidate workflow ends after writing the content-free final
receipt and completing unconditional cleanup. It does not generate an SBOM,
invoke attestation, upload an artifact, retain a signed candidate, or publish
a release. These remain separate, owner-authorized release gates. A future
release finalizer may proceed only after the unpacked, installed, and installer
subjects are frozen and verified, and may then:

1. generate an SPDX SBOM whose subject is the final installer digest;
2. invoke the repository's protected
   [cross-platform attestation action](./2026-08-18-cross-platform-release-publication.md)
   once for that exact subject and SBOM;
3. bind the attestation bundle subjects to the final installer digest and
   authority manifest; and
4. retain only the approved content-free evidence and artifact-specific
   attestation bundles in protected CI storage.

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

The following are production-acceptance criteria, not a claim that the signed
candidate workflow has met them. That workflow intentionally ends with an
unpublished candidate, `production.ready: false`, and installed lifecycle
`not_run`; a future owner-authorized release gate must close the remaining
items on one exact revision:

- verified v2 warm-and-clean handoff with raw receipt hashes equal to the
  recorded workflow artifact digests;
- independently revalidated source workflow REST metadata matching the handoff
  repository, workflow path, run, attempt, ref, source SHA, event, status, and
  conclusion;
- clean protected checkout and exact package version;
- raw checked-out `package.json` bytes bound by path, name, version, source
  revision, byte count, and SHA-256 in `sourcePackage`;
- fresh Windows x64 staging with no marker, reparse point, symlink, or stale
  output;
- exact TrustedSigning 0.5.0 preflight pass;
- operator-rechecked exact Azure identity, OIDC, RBAC, and protected
  environment governance, with no reliance on the supplied handoff as live
  proof;
- protected native preflight evidence for the full Authenticode distinguished
  subject, plus explicit owner approval of that subject;
- passing native presign receipt for exactly the two fixed `.node` modules;
- a validated `authority-input.json` derived from the closed evidence/staging
  roots, followed by the canonical `authority.json` manifest in that evidence
  root;
- valid authority v2 manifest matching handoff, `sourcePackage`,
  `nativePresign`, binding, version, and native signed bytes;
- successful electron-builder packaging with `!.node` and zero second native
  signing operations;
- `evidence/windows-signing-operation-ledger.json` with one finalized ledger,
  zero `node` operations, and zero `unexpected` operations;
- passing post-builder directory verification with the authority signed native
  overlay, exact `app.asar`/`app.asar.unpacked` boundary, and unchanged
  sidecar/runtime-manifest evidence;
- packaged-artifact receipt binding the raw signing-ledger bytes and the exact
  ten-file PE aggregate (`peInventory` count and `signedCount`);
- branded native-Windows Authenticode collection with
  `probeMode: "native-windows"`, the exact ten-file pre-install closure, and
  the uninstaller deferred honestly to installed lifecycle;
- passing `evidence/installer-receipt.json` and
  `evidence/windows-production-finalizer-receipt.json`, with the installer
  derived from the branded native collection, publication disabled, and all
  installed-lifecycle fields marked `not_run` until a separate native
  lifecycle receipt exists;
- independently verified unpacked, installer, and installed subject hashes;
- valid publisher, timestamp, and `signtool /pa` evidence for every signed
  PE and both native modules;
- successful disposable installed-app smoke and no orphaned companion;
- final SBOM and protected attestation bundles bound to the final installer
  (a future release gate; not performed by the signed candidate workflow);
- approved content-free retained evidence with no secret or raw diagnostic
  (the signed candidate itself is not retained); and
- unchanged `productionSafe: false` and production selectors unless a
  separate, explicitly authorized security-promotion goal closes them.

Any missing item is a failed or incomplete finalizer attempt, not a partial
Windows support claim.

## What macOS can and cannot prove

macOS can run the portable contract tests for closed input validation,
deterministic serialization, injected signer behavior, digest binding,
no-clobber receipt publication, invalidation semantics, and the content-free
handoff/package/presign provenance join. It can also run the authority-input,
Authenticode-inventory fixture, installer-receipt, rollback-policy, and
zero-`.node` signing-ledger contract tests, and check that the release
configuration expresses `signExts: [".dll", "!.node"]`. These are portable
contract checks only; injected evidence must never be promoted to native proof.

macOS cannot prove Azure Trusted Signing credentials or endpoint authority,
the installed TrustedSigning 0.5.0 module, Windows PE/Authenticode behavior,
`signtool.exe /pa`, Windows reparse-point and sharing races, Windows ACLs,
native Credential Manager behavior, actual Windows electron-builder signing,
or the installed Windows lifecycle. Those claims require the protected native
Windows x64 finalizer and its retained evidence.
