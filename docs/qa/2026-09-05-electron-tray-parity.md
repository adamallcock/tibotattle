---
title: Electron tray and native Mac presentation parity
date: 2026-09-05
type: review
status: in-progress
---

# Scope and evidence boundary

Follow-up to the owner's side-by-side screenshots of the Electron and native
Mac tray. Work starts from packaged Electron commit `f71d121d` in an isolated
worktree; unfinished accountless integration remains in its original worktree.

The native `MenuBarPopover.swift` and `MenuBarStatus.swift` reference matches
the 0.1.18 release worktree. This work targets the compact native hierarchy,
coverage styling, truthful quota display and crisp menu-bar template image.
It does not authorize contribution activation, shared-profile mutation,
system-app replacement, signing or public release.

## Acceptance

- A 400-point popup fits its natural content and stays inside the display.
- Header contains product name, relative freshness and More; footer contains
  Open and Refresh with the API-equivalent billing disclosure.
- Allowance and Local usage match native hierarchy; unavailable weekly pace
  does not create an empty section; partial and unavailable history are clear.
- Both 7-day and 30-day controls, More, Open, Refresh, Escape and dismissal work.
- Template image supplies correctly scaled 1x and 2x representations.
- A valid direct primary quota, including zero remaining, can display without
  notification-qualified identity evidence. Stale, expired and missing quota
  never becomes zero, and notification authority remains unchanged.
- Final evidence distinguishes unit/browser checks from a freshly packaged
  Mac app, copied-profile inspection, other physical OSes and release gates.

## Findings and implementation

The previous popup used a separate oversized heading and fixed 408 by 720
window. It styled partial bars orange instead of native teal hatching. The
template image ended at 16 pixels with only a 1x representation. Desktop status
also depended on a completed notification-qualified refresh receipt instead
of the current published quota already visible in the native popup.

The new bounded content-height bridge accepts only a positive integer from
the committed popup's main frame. Main clamps the preferred height and work
area, without reopening or focusing a hidden popup. Focused window and
preload tests pass (8/8), including invalid senders, malformed sizes, work-area
caps and restoration on a larger display.

The renderer now follows native typography, spacing, segmented controls and
proportional hatched bars. Valid current Weekly Pace remains available. The
dynamic icon reuses the reviewed bird artwork with live remaining meter,
analyzing dots and an outlined stale/unavailable meter; unchanged polls reuse
the previous image. The display-only quota projection reads a frozen two-lane
cache and cannot create notification evidence.

Integrated Electron (367), web (537), local companion (312) and focused
status/snapshot/runtime/API (53) tests passed during integration. Architecture,
documentation, i18n mirror and preflight checks also passed. Final native-size
CSS corrections and strict popup duplicate/invalid-lane selection receive
their focused checks before packaging.

## Packaged checks

Source `250be5b956041611ee8084de0493576a10175906` built a verified unsigned
darwin-arm64 directory package. Its ASAR digest is
`95f221281b803f30478516f90a3d11a912ba40021921844df565ac8d0ec79ad2`.
All four development packaging jobs and retained artifacts passed for that
exact source: [Actions run 33971482768](https://github.com/adamallcock/tibotattle/actions/runs/33971482768).

Actual Mac inspection used a durable private SQLite backup with the matching
device salt and no hosted contribution origin. A local detailed refresh
completed and clean relaunch preserved the derived history. The 400-point
popup rendered both 7-day and 30-day charts with proportional teal hatching,
coverage counts, partial-pricing disclosure and both footer actions visible.
Range switching, More, Open and Escape passed native UI checks. More replaced
the popup with the context menu instead of displaying both overlays.

The first durable copy used Node's default symlink rewriting and failed to
launch. The rejected copy was preserved; recopying with `verbatimSymlinks`
retained all 14 relative framework links. The corrected copy launched and
exited cleanly. Copying an ASAR digest alone does not qualify a Mac bundle.

The interaction correction consumes main-process Refresh availability while
starting/analyzing. Its first package exposed an existing missing initial
model delivery: the controller only sent subsequent status changes. The
controller now sends its current model before each presentation; initial and
reopen ordering are covered by regression assertions. A new package check is
required before final handoff.

An actual Electron 43.2.0 NativeImage probe verified the unchanged icon
factory against its exact source hash and the packaged ASAR asset. Live
0/50/100, analyzing and stale states all produced nonempty 16-point template
images with scale factors 1 and 2 and valid 32-pixel PNG exports. This proves
runtime image generation, separately from the rendered popup checks.
Physical Windows, Linux and Intel desktop behavior,
automatic contribution activation, signing and publication remain separate
gates; four successful package builds do not close those gates.
