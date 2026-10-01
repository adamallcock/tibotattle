---
title: Allowance tanks and shared pacing forecast
date: 2026-09-13
type: plan
status: complete
---

Implement the owner-approved Overview design: equal fuel tanks for every valid
observed allowance, one current Codex forecast below them, and a labelled timeline.
Use relative days/hours with exact event timestamps on hover, focus, or tap.

Acceptance: preserve quota identity, unknown/stale evidence and forecast math;
retain forecast detail through disclosure; support one, two and many windows;
localize new copy; verify focused and full web tests, browser rendering and
keyboard/narrow layouts. Commit only this isolated worktree's changes.

Do not infer plan/window mappings or retire Spark data. Provider observations
remain authoritative. This is a source/browser change, not a packaged release.

Completed in an isolated worktree from base 9385bad2. Tanks lead with the current
Codex pool; Spark and future observed pools remain distinct. The existing weekly
forecast contract is retained without inferring monthly plan mappings.

Validation on 2026-09-13:

- `pnpm run product:ui:test`: 735 tests passed, including 10 new tank/timeline
  behavior tests covering one through seven windows, unknown/zero/stale values,
  elapsed resets, edge labels, timestamps, pace states and translations.
- `pnpm run docs:check`, `pnpm run test:preflight`,
  `pnpm run i18n:browser:check`, and `pnpm run architecture:check`: passed.
- Browser inspected with real local evidence through a temporary loopback-only
  read-only preview. Verified labelled run-out/reset geometry, timestamp popover,
  Escape dismissal, evidence disclosure, and narrow Spanish wrapping.
- Preview intentionally refused mutations; it did not refresh or change the
  user's local evidence. No installed bundle, signing, release or deployment
  qualification is claimed.
