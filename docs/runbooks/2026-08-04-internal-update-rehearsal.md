---
title: TiboTattle Internal N to N+1 Update Rehearsal
date: 2026-08-04
type: runbook
status: owner-run-internal-only
---

# TiboTattle internal N to N+1 update rehearsal

This is an owner-run rehearsal for a disposable macOS profile. It is not a
signing, notarization, Sparkle-feed publication, R2 write, deployment, or
release-approval procedure. The verifier only reads the candidate bundle's
public metadata and, when `--live` is explicitly supplied, performs bounded
credential-free HTTPS reads of the configured public endpoints.

`N` means the currently installed signed build in the disposable profile;
`N+1` means the candidate build being rehearsed. Keep the signed `N` DMG (or
the owner-approved recovery copy) available before starting. Do not use an
ordinary development or ad-hoc build for the N to N+1 claim.

## Gate meaning

Run the verifier against the exact candidate app bundle. Endpoint values are
explicit arguments so a copied or stale bundle cannot silently redirect the
rehearsal to a different service. The explicit central origin and appcast URL
must match the candidate's embedded public metadata before any request is
made.

Offline inspection is useful for the local boundary, but it is not a usable
updater proof:

```bash
node scripts/verify-macos-preview-remote.js \
  --app "/absolute/path/to/N+1/TiboTattle.app" \
  --central-origin "https://tibotattle.com" \
  --appcast-url "https://updates.tibotattle.com/appcast.xml" \
  --artifact-url "https://updates.tibotattle.com/releases/<N+1>/<sha256>/TiboTattle.dmg" \
  --production-claim \
  --receipt "/absolute/path/to/rehearsal/N+1-offline.json"
```

Because `--live` is absent, this command must exit non-zero with a blocked
production claim. The receipt is still useful: it records that the network was
not checked and contains no appcast or artifact payload.

After the owner has confirmed that the public feed and artifact are intended
to be exercised, run the bounded live proof:

```bash
node scripts/verify-macos-preview-remote.js \
  --app "/absolute/path/to/N+1/TiboTattle.app" \
  --central-origin "https://tibotattle.com" \
  --appcast-url "https://updates.tibotattle.com/appcast.xml" \
  --artifact-url "https://updates.tibotattle.com/releases/<N+1>/<sha256>/TiboTattle.dmg" \
  --live \
  --production-claim \
  --receipt "/absolute/path/to/rehearsal/N+1-live.json"
```

The live command exits zero only when all of the following are true:

- the candidate bundle is locally valid and remains in the preview boundary;
- the explicit endpoints match the embedded public metadata;
- every configured central health/ready endpoint is healthy;
- the appcast is a valid bounded Sparkle RSS/XML document, is not a 404/410,
  and contains exactly the configured content-addressed N+1 enclosure; and
- the remote enclosure bytes have the advertised length and SHA-256.

An unavailable request, malformed XML, invalid enclosure metadata, mismatched
URL, missing artifact, byte mismatch, or hash mismatch is a blocked result.
The verifier never turns a healthy central endpoint into updater readiness when
the feed is absent. In particular, the read-only evidence recorded at
`2026-08-04T18:56Z`—`https://updates.tibotattle.com/appcast.xml` returning
HTTP 404 while `/api/health` reported `enrollmentMode=open`—is a blocking
`not_published` appcast state, not a usable production updater.

The JSON receipt is content-free. It records bounded states, HTTP statuses,
public endpoint metadata, artifact byte count/hash, and the claim outcome. It
does not record appcast XML, artifact bytes, Sparkle signatures, public keys,
credentials, account data, raw logs, or filesystem paths. Preserve one fresh
receipt per attempt; the verifier refuses to overwrite an existing receipt.

## Owner-only prerequisites

Before the manual rehearsal, the owner must supply or confirm all of these
outside this lane:

1. A Developer ID-signed, notarized, stapled build for `N`, installed only in
   the disposable profile, and the exact signed/notarized `N+1` candidate.
2. The Sparkle-signed appcast and its immutable public artifact at the exact
   URLs passed to the verifier. The feed must already be available; this lane
   does not sign, publish, upload, or repair it.
3. A disposable macOS user profile or release VM with no existing TiboTattle
   state, Login Item, updater prompt, or retained account material.
4. A recoverable copy of `N` and an owner-approved way to restore it if the
   candidate cannot complete the rehearsal.
5. An owner-only evidence directory for the content-free receipts. Do not put
   private keys, Keychain exports, tokens, account identifiers, or raw logs in
   that directory.

If any prerequisite is missing, stop at the offline inspection and report the
specific blocked state. Do not substitute an ad-hoc signature, a local file,
an empty feed, or a central-health response for the missing updater proof.

## Exact N to N+1 profile rehearsal

Perform the following in one disposable profile, recording only the bounded
receipt and a pass/fail note for each step.

1. **Prepare N.** Start the clean profile, install the signed `N` through the
   owner's approved install path, launch it once, and confirm the app opens as
   the expected `N` version. Establish one harmless local-state canary (for
   example, a visible setting) so retention can be checked without recording
   account or activity data.
2. **Preflight N+1.** Run the live verifier command above against the exact
   `N+1` bundle. A non-zero exit, `not_published`, `unavailable`, `invalid`, or
   `mismatched_url` result ends the attempt; do not open an updater flow and do
   not make a production claim.
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
   internal N to N+1 rehearsal complete. Keep the verifier receipt and the
   human pass/fail note together. This is still preview/dogfood evidence; it
   does not authorize production publication.

## Stop conditions and recovery

Stop immediately for a feed HTTP 404/410, any redirect, malformed XML,
invalid enclosure URL/length/version/signature metadata, a candidate/endpoint
URL mismatch, an artifact status other than 2xx, a byte-count/hash mismatch,
an unexpected installed app identity, or a state change outside the rehearsal.
Retry only with a fresh receipt filename after the owner has diagnosed the
bounded failure. If the second attempt fails, use the retained N fallback and
leave production claims blocked until the owner supplies fresh feed/artifact
evidence.
