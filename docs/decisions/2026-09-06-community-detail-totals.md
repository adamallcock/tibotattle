---
title: Community activity total tokens and API-equivalent spend
date: 2026-09-06
type: decision-record
status: implemented-pending-deployment
---

# Community activity totals

The public activity detail uses all tokens in its chart, summary and daily
table: uncached input + cache-read input + cache-write input + combined output.
These categories are disjoint. Combined output already contains reasoning;
text and reasoning must not be added a second time. Invalid or overflowing
counts remain unavailable, never zero.

The contributors-that-day summary is replaced by total API-equivalent spend
across the displayed published days, in USD. This is a priced equivalent of
reported usage, not an actual invoice or the value of an allowance. Known
subtotals retain a visible priced-portion qualifier whenever any day or event
is missing pricing. Fully unavailable history does not display zero; a
genuinely empty, fully accounted usage population may do so.

## Pricing and publication contract

The additive daily `apiEquivalentSpend` block prices the same active,
winner-selected usage population as the existing token totals. It uses the
shared event-time pricing adapter, including speed tier and context evidence.
The block carries method and registry identifiers plus conserved fully priced,
partially priced and unpriced event counts. Public projection omits stale or
invalid blocks and exposes no event records, identities or private diagnostics.

Server pricing method v0.5 corrects inherited boundary errors: an unknown
provider cannot inherit Anthropic pricing; incomplete input counts cannot
establish a short-context band; explicitly zero aggregate cache writes need
no inferred Anthropic TTL allocation. Context-independent known components
remain priceable. Existing fit/cache keys include the method version, so
corrected costs cannot reuse v0.4 evidence. This changes hosted derived
pricing, not released desktop artifacts or persisted telemetry.

Pricing reads at most eight admitted chunks at once and reserves a whole day
against the shared pass budget of 2,048 chunks and 200,000 events. Temporary
budget exhaustion defers the day without publication or dequeue. A day above
the absolute capacity publishes an explicit whole-day unavailable block, not
a prefix subtotal; unprocessed events are distinct from unpriceable events.
Nanodollar accumulation uses integers, with rounding only at the public daily
boundary. Existing epoch, source-pin, correction and publication fences remain.

Missing or obsolete price blocks on already-published days form a bounded
backfill worklist. Historical revisions remain immutable. Allowance rebuilding
is still a prerequisite in the current scheduler; the ongoing allowance-query
incident therefore blocks live price backfill. Source implementation and local
rendering qualification do not establish public availability.

## Qualification and rollout boundary

The UI passed 504 tests and 36 synthetic rendered scenarios: complete, partial,
unavailable and genuine-zero pricing; three languages; 1440, 390 and 320 px
widths. The scenarios had no runtime errors or horizontal overflow. They used
synthetic public data only, not production telemetry.

The rejected indexed-neighbor allowance query is rolled back in this branch
to its prior implementation, retaining exact-result regressions. That rollback
does not solve the earlier large-corpus memory issue. No new account-level
resource refusal, migration, consent change or maintenance-control change is
implied by this feature. Production recovery and rendered live verification
remain separate gates; see [current status](../current-status.md).
