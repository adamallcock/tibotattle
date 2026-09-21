---
title: Include tool-free fallback estimates in Output speed
date: 2026-09-21
type: plan
status: in-progress
---

The owner clarified that additive recovery means one Output speed graph containing
response-timed measurements plus eligible tool-free full-turn estimates, not a
third graph. Each turn contributes once, preferring response timing. Fallbacks
include initial waiting; counts and methodology disclose this distinction.
Original parser/store evidence and TTFT remain unchanged. The projection computes
combined percentiles from per-turn samples under schema 4/method 5.

Acceptance:

- Admit only completed, single-response, stable-model turns with positive,
  reconciled output tokens and valid boundaries. Reject observed tools, unknown
  activity, steering, compaction, missing baselines, resets, duplicate receipts,
  concurrent turns, malformed/oversized evidence, and uncertain identities.
- Preserve the original method-2 sidecar and parser behavior. Reconstruct the
  supplement in its own versioned sidecar using the original private correlation
  key. Keep cursors and pending state atomic; never modify accounting state.
- Join supplemental evidence only to matching retained turns. No additional
  total-turn or TTFT counts; existing response-speed fields remain unchanged.
- Keep original saved measurements readable if supplemental collection fails.
  Both scans stay bounded, cancellable, lazy, and resumable.
- Render one Output speed chart with a method breakdown and explicit initial-wait semantics.
  Verify synthetic negative cases, restart/replay, sidecar compatibility,
  existing evidence conservation, and rendered real-data aggregates.

Source changes and local validation do not install or publish a release.

Prior implementation snapshot (2026-09-21), before the clarified combined-chart
request. Its three-chart UI evidence does not qualify the revised UI. Integrated with main at
`8a340061` in source revision `dc38f3859d030b76f2fc977f358476097d2ae861`:

- Integrated parser/store/controller/reporting checks: 58 passed. Additional
  portable Windows adapter and pinned-window checks passed; these do not claim
  physical Windows execution.
- Local companion suite: 363 passed. Browser UI suite: 942 passed. Translation
  tests: 13 passed; generated browser translations match canonical sources.
- Architecture, documentation preflight, and whitespace checks passed.
- A complete bounded historical diagnostic matched all 5,501 original GPT-5.5
  turns across 1,009 source files (10.8 GB), with no read failures or changed
  sources. It found 235 eligible turns. Mutually exclusive exclusions, in
  priority order: 4,888 tool/unknown activity, 30 missing/invalid cumulative
  baseline, 346 multiple/unreconciled responses, and 2 invalid timing boundaries.
  Underlying exclusion predicates overlap; only the priority counts sum to the
  original population. No original measurement fields changed.
- Browser inspection used real aggregates in English desktop and narrow
  Spanish/Chinese views. Existing speed and latency charts remained alongside
  the separate throughput chart without page overflow.
- Main already contained the unrelated reporting-export allowlist correction;
  its boundary tests now pass without a separate patch.
- A fresh macOS arm64 development package passed its artifact verifier. ASAR
  SHA-256: `099ce69fd20cb8ef04bbce8e0dbd0c4c71461a1a6530dfec1b1f91cf768af7a9`.
  It was installed side by side with a private copied profile and hosted sharing
  disabled. Native startup, reporting-period/model selection, and the recovered
  235-of-5,501 chart were inspected after reopening. Original 0 speed and 5,000
  latency counts remained visible. Menu-driven shutdown passed. The stable
  installed app and its timing store were preserved.

- Full background collection completed across 9,644 discovered files (the active
  source inventory grew by one after the first pass). Restart preserved every
  model count. Both the retained-row comparison and supplemental join reported
  zero changes to original fields. Maximum cached controller read time across
  the two resumed passes was 2.08 ms; this measures cached reads, not whole UI
  latency. The standalone probe keeps a referenced timer alive while closing
  the intentionally unreferenced worker, matching the application's live loop.
- A follow-up scan found 671 replaced sources and one rewritten source refused
  by the original cache's identity guards, and zero supplemental errors. Saved
  measurements stay available with the existing stale indication; this change
  does not weaken those guards or rewrite the original cache.
- Broad root run: 5,630 tests, 5,567 passed, 15 failed, 48 skipped. Three file-level
  dependency failures passed after installing the existing Worker lockfile.
  Ten runtime/resource/native failures passed outside the outer sandbox,
  including the native deny-network test with its own sandbox still enforced.
  The two remaining retained-R7-receipt checks are stale on main too: retained
  provenance has 408 inputs whereas current main has 409. No R7 receipts were
  regenerated or relabelled. The full root gate is therefore not claimed green.

The prior source change was merged in PR #182. Revised combined-chart validation
is pending below. No signed release, production replacement, or updater
publication is included.


Clarified combined-chart implementation (2026-09-21):

- Schema 4/method 5 prefers response timing, otherwise admits an eligible
  tool-free full-turn estimate. One sample per turn feeds the pooled percentiles;
  fallback counts remain explicit. The third chart is removed.
- Synthetic projection/worker/restart tests: 22 passed. Companion: 363 passed.
  Browser UI: 944 passed. Translation tests: 13 passed; mirror check passed.
  Architecture and documentation preflight passed.
- A read-only projection over the completed real-data sidecars returned 235
  Output speed measurements from 5,501 GPT-5.5 turns, all 235 full-turn estimates,
  with 5,000 TTFT measurements. No parser or persistent-store change was needed.
- Refreshed installed QA rendering remains to be checked.
