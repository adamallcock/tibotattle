---
title: Forward-compatible quota limit display names
date: 2026-08-25
type: decision-record
status: implemented
---

# Forward-compatible quota limit display names

## Decision

Quota identity remains `(provider, limitId, duration)`. Provider-supplied
`limitName` is bounded local display metadata and never participates in pool
selection, track identity, calibration, observation deduplication, export, or
contribution.

Known technical identifiers have audited aliases:

| Provider limit ID | Product alias | Accounting treatment |
| --- | --- | --- |
| `codex` | Codex | Normal Codex allowance |
| `codex_bengalfox` | Spark | Separate Spark allowance |
| `codex-spark` | Spark | Reserved Spark alias |

The ordinary 300-minute `codex` window remains **Five-hour allowance**. The
provider currently supplies no separate human name for that pool.

## Future pools

A previously unseen, syntactically safe limit ID stays distinct in the local
projection. It remains excluded from the normal headline, calibration, and
closed export registry until reviewed.

Display resolution is deterministic:

1. Known ID and duration combinations use audited localized product copy.
2. An unknown ID with a validated provider name uses
   `{name} · {duration} allowance`.
3. An unnamed or rejected provider name uses
   `Other observed {duration} allowance`.
4. Invalid duration evidence is not rendered as a current allowance card.

Provider names are normalized to a maximum of 80 Unicode code points and a
conservative single-line product-name character set. Paths, URLs, email-like
account identifiers, markup, control characters, and overlong strings fail
closed to the generic duration label.

## Privacy and compatibility boundaries

- Raw technical IDs are never rendered as copy.
- Display names are stored only in the bounded local collector record and
  current local dashboard projection.
- Observation event keys omit display names, so a copy change cannot create a
  new quota observation.
- The collector export source accepts the optional validated local field, then
  drops it before producing an export candidate.
- Unreviewed pools are omitted from the closed collector export candidate
  contract; a mixed snapshot can still export its reviewed windows.
- The native compact menu continues to show only normal `codex` lanes. The
  embedded dashboard renders other observed pools after Spark and normal Codex
  cards without promoting them into the headline.
