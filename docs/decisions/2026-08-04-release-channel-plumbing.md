---
title: Release channel plumbing
date: 2026-08-04
type: decision-record
status: implemented-local
---

# Decision

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
feed, deployed service, or public channel operation.
