---
title: Consistent dashboard page headers
date: 2026-09-13
type: plan
status: implemented
---

Unify the shared Electron dashboard with sidebar-matching page titles, serif
36px headings, short localized descriptions, 32px outer spacing and 24px content
gaps. Reuse shared CSS and existing controls. Keep measurement qualifiers,
filter state, consent controls and unavailable states intact.

Overview uses one introduction and a keyboard-accessible setup disclosure that
collapses only when ready with results. Community has a page header outside its
sharing card. Charts retain their own headings and filters.

Validation: focused UI and locale checks, full web suite, preflight, and rendered
wide/narrow layouts. Verify a fresh Electron artifact if local packaging permits;
browser evidence alone does not qualify the installed app. No publishing or
system installation is part of this change.

## Validation evidence

- All 728 web tests pass, including setup disclosure recovery and all shipped
  header translations through the browser entrypoint.
- Browser mirror check passes. The preflight lane passes when invoked directly;
  the aggregate preflight command is blocked by the pre-existing tracked root
  file `design-qa.md`, which is outside this change.
- Reviewed browser rendering with live loopback overview, allowance, trends and
  performance data; Projects shows its unavailable state. Inspected responsive
  model headers in English, Spanish and Simplified Chinese. The temporary
  preview blocks all writes and only forwards allowlisted local GET requests.
- Unsigned development artifact built and verified from `98343db2f61692b2bdfdf2dd200fe6c47ce1672b`.
  ASAR SHA-256: `05bfa9515a9c36df0e7c169ff51f8b1beffd34820f6d256687357bd3ebd44935`.
- Packaged Electron diagnostic captures confirm all seven page headers use the
  same serif family, 36px size, and top/left coordinates (108px/237px at the
  tested window size). Reviewed Overview, Community, Model performance and
  Usage and costs captures; browser review additionally covered populated data.
  Local evidence is in `.release-build/header-layout-evidence.json` and
  `.release-build/header-<page>.png`. These use only the disposable synthetic
  smoke profile; the live browser preview was a separate read-only check.
- Corrected the smoke tool's stale five-page navigation assumption to require
  the exact seven shipped page IDs in order. All 32 smoke contract tests pass.
- Full packaged smoke remains unqualified: startup refresh and dashboard chrome
  pass, but the accounting parity gate fails (`usage_parity_invalid`). Diagnostic
  captures show accounting still loading/unavailable. No assertion was relaxed
  for that failure. Receipt: `.release-build/header-smoke-qualified.json`.
- Full preflight remains blocked by the root-layout issue above. No signing,
  publishing, system installation, updater, or complete lifecycle qualification
  is claimed.
