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
every failure that prevents app startup. The source checkout now has a separate
read-only macOS command, `npm run diagnose:desktop-crash`, which runs under Node
without starting Electron. It reads recent Apple crash reports through a bounded
allowlist, and inspects the local capture preference and dump counts without
reading dump bytes. It never changes preferences or sends data. Reports it cannot
parse stay unavailable; the user can inspect them in Console and share only
reviewed exception type, termination reason, and crashed-thread top frames.
An explicit `--verbose` mode expands the local result to at most 20 safe symbol
tokens per crashed thread and at most 40 recent, revalidated companion
diagnostic notes per profile, including fixed status codes and support references.
It still excludes raw Apple report text, Crashpad memory dumps, native free-form
messages, and private paths. No mode automatically sends output.
The separate `--export-private` mode is an explicit owner action that creates a
new owner-only local directory outside the source checkout. It copies bounded,
matching original Apple reports and companion diagnostic log generations under
fixed names, with a content-free hash manifest. `--include-dumps` is a second
explicit choice for up to four local Crashpad dumps; total copied bytes are
capped. The directory is never attached, projected into ordinary diagnostics,
or transmitted by TiboTattle. Raw contents may contain paths and process memory;
the owner must review them and choose a private handoff with the maintainer.
Public issues continue to receive only reviewed summary text.
This source command does not make the in-app doctor available during a launch
crash, and it is not an installed-app feature. Source tests validate the
preference and projection boundaries. Packaged, installed, signed-release, and
updater behavior require separate evidence.
