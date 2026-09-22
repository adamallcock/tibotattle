---
title: Development allowance forecast recovery
date: 2026-09-13
type: plan
status: implemented
---

Restore a useful development-app handoff with observed allowance animation,
pacing, and the merged cache matrix, using a separate private history profile.

Acceptance:

- Identify the exact running development artifact and retained-data state.
- Keep stale observations explicit, with no inferred rate or animated discharge.
- Show why pacing is waiting instead of silently removing the forecast panel.
- Restore fresh allowance collection and complete the history projection.
- Verify the forecast, animation, and cache model picker in the packaged app.

Validation proceeds from focused synthetic tests to the web surface gate,
development packaging, and inspection with the private real-history copy.
This task does not qualify signing, updater publication, or a public release.

Diagnosis: the restricted macOS QA lane deliberately disables the production
account-observation credential. Its fresh quota percentages are therefore
unattributed and cannot support a forecast. Stale observations also freeze
the tanks by design.

The interactive handoff opts into an independent, owner-only 32-byte pacing key
alongside its development export identity. Automated QA keeps its default
credential bypass. Production paths do not accept the override, invalid files
fail closed, and existing history is never relabeled. A new local pacing track
requires fresh comparable readings and measured quota movement.

Source validation: browser surface (836), local companion surface (360),
development account/refresh/Electron tests (276), and private profile tests (10)
passed. Architecture and preflight checks passed. Development packaging and
real-history inspection are separate handoff steps bound to the resulting
artifact; this source record does not assert a released or installed build.
