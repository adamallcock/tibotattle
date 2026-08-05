---
title: TiboTattle internal dogfood versus release readiness
date: 2026-08-05
type: runbook
status: internal-preview-usable-release-blocked
---

# TiboTattle internal dogfood versus release readiness

Use this runbook to decide whether a TiboTattle build is suitable for
internal product smoke or for release qualification. It is a local and
owner-only procedure: it does not deploy, publish, create credentials, or
make a release claim from configuration alone.

## Current decision boundary

The current internal dogfood artifact is an ad-hoc `preview_distribution`
bundle. It can be installed through the guarded route at
`/Applications/TiboTattle.app` and can talk to the deployed central service.
That proves an installed service-connected preview, not a distributable or
updatable release. It is not Developer-ID signed or notarized, and therefore
cannot prove Sparkle updating.

The named `internal-dogfood` release channel is a separate future lane. Its
policy in [`config/release-channels.js`](../../config/release-channels.js) is
currently fully unconfigured and must not inherit stable endpoints. The
stable update URL, `https://updates.tibotattle.com/appcast.xml`, currently
returns HTTP 404. Treat that as **not published**; do not describe an updater
as working.

| Lane | What it can prove now | What it cannot prove |
| --- | --- | --- |
| `preview_distribution` internal smoke | Guarded `/Applications` install, launch, and interaction with the deployed central service | Developer ID, notarization, Sparkle signature acceptance, or N→N+1 updating |
| `internal-dogfood` release candidate | Only after its distinct source-bound policy and signed artifacts exist | Nothing while the policy is unconfigured |
| `stable` release candidate | Only after the stable feed, artifact, and owner release gates pass | Anything while the current appcast is 404 or client acceptance is unobserved |

## 1. Run the current internal preview smoke

Build and validate the preview through the repository commands, then use the
guarded installer. Do not copy an app into `/Applications` by hand:

```bash
npm run product:macos:preview
npm run product:macos:preview:install
```

Launch `/Applications/TiboTattle.app` and perform the intended local smoke
against the deployed central service. For a local-only bundle check, or for a
bounded live service/feed observation, invoke the verifier with the preview
channel explicitly:

```bash
node scripts/verify-macos-preview-remote.js \
  --app "/Applications/TiboTattle.app" \
  --channel preview_distribution

node scripts/verify-macos-preview-remote.js \
  --app "/Applications/TiboTattle.app" \
  --channel preview_distribution \
  --live
```

The live command is credential-free and read-only. With the current external
state it must stop at the unpublished appcast (HTTP 404), even if the central
service responds successfully. Neither command is an updater test, and a
receipt from either command cannot authorize distribution.

## 2. Qualify a signed release candidate

Do not promote the preview bundle. For a future internal dogfood or stable
candidate, follow the named channel policy and the external-distribution
release path:

1. Read the [release-channel decision](../decisions/2026-08-04-release-channel-plumbing.md)
   and resolve the selected channel from source. The current
   `internal-dogfood` check must fail closed with
   `RELEASE_CHANNEL_NOT_CONFIGURED`:

   ```bash
   node apps/worker/scripts/release-readiness.mjs --channel internal-dogfood
   ```

   Do not substitute a host, feed, bucket, key, or command-line endpoint for
   a missing policy. Keep all release configuration source-bound.
2. Once an owner-reviewed policy exists, build from the clean annotated tag
   through the channel-aware release path. For internal dogfood, the command
   is:

   ```bash
   npm run product:macos:updater:prepare
   npm run product:macos:release -- --channel internal-dogfood
   ```

   The equivalent stable path must name `stable` and retain its previous
   stable manifest continuity input. The candidate must be Developer-ID
   signed, notarized, and stapled; local packaging or an ad-hoc signature is
   not a substitute.
3. Publish and read back the exact Sparkle-signed appcast and immutable DMG
   through the [Sparkle publisher runbook](./2026-08-02-r2-sparkle-update-publisher.md).
   The appcast URL, artifact, bucket, object prefix, service origin, and
   public-key fingerprint must come from the selected source policy. Never
   put a private signing key in this repository or in a receipt.
4. Use the [owner release sequence](./2026-08-04-owner-release-execution.md)
   for deployment containment, publication, rollback, and stable intake. A
   healthy service response, a local release manifest, or remote feed
   readback alone is not client update acceptance.

## 3. Required N to N+1 proof

The only valid updater proof is a manual installed-client rehearsal in a
disposable macOS profile. The [detailed rehearsal](./2026-08-04-internal-update-rehearsal.md)
contains the owner receipt and recovery rules; the minimum sequence is:

1. Install a Developer-ID-signed, notarized, stapled predecessor `N` and
   retain a recoverable copy.
2. Produce a separately signed, notarized, stapled successor `N+1` from the
   same source-bound named channel. Confirm that the valid Sparkle-signed feed
   and immutable artifact are available at the policy-derived URLs, with the
   expected version and digest.
3. From `N`, perform the manual **Check for Updates** action and confirm that
   the feed identifies `N+1`.
4. Allow the `N+1` download, installation, and required quit/relaunch path to
   complete. Then relaunch and check that the installed version is `N+1` and
   the app remains usable.
5. If any step fails, stop the release claim, preserve a content-free failure
   receipt, and restore `N` through the approved recovery path. A remote
   preflight, feed readback, or verifier receipt cannot replace this
   observation.

## Release-ready versus stop

Mark a channel release-ready only when all of these are observed for the same
source-bound candidate: distinct channel policy, Developer ID signature,
notarization/stapling, valid signed feed and artifact, successful manual
`N`-to-`N+1` download/install/relaunch/version check, and the remaining owner
deployment gates.

Stop at internal dogfood when the goal is only product smoke. Stop release
qualification for an ad-hoc bundle, an unconfigured channel, a feed 404/410,
missing or mismatched artifact, missing signing/notarization, endpoint drift,
or an unobserved installed-client upgrade. Do not advance by inference from a
healthy central service or by copying stable configuration into dogfood.
