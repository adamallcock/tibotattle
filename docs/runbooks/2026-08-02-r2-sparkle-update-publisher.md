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
Sparkle private key, or invoke a signing utility. It accepts the public
Ed25519 verification key only to match the release-manifest fingerprint and
verify the exact appcast enclosure signature. Wrangler uses its existing
operator authentication only when an explicit publish is requested.

## Stable continuity and atomic appcast gate

Stable Sparkle releases use the reviewed `previous_stable_manifest_required`
policy. Every stable validation, release, and publication after the first one
must receive the exact manifest from the previously published stable release
with `--previous-stable-manifest`. A missing, unreadable, malformed, non-stable,
older, or differently keyed manifest fails closed before publication; the
public-key fingerprint is never logged.

The first stable feed publication is a separate owner-only bootstrap. It must
pass `--stable-bootstrap` explicitly, must not pass a previous manifest, and is
accepted only while the live stable appcast is empty. Bootstrap is not a
fallback for missing prior state, and an existing appcast cannot be bootstrapped
over.

The installed Wrangler R2 CLI exposes only an ordinary `PUT`; it has no
conditional-write flag. Therefore `--publish` intentionally fails closed
unless the caller supplies the owner-provisioned `atomicAppcastGuard` seam. The
guard must perform the final appcast mutation as one atomic compare-and-swap:
compare the expected current appcast bytes/hash (or the empty state) and write
the candidate bytes in the same remote conditional operation. A read followed
by an ordinary Wrangler `PUT` is not an implementation of this contract.

The owner must provide a Worker or Durable Object endpoint using a real R2
conditional primitive, such as Workers R2 `put(..., { onlyIf: { etagMatches } })`
or an R2 S3 `If-Match`/`If-None-Match` request. See the [Workers R2 API
reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
and [R2 S3 API compatibility
reference](https://developers.cloudflare.com/r2/api/s3/api/). Until that
owner-only guard is provisioned and reviewed, no live appcast publication is
permitted.

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
validated before any Wrangler command can run. Supply the matching public key
through `--sparkle-public-ed-key`; it is compared with the release manifest's
public-key SHA-256 fingerprint and used for local Ed25519 verification.
The candidate release must have exactly one matching enclosure. The appcast may
also retain older signed full or delta enclosures; before publication, each is
read and cryptographically verified from R2. This publisher does not upload a
new delta artifact, so a release containing one is accepted only when its
immutable object was already safely published and verified.

## Publish procedure

The release step must use the same continuity choice before it emits a
manifest. For an established stable channel, pass
`--previous-stable-manifest`; for the first stable release only, pass
`--stable-bootstrap`:

```bash
npm run product:macos:release -- \
  --app ".release-build/macos-production/TiboTattle.app" \
  --channel stable \
  --previous-stable-manifest "/absolute/path/to/previous-stable-release.json"
```

Start with the signed DMG, the release manifest emitted beside it by that
command, and the signed `appcast.xml`. First run the validation-only command
(it does not contact R2):

```bash
npm run product:macos:publish-update -- \
  --bucket tibotattle-updates \
  --dmg ".release-build/macos-release/TiboTattle-0.1.0-macOS-arm64.dmg" \
  --release-manifest ".release-build/macos-release/TiboTattle-0.1.0-macOS-arm64.dmg.release.json" \
  --appcast "/absolute/path/to/appcast.xml" \
  --previous-stable-manifest "/absolute/path/to/previous-stable-release.json" \
  --sparkle-public-ed-key "$USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY"
```

For the first stable publication only, replace the previous-manifest option
with `--stable-bootstrap`.

The default production verifier re-runs the signed/notarized DMG gate, checks
the release-manifest SHA-256 and production assurances, requires the manifest's
canonical feed URL, and verifies every appcast enclosure stays on the approved
origin. It only accepts the current enclosure when it points to the
content-addressed object path above and has the exact manifest byte length and
bundle version. Validation-only mode remains local and does not contact R2.
When `--publish` is supplied, the publisher performs an additional read-only
R2 preflight before any upload: every preserved DMG or delta enclosure must
exist at its content-addressed key with the advertised byte length and SHA-256,
and any existing appcast must contain a lower highest bundle version than the
candidate.

After reviewing the printed plan, an owner-only caller may request `--publish`;
the current CLI invocation below documents the required inputs but remains
fail-closed until the atomic guard is provisioned. Artifact and manifest keys
are content-addressed under
`releases/<bundle-version>/<dmg-sha256>/` and are never overwritten. The mutable
`appcast.xml` is checked first and needs the additional explicit
`--replace-appcast` flag after the initial publication; that flag does not allow
an equal or lower bundle version to replace the live appcast:

```bash
npm run product:macos:publish-update -- \
  --bucket tibotattle-updates \
  --dmg "/absolute/path/to/TiboTattle-0.1.0-macOS-arm64.dmg" \
  --release-manifest "/absolute/path/to/TiboTattle-0.1.0-macOS-arm64.dmg.release.json" \
  --appcast "/absolute/path/to/appcast.xml" \
  --sparkle-public-ed-key "$USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY" \
  --previous-stable-manifest "/absolute/path/to/previous-stable-release.json" \
  --replace-appcast \
  --publish
```

The command-line publisher currently stops with
`SPARKLE_UPDATE_ATOMIC_GUARD_REQUIRED` because it cannot inject the owner guard.
Once the owner-only guard is provisioned, the publisher uploads the DMG and
manifest first with one-year immutable caching
(`application/x-apple-diskimage` and `application/json; charset=utf-8`), then
calls the guard for the appcast-last atomic mutation with
`application/xml; charset=utf-8` and `public, max-age=300, must-revalidate`.
After publication, it fetches the canonical public appcast with cache bypass,
requires the exact uploaded bytes and cache metadata, revalidates the current
enclosure, streams the public DMG to verify its byte length and SHA-256, and
checks the public length of any preserved enclosure entries. It does not report
publication success when that public read-back fails. A failed later upload or
read-back can leave immutable objects behind; the feed pointer is not
automatically rolled back, so do not delete immutable release objects as
recovery.

## Post-publication check

Independently fetch the canonical HTTPS appcast, verify it retains the signed
enclosure URL and signature, download the DMG, compare its SHA-256 with the
immutable release manifest, and rehearse the update on a clean Mac. This
publisher does not replace the normal Sparkle update/install rehearsal.
