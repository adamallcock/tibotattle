# TiboTattle support

TiboTattle is maintained on a best-effort basis. Before reporting a problem,
update to the latest published stable release, read the
[public user guide](https://tibotattle.com/docs), and check the
[current status matrix](docs/current-status.md).

## Choose the right channel

- Use the [bug report form](https://github.com/adamallcock/tibotattle/issues/new?template=bug_report.yml)
  for the macOS app, local dashboard, refresh, updater, or install problems.
- Use the [hosted-service form](https://github.com/adamallcock/tibotattle/issues/new?template=hosted_service.yml)
  for non-sensitive `tibotattle.com`, sign-in, contribution, disconnect, or
  community-result bugs; it is a public issue form, not a private erasure channel.
- Use a [private GitHub Security Advisory](https://github.com/adamallcock/tibotattle/security/advisories/new)
  for vulnerabilities, privacy-boundary failures, credential exposure, or a
  way to access another person's data. Do not open a public security issue.
- Provider billing, subscription, account access, and authoritative quota
  questions belong with the provider. TiboTattle reports observations and
  estimates; it is not the provider's billing system.

## Hosted history and privacy requests

In the [2026-08-30 source contract](docs/decisions/2026-08-30-self-service-deletion-retirement.md),
**Disconnect this Mac** requires confirmation and stops this device's hosted
contribution authority without deleting hosted history or local analysis.
Signing out is not device disconnect. Self-service hosted deletion is retired;
private hosted erasure is a separately authorized maintainer operation described
in [production operations](docs/runbooks/production-operations.md#private-owner-participant-erasure).
Older installed apps and deployed services may not yet match that source.

This retirement does not decide the handling of applicable privacy or erasure
requests. A dedicated private privacy-request intake channel and completion
deadline are not documented here. Do not put account identifiers, proof of
identity, or private request details in public issues. The Security Advisory
channel above is for security/privacy-boundary failures, not a newly promised
general erasure-request service.

## What to include

Include the app version from **Settings → About**, install channel, macOS
version and architecture, the exact action, expected behavior, observed
evidence state, and any fixed diagnostic or failure code. If the problem is an
update, name whether it was a manual check, automatic download, Homebrew
install, or direct DMG replacement.

Run `npm run diagnose:dashboard` only from a source checkout. Review its output
before sharing it. Use synthetic examples where possible.

In the Electron app, open **Settings → General → Local tools → Show diagnostics**
to run the doctor. Review its content-free report, then choose **Copy diagnostics**
or **Prepare support issue…**. The latter opens an editable GitHub issue form
with only that report; GitHub receives the form URL when it opens. Describe the
problem and review the form before submitting. The doctor does not include or
upload a native crash report.

On macOS, that dialog can also opt in to **local crash capture for the next
launch**. It is off by default, separate from contribution sharing, and never
uploads dumps. Restart after changing it. **Open local crash reports** reveals
the Crashpad folder for manual inspection. A dump may contain process memory,
so do not attach or share it unreviewed. Disabling capture also takes effect
after restart; existing local dumps are preserved for your review.

Never paste prompts, model responses, credentials, OAuth material, account
identifiers, real session paths, repository names, or unredacted local files
into an issue or pull request. A screenshot can contain private data even when
the diagnostic text is safe.

If TiboTattle closes during launch, note whether a native alert shows the fixed
support code `electron_shell_entry_failed`. This means startup stopped before
the dashboard opened; it does not identify the underlying cause. On macOS, a
person with this source checkout and Node.js 22.13+ can run the independent,
read-only doctor **without opening TiboTattle**:

```sh
npm run diagnose:desktop-crash -- --hours 72
```

Builds that include the packaged doctor can run the same script through the
installed Electron executable's separate Node mode. This bypasses TiboTattle's
main process, so it still works when the app exits during bootstrap:

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/TiboTattle.app/Contents/MacOS/TiboTattle" \
  "/Applications/TiboTattle.app/Contents/Resources/app.asar/scripts/diagnose-desktop-crash.mjs" \
  --hours 72 --verbose
```

It checks recently modified TiboTattle Apple crash reports, prints only an allowlisted
exception type, termination namespace/code, and up to five safe crashed-thread
symbol names, then reports the local crash-capture preference and dump counts.
Add `--verbose` for up to 20 crashed-thread frames per report, allowlisted app
and macOS version fields, and up to 40 recent entries from the companion's
owner-only diagnostics log. Those entries contain fixed codes and opaque
support references, not raw session content; malformed or unknown fields are
omitted. It also reads one owner-only, content-free startup result written by
the Electron main process. That result identifies the last startup phase,
outcome, and fixed failure code even when the companion never started. The
doctor reports when either source is missing or could not be read.
The verbose output still needs review before posting to a public issue.
If deeper private review is needed, an affected user can explicitly create a
local owner-only evidence directory at a new, absolute path outside the source
checkout:

```sh
node scripts/diagnose-desktop-crash.mjs --hours 72 --verbose --export-private "$HOME/Desktop/TiboTattle-private-evidence"
```

This copies at most ten matching Apple reports, the current/previous bounded
companion diagnostics logs, and the bounded startup result into that directory
with fixed filenames and a hash manifest. Add `--include-dumps` only when native Crashpad dumps are needed; at
most four recent dumps are copied, subject to a 64 MiB bundle limit. The
destination must not already exist. The manifest records skipped evidence,
so a bounded export must not be described as every system log. TiboTattle does
not have a persistent Electron main-process text log, and this command does not
collect macOS-wide unified logs, Codex data, or Keychain material.
If `manifest.json` is absent, the export did not finish; treat that directory
as incomplete and do not share it.

The private directory may contain paths, report text, and process memory. Keep
it local until the user and maintainer agree on a private handoff; **do not post
it in a public GitHub issue**. The command does not transmit or attach it.
It does not start the app, access Codex sessions or Keychain, change settings,
or send data. For machine-readable summary output use
`node scripts/diagnose-desktop-crash.mjs --hours 72 --verbose --json`; it returns
the same bounded fields for local Codex analysis.
Stable reports are selected by default; add `--channel dev` for **TiboTattle
Dev**, or `--channel all` for both. Neither standard nor verbose output includes
raw reports, dump bytes, paths, or report filenames.
The saved preference cannot prove that Crashpad was active when a particular
crash happened; it takes effect only after an app launch. A displayed report
timestamp is its file modification time, which may differ from the crash time.
Review the output before sharing it. The existing `npm run doctor` checks Codex
tool readiness; it is unrelated to desktop crash diagnosis. This source command
is available before a new app release. The installed-app command requires a
release whose packaged runtime contains the doctor; older releases still need
a current source checkout.

If the CLI finds no matching report, or a report uses a newer Apple format it
cannot read, open **Console** with Spotlight, select **Crash Reports**, and look
at the launch time. After reviewing for private paths and content, share only
the exception type, termination reason, and top frames of the crashed thread.
A full unreviewed report is not needed for initial triage. No report does not
rule out an early failure.

## Supported surface

The published 0.1.24 release provides macOS 14+ installers for Apple silicon and
Intel, a Windows x64 installer and a Linux x86_64 AppImage. Macs use the same
[Homebrew command](README.md#install-macos-apple-silicon-or-intel), or their
matching direct DMG. See [platform qualification](docs/reference/platform-support.md)
for exact artifact assurances and the owner-accepted unperformed macOS
existing-credential and Linux physical/FUSE/existing-install coverage.
Local analysis works without the hosted service; a hosted outage should remain
visibly unavailable rather than make the
local dashboard unusable.

Only the latest published stable release and current source receive routine
fixes. Older releases may be investigated, but the first requested step may be
an upgrade. Development, preview, container, and source-only platform lanes are
not supported distribution channels.

## Safe recovery boundary

Preserve the original state when reporting an indexing, SQLite schema,
Application Support, Keychain, contribution, or updater problem. Do not relabel
a SQLite `user_version`, delete the only index, wipe Application Support, reset
Keychain identities, revoke devices, or delete hosted data merely to make an
error disappear. Those actions have separate consequences and require an
explicit recovery or deletion workflow.

See the [local-data and privacy reference](docs/reference/local-data-and-privacy.md)
and [unified-index recovery runbook](docs/runbooks/unified-index-recovery.md)
for the maintained boundaries.
