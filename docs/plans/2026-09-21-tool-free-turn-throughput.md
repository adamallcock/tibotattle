---
title: Add tool-free turn throughput beside response speed
date: 2026-09-21
type: plan
status: implemented-local
---

The owner requested additive recovery of useful measurements from older Codex
logs for turns without tools. Preserve existing output speed, TTFT, counts, and
saved timing evidence. Add a separate distribution for a single response with
reconciled output tokens divided by the complete turn duration, including initial
waiting. Do not subtract TTFT or pool this metric with response-window speed.

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
- Render a separately labelled chart with explicit initial-wait semantics.
  Verify synthetic negative cases, restart/replay, sidecar compatibility,
  existing evidence conservation, and rendered real-data aggregates.

Source changes and local validation do not install or publish a release.

Validation snapshot (2026-09-21), against local changes based on
`9385bad260698814cc2a4a6c685575a3fd63811a`:

- Parser and provider boundary tests: 39 passed. Projection, controller, and
  supplemental parser/store/worker tests: 20 passed, including restart,
  cancellation, incompatible stores, orphan receipts, and conservation.
- Local companion suite: 356 passed. Browser UI suite: 727 passed. Translation
  tests: 12 passed; generated browser translations match canonical sources.
- Architecture, documentation preflight, and whitespace checks passed.
- A read-only historical source sample of 150 files recovered 16 eligible
  GPT-5.5 turns into an isolated supplemental store. Joining those observations
  changed no original measurement fields. This is a sample, not a complete
  historical backfill or an installed-app result.
- Browser inspection used real aggregate measurements. Existing speed and
  latency charts remained alongside the supplemental chart; English desktop
  and narrow Spanish/Chinese views rendered correctly without page overflow.
- The broader reporting-owner export check fails on unrelated usage-explainer
  exports. The same export mismatch was reproduced from the unchanged base
  commit; it is outside this implementation.

The installed app and its saved timing store remain unchanged. Packaging,
installation, native rendering, and a complete runtime backfill remain separate
gates.
