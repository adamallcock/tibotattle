---
title: TiboTattle Internal N to N+1 Update Rehearsal
date: 2026-08-04
type: runbook
status: owner-run-internal-only
---

# TiboTattle internal N to N+1 update rehearsal

This is an owner-run rehearsal for a disposable macOS profile. It is not a
signing, notarization, Sparkle-feed publication, R2 write, deployment, or
release-approval procedure. The verifier performs a **remote feed preflight**:
it reads both sealed channel identities from the candidate bundle and, when
`--live` is explicitly supplied, performs bounded credential-free HTTPS
readback. It does not verify the Sparkle signature and it does not prove that
an installed client accepts the update.

The `--channel` value is mandatory and must match both
`Contents/Info.plist:UsageMonitorReleaseChannel` and
`Contents/Resources/build-manifest.json:release.channelName`. A
`preview_distribution` bundle is the preview/ad-hoc boundary only; it is not
a signed dogfood or stable release bundle. `stable`, and a future configured
`internal-dogfood`, are checked through the external-distribution bundle
inspector and derive their central origin, appcast URL, and any reviewed
public-key fingerprint from `config/release-channels.js`. The current
`internal-dogfood` entry is deliberately unconfigured, so it fails locally
with an actionable policy error before any network request. No endpoint flag
may be used to bypass that policy.

For the current unconfigured dogfood lane, an explicit check is expected to
stop locally:

```bash
node scripts/verify-macos-preview-remote.js \
  --app "/absolute/path/to/N+1/TiboTattle.app" \
  --channel internal-dogfood
```

It must report that `internal-dogfood` needs reviewed dedicated endpoints and
must make zero HTTPS requests. Do not substitute `stable` or a command-line
endpoint override for that missing policy.

`N` means the currently installed signed build in the disposable profile;
`N+1` means the candidate build being rehearsed. Keep the signed `N` DMG (or
the owner-approved recovery copy) available before starting. Only a signed
`stable` or configured named dogfood bundle may participate in the owner-only
installed-client rehearsal. A `preview_distribution` or `development` bundle
may be inspected locally, but cannot be used as that proof.

## Gate meaning

Run the verifier against the exact candidate bundle for the selected channel.
For named release channels, endpoints are policy-derived and cannot be
overridden. For the preview compatibility path, explicit public endpoint
arguments remain cross-checked against the bundle metadata before any request
is made.
The only full update-acceptance proof is an owner-observed signed N to N+1
rehearsal in this disposable profile; no verifier result or receipt can replace
that observation.

Offline inspection is useful for the local boundary, but it is not a usable
remote feed preflight or updater proof:

```bash
node scripts/verify-macos-preview-remote.js \
  --app "/absolute/path/to/N+1/TiboTattle.app" \
  --channel preview_distribution \
  --central-origin "<reviewed channel central origin>" \
  --appcast-url "<reviewed channel appcast URL>" \
  --artifact-url "<reviewed channel artifact URL>" \
  --remote-feed-preflight \
  --receipt "/absolute/path/to/rehearsal/N+1-offline.json"
```

Because `--live` is absent, this command must exit non-zero with a blocked
remote feed preflight. The preview bundle remains explicitly preview/ad-hoc;
this command is not a signed dogfood rehearsal and cannot be used as one. The
content-free receipt records that the remote feed preflight was not checked
and contains no appcast or artifact payload.

After the owner has confirmed that the reviewed, dedicated internal-dogfood
feed and artifact are intended to be exercised, run the bounded live remote
feed preflight against that named channel:

```bash
node scripts/verify-macos-preview-remote.js \
  --app "/absolute/path/to/N+1/TiboTattle.app" \
  --channel internal-dogfood \
  --live \
  --remote-feed-preflight \
  --receipt "/absolute/path/to/rehearsal/N+1-live.json"
```

Until `config/release-channels.js` contains the separately reviewed dogfood
endpoints, this exact command must fail closed with
`RELEASE_CHANNEL_NOT_CONFIGURED` and make zero HTTPS requests. Do not
substitute `stable` or a command-line endpoint override for the missing
dogfood policy. The public `stable` preflight belongs only to the separately
gated [public stable stage](./2026-08-04-owner-release-execution.md#5-public-stable-publish-observe-then-open-intake).

The live command intentionally exits non-zero when
`--remote-feed-preflight` is present: this verifier never turns remote
readback into update acceptance. A receipt may report
`remotePublicationReadback.status` as `passed`
only when all of the following are true:

- the candidate bundle passes the selected channel's local boundary (the
  preview/ad-hoc validator for `preview_distribution`, or the
  external-distribution inspector for `stable`/configured dogfood);
- the two sealed channel fields and the selected `--channel` match exactly;
- named-channel endpoints match `config/release-channels.js` (preview
  compatibility endpoints must match the embedded public metadata);
- every configured central health/ready endpoint is healthy;
- the appcast is a valid bounded Sparkle RSS/XML document, is not a 404/410,
  and contains exactly one content-addressed full `.dmg` N+1 enclosure; and
- the remote response supplies `Content-Length` matching that enclosure before
  the bounded stream is consumed, and the streamed bytes have its SHA-256.

The selected enclosure is the sole source of artifact identity. Preview-only
artifact digest/length configuration is an exact cross-check only; it cannot
select or replace the feed candidate. Named release channels do not accept
artifact endpoint, digest, length, or health-path overrides. Delta enclosures,
multiple full-DMG enclosures, missing `Content-Length`, mismatches, and
ambiguous candidates are blocked.

An unavailable request, malformed XML, invalid enclosure metadata, mismatched
URL, missing artifact, byte mismatch, missing/mismatched `Content-Length`, or
hash mismatch is a blocked preflight. The verifier never turns a healthy
central endpoint into update acceptance when the feed is absent. In particular,
the read-only evidence recorded at
`2026-08-04T18:56Z`—`https://updates.tibotattle.com/appcast.xml` returning
HTTP 404 while `/api/health` reported `enrollmentMode=open`—is a blocking
`not_published` appcast state, not a usable production updater.

The JSON receipt is content-free and schema-versioned. It binds the attempt to
the exact channel, feed URL, selected artifact URL/hash/length when observed,
candidate version, and public Ed25519 key fingerprint. It records
`cryptographicSignatureVerified: false` because this verifier performs no
public-key verification, and `sparkleAcceptance.status: "not_verified"` until
the owner observes a real signed N to N+1 installed-client rehearsal. It does
not record appcast XML, artifact bytes, Sparkle signatures, public keys,
credentials, account data, raw logs, or filesystem paths. A receipt cannot
record a passed update-acceptance claim and the verifier refuses to overwrite
an existing receipt.

## Owner-only prerequisites

Before the manual rehearsal, the owner must supply or confirm all of these
outside this lane:

1. A Developer ID-signed, notarized, stapled build for `N`, installed only in
   the disposable profile, and the exact signed/notarized `N+1` candidate.
2. The Sparkle-signed appcast and its immutable public artifact at the
   policy-derived named-channel URL (or the reviewed preview compatibility
   URLs). The feed must already be available; this lane does not sign,
   publish, upload, or repair it.
3. A disposable macOS user profile or release VM with no existing TiboTattle
   state, Login Item, updater prompt, or retained account material.
4. A recoverable copy of `N` and an owner-approved way to restore it if the
   candidate cannot complete the rehearsal.
5. An owner-only evidence directory for the content-free receipts. Do not put
   private keys, Keychain exports, tokens, account identifiers, or raw logs in
   that directory.

If any prerequisite is missing, stop at the offline inspection and report the
specific blocked state. Do not substitute an ad-hoc signature, a local file,
an empty feed, a central-health response, a content hash, or this verifier's
receipt for the missing updater proof.

## Exact N to N+1 profile rehearsal

Perform the following in one disposable profile, recording only the bounded
receipt and a pass/fail note for each step.

1. **Prepare N.** Start the clean profile, install the signed `N` through the
   owner's approved install path, launch it once, and confirm the app opens as
   the expected `N` version. Establish one harmless local-state canary (for
   example, a visible setting) so retention can be checked without recording
   account or activity data.
2. **Preflight N+1.** Run the live verifier command above against the exact
   `N+1` bundle. A blocked `remotePublicationReadback`, `not_published`,
   `unavailable`, `invalid`, or `mismatched_url` result ends the attempt; do
   not open an updater flow and do not make an update-acceptance claim. Even a
   passed remote preflight leaves `sparkleAcceptance` unverified.
3. **Cancellation path.** From N, start the manual update check and begin the
   N+1 download/install flow. Cancel while the operation is cancellable. Confirm
   that the app remains on N, the update is not reported as installed, and the
   user can return to the normal app without a stuck update state. Record the
   cancellation as a failed update attempt, not as a successful update.
4. **Retry path.** Start the same update check again from N. Allow the complete
   download, verification, install-on-quit/relaunch path required by the owner
   configuration. Relaunch and confirm the app reports N+1, opens normally, and
   retains the harmless local-state canary. Confirm that only one app/update
   operation is active and that no duplicate installed copy was introduced.
5. **Fallback path.** If the retry cannot complete, if the appcast becomes
   unavailable/malformed, or if the artifact proof fails, stop and preserve the
   failed receipt. Quit the candidate, restore the retained signed N through
   the owner-approved recovery path, relaunch it, and confirm the canary and
   normal N behavior remain. Do not delete local state, rotate keys, or treat a
   fallback as evidence that N+1 passed.
6. **Closeout.** Only when cancellation, retry, and fallback handling are
   understood and the successful retry is observed may the owner mark the
   internal N to N+1 rehearsal complete. Keep the verifier preflight receipt
   with the owner-only operational record; that record is not an input to this
   verifier and cannot make an unverified update pass. This is still
   preview/dogfood evidence; it does not authorize production publication.

## Stop conditions and recovery

Stop immediately for a feed HTTP 404/410, any redirect, malformed XML,
invalid enclosure URL/length/version/signature metadata, a delta or ambiguous
candidate, a candidate/endpoint URL mismatch, missing/mismatched
`Content-Length`, an artifact status other than 2xx, a byte-count/hash
mismatch, an unexpected installed app identity, or a state change outside the
rehearsal.
Retry only with a fresh receipt filename after the owner has diagnosed the
bounded failure. If the second attempt fails, use the retained N fallback and
leave release publication blocked until the owner supplies fresh feed/artifact
evidence and completes the real signed N to N+1 installed-client rehearsal.
