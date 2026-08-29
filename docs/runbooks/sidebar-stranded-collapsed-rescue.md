---
title: Rescue a stranded collapsed dashboard sidebar
date: 2026-08-22
type: runbook
status: active
---

# Rescue: the dashboard sidebar is collapsed and will not come back

Applies to the published TiboTattle **0.1.16 and earlier**. The reviewed source
after 0.1.16 carries the fix described at the bottom, but as of 2026-08-27 no
0.1.17 stable artifact has been published. Installed 0.1.16 users need the
manual rescue below until a fixed release is actually available.

## What the person sees

The dashboard window opens with the report content flush against the left edge
and no sidebar: no Overview, Usage, Trends, or Community rows, and therefore no
way to change page. Quitting and reopening does not help. Reinstalling does not
help either.

## Why it happens

The sidebar is a real `NSSplitViewItem` with `canCollapse = true`, so dragging
its divider to the leading edge collapses it — normal Mac behaviour. Three
things then combine into a trap:

1. The split view's `autosaveName` persists the collapsed state, so it survives
   quit, relaunch, and reinstall (the state lives in user defaults, not in the
   app bundle).
2. A collapsed pane leaves no divider to drag back.
3. Builds through 0.1.16 shipped **no** toolbar item, menu command, or key
   equivalent that could reopen it.

With all navigation living in that sidebar — the web report hides its own
sidebar when running inside the app — the window is left with no way to
navigate and no way back.

## The rescue (works on the build they already have)

The persisted geometry is a single user-defaults key. Deleting it discards the
collapsed state; the next launch lays the sidebar out fresh.

### Update after a fixed release is published

The source intended for 0.1.17 reopens a stranded sidebar once on first launch
and then carries a toolbar button and a ⌃⌘S menu command. Do not direct users
to update until the public release and appcast actually advertise a fixed
version. On the currently published 0.1.16 release, use the steps below.

### Manual rescue, step by step

The commands run in **Terminal**, the app built into macOS. To open it: press
⌘Space, type `Terminal`, press Return (or find it in Finder under
Applications → Utilities → Terminal).

**Order matters. Quit the app first.** A running TiboTattle holds its own copy
of these settings and rewrites them when it quits, which would put the
collapsed state straight back. So:

1. **Quit TiboTattle completely** — ⌘Q, or right-click its Dock icon and
   choose Quit. If the window is unusable, use Force Quit (⌥⌘Esc). Also quit
   it from the menu-bar icon if it is running there.
2. Open Terminal.
3. Paste this line and press Return. It prints nothing when it works:

```bash
defaults delete com.usagemonitor.local "NSSplitView Subview Frames com.usagemonitor.local.dashboard-split.v1"
```

4. Reopen TiboTattle. The sidebar is back.

If step 3 prints `does not exist`, the setting was already cleared — carry on
to step 4 anyway.

That restores the sidebar at its minimum width (about 188pt), because the
one-time width seeding has already run. To have it reopen at the designed
216pt instead, run this as well, still before reopening the app:

```bash
defaults delete com.usagemonitor.local "tibotattle.dashboard-split-seeded.v1"
```

Neither command touches usage data, cached analysis, sign-in state, device
credentials, or settings. Both only discard window geometry.

### Verified

Measured against a real build on 2026-08-22, driving the packaged app's chrome
smoke with a forged collapsed autosave:

| state | result |
|---|---|
| collapsed geometry persisted | report pane at x=0, sidebar out of layout — reproduces the report |
| after deleting the autosave key | sidebar restored, 188pt |
| after deleting both keys | sidebar restored at the designed 216pt |

## The source fix intended for 0.1.17

Three changes, so this state is neither reachable-without-recovery nor sticky:

- **Toolbar**: the system `.toggleSidebar` item, in both the default and
  allowed identifier sets. AppKit owns its icon and its Hide/Show label.
- **View menu**: a *Hide/Show Sidebar* command on the standard ⌃⌘S key
  equivalent, dispatched down the responder chain so it reaches whichever
  dashboard window is key. Its title is rewritten by the chrome's
  `validateUserInterfaceItem`.
- **One-time rescue**: on the first launch of a build that can undo a collapse,
  an already-stranded sidebar is reopened once and a marker is recorded. After
  that a deliberate collapse is respected, because it is now reversible. The
  rescue deliberately runs *before* the width-seeding early return — every
  already-installed user has the seeding marker set, which is precisely the
  population that can be stranded.

`--native-dashboard-sidebar-recovery-smoke-test` on the packaged binary drives
all of it against real chrome: collapse, reopen through the same action the
toolbar and menu send, the enforced minimum width on return, the menu title
flip, the one-time rescue, and that a later deliberate collapse is left alone.

## General rule

Any pane that can be collapsed needs a way back that does **not** live inside
that pane. A divider is not an affordance once it is gone.
