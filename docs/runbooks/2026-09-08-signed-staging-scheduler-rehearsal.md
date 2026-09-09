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
account. A later consumer job must obtain an already-signed artifact, verify
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

These helper tests do not qualify a packaged scheduler. A launch consumer still
needs a bounded, reviewed macOS process boundary: prelaunch quiescence, ownership
of the launched process and its debugger listener, exact dashboard binding,
private temporary storage, bounded waits and verified cleanup. Real signed
launch, restart, credential access, enrollment and upload evidence remains
unfinished. No hosted requests are made by this intake command or its preparation
helper.


For the next implementation, first reuse the bounded exit-observer,
descendant-capture and cleanup patterns in `scripts/smoke-electron-macos.mjs`,
and the failure-only TERM/KILL escalation in
`scripts/qa-electron-macos-real-history.mjs`. The former is an unsigned
synthetic-profile harness and the latter uses copied real history; neither
qualifies this signed staging profile as-is. Their test-profile signals and
launch settings must not be copied into an ordinary signed launch. The missing
composition must bind the verified artifact to its executable, disposable
profile and owned listener, then prove the captured process tree has stopped.
