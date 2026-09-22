---
title: Opt-in crash capture and support doctor
date: 2026-09-21
type: decision-record
status: current
---

# Opt-in crash capture and support doctor

The Electron **Show diagnostics** action is the small support doctor. It displays
the closed, content-free diagnostics projection before offering copy or a
prefilled GitHub issue. Opening the issue form is a deliberate action; the user
can edit it before submitting. The issue body contains no raw crash report,
dump, private path, account identifier, session content, or native error text.
The GitHub issue form is an external destination, so even its URL may be logged
by GitHub when opened. Do not add automatic submission or a second support
ingest route under this decision.

On macOS, native Electron crash capture is separately opt-in and defaults off.
Its owner-only preference is independent of contribution sharing. A stored opt-in
starts Electron's Crashpad reporter during early main-process bootstrap with
`uploadToServer: false` and no submit URL. Dumps may contain process memory and
private data; they stay in Electron's local Crashpad directory and are never
attached to the doctor or uploaded by TiboTattle. The doctor can open that
directory for manual review. Preference changes take effect on the next launch,
because Electron cannot stop an already-started reporter. A corrupt or
unavailable preference fails closed. Other platforms do not offer this capture
path yet.

This captures crashes only after the reporter starts and does not diagnose
every failure that prevents app startup. For a macOS launch failure, Apple
Console → Crash Reports remains the fallback; share only reviewed exception
type, termination reason, and crashed-thread top frames. Source tests validate
the preference and projection boundaries. Packaged, installed, signed-release,
and updater behavior require separate evidence.
