---
title: Admin monitoring component review
date: 2026-09-21
type: review
status: reviewed
---

# Admin monitoring component review

Initially reviewed every owner-dashboard section based on `9385bad2`,
including the existing native/Electron version-matrix changes. Source contracts,
current read-only production rendering and local fixture rendering were inspected.
Changes are local; this is not a deployment, uptime or release-readiness receipt.

The patch was then integrated onto current `main` (`8a340061`). Read-only
production health reported source `0fb6a5e6`, verified as an ancestor of that base.
The integration preserves typed v1/v1.1 counting, historical publication and
graph-preview readiness, schema-v3 graph rebuild progress, and operational
readiness. Overview v0.5 explicitly identifies the storage mode rather than reusing
production’s typed-only v0.4 identifier. No production control was changed.

## Component coverage

| Step | Component | Outcome and monitoring value |
|---|---|---|
| 1 | Header, refresh and browser alerts | Added section navigation, clearer service-snapshot wording and compact toolbar alignment. Explained that hidden/offline tabs pause automatic refresh. Initial source loading cannot emit incident notifications. |
| 2 | Attention summary | Independent history, allowance and progress failures now prevent an all-clear. Previous evidence remains visible after transient failures. Added explicit warnings for successful evidence more than 24 hours behind the service snapshot; this is a review threshold, not a cache expiry. |
| 3 | Contributors and accepted uploads | Replaced person/account approval claims with pseudonymous contributor identity labels. Explained retained totals and bounded counts. Counts follow the active storage mode; typed storage retains v1/v1.1 upload-header semantics. |
| 4 | Growth and activity | Marked legacy sign-in/pairing/consent metrics; separated retained totals from recent UTC-day charts. DMG changes compare recorded sampled days, without filling missing download observations. Missing comparisons remain unavailable. Preserved the producer’s sparse current-plan count map, including zero current contributors for a historical median-only plan. |
| 5 | Upload storage safety | Confirmed grace-period and reconciliation semantics. Fixed history classification of v1.1-referenced objects to match the overview; this does not activate v1.1 ingestion. |
| 6 | App activity, versions and releases | Retained native/Electron-by-OS matrix. Added missing Intel native artifact traffic. Explained overlapping address reach, capped version lists, 24-hour headlines, DMG-only GitHub coverage and the difference between a GitHub tag match and per-platform update compliance. Qualified badges for sampled/bounded/failed-sync sources. |
| 7 | Allowance and graph reconstruction | Added calculated-at evidence, estimator limitations and previous-preview warnings. Existing mode/range, sparse-estimate and progress contracts remain. Access refusal clears the graph and its freshness caption. |
| 8 | Collection controls | Explained stage effects. Preserved unsaved choices across refreshes and their original revision; conflicting revisions require discard/review. Actions are disabled before a usable overview and after read failure or owner refusal. Captured form data before disabling controls. |
| 9 | Maintenance | Distinguished completed, incomplete, already-running and unrecognized results. Ordinary maintenance is explicitly separate from participant erasure. Existing audit presentation is reused. |
| 10 | Ingress and operational readiness | Added admission-capacity and incomplete-cycle warnings; retention completion older than the service's two-hour policy is flagged. Preserved weekly and daily query bounds. Added retention completion time and readable snapshot dates/layout. Clarified that this panel is not an authoritative `/ready` probe. |
| 11 | Sampled service failures | Clarified retained sample counts and cross-platform local diagnostics. Attention uses recent 5xx groups instead of claiming an exact count from the newest 20 events. Absence of retained failures is not an uptime guarantee. |
| 12 | Recent control actions | Retained bounded newest-first pagination, escaped technical fields and explanatory outcomes. Already-running maintenance is no longer described as completed. |

## Evidence and validation

The original audit results below describe the pre-integration checkout. Final
integration checks and the review/merge outcome are recorded in the pull request.

- Live owner page inspected read-only, including current aggregate labels,
  freshness, readiness and graph controls. No remote mutation was exercised.
- Local preview used clearly marked synthetic fixtures; production data was not
  introduced into tests. Desktop rendered inspection covered all twelve steps.
- Browser interactions verified section navigation, allowance mode switching,
  draft-change/refresh/discard, source-refresh failure with retained graphs, and
  subsequent source recovery. Page identity, meaningful content and console
  state were inspected. Deliberate source failures returned expected 503s.
- Reliable screenshots were captured at the native in-app desktop viewport
  (962 by 541 CSS pixels). Mobile emulation exercised a narrow DOM layout but
  produced unreliable scaled/tiled screenshots; those captures were rejected.
  Physical mobile, screen-reader and notification-delivery qualification remain
  unverified. Keyboard behavior and graph focus have automated regression tests.
- Root product UI suite: 736 tests passed. Focused Worker analytics, metrics
  history, admin access and reconstruction suites: 52 tests passed. Worker
  TypeScript passed. Generated admin assets and repository preflight passed.
- The complete Worker gate is not green: its package, endpoint, type and script
  checks passed, but its broad suite reproduced the existing
  date-sensitive metrics-history test failure, where an August 21 snapshot falls
  outside the rolling 30-day window on September 21. The run then stopped
  producing output and was interrupted; deployment dry runs were not reached.
  An earlier script-gate attempt failed in local migration setup; an isolated
  migration reproduction and the final script gate succeeded. These do not
  establish a production deployment failure.

## Remaining boundaries

The open browser is a convenience monitor, not unattended alerting. Browser/OS
notification permission and delivery were not changed or certified. GitHub DMG
counters cannot supply Windows/Linux installer adoption or a Homebrew-only
history. Existing Electron installations without a product-version header remain
unknown; future released clients must carry the updater change. Source, live
service, deployed UI and released Electron clients are separate gates.

Maintained operating guidance is in the
[production operations runbook](../runbooks/production-operations.md).
