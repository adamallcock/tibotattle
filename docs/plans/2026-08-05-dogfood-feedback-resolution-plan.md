---
title: TiboTattle dogfood feedback resolution
date: 2026-08-05
type: plan
status: implemented-awaiting-live-qa
---

# Objective

Resolve the 36 dogfood callouts from the installed internal build without
weakening accounting correctness, privacy boundaries, or release safety. The
shipped macOS bundle and its rendered local report are the acceptance surface;
source-only tests are necessary but not sufficient.

# Bounded execution rule

Work each lane to a verified stopping point. A failed approach may be retried
once after the cause is understood. If an item then depends on unavailable
provider evidence, owner credentials, or a destructive/external action, record
the exact blocker and requested next action, finish every independent item, and
stop. Do not create replacement tasks, branches, or worktrees merely to keep
the goal active.

# Lanes

1. **Native shell and settings**: coherent native settings sections, honest
   updater/login-item/notification state, refresh controls, status toolbar,
   navigation reliability, and companion lifecycle.
2. **Accounting and history truth**: event-time price epochs, unpriced model
   evidence, index completeness, fit semantics, residual classification, and
   complete history ranges.
3. **Report and charts**: remove obsolete/noisy material; make every chart
   legible, keyboard accessible, hoverable, non-selecting while dragged, and
   locale-aware.
4. **Community contribution**: repair the signed-in submission path, simplify
   copy, and consolidate privacy explanation into the contribution journey.
5. **Packaged verification**: focused tests first, broader contracts second,
   then install a fresh signed dogfood successor and inspect every affected
   page and interaction.

# Numbered acceptance matrix

| # | Required outcome | Acceptance evidence | Status |
|---:|---|---|---|
| 1 | Language setting uses one short supporting sentence. | Native screenshot and localization tests. | Implemented; localization verified; screenshot blocked by locked Mac. |
| 2 | General description accurately describes foreground/background refresh and local-data boundaries. | Source contract plus native screenshot. | Implemented and source-verified; screenshot blocked by locked Mac. |
| 3 | Launch-at-login and notification permission follow native guided flows with actionable status. | Packaged app manual flow plus deterministic state tests. | Implemented with direct System Settings recovery; manual OS flow pending. |
| 4 | Reset notification is either enabled from a true provider reset identity or omitted; no confusing dead control. | Receipt-shape proof and native state test. | Verified: dead control removed; schedule-only receipts cannot alert. |
| 5 | Settings are divided into coherent icon-labelled native sections inspired by platform conventions. | Native screenshot at normal and narrow sizes. | Implemented; packaged visual QA blocked by locked Mac. |
| 6 | Refresh cadence has a safe persisted UI stub, clearly marked if scheduling is not yet active. | Preference round-trip and UI test. | Verified: bounded 1/5/15/30-minute preference drives foreground scheduling. |
| 7 | Obsolete section 5 is removed from navigation, markup, localization, and tests. | DOM/navigation assertion. | Verified by DOM and navigation tests. |
| 8 | “Account unattributed” is replaced with plain, actionable language or omitted when immaterial. | Fixture rendering assertion. | Verified: immaterial account attribution is omitted. |
| 9 | Price summary removes `+ unpriced` when zero, reduces provenance noise, and distinguishes pricing coverage from index progress. | 7d/30d fixture screenshots and tests. | Verified in source and period-coverage fixtures; visual QA pending. |
| 10 | Fit-unavailable states explain the exact evidence threshold; observed versus cost-implied movement has a plain-language interpretation. | Positive and insufficient-evidence fixtures. | Verified in positive and insufficient-evidence render fixtures. |
| 11 | Every event is priced by the rate card effective at its event time, including the late-July 2026 boundary. | Boundary fixtures on both sides and aggregate parity test. | Verified by 61 local pricing/calibration tests and 14 Worker pricing tests. |
| 12 | Unknown/unpriced overflow records are identified by safe model/reason metadata and represented honestly. | Local diagnostic summary without content or identifiers. | Verified: Spark is a bounded known-unpriced row; arbitrary labels collapse to unknown. |
| 13 | Signed-in contribution review and upload work against the configured dogfood service or expose a precise recoverable error. | Google flow plus request/response diagnostic and Worker/local tests. | Implemented and locally verified; live upload intentionally awaits owner review/consent. |
| 14 | Community is the single contribution/privacy journey; redundant Data & Privacy navigation is removed. | Navigation and contribution-page screenshot. | Verified in native destinations and web navigation; screenshot pending. |
| 15 | Remove the contributed-data deletion sentence. | Copy assertion. | Verified by copy assertion. |
| 16 | Contribution copy is materially shorter without weakening consent or data-boundary disclosure. | Before/after word count and screenshot. | Implemented and copy-tested; screenshot pending. |
| 17 | Trends navigation always switches page and focuses its heading. | Repeated navigation interaction test. | Verified by repeated navigation/focus tests; live repetition pending. |
| 18 | Minimum observed-span control is present, correctly bounded, and explains inclusion without misleading confidence language. | Slider boundary and filtering tests. | Verified; slider is capped at 99 percentage points. |
| 19 | Price-basis/provenance appears immediately below allowance history rather than before the primary reading. | DOM-order assertion. | Verified by DOM-order assertion. |
| 20 | Allowance-history points expose high-quality pointer hover and keyboard focus details. | Playwright hover/focus screenshot and accessibility assertion. | Implemented and interaction-tested; rendered hover screenshot pending. |
| 21 | Remove repeated-history and usage-increment headline tiles; retain only user-relevant accounting. | DOM absence and accounting parity test. | Verified by DOM absence and accounting parity. |
| 22 | Explain or repair the 7d 100% versus 30d 54% coverage difference from exact reason/model evidence. | Local 30d coverage audit and regression fixture. | Verified: older pre-registry activity is intentionally unpriced; period fixture added. |
| 23 | Updater state says “Up to date” when current and has one canonical home in Settings/About. | Fresh installed app manual check. | Implemented; canonical details are in About; installed-candidate check pending. |
| 24 | Toolbar combines freshness and refresh action with aligned label, relative observation age, progress, and failure state. | Native screenshots across states. | Implemented and source-tested; state screenshots pending. |
| 25 | Overview never renders all report pages as one continuous document after repeated navigation/refresh. | Stress navigation test. | Verified by page isolation/navigation tests; live stress pending. |
| 26 | Sidebar uses a higher-fidelity native-looking presentation with clear selection, spacing, and icons. | Packaged light/dark screenshots and keyboard navigation. | Implemented; light/dark packaged visual QA pending. |
| 27 | Companion does not flap unavailable during normal operation; lifecycle failures have precise recovery. | Repeated launch/refresh/idle stress test and logs. | Lifecycle/reload tests pass; live idle stress pending. |
| 28 | In-app companion failure state never gives website installation instructions; it offers relevant retry/restart diagnostics. | In-app failure fixture screenshot. | Verified in loopback failure fixture; screenshot pending. |
| 29 | Remove the overview subtitle about quota observations/API-price equivalent. | Copy assertion. | Verified by copy assertion. |
| 30 | User-selected ranges can reach all indexed history; no accidental 31-day ingestion or query ceiling. | >31-day fixture/query and local-data proof. | Deferred honestly: archive scan is resumable across all history, but visible accounting remains a reviewed 31-day cache and is now labelled as such. |
| 31 | Every plotted series has pointer hover and keyboard-focus data labels. | Shared chart interaction tests. | Implemented for all primary series and interaction-tested; rendered QA pending. |
| 32 | Timeline gets readable adaptive date/time ticks and no raw zone identifier axis title. | Wide/narrow screenshots. | Implemented with adaptive 3–7 rotated ticks; screenshots pending. |
| 33 | Time zones use a localized human label; timeline provenance boilerplate and repeated-history copy are removed. | Locale fixtures and DOM assertions. | Verified with Intl-based zone labels and DOM assertions. |
| 34 | Residual chart and exact-period table stack vertically rather than compete horizontally. | Responsive screenshot. | Implemented in responsive layout; screenshot pending. |
| 35 | Zero activity plus zero quota movement is classified as idle, not an estimator miss; gaps and true residuals remain distinct. | Deterministic idle/gap/residual fixtures. | Verified by deterministic idle/gap/residual fixtures. |
| 36 | Dragging charts does not select chart text or labels and preserves normal page selection elsewhere. | Pointer-drag interaction test. | Implemented with chart-scoped selection suppression; rendered drag QA pending. |

# Release gate

Completion requires: clean Git status; numbered disposition for all 36 items;
focused accounting/UI/native tests; architecture and documentation checks; a
fresh packaged dogfood successor installed in `/Applications`; and rendered
visual inspection. Any unverified owner-only sign-in or provider-data pathway
is reported as a blocker rather than marked complete.

# Verification snapshot

- Focused report, navigation, localization, and packaged macOS regressions:
  177/177 passed.
- Local service, contribution recovery, archive indexing, and refresh lifecycle:
  85/85 passed.
- Event-time pricing, registry boundaries, cache projection, and calibration:
  61/61 passed locally; Worker pricing 14/14 passed.
- Architecture boundaries, documentation links, browser localization mirror,
  preview build, and preview validation passed.
- Remaining blockers are bounded: the Mac is locked, so rendered interaction QA
  cannot run; a real contribution upload requires owner review and consent; and
  item 30 requires a separate archive-to-visible-accounting projection rather
  than relabelling a 31-day cache as unbounded.
