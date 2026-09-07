---
title: Actual plan values and admin graph parity
date: 2026-09-07
type: plan
status: locally-validated-awaiting-deployment
---

# Actual plan values and admin graph parity

Base: clean `44c763e2`, verified deployed presentation source `3f82d9ac`.
Keep pricing, contribution consent, database schema, backfill and installers
unchanged. The public/private data boundary remains closed.

- Keep chart lines and primary card amounts on the comparable Pro 20x weekly
  basis. Add a secondary, explicitly labelled weekly API-equivalent estimate
  for the actual plan: Pro 20x divides by 1, Pro 5x by 4, Plus by 20. Do not
  confuse this with the subscription price, round before conversion, or replace
  unknown estimates with zero. Use the same conversion in public and admin.
- Bring the admin allowance views into parity with the public cards: requested
  model order, compact themed cards/icons, fitted All-history dates, restrained
  markers and selectable legend focus. Preserve admin-only coverage, model
  visibility controls, date windows, diagnostic detail and source semantics.
- The existing website/admin SVG renderers own this comparison, not a new
  report runtime. Keep zero-based comparable dollar scales, real calendar gaps,
  visible units, dates and sample counts. Only the small secondary plan value
  changes denominator; never silently rescale the chart.
- Verify conversion examples/unknowns, ordering, shared presentation and asset
  dependency closure with focused tests, then owning web/Worker/release gates.
  Inspect public real-data preview and safe admin preview, desktop and narrow
  screens; verify both live surfaces after the normal guarded deployment.

Local qualification: 545 web tests, 36 release/preview tests, 20 preflight tests,
architecture and documentation checks pass. The six focused admin asset/mirror
tests pass. Chrome confirms the live-data public captions ($479 Pro 5x, $113
Plus), Spanish text and phone-width cards. Synthetic admin Chrome checks confirm
shared themes/order, actual-plan captions, read-only filters, restored focus,
all-point keyboard inspection and readable responsive axes. Desktop/mobile
emulation was restored. Full Worker/dry deployment and exact live proof remain
pending; no production write has occurred in this change yet.
