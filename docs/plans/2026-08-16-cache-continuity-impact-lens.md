---
title: Cache continuity impact lens
date: 2026-08-16
type: plan
status: implemented
---

# Cache continuity impact lens

## Goal

Estimate the incremental Standard API-equivalent premium associated with a
material cache-read collapse between adjacent user turns that keep the same
effective model and reasoning configuration. Elapsed time is an evidence
dimension, not an eligibility rule. Keep post-compaction requests visible but
separate because compaction changes the context and makes the old warm-prefix
counterfactual invalid.

## Evidence boundary

- Compare adjacent positive-input usage requests within one salted local
  session.
- Treat Max and Ultra as the same effective API reasoning effort.
- A continuity candidate has the same recognized effective configuration and
  routing/surface semantics, a genuine new-user-turn boundary, and no recorded
  compaction between requests.
- Require all cache/input components, prior cache read greater than zero, and
  current total input at least as large as the prior cache read. The last rule
  excludes contracted contexts that cannot contain the old reusable prefix.
- A material drop retains at most 50% of the prior cache read. Lost reuse is
  bounded by both the observed cache-read decline and current uncached plus
  cache-write input.
- Price the same warm-cache counterfactual and event-time Standard API cards as
  the switch lens. Never add this diagnostic premium to ordinary usage cost.
- Label the relationship as possible, not causal. Provider routing, prefix
  changes, retention policy, and unobserved application behavior remain
  alternative explanations. Show gap bands from under one minute through more
  than 24 hours so age remains inspectable without manufacturing a TTL.

## Compaction handling

Retain only a content-free compaction boundary in the local unified index:
salted event key, salted session join key, timestamp, and parser/run
provenance. Intern one salted source identity and retain a byte offset on each
usage fact so tied timestamps follow transcript order without duplicating a
32-byte digest per row. The extractor recognizes the top-level marker from the
bounded prefix of an oversized line and never decodes its replacement history.

Any adjacent request pair crossed by a recorded compaction is excluded from
both the switch and cache-continuity premium. The dashboard reports post-compaction
request/drop counts separately; it does not manufacture a dollar cost for a
context that was deliberately rewritten.

Rows produced before compaction-aware parsing are not evidence that no
compaction occurred. A period with relevant uncovered transitions withholds
the premium rather than presenting a contaminated zero or sum. Exact-order
gaps are counted only in periods containing the affected session's latest
positive-input request; an ancient retained source therefore cannot suppress
a fully covered recent period. A one-request session cannot contain an
adjacency and is not treated as a coverage gap.

## Minimal integration

1. Add the compaction boundary to the existing extractor, unified SQLite
   writer, incremental healing path, and rebuild worker.
2. Extend the existing cache-impact query so switch and continuity analyzers
   share one adjacency scan and one accounting pricer.
3. Add `cacheContinuityImpact` beside `cacheSwitchImpact` in the companion
   projection, reusing the seven-day allowance conversion.
4. Reuse the accounting metric-card, evidence-disclosure, table, period
   selector, localization, and browser fail-closed patterns.
5. Page each cache-impact table at ten rows using the dashboard's established
   Previous/Next range control. The fixed seven-band summary remains one page,
   while the bounded recent-evidence lists use two pages when all 20 rows exist.

## Live implementation calibration

A fresh throwaway v6 index rebuilt from the still-present local corpus on
2026-08-16 contained 505,930 usage events with complete exact-order coverage;
the installed app index was not modified. The final no-floor analyzer found 87
material drops across 666 comparable same-configuration turn pairs over seven
days, 10,103,040 bounded lost-reuse tokens, and a $38.5365888 Standard
API-equivalent premium. Thirty days contained 636 of 2,762 and $300.85396992;
all indexed history contained 1,687 of 6,200 and $796.35481722. An earlier
literal-zero-cache sensitivity found only 18 seven-day drops and $10.334016,
so a zero-only rule misses most severe partial collapses. These are local
calibration observations, not retained product fixtures.

The compact source-id/offset schema grew the frozen representative index from
187.85 MiB to 198.86 MiB (+11.01 MiB / 5.86%), versus about 108 MB for the
rejected per-event order-table design. The final exact analyzer took about 1.3
seconds warm on the fresh 505,930-event index while feeding both lenses from
one scan.

## Verification

- Extractor: oversized compaction line remains bounded and content-free.
- Index: cold rebuild, worker parity, migration, incremental resume/healing,
  and privacy projection.
- Analyzer: gap boundary/bands, Max/Ultra equivalence, positive-input
  adjacency, compaction precedence, context contraction, mixed pricing, and
  identifier-free recent evidence.
- Product: companion/browser normalization fail closed, seven-day allowance
  conversion only, three-locale copy parity, rendered desktop/narrow layouts,
  zero/partial/unavailable states, live read timing, and live aggregate smoke.

## Provider references

- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching):
  cache hits are observable through cached-token usage, while exact-prefix
  matching, cache availability, routing, and retention can all affect reuse.
- [Compaction](https://developers.openai.com/api/docs/guides/compaction): the
  compacted output becomes the canonical next context and carries prior state
  forward using fewer tokens, so it is not the old warm prefix.
