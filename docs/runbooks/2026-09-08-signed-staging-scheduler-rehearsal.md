---
title: Signed staging scheduler rehearsal
date: 2026-09-08
type: runbook
status: draft
---

The `accountless-signed-staging-rehearsal` package profile prepares one
Darwin arm64 package for the remaining native scheduler qualification. It
keeps TiboTattle's production application identifier and macOS native
credential backend, binds contribution only to the canonical staging origin,
and disables the updater. It is not a production distribution profile and it
has no update feed or publishing configuration.

The source package requires two finalizer inputs: the disposable consumer
account's numeric UID and login name. They are written into the signed package
marker. At launch, `process.getuid()` and `os.userInfo()` must match those
values, and the fixed runner-profile environment must be present. These are
accidental-launch constraints for the dedicated disposable OS account, not an
attestation that the process runs on a GitHub host. `HOME`, `USER`, and other
launcher environment values do not select the profile or satisfy the account
check. The check occurs before the native handover or credential adapter is
created.

Before readiness, the package redirects both Electron `userData` and
`sessionData` to the fixed `TiboTattle Signed Staging Rehearsal` sibling under
the operating system's `appData` directory. This keeps Chromium cookies,
caches, and other session state out of the normal TiboTattle profile; the
synthetic companion roots remain nested under that isolated profile.

The child process receives the existing synthetic rehearsal roots and the
fixed `rehearsal-v1` accountless mode. It cannot inherit a production
contribution destination, a caller-selected queue, or a prepared directory.
The package marker is mutually exclusive with stable distribution, handover,
hosted rehearsal, development, and test-lane markers.

This source change does not sign, publish, deploy, launch, or create a macOS
account. The consumer job must obtain an already-signed artifact, verify
its code signature before launch, and supply the actual fresh hosted runner's
UID and login name when the package is finalized. The hosted runner's native
Keychain and ServiceManagement behavior remains a separate qualification
result.


## Local intake and preparation boundary

The local `scripts/consume-signed-electron-staging.mjs` command verifies an
already-extracted Darwin arm64 staging app against an explicit source revision,
ASAR digest, signed staging marker and native application signature. Its only
CLI mode is read-only verification:

```sh
node scripts/consume-signed-electron-staging.mjs \
  --app /absolute/owned/staging/TiboTattle.app \
  --source-revision <full-source-sha> \
  --asar-sha256 <archive-sha256>
```

The supplied values must come from the reviewed build and transport evidence.
The command neither selects a latest artifact nor extracts, launches, publishes
or creates a profile. Verification invokes `/usr/bin/codesign`; it never
launches the application. Execution and acknowledgement flags are refused. Its
receipt establishes artifact intake only.

An exported preparation helper writes the canonical first-run receipt and
persistent sharing-off preference into a new isolated profile, using the same
settings resolver and preference coordinator as the application. It checks the
actual operating account against the signed marker before creating directories.
An existing profile is refused. If preparation partially fails, the profile is
preserved and a retry is refused; there is no automatic deletion or repair.
Recovery requires inspection of the exact disposable profile and a separately
reviewed recovery operation or a newly provisioned disposable account and
matching artifact.

The preparation helper accepts validated metadata as a separate contract; it
does not itself bind that metadata to a signature-verified artifact. Any future
launcher must carry the verified artifact binding into preparation and launch.

## Explicit execution boundary

`electron-signed-staging.yml` is a manual disposable macOS arm64 consumer.
Probe mode records the runner account so the package can bind its numeric UID
and login name. Execute mode requires the exact signed source, archive and ASAR
hashes, plus the independently reviewed runner revision. The selected workflow
commit must match that runner revision. Both identities are retained so a test
harness repair does not require signing unchanged application code again. It downloads only from the isolated test-artifact namespace, refuses
redirects, verifies the ZIP before extraction, and validates Developer ID and
the package marker before profile creation or launch.

`scripts/run-signed-electron-staging.mjs --execute-staging` is the separate
execution entrypoint. It initializes a new profile through the existing
policy controller with `default_on` and acknowledges first run. This is an
explicitly seeded default-on integration rehearsal, not proof of untouched
fresh-install classification or delivery of migration notices. The app then
owns native credentials, enrollment, upload authorization and scheduling.
The fixture contains only synthetic usage/quota records; the child uses the
compiled staging endpoint and isolated source roots.

The runner checks the main process's debugger listener before selecting its
same-origin dashboard and Settings frame. It waits for a validated accepted
upload timestamp, restarts the process, requires an authenticated sync with
unchanged installation binding, disables sharing through the normal Settings
bridge, and restarts again to confirm the durable opt-out. Only a closed,
content-free receipt is retained. The profile and credentials remain on the
disposable runner and are never uploaded.

Controlled process-group termination and verified cleanup are recorded as
such; this does not qualify native menu Quit, operating-system notification
presentation, locked Keychain behavior, or interruption recovery for an
ordinary user's installation. The source tests and prepared workflow do not
establish an actual signed scheduler pass. Execution evidence remains required.


## Untouched first-launch confidence check

The manual `native-ui-probe` mode reads only whether the disposable Mac permits
native UI automation. It does not enumerate applications or inspect their data.
A successful probe is an environment prerequisite, not proof that the app's
introduction was completed.

The separate `fresh-install` workflow mode uses the same immutable signed app
inputs and intake checks, then runs `--execute-fresh-install`. Its `untouched`
preparation creates only isolated directories and synthetic source input. It
writes no first-run receipt, settings, sharing preference, index or credential.
The runner verifies that classification markers are absent before launch.

After verifying the exact launched executable and process group, the runner
inspects only that process's native introduction. It requires the expected
message, Continue/Quit buttons and login checkbox, clears Start at login, and
clicks Continue. No injected dialog response or acknowledgement bypass is used.
Missing Accessibility permission, unexpected controls or a timeout fail with an
explicit stage; the runner never approves unrelated prompts.

The app must create its own acknowledgement and report enabled sharing with
`default_on` through the normal Settings bridge. The runner then stops its owned
processes. The receipt separately records untouched preparation, native intro
completion and the observed policy result. It does not claim an accepted upload,
credential restart or migration notice delivery. This check can run while staging
collection and enrollment remain disabled: it qualifies local first-launch
classification only and does not require a new deployment or a seven-day wait.
