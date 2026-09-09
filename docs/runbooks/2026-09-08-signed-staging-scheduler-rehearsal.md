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
