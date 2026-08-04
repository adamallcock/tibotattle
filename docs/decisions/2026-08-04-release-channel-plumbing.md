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

## Follow-up boundary

The release-readiness/preview verifiers still need to consume the selected
policy where they inspect remote artifacts.
The `58739e3` release-readiness observer should consume the same
`getReleaseChannel`/`resolveReleaseChannel` contract when it is refactored;
it must not keep treating `config/deployment-endpoints.js` as the universal
channel source.

Preview remains a distinct `preview_distribution` path and rejects a named
non-stable channel, so it cannot silently become dogfood. For backwards
compatibility, `MACOS_PREVIEW_PUBLIC_CONFIGURATION` still supplies the
reviewed stable central/appcast defaults when preview is invoked without
overrides. That is the remaining risk: a preview build can still be an
explicitly requested production-service test client until a separately
reviewed preview policy (or an explicit-only preview configuration) replaces
those defaults. This lane does not edit the worker, package scripts, or public
preview verifier.

In particular, `scripts/verify-macos-preview-remote.js` currently requires
`UsageMonitorCentralOriginMode === production_https` near lines 321 and 459;
it must instead resolve the named channel policy, require the channel’s exact
service origin and expected mode, and reject unconfigured dogfood without
falling back to stable. The build must emit the same channel/mode metadata.

The external prerequisite is owner provisioning of dedicated staging service,
update-feed, DNS/R2 bucket, and the corresponding credentials/public key. This
lane did not provision, publish, deploy, write R2, or access credentials.
