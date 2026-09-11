---
title: Automatic native-to-Electron replacement upgrade
date: 2026-09-10
type: plan
status: in-progress
---

The user requires an ordinary replacement install: download, replace the app,
open it, and continue with existing history and settings. The released 0.1.19
manual predecessor-backup procedure does not meet that requirement.

## Acceptance

- First launch recognizes supported retained native data even when the old app
  bundle has already been replaced. No folder creation or app-copy task for users.
- Preserve original history, identity salt, credentials, contribution choices,
  appearance/language/tray settings and startup preference. Automatically back up
  and transactionally import data; interrupted imports resume without duplicates.
- Keep current signed-app/helper and filesystem verification. Do not invent a
  missing predecessor's version or signing evidence. Unknown data formats remain
  recoverable and cannot silently become an empty profile.
- Prevent the retired process/login item writing concurrently. Never terminate
  unrelated applications or broaden Keychain access.
- Verify the replacement journey with signed installed bytes and synthetic
  retained data, then restart and verify continued history and credentials.
- Publish corrected installers and matching website/Homebrew behavior only after
  the replacement path is verified. Version 0.1.19 is immutable; use a patch release.

## Work

1. Implement explicit retained-state migration plus native helper support.
2. Focused recovery, compatibility, identity and first-launch tests; independent
   review of the changed security and lifecycle boundaries.
3. Build/sign and rehearse ordinary replacement for Mac architectures using the
   existing qualification tools; preserve exact artifact/source evidence.
4. Publish the patch and align download/migration copy and Homebrew channel.

## Current evidence

Implementation in progress on the Electron release lineage, based on 0941dcbb.
Existing production app source is 178315c4; native repository main does not yet
contain the Electron implementation. No release or production state changed by
this repair as of this entry.
