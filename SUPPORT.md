# TiboTattle support

TiboTattle is maintained on a best-effort basis. Before reporting a problem,
update to the latest published stable release, read the
[public user guide](https://tibotattle.com/docs), and check the
[current status matrix](docs/current-status.md).

## Choose the right channel

- Use the [bug report form](https://github.com/adamallcock/tibotattle/issues/new?template=bug_report.yml)
  for the macOS app, local dashboard, refresh, updater, or install problems.
- Use the [hosted-service form](https://github.com/adamallcock/tibotattle/issues/new?template=hosted_service.yml)
  for `tibotattle.com`, sign-in, contribution, deletion, or community results.
- Use a [private GitHub Security Advisory](https://github.com/adamallcock/tibotattle/security/advisories/new)
  for vulnerabilities, privacy-boundary failures, credential exposure, or a
  way to access another person's data. Do not open a public security issue.
- Provider billing, subscription, account access, and authoritative quota
  questions belong with the provider. TiboTattle reports observations and
  estimates; it is not the provider's billing system.

## What to include

Include the app version from **Settings → About**, install channel, macOS
version and architecture, the exact action, expected behavior, observed
evidence state, and any fixed diagnostic or failure code. If the problem is an
update, name whether it was a manual check, automatic download, Homebrew
install, or direct DMG replacement.

Run `npm run diagnose:dashboard` only from a source checkout. Review its output
before sharing it. Use synthetic examples where possible.

Never paste prompts, model responses, credentials, OAuth material, account
identifiers, real session paths, repository names, or unredacted local files
into an issue or pull request. A screenshot can contain private data even when
the diagnostic text is safe.

## Supported surface

The published product currently supports macOS 14 or later on Apple silicon.
Windows and Linux work in this repository is preparation or experimental
evidence, not a supported install. Local analysis works without the hosted
service; a hosted outage should remain visibly unavailable rather than make the
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
