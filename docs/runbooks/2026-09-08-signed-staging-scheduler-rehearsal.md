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
marker. At launch, the marker is accepted only on a GitHub-hosted macOS arm64
profile when `process.getuid()` and `os.userInfo()` both match those values.
The check occurs before the native handover or credential adapter is created;
`HOME`, `USER`, and other launcher environment values do not select the
profile or satisfy the account check.

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
