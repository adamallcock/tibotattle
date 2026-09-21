---
title: "Folding the v1.1 scalar (cost) half"
date: 2026-09-18
type: research
status: investigation
---

# Folding the v1.1 scalar (cost) half — measured feasibility

Measurement, not a decision. Supersedes the
"single biggest unknown" left open by
`docs/plans/2026-09-17-graph-acquisition-throughput.md`.

## Question

The prepared graph-day projection folds the **model** half of the v1.1 usage
reduction. The **scalar** half — the cost evidence the `fits` metric needs, and
therefore the public allowance band — is still paged from source on every
claim. Should it be folded too?

The 2026-09-17 plan recommended **not** folding it, on the grounds that quota
and usage records share observation instants to within 0.03%, so there is
roughly one scalar bucket per usage event and the artifact would compress about
1:1 (~340 KB per owner-day, ~330 MB for the corpus). It left one question open:
whether the densest owner's scalar reduction is already destined to refuse.

## Answer to the open question: yes, and for more than one owner

`MAX_USAGE_BUCKETS = 120_000` (`apps/worker/src/quota-analysis-v11.ts:75`).
Exceeding it sets `scalarRefusal = "reduced_usage_limit_exceeded"`
(`:1210`), which refuses the fits half only; the model half is bounded
separately by `costs` and `poisoned`, which are 2-hour binned and nowhere near
the ceiling.

A scalar bucket is keyed `[provider, scope, eraKey, exact, anchor]` (`:1199`),
and `anchor` is the event's interval end whenever it coincides with a quota
grid instant. So the bucket count is, to within the 0.03% the plan measured,
the count of **distinct usage instants in the window**.

Measured from `typed_telemetry_records` (stream 1 is usage), rolled into
windows, worst case per owner:

| owner | 7 days | 14 days | 30 days | 100 days |
|---|---|---|---|---|
| 1 | 117,764 | 199,120 | 324,942 | 671,194 |
| 2 | 96,770 | 154,287 | 291,982 | 637,711 |
| 3 | 38,370 | 62,825 | 123,321 | 267,678 |
| 4 | 21,219 | 34,700 | 63,999 | 97,564 |

Against the 120,000 ceiling, at the live 100-day window the three densest
owners are 5.6x, 5.3x and 2.2x over. The plan's estimate of ~640,000 anchors
for the heaviest owner was accurate (637,711 measured).

## CORRECTION — production does not show the refusal this predicts

An earlier revision of this document concluded that the band excludes its
densest contributors. **That was wrong, and production refutes it.**

Grouping `analytics_community_graph_results` by owner rather than by result:
**18 of 19 owners produce populated fits**, and those 18 include all three
owners held in the prepared store — including the densest, at 933,123 usage
rows. Exactly one owner has never produced a fit, and it is not one of the
dense ones. The live public band agrees: 17 participants and 40 fits on the
most recent day.

The earlier "2 owners empty" figure counted *results*, not owners; a single
owner contributes both empty and populated results on different days.

So the instant counts above are real, but the inference from them is not. The
bucket count is evidently lower than the instant count in practice — candidates
include the `eraKey === null` early return at `:1194`, which creates no bucket,
and an effective window narrower than the nominal one. **The mechanism is
unconfirmed and should not be cited until someone reaches it.** An independent
attempt to drive the 100-day reduction offline could not reach it either: the
read failed first with D1 error 7429 (CPU limit) at the third statement, before
a single usage row was priced.

The lesson is the one this repository already states: use direct runtime
inspection to establish live state, and do not let a measured input stand in
for an observed outcome.

## Does folding the scalar half help?

**No.** The ceiling is on the number of distinct buckets the reduction holds,
not on how the rows reaching it are read. A folded artifact would hand the
reduction the same instants and refuse at the same point. Folding changes the
statement cost of getting there, nothing else.

And the statement cost it would save is not the binding constraint:

- the model metric already folds, and its long pass now completes six
  calculations reading zero raw rows;
- the fits metric completes for all eighteen owners it can complete for, and
  no `:fits-1` checkpoint stages are accumulating, which is what a fits claim
  struggling to finish inside a pass would look like.

So the ~330 MB artifact would buy a saving on work that already finishes — and
with 18 of 19 owners producing fits today, there is no observed population it
would rescue.

## If a ceiling refusal is ever observed

Three levers, none free, and this is an owner decision. None of them is
warranted until the refusal is actually observed:

1. **A shorter window for the fits metric only.** All four owners fit at seven
   days; owner 1 sits at 98% of the ceiling, so it is not comfortable. Note
   that `COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS = W - 30` goes negative below
   a 30-day window and is used as a lower day bound, so this is not a
   one-constant change.
2. **Raise the ceiling.** 671,194 buckets at roughly 100 bytes each is about
   67 MB against a 128 MiB isolate, before the checkpoint byte cap
   (`MAX_V11_USAGE_CHECKPOINT_BYTES`, 8 MB) is considered — that cap binds
   first and is the harder of the two.
3. **Coarsen the anchor grain.** This collapses the bucket count directly, the
   way 2-hour binning already does for the model half. It changes which reset
   window a cost lands in near boundaries, so it is a deliberate,
   documentable change to the answer, not a transparent optimisation.

## Recommendation

Do not fold the scalar half. It addresses no observed problem: the fits metric
completes for 18 of 19 owners today, including the densest.

Treat the instant counts as a standing hazard to revisit if a
`reduced_usage_limit_exceeded` refusal is ever observed in production, not as
evidence of one now.
