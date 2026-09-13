---
title: Consistent dashboard page headers
date: 2026-09-13
type: plan
status: in-progress
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
- Electron artifact and runtime validation remain pending this source commit.
