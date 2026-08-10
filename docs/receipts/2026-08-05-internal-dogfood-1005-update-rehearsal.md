---
title: TiboTattle internal dogfood build 1005 update rehearsal
date: 2026-08-05
type: receipt
status: passed-internal-dogfood
---

# TiboTattle internal dogfood build 1005 update rehearsal

## Verdict

Build `0.1.0 (1005)` is the installed private-channel internal release
candidate for updater dogfooding. The signed and notarized `1004 → 1005`
update completed through Sparkle in `/Applications/TiboTattle.app`, relaunched
as a new process, retained the existing local dashboard evidence, and returned
an honest verified-no-update state on the next manual check.

This receipt does not authorize a stable publication or public intake.

## Bound identities

- Source commit: `967fac19bdcd5b1a6cd79a6e9a0fdb6590c58f8d`
- Annotated source tag:
  `tibotattle-internal-dogfood-0.1.0-rc4-source-20260805`
- Channel: `internal-dogfood`
- Appcast:
  `https://dogfood-updates.tibotattle.com/internal-dogfood/appcast.xml`
- Appcast SHA-256: `1c55c3fcc01c3deec0ce294ea385e35a2a850c0e37959116f9ac9e357ea9e67e`
- Appcast bytes: `1,367`
- Candidate DMG SHA-256:
  `f0c95eead890810fd91b78e439d297f85347899a0e12992a6ba436f129fd9417`
- Candidate DMG bytes: `48,729,348`
- Sparkle public-key fingerprint:
  `77d5717947da768e7e96a1b1e6225d2cae4748a556f109f2a30444a5f41ff3d2`

The build manifest records Developer ID hardened runtime, app and DMG
notarization, stapling, Gatekeeper assessment, clean-profile validation, and
reproduction from the checked-out source as passed. No private key, token,
provider identifier, account data, raw appcast, or raw local log is recorded
here.

## Observed rehearsal

1. Before the first private feed publication, the installed predecessor saw
   the feed as unavailable (HTTP 404). The native failure state remained
   retryable and local analysis continued.
2. The first update prompt was dismissed while cancellable. The installed
   build and process remained unchanged, and a second manual check rediscovered
   the same strictly newer candidate.
3. The signed `1004` predecessor then discovered signed `1005`, downloaded it,
   reached Sparkle's **Ready to Install** state, and accepted **Install and
   Relaunch**.
4. The installed bundle changed from build `1004` to `1005`; the TiboTattle
   process identity changed; the only running product executable remained
   `/Applications/TiboTattle.app/Contents/MacOS/TiboTattle`.
5. The relaunched app passed strict code-signature verification, notarized
   Developer ID Gatekeeper assessment, and stapled-ticket validation.
6. The existing local allowance, indexed history, settings, and dashboard
   state remained available after relaunch.
7. A manual check from build `1005` displayed **You're up to date**. After the
   dialog closed, About continued to display **Up to date** rather than the
   former false **Update unavailable** state.

The independent bounded HTTPS observer also passed central health/readiness,
single-candidate appcast structure, exact enclosure URL, streamed artifact byte
count, and SHA-256 readback. Its JSON receipt remains owner-local under the
ignored release-build directory; remote readback alone was not counted as the
installed-client proof above.

## Recovery and remaining release boundary

- The pre-rehearsal installed-app backup remains recoverable at
  `/Applications/TiboTattle.app.backup-2026-08-05T18-09-37-321Z` until owner
  testing is complete.
- Previously published dogfood artifacts remain immutable; a defect is fixed
  forward with a strictly newer dogfood build rather than by deleting objects
  or lowering the feed version.
- The stable appcast was rechecked after dogfood publication and remained HTTP
  404. No stable artifact, feed, production intake, or public-release mutation
  was made.
- The bounded release-readiness probe passed the dogfood appcast readback but
  observed the shared central service in `open` enrollment with `operational`
  collection controls. The stable release policy requires disabled enrollment
  and contained collection, so this is an explicit stable-release blocker; it
  does not invalidate the isolated updater rehearsal above.
- A real provider-authentication pass and native accessibility/visual review
  remain owner dogfood checks before this candidate can inform a closed beta or
  stable release.
