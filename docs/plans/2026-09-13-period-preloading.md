---
title: Preload standard dashboard periods
date: 2026-09-13
type: plan
status: completed
---

Implement period preloading from updated main, preserving unrelated worktrees.
The selected page and period take priority. Warm the other standard periods when
that page is visible, keep bounded process-local caches, and switch between ready
results immediately while refreshing in the background. Do not eagerly scan
hidden pages, persist browser measurement payloads, derive periods from rounded
chart summaries, or weaken scope/generation invalidation.

- Performance: reuse existing all-period backend snapshots and individual API;
  coalesce browser requests, preload the fixed three periods, preserve ready
  charts on transient failures, and cancel/fence pending work on hide or destroy.
- General dashboard: verify all standard periods already arrive in its shared
  data payload; retain local redraw without extra requests.
- Projects and threads: inspect and reuse its existing multi-period source cache
  and immutable snapshot contract before warming the period controls.
- Validate selected-first behavior, first switches after warming, races,
  invalidation, empty results, visibility and failure recovery. Run focused then
  full UI tests, relevant backend checks, and browser interaction QA.

No database migration, release, publication, or installation is part of this task.

Implementation uses the existing APIs and adds no dependencies. Performance
retains at most three ready period payloads, coalesces pending requests, and
revalidates warmed siblings after 60 seconds. Projects and threads retains at
most four first-page responses for one query family and source generation.
Sequential related-period queries preserve the selected server report within
the existing two-snapshot capacity. Cached values remain readable while a new
report validates; cached snapshot handles never enable drill-down by themselves.

Validation evidence:

- Local companion suite: 352 tests passed, including a real service/shared-reader
  regression proving one accounting projection and a two-snapshot maximum while
  warming all periods.
- Browser interaction: production Performance component and client with retained
  local measurements; first switches to all three periods and rapid switches kept
  charts visible. Production Projects and threads component with the real service
  and a synthetic fixture warmed all four periods, displayed the correct cached
  range immediately, disabled controls while validating, and restored working
  project expansion afterward. No browser warning or error was observed.
- UI suite: 749 tests passed, including 30 Performance and 43 Projects and
  threads assertions/subtests covering warming, late responses, deadlines,
  invalidation, pagination, hidden views, and teardown. A cached display cannot
  revive an invalidated server handle during recovery.
- Architecture, preflight and whitespace checks passed.

Browser evidence qualifies these component interactions in local development.
It does not qualify an installed desktop artifact or a release. Projects and
threads browser data was synthetic; retained real measurements were used only
for the Performance browser check.
