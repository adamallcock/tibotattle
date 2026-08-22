# Rescue: the dashboard sidebar is collapsed and will not come back

Applies to TiboTattle **0.1.16 and earlier**. Builds after that carry the fix
described at the bottom and need none of this.

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

```bash
defaults delete com.usagemonitor.local "NSSplitView Subview Frames com.usagemonitor.local.dashboard-split.v1"
```

Then quit TiboTattle completely (⌘Q, or Force Quit if the window is unusable)
and reopen it. The sidebar comes back.

Deleting only that key restores the sidebar at its minimum width (about 188pt)
because the one-time width seeding has already run. To have it reopen at the
designed 216pt instead, delete the seeding marker as well before relaunching:

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

## The fix (0.1.17 and later)

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
