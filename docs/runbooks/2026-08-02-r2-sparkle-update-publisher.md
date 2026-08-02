---
title: TiboTattle R2 Sparkle Update Publisher
date: 2026-08-02
type: runbook
status: implemented-local-publisher
---

# TiboTattle R2 Sparkle update publisher

The canonical production Sparkle feed is
`https://updates.tibotattle.com/appcast.xml`. Production macOS builds must use
that exact URL for `--sparkle-appcast-url`; the publisher rejects a release
manifest that records any other feed.

The publisher writes only to the explicitly supplied approved R2 bucket,
`tibotattle-updates`, using the pinned local Wrangler CLI. It does not deploy a
Worker, create a bucket, configure DNS, read Cloudflare credentials, accept a
Sparkle private key, or invoke a signing utility. Wrangler uses its existing
operator authentication only when an explicit publish is requested.

## Required manual signing gate

After the DMG has passed the normal Developer ID, notarization, stapling, and
clean-install gates, sign that exact DMG with Sparkle's offline signing process.
Create the appcast so its enclosure has the resulting canonical
`sparkle:edSignature`, exact byte `length`, `sparkle:version`, and this exact
immutable download URL:

```text
https://updates.tibotattle.com/releases/<bundle-version>/<dmg-sha256>/<dmg-file-name>
```

The Sparkle private key stays with the manual signing process; it must never be
passed to or stored by this publisher. The appcast and its referenced DMG are
validated before any Wrangler command can run.

## Publish procedure

Start with the signed DMG, the release manifest emitted beside it by
`npm run product:macos:release`, and the signed `appcast.xml`. First run the
validation-only command (it does not contact R2):

```bash
npm run product:macos:publish-update -- \
  --bucket tibotattle-updates \
  --dmg ".release-build/macos-release/TiboTattle-0.1.0-macOS-arm64.dmg" \
  --release-manifest ".release-build/macos-release/TiboTattle-0.1.0-macOS-arm64.dmg.release.json" \
  --appcast "/absolute/path/to/appcast.xml"
```

The default production verifier re-runs the signed/notarized DMG gate, checks
the release-manifest SHA-256 and production assurances, requires the manifest's
canonical feed URL, and verifies every appcast enclosure stays on the approved
origin. It only accepts the current enclosure when it points to the
content-addressed object path above and has the exact manifest byte length and
bundle version.

After reviewing the printed plan, append `--publish` to run Wrangler. Artifact
and manifest keys are content-addressed under
`releases/<bundle-version>/<dmg-sha256>/` and are never overwritten. The mutable
`appcast.xml` is checked first and needs the additional explicit
`--replace-appcast` flag after the initial publication:

```bash
npm run product:macos:publish-update -- \
  --bucket tibotattle-updates \
  --dmg "/absolute/path/to/TiboTattle-0.1.0-macOS-arm64.dmg" \
  --release-manifest "/absolute/path/to/TiboTattle-0.1.0-macOS-arm64.dmg.release.json" \
  --appcast "/absolute/path/to/appcast.xml" \
  --replace-appcast \
  --publish
```

Wrangler uploads the DMG and manifest first with one-year immutable caching
(`application/x-apple-diskimage` and `application/json; charset=utf-8`), then
the appcast with `application/xml; charset=utf-8` and
`public, max-age=300, must-revalidate`. A failed later upload leaves no changed
feed pointer; do not delete immutable release objects as recovery.

## Post-publication check

Independently fetch the canonical HTTPS appcast, verify it retains the signed
enclosure URL and signature, download the DMG, compare its SHA-256 with the
immutable release manifest, and rehearse the update on a clean Mac. This
publisher does not replace the normal Sparkle update/install rehearsal.
