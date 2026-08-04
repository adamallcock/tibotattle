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

Stable appcasts use the canonical single-item contract in
`config/sparkle-appcast-policy.js`, matching the owner-only Worker guard: one
RSS channel item, one signed full `.dmg` enclosure, no
`sparkle:deltaFrom`, and no retained history or extra enclosures. This is a
release-safety contract, not a formatting preference: a local publisher that
accepted history or deltas could pass its own checks and then fail at the
guard after immutable objects had already been uploaded. The internal-dogfood
descriptor is currently unconfigured, so it cannot reach this stable publisher
or guard; a future configured channel needs a separately reviewed policy.

Fresh bootstrap and replacement both publish the current full DMG as the sole
feed entry, so an older installed client can update directly without requiring
retained feed history. Exact retry/resume recognizes only that same one-item
candidate and never claims that older entries were retained. Replacement still
requires an explicit flag and a strictly newer bundle version; rollback is a
manual higher-version signed release, never a silent downgrade.

The macOS bundle builder has a separate accident-prevention boundary: direct
`build-macos-app.js --external-distribution --release-channel stable`
invocation fails before it creates an output bundle. `release-macos-app.js`
performs the shared continuity/bootstrap validation first, then sets a
narrowly scoped `USAGE_MONITOR_MACOS_RELEASE_GATE=release-macos-app` marker for
its fresh builder subprocess. The marker is an internal handoff, not a
hostile-user security boundary; it prevents an ordinary direct build from
being mistaken for a fully gated release. Development and preview builds do
not require or use it.

The installed Wrangler R2 CLI exposes only an ordinary `PUT`; it has no
conditional-write flag. Therefore `--publish` fails closed unless the caller
supplies either the preserved test seam or an explicit owner-provisioned guard
endpoint and token. The production guard contract is the exact Worker route
`/api/v1/internal/release/appcast`; it is not a broad R2 proxy and is absent
(`404`) while disabled.

The guard authenticates a bounded canonical request with an HMAC-SHA-256 over
the schema, `POST`, exact route, timestamp, nonce, and body SHA-256. The token
is read from the allowlisted environment variable name, never printed or
placed in a receipt or request body. The Worker rejects stale timestamps and
consumes each nonce once in the existing
D1 database with a short TTL before it reads or writes R2. A duplicate nonce,
bad signature, or failed storage operation fails closed. The request names the
reviewed `stable` channel, exact `tibotattle-updates` bucket and `appcast.xml`
key, exact XML content type/cache-control, bounded candidate bytes, candidate
SHA-256, and expected current state/hash (and optional current HTTP etag).

The owner-only Worker reads the current appcast, verifies that state, and calls
R2 `put(..., { onlyIf: { etagMatches } })` (or the empty-object equivalent) with
the candidate and HTTP metadata. Cloudflare documents that a failed R2
conditional put returns `null`, which the guard reports as a distinct conflict;
it performs no fallback ordinary put. See the [Workers R2 API
reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
and [R2 S3 API compatibility
reference](https://developers.cloudflare.com/r2/api/s3/api/). The appcast is
the only mutable release object; artifacts and manifests remain immutable and
are handled by the existing publisher first.

The checked-in Worker configuration intentionally does not declare the release
R2 binding, enable the route, or provide its secret. Before any owner
activation, the owner must separately review and provision all of the
following for the exact selected channel:

1. Apply the checked-in D1 migration for the nonce ledger.
2. Bind R2 as `SPARKLE_RELEASES` to the exact reviewed update bucket
   `tibotattle-updates`; do not point it at `QUARANTINE` or another bucket.
3. Set `SPARKLE_APPCAST_GUARD_MODE=enabled` plus exact reviewed values for
   `SPARKLE_APPCAST_GUARD_CHANNEL=stable`,
   `SPARKLE_APPCAST_GUARD_BUCKET=tibotattle-updates`,
   `SPARKLE_APPCAST_GUARD_APPCAST_KEY=appcast.xml`,
   `SPARKLE_APPCAST_GUARD_ENDPOINT_PATH=/api/v1/internal/release/appcast`,
   `SPARKLE_APPCAST_GUARD_CONTENT_TYPE=application/xml; charset=utf-8`,
   `SPARKLE_APPCAST_GUARD_CACHE_CONTROL=public, max-age=300, must-revalidate`,
   and `SPARKLE_APPCAST_GUARD_MAX_XML_BYTES=1048576`.
4. Store a fresh owner-only value of at least 32 characters as the
   `SPARKLE_APPCAST_GUARD_TOKEN` Worker secret. Never put its value in source,
   shell history, receipts, logs, or the appcast.
5. Verify the explicit CLI endpoint is HTTPS, has no credentials/query/hash,
   and is exactly the selected channel service origin plus the fixed route.

This is an owner provisioning checklist, not evidence that the binding,
secret, route, endpoint, or D1 migration is deployed. Until all five items are
reviewed and receipted, no live appcast publication is permitted.

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
The candidate release must satisfy the canonical one-item/full-DMG contract
above. No history or delta enclosure is preserved or uploaded.

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
canonical feed URL, and verifies the sole appcast enclosure stays on the
approved origin. It only accepts that enclosure when it points to the
content-addressed object path above and has the exact manifest byte length and
bundle version. Validation-only mode remains local and does not contact R2.
When `--publish` is supplied, the publisher performs an additional read-only
R2 preflight before any upload and requires any existing canonical appcast to
contain a lower bundle version than the candidate.

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
  --atomic-appcast-guard-endpoint "https://EXACT-REVIEWED-SERVICE-ORIGIN/api/v1/internal/release/appcast" \
  --atomic-appcast-guard-token-env SPARKLE_APPCAST_GUARD_TOKEN \
  --replace-appcast \
  --publish
```

The token option is an allowlisted environment-variable name, not a literal
secret argument. The publisher reads `SPARKLE_APPCAST_GUARD_TOKEN` only when
`--publish` is active and removes it from its environment before local input
and DMG validation, so child processes do not inherit the value even when
validation fails. A literal
`--atomic-appcast-guard-token` option is rejected. Without both explicit guard
options, the command-line publisher stops with
`SPARKLE_UPDATE_ATOMIC_GUARD_REQUIRED` (or an options error) before any remote
read or mutation. Once the owner-only guard is provisioned, the publisher uploads the DMG and
manifest first with one-year immutable caching
(`application/x-apple-diskimage` and `application/json; charset=utf-8`), then
calls the guard for the appcast-last atomic mutation with
`application/xml; charset=utf-8` and `public, max-age=300, must-revalidate`.
After publication, it fetches the canonical public appcast with cache bypass,
requires the exact uploaded bytes and cache metadata, revalidates the current
enclosure, streams the public DMG to verify its byte length and SHA-256, and
does not report publication success when that public read-back fails. A failed later upload or
read-back can leave immutable objects behind; the feed pointer is not
automatically rolled back, so do not delete immutable release objects as
recovery.

Passing local code/tests validates this contract and the publisher's simulated
R2/read-back seams only. It is not a live release: owner-only signing,
notarization/stapling, clean-profile update rehearsal, Worker/guard
provisioning, public R2/appcast mutation, and public read-back remain external
release gates.

## Post-publication check

Independently fetch the canonical HTTPS appcast, verify it retains the signed
enclosure URL and signature, download the DMG, compare its SHA-256 with the
immutable release manifest, and rehearse the update on a clean Mac. This
publisher does not replace the normal Sparkle update/install rehearsal.
