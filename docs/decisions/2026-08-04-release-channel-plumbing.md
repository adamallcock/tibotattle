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

## Follow-up boundary

The next owner must thread the selected policy into
`scripts/build-macos-app.js` and the release-readiness/preview verifiers.
The `58739e3` release-readiness observer should consume the same
`getReleaseChannel`/`resolveReleaseChannel` contract when it is refactored;
it must not keep treating `config/deployment-endpoints.js` as the universal
channel source.

In particular, `scripts/verify-macos-preview-remote.js` currently requires
`UsageMonitorCentralOriginMode === production_https` near lines 321 and 459;
it must instead resolve the named channel policy, require the channel’s exact
service origin and expected mode, and reject unconfigured dogfood without
falling back to stable. The build must emit the same channel/mode metadata.

The external prerequisite is owner provisioning of dedicated staging service,
update-feed, DNS/R2 bucket, and the corresponding credentials/public key. This
lane did not provision, publish, deploy, write R2, or access credentials.
