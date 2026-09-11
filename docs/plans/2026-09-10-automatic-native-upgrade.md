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

### Signed qualification, 2026-09-11

Application source `754fa1bbee6176c85ed96272b3582686f37a44d9` is packaged
as 0.1.20 / build 2026091101. Both Mac architectures are signed and notarized;
Linux packaging passed. Windows signed installation is being retried after an
initial installer timeout, before app launch.

The first signed Mac replacement run (34550480600) failed during first launch.
Run 34551085835 narrowed this to the transfer helper: migration remained at the
`started` checkpoint, before a data copy. Owned processes were stopped; no success
claim is made. Run 34551358882 adds a fixed, read-only helper preflight diagnostic
from the authenticated signed Electron parent on the disposable synthetic host.
Runner diagnostics are separate commits; the signed application bytes are unchanged.

Website and Homebrew 0.1.20 changes are prepared but unpublished. Stable 0.1.19
and its accurate manual migration warning remain in place until replacement is
verified. Final publication staging is under
`.release-build/stable020-publication-20260911` (local, ignored evidence).

The signed support-code build `9971e656` (run 34552482636) identified
`TRANSFER_LOGIN_ITEM_NOT_FOUND`: the embedded helper could not query the main-app
startup service. Startup snapshot, disabling and verification now belong to the
actual Electron main process. The helper authenticates/stops the retired writer
and reads native preferences; it cannot claim to own or disable a login item.
The repaired boundary passes 91 focused JS tests and 10 compiled helper tests.
A new signed installed rehearsal remains required.

Windows diagnostic run 34552043838 showed the frozen signed installer completing
successfully in approximately 196 seconds, beyond the old 180-second harness
budget. The bounded budget is now 300 seconds; the full signed installed journey
is rerunning without re-signing or weakening correctness assertions.

The 7fc6f0ef signed rehearsal (34553531272) still reports
`TRANSFER_LOGIN_ITEM_NOT_FOUND` from the actual main-app API. The initial helper
location explanation alone was therefore insufficient. Its boundary fix and
crash-safe snapshot remain valid improvements, but are not installed success.
Run 34553921574 separately tests LaunchServices registration of the copied bundle
before launch. No unavailable startup state has been reclassified as success and
no public installer/feed/site has changed.

The LaunchServices registration run also failed at the same unchanged checkpoint.
Apple DTS documents that a valid, unseen service can report `notFound`; Electron
then derives `openAtLogin: false` from that status rather than a separate setting.
See https://developer.apple.com/forums/thread/719862 and Electron 43.2.0's
`shell/browser/browser_mac.mm` implementation. We therefore preserve unknown or
approval-pending startup registration without OS writes while allowing authenticated,
writer-stopped, journaled data import. The durable original startup snapshot is
nullable; retries retain that untouched decision, and completion records a distinct
`electron_login_preserved` phase rather than claiming ownership. The ordinary
settings UI continues to read actual OS status; the stored default is never applied
at launch. Known startup choices retain snapshot-before-disable and verified restore.
Signed installed proof of this updated contract remains required before publication.
