---
title: Homebrew Distribution and macOS Support
date: 2026-08-15
type: decision-record
status: maintained
---

# Homebrew distribution and macOS support

## Decision

Updated on 2026-09-07 for the qualified dual-architecture cask; the original
Apple-silicon-only decision is retained in Git history.

Publish TiboTattle through the first-party
[`adamallcock/homebrew-tap`](https://github.com/adamallcock/homebrew-tap) tap.
The supported one-command install is:

```bash
brew install --cask adamallcock/tap/tibotattle
```

The cask selects the same signed, notarized architecture-specific DMG as the
website and GitHub Release: `arm64` for Apple silicon and `x64` for Intel,
with independent SHA-256 values. It declares `auto_updates true`, preserving the existing signed
Sparkle feed as the installed app's update authority. Homebrew is an additional
install and uninstall route, not a replacement release channel.

The public support floor is macOS 14 (Sonoma) on Apple silicon and Intel. The app bundle,
Swift compiler target, public release-site metadata, release runbook, and cask
must all carry that same floor. The packaged runtime means end users do not
need Node.js, pnpm or Xcode. The separate Apple silicon build-host requirement
does not restrict which published installer they can use.

## Uninstall and data boundary

Ordinary `brew uninstall --cask tibotattle` removes only the application.
`brew uninstall --cask --zap tibotattle` may additionally remove only these
app-owned paths:

- `~/Library/Application Support/Usage Monitor`
- `~/Library/Caches/com.usagemonitor.local`
- `~/Library/HTTPStorages/com.usagemonitor.local`
- `~/Library/HTTPStorages/com.usagemonitor.local.binarycookies`
- `~/Library/Preferences/com.usagemonitor.local.plist`
- `~/Library/Saved Application State/com.usagemonitor.local.savedState`
- `~/Library/WebKit/com.usagemonitor.local`

The zap must never target `~/.codex`, Claude data, arbitrary logs, home-wide
globs, Login Items, or Keychain entries. TiboTattle's four fixed Keychain
services remain because ordinary uninstall is reversible and those credentials
have different hosted and local consequences. The app's explicit,
two-confirmation **Identity & Device Reset…** flow remains the only supported
credential reset.

## Tap automation

The tap owns an hourly and manually dispatchable GitHub Actions workflow. It
reads the latest immutable, non-draft, non-prerelease `adamallcock/tibotattle`
release and requires both exact `TiboTattle-X.Y.Z-macOS-arm64.dmg` and
`TiboTattle-X.Y.Z-macOS-x64.dmg` assets. Independent native Apple silicon and
Intel jobs verify each HTTPS download's size, SHA-256, architecture, signature
and stapled notarization ticket, then run Homebrew style, online audit,
installation and uninstall checks. Both jobs must pass before the main-branch
publication job may update only the cask version and architecture checksums.

Checks detect architecture or checksum drift even when the version is unchanged
and reject downgrades. A manual `force_verify` run rechecks a matching release;
the publication job makes no commit if the cask already matches. Normal pushes
require the same clean source base used for qualification. This preserves the
existing automatic publication behavior without a long-lived cross-repository
write credential in the application repository.

## Official Homebrew cask gate

Do not submit `tibotattle` to `Homebrew/homebrew-cask` yet. As of 2026-08-15,
the public repository was created on 2026-07-24 and had one star, no forks, and
one watcher, below Homebrew's current age and notability requirements and its
higher self-submission thresholds. Recheck the live policy and repository
metrics before any future submission. Until acceptance, the exact unqualified
one-line command `brew install --cask tibotattle` is not advertised; the
qualified first-party-tap command above is the supported route.

## Release gate

Every stable release remains gated independently: signed DMG, notarization and
stapling, Sparkle appcast, GitHub Release, cask update, and website deployment
are separate receipts. A cask update never turns a failed or incomplete app
release into a successful one.
