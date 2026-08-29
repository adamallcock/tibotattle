---
title: Homebrew Distribution and macOS Support
date: 2026-08-15
type: decision-record
status: maintained
---

# Homebrew distribution and macOS support

## Decision

Publish TiboTattle through the first-party
[`adamallcock/homebrew-tap`](https://github.com/adamallcock/homebrew-tap) tap.
The supported one-command install is:

```bash
brew install --cask adamallcock/tap/tibotattle
```

The cask installs the same signed, notarized arm64 DMG as the website and
GitHub Release. It declares `auto_updates true`, preserving the existing signed
Sparkle feed as the installed app's update authority. Homebrew is an additional
install and uninstall route, not a replacement release channel.

The public support floor is macOS 14 (Sonoma) on Apple silicon. The app bundle,
Swift compiler target, public release-site metadata, release runbook, and cask
must all carry that same floor. The already-published v0.1.11 binary is more
permissive at the bundle level; the cask and public support contract still
require Sonoma, and the next signed release will carry 14.0 in the bundle and
Sparkle appcast.

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
reads the latest non-draft `adamallcock/tibotattle` release, requires the exact
`TiboTattle-X.Y.Z-macOS-arm64.dmg` asset, downloads and hashes it, validates the
mounted app's signature and stapled notarization ticket, updates only the cask
version and SHA-256, and runs Homebrew style, audit, install, and uninstall
checks before committing. This avoids a long-lived cross-repository write
credential in the application repository.

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
