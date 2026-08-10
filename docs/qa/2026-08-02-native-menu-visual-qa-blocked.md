---
title: Native Menu Visual QA (Blocked Historical Capture)
date: 2026-08-02
type: qa
status: blocked
---

# Native menu visual QA

This is a historical QA record, not current release evidence. It records a
blocked comparison with CodexBar and must not be used to claim that a packaged
TiboTattle menu has passed visual or interaction QA.

## What happened

An ad-hoc TiboTattle bundle retained the existing local state, but its local
companion exited because another running bundle already held the deliberately
exclusive, owner-only automatic-contribution instance lock. Starting the
bundled companion in a clean temporary state succeeded, which isolated the
failure to competing state ownership rather than the bundle payload.

The attempted capture therefore never reached a fresh ready-state menu. It was
not comparable with the CodexBar reference and was correctly marked blocked.

## What this record does and does not establish

- Source review at the time found a menu hierarchy for freshness, quota lanes,
  local analysis, updates when available, and quit.
- It does **not** establish typography, spacing, colour, icon legibility,
  interaction fidelity, or compiled-bundle rendering.
- Temporary screenshots, development build directories, and local temp paths
  from the original attempt are intentionally not retained here.

## Required fresh QA before release

1. Start one freshly packaged app with an isolated owner-only state directory.
2. Reach a ready local-companion state using real local evidence.
3. Capture the expanded menu, then verify click-away and Escape dismissal,
   keyboard navigation, icon legibility, and stale/current states.
4. Compare interaction and layout against the approved CodexBar reference
   while preserving TiboTattle's privacy model and product-specific copy.
5. Store only a durable, privacy-reviewed receipt under `docs/qa/`; do not put
   transient screenshots or generated report artifacts in the repository root.
