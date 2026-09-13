---
title: Animated allowance tanks
date: 2026-09-13
type: plan
status: complete
---

Implement the approved glass tanks and animated basin in the existing allowance
Overview. Keep percentage, source freshness, reset timestamps and the shared
forecast authoritative. Only a matching fresh Codex weekly pool receives flow,
using the existing forecast standing; no new forecast or ledger is calculated.

Use a local canvas renderer with no added dependency or network access. Retain
text and static fill when canvas is unavailable, stop animation while hidden or
offscreen, respect reduced motion, provide a pause control, and dispose resources
on dashboard refresh. Support one through many windows without fixed plan rules.

Acceptance: focused lifecycle and evidence tests, full web tests, localization,
architecture and documentation checks; inspect real local data and representative
widths in the browser. Commit on the existing isolated allowance branch. Source
and browser evidence do not establish an installed or released desktop artifact.


Implemented on the isolated allowance branch after e608ddc9. The renderer uses
one shared frame loop capped at 30 draws/second and device pixel ratio capped at
2. Rendered flow saturates at 5x for bounded animation; the textual forecast
retains its actual ratio. Refresh disposes canvases, observers and event handlers.
The client export includes both modules; the desktop import graph collects them.
Public release builds explicitly exclude them.

Validation on 2026-09-13:

- 738 web tests passed, including matching-pool rejection, unavailable/zero/stale
  evidence, bounded rendering and frame-loop pause/disposal checks.
- 29 distribution tests passed, including the actual desktop module graph and
  client export, and public-release exclusion checks.
- Architecture, documentation governance, preflight and browser catalog checks
  passed. No new runtime dependency was added.
- Read-only browser preview used real local allowance and forecast data. Verified
  crimson flow only for the matching Codex pool, idle separate pools, changing
  visible canvas pixels and identical paused pixels. Verified reduced-motion
  static rendering, dark palette, one control group after language changes, and
  Spanish at a 323 CSS-pixel viewport without horizontal overflow.
- The preview refuses mutations and therefore displays an existing analysis-start
  notice; no refresh or private evidence mutation was performed. Installed app,
  signing, release, deployment and remote publication remain unqualified.

Follow-up refinement: replace the labelled motion toolbar with an accessible
pause icon and silently hide it for reduced motion. Remove the explanatory UI
line, use the shared Spark icon and full model name, draw five-hour vessels at
40% width, and animate a sheen inside the fixed forecast coverage bar. The same
pause, reduced-motion and visibility policy governs the bar. Narrow width is a
visual convention, not a capacity estimate.

Follow-up validation: 740 web tests passed. Browser checks confirmed the 40%
vessel geometry, full Spark labels with the shared icon colour, hidden controls
and no explanatory copy under reduced motion, and a changing forecast sheen
with an unchanged coverage width. The discreet pause control stopped both.
