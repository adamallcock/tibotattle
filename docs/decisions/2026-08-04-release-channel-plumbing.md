---
title: Release channel plumbing
date: 2026-08-04
type: decision-record
status: supplemented
---

# Decision

## Supplement — 2026-08-05

The original `internal-dogfood` null-policy decision below is a historical
snapshot of the reviewed state on 2026-08-04. It has been supplemented by the
configured descriptor now present in `config/release-channels.js`; the original
text is retained rather than rewritten.

`internal-dogfood` is now configured with
`serviceOriginMode: internal_dogfood_https`. It intentionally shares
`https://tibotattle.com` for the app service and public website, while its
update distribution remains isolated: update origin
`https://dogfood-updates.tibotattle.com`, appcast
`https://dogfood-updates.tibotattle.com/internal-dogfood/appcast.xml`, bucket
`tibotattle-dogfood-updates`, immutable object prefix
`internal-dogfood/releases`, and a dedicated reviewed Ed25519 public key.
`internal-dogfood` must continue to resolve only from this source-bound policy
and must never inherit stable update identifiers.

This supplement changes channel configuration state, not release readiness:
owner-only signing, publication and read-back, deployment containment, and an
observed installed-client rehearsal remain separate gates.

## Original decision (2026-08-04 snapshot)

Release tooling uses explicit named channels. `stable` derives its service,
public-site, Sparkle origin/feed, and bucket from
`config/deployment-endpoints.js`; its existing `releases/<version>/<sha>/...`
object layout remains unchanged. Both the macOS release and Sparkle publisher
CLIs require explicit `--channel stable` (or another named channel).

`internal-dogfood` is intentionally present only as a fully null,
non-operational policy. It cannot resolve, package, or publish until this file
is reviewed with a dedicated HTTPS service origin, a non-production
`serviceOriginMode` of `internal_dogfood_https`, dedicated public/update
origins, a separate appcast path, immutable object prefix, R2 bucket, and
reviewed Sparkle public-key fingerprint. The channel API rejects copied stable
origins, feed/object paths, bucket, mode, or key.

The macOS builder and signed-release core now consume that named policy for
external bundles. Stable continues to emit `production` / `production_https`
and the exact reviewed production endpoints. A future configured dogfood
candidate will emit `internal-dogfood` / `internal_dogfood_https` with its
policy-owned website, service, appcast, and public-key inputs. Endpoint flags
remain compatibility inputs only: external builds compare them with the
selected policy and never use them as an alternate source.

Stable Sparkle publication also has an explicit canonical appcast policy in
`config/sparkle-appcast-policy.js`: exactly one RSS channel item and exactly
one signed full `.dmg` enclosure, with no `sparkle:deltaFrom`, retained history,
or extra enclosure. It matches the owner-only Worker guard contract. The
publisher rejects a violation before any R2 read or mutation; this prevents a
local validation pass from producing a feed that the later guarded stable
publication would reject. A one-item feed is sufficient for fresh bootstrap,
replacement, and exact resume because each earlier client can receive the
current full DMG directly. Replacement remains strictly forward-versioned and
rollback remains a manual higher-version signed release.

Every new bundle also exposes the named identity directly for verifiers:
`Contents/Info.plist:UsageMonitorReleaseChannel` and
`Contents/Resources/build-manifest.json:release.channelName` are identical.
Their values are `stable` for the stable external channel,
`internal-dogfood` for a configured dogfood external channel,
`preview_distribution` for preview, and `development` for an ordinary
development bundle. The existing `UsageMonitorBuildChannel` and
`release.channel` fields remain unchanged for compatibility (`production` for
stable and `internal-dogfood` for dogfood). External inspection requires both
named-identity fields to match the selected policy; it does not infer `stable`
from the legacy `production` value.

## Implemented verification boundary

The release-readiness observer and remote macOS preview verifier now resolve
the selected named channel policy before they inspect a remote endpoint. They
derive the service origin, appcast URL, and object prefix from that policy,
enforce the sealed channel identity, and reject command-line endpoint
overrides. An unconfigured `internal-dogfood` channel fails before any network
request and never falls back to the stable channel.

Preview remains a distinct `preview_distribution` path rather than a release
channel. It cannot silently become dogfood: a channel-bound external bundle
must carry matching named-identity fields and match the selected channel's
policy. These checks establish a local fail-closed boundary only; they do not
prove that a signed artifact, update feed, or hosted service exists.

The external prerequisite is owner provisioning of dedicated staging service,
update-feed, DNS/R2 bucket, and the corresponding credentials/public key. This
lane did not provision, publish, deploy, write R2, or access credentials. This
local decision record does not evidence a signed artifact, released update
feed, deployed service, or public channel operation. Passing local code
validation is not a live release or evidence that the owner-only signing,
notarization, Worker guard, R2 mutation, public read-back, or clean-profile
update rehearsal gates have passed.

The disabled appcast guard now has a local server-side verification boundary:
when owner-provisioned, it independently checks exactly one full stable `.dmg`
enclosure/item, rejects all delta/history entries, verifies both the active
baseline and candidate R2 artifact metadata/bytes and Sparkle Ed25519
signatures, and enforces monotonic version before the existing nonce/CAS write.
A malformed or unverifiable non-empty baseline fails closed; owner remediation
or a controlled migration must establish a valid baseline rather than silently
overwriting it. The checked-in Worker remains disabled and unprovisioned; code
validation is not channel readiness, and real readiness still requires owner
review of the stable public-key fingerprint, R2/D1 bindings, token,
signed/notarized artifacts, deployed feed, and guarded CAS rehearsal.
Passing local code validation is not a live release or evidence that the
owner-only signing, notarization, Worker guard, R2 mutation, public read-back,
or clean-profile update rehearsal gates have passed.
