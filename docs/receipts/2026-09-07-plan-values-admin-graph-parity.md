---
title: Actual plan values and admin graph parity
date: 2026-09-07
type: receipt
status: deployed-live-data-qualification-blocked
---

# Actual plan values and admin graph parity

Published clean source `df5599707df189678079c15e683c18a7e0a5da1f` on
2026-09-07. Implementation: `2ae67c6d`; follow-up `df559970` corrects the
deployment snapshot test fixture. Base: `44c763e2`, previously deployed
presentation `3f82d9ac`. Source deployment and local rendering pass; restored
live plan/model rendering remains a separate, open cache-publication gate.

## Requested presentation

- Keep chart lines and primary card values on the common Pro 20x weekly basis.
  Public and admin plan cards add a small **This plan: …/week at API prices**
  caption. Divide the unrounded reference estimate by 1 for Pro 20x, 4 for
  Pro 5x and 20 for Plus; round only for display. These are API-equivalent
  allowance estimates, not subscription prices. Unknown stays unknown; zero
  remains zero. Models and aggregate do not acquire an actual-plan caption.
- Share compact cards, model themes/icons, colour mapping and requested order
  with admin: Astra, Sol, Terra, Luna, GPT-5.5, then other reviewed models.
  Preserve admin-only fit/coverage diagnostics and the full model catalog.
- Fit All-history date edges to the selected view's actual evidence, preserving
  internal calendar gaps and common zero-based dollar scales. Legends focus a
  series without rescaling. Thin dense markers visually, retaining every point
  for pointer/keyboard inspection. Admin axes now remain readable at narrow
  widths, and resizing preserves selections.
- The chart-design skill guided denominator labels, shared scales and real
  gaps. The frontend-testing skill guided responsive, keyboard, unavailable
  state and real-data preview checks. No new chart runtime or dependency was
  introduced.

## Qualification

- 545 web tests, 36 release/preview tests and 20 preflight tests passed.
  Architecture and documentation checks passed. Focused shared admin asset
  staging/generation tests passed, with generated admin sources current.
- All 802 Worker runtime tests, 202 deployment/operations tests, workspace
  guards, endpoint checks, generated types and TypeScript checks passed.
  Default, staging and production dry bundles passed.
- The first full operations suite correctly rejected a synthetic deployment
  snapshot missing `model-catalog.generated.js`, now a transitive admin import.
  Both relevant mock asset trees were updated. No guard, assertion or test was
  weakened; the corrected full suite passed.
- Chrome real-data public preview showed Pro 5x `$1,916` normalized and `$479`
  actual; Plus `$2,257` normalized and `$113` actual. Inline and expanded cards,
  Spanish captions and 390px-width layout passed without horizontal overflow.
- The isolated, explicitly labelled synthetic admin preview exercised actual
  values, shared model order/themes, all 39 catalog choices, focus restoration,
  every-point keyboard inspection, empty/unavailable states and responsive
  axes. At 390px the chart used matching 294px coordinates and readable labels;
  restoring desktop width retained the selected series. No console warnings or
  errors were observed in either preview. Only the temporary preview servers
  started for this task were stopped; temporary browser overrides were restored.

## Publication and independent live proof

The normal guarded wrapper returned `PRODUCTION_DEPLOYED`, no unapplied
migrations, healthy pre/post checks and public-only routing. No exception or
direct deployment bypass was used. Independent checks confirmed the exact
source, seven public asset hashes, five private routes denied on the public
host, unchanged architecture-specific 0.1.18 downloads, and the retained
1200x630 PNG social metadata/MIME/crawler policy. Public source-closure SHA-256:
`2b3153e31182e87bf40c7c95db785f666998b762ca79b341154da3295c6d1581`.

Authenticated Chrome loaded the new admin module and all shared dependencies,
including the model catalog, with HTTP 200 and no console errors. That proves
the deployed module graph, not rendering of currently unavailable live values.
No schema, telemetry, consent, pricing, estimator, scheduler, desktop installer
or updater change accompanied this presentation deployment.

## Separate live-data blocker

Before deployment, the admin route returned HTTP 503
`ADMIN_ALLOWANCE_CACHE_UNAVAILABLE` at 15:09 UTC. A singleton metadata read
confirmed generation at **13:05:41 UTC**, size **43,058 bytes**, below the 256KiB
limit. Its two-hour validity ended at **15:05:41 UTC**. Public plan/model
breakdowns are consequently withheld; the separate aggregate allowance and
all-token activity views remain available. The live checker intentionally
fails its breakdown-availability assertion; do not label this receipt a fully
restored live graph.

Bounded SELECT-only diagnosis reported zero rows written. All 15 uploading
heads had fit/model caches and input revisions, with no input/window mismatch
or pending current checkpoint. The latest inspected maintenance pass completed
at 15:22:40 UTC without a failure or retained lease. A natural scheduled
invocation at 15:24:35 UTC reported completed account analysis (15 visited,
none republished/resumed, 143 queries used at that stage), followed by
`ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE`. No maintenance was triggered manually.
This proves an aggregate-publication failure, not a database outage, missing
account-cache census, or a proven deadline/validation/root-cause diagnosis.

A final identifier-free size census also stayed within the separate publisher
limits: 23,651 total fit bytes (16MiB limit), maximum fit/model key lengths
438/446 bytes (512-byte limit), and maximum model payload 1,043 bytes (16KiB
limit). Size refusal is not supported by that observation.

The publisher shares scheduled budgets and requires valid complete inputs and
unchanged source state. The next step is to distinguish publication admission,
validation and budget refusal without extending freshness or rewriting cache
timestamps. Backend repair was raised separately with the owner because it
expands this small presentation request. Existing released evidence remains
immutable. Local logs use the `.release-build/plan-values-admin-` prefix.
