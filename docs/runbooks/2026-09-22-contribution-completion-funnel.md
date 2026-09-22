---
title: Contribution completion funnel diagnosis
date: 2026-09-22
type: runbook
status: current
---

# Contribution completion funnel diagnosis

Use aggregate-only evidence to distinguish receipt, domain activation, analytics
projection and public publication. The diagnostic is source-qualified against the
0.1.24 candidate based on `60b9cf52`; it does not assert a deployed schema, active
v1.2 transport, or a completed production investigation. Production operation
boundaries remain in [Production service operations](production-operations.md).

## Prepare a read-only query plan

From the repository root:

```sh
node apps/worker/scripts/contribution-completion-funnel.mjs \
  --from 2026-09-21T00:00:00.000Z \
  --until 2026-09-22T00:00:00.000Z \
  --v12 absent
```

The command only prints a JSON plan containing fixed aggregate `SELECT` queries.
It cannot execute queries, access credentials, contact services, apply migrations
or change files. Unknown options and noncanonical timestamps are refused. Choose
`--v12 present` only for a source with the v1.2 schema; presence does not mean
activation. The first query reports its `staged` or `active` runtime state.
`absent` fails closed if any `telemetry_v12_*` object exists. Missing tables or
columns fail at SQL preparation; registry mismatches report
`unavailable_contract`. Do not convert either case into a zero count.

Use the owner's verified deployed configuration to resolve the ingestion database
(`STORAGE_INGESTION_DB`) and separate analytics database
(`STORAGE_ANALYTICS_DB`). These are roles, not guessed resource names. The ordinary
Worker configuration's `USAGE_MONITOR_DB` is not sufficient evidence that the
selected physical database is the current ingestion authority. Verify the active
cutover binding and database identity before running any statement. Do not combine
the statements against one database or silently query a retained predecessor.

An authorized operator may execute the reviewed statements using the existing
read-only D1 inspection workflow. Run the source-contract query first. Preserve
the environment, candidate revision, capture time, UTC interval, role and status
beside the aggregate results. Never add participant IDs, owner digests, device
IDs, session identifiers, paths, R2 keys, payloads or JSON record bodies to output.
Do not publish these operational aggregates as community data.

## Limits and time definitions

- Receipt and domain queries use `[from, until)` on server `created_at`, with
  canonical UTC millisecond timestamps and a maximum interval of 31 days.
- Every query materializes at most 10,001 input rows. More than 10,000 makes all
  its metrics `NULL` with `unavailable_row_limit`; no partial population is
  presented as complete. Reduce the interval. Distinct-owner counts from separate
  intervals must not be summed.
- This caps materialized rows and output, **not SQLite scan cost**. Existing
  journal indexes do not guarantee a global receipt-time range seek. Use an
  operator query timeout/resource budget and stop on excessive work; a SQL
  `LIMIT` is not proof of bounded disk reads. Do not add a remote index as part of
  inspection.
- Analytics queries cover every UTC activity day intersecting the interval.
  `observedDays` in the plan gives the exact day range. Projection domains are
  selected by range overlap; `through_day` is a declared domain boundary, not
  evidence of a record on that day.
- `latest_receipt_at` is server acceptance time. `latest_chunk_day` is the chunk
  partition's activity day, not a scan of canonical record timestamps.
  `latest_observed_day` in analytics is the latest selected derived activity day.
  `latest_release_at` is publication creation time. Empty, valid input has a
  count of zero and a latest timestamp/day of `NULL`.
- A bounded set of sequential queries is not an atomic cross-database snapshot.
  Mark observations with capture times and repeat a narrow interval if progress
  races make the result ambiguous. There is no global all-history freshness claim.

## Interpret the stages

| Query | What it proves | What it does not prove |
|---|---|---|
| `v1_receipts`, `v11_receipts`, `v12_receipts` | Accepted journal chunks and distinct receiving owners in the receipt interval, plus latest chunk partition day | Upload attempts, HTTP retries, verified people, new activity on the receipt day, or public eligibility |
| Receipt `owners_with_public_source_authority` | Those receipt owners currently appear in the canonical source-authority view | That every received chunk belongs to the active domain or has been published |
| Receipt `owners_without_current_domain` | Recent receivers with no current head for that format | A count of failed uploads; first-time history staging can be legitimate |
| Receipt `chunks_with_staged_manifest` | Accepted chunks whose manifest is still staged | Domain completeness or eventual activation |
| Receipt `chunks_outside_current_domain` | Accepted chunks whose manifest is outside that owner's current head | Necessarily a fault: superseded generations also fall outside the current domain |
| `v11_domains_created`, `v12_domains_created` | Domains created in the interval and how many are not current heads | Whether a noncurrent domain was never activated or was subsequently superseded |
| `v11_projection_work` | Selected v1.1 projection generations, building work, and current projected owner heads | v1.2-specific projection counts or current publication eligibility |
| `v1_projected_days` | Selected derived v1 chunk slots and owners | Receipts during the same interval or final public contribution counts |
| `daily_owner_projection` | Complete/incomplete derived owner-days and those using the `effective` reader | A separate v1.2 owner count; `effective` can reconcile multiple formats |
| `daily_publication` | Current stored publication heads, release times and missing publication rows | A live public endpoint serving those rows under current authority/containment fences |
| `daily_queue` | Queued source-days in the selected activity interval | An empty upstream ingestion, activation or projection backlog |

Counts use different units and cohorts. The independent databases cannot be
joined by this tool, and it never exports their private linking keys. Do not
subtract analytics owners from receipt owners to invent an exact number of
stuck people. v1 chunks are an append-only revision journal: repeated transport
replays do not create a new row, but accepted corrections can. Format counts also
overlap across owners; do not sum them as unique people.

In particular, many recent receipts with old chunk days and no current domains
are consistent with first-history backfill. Staged manifests and noncurrent
domains require a repeat capture to distinguish steady progress from a stall.
Current source authority with growing analytics work suggests a projection delay.
Completed owner-days with old publication timestamps suggest downstream delay,
but confirm the existing publication method and authority fences before drawing
a cause. A fresh stored publication still needs a separate, read-only public
endpoint check for its observed day and release timestamp.

v1.2 is optional and forward-only. A missing schema is explicitly unavailable,
not zero traffic; `--v12 absent` only diagnoses v1/v1.1. When present, its receipts,
manifests and domain heads are measured independently. The current analytics
tables have no separate v1.2 projection-owner-head family; mixed effective-reader
owner-days must remain mixed in reports. This diagnostic never activates a
transport, changes consent, publishes a partial domain, bypasses a privacy gate,
or refreshes an allowance fit.

## Verification and follow-up

```sh
node --check apps/worker/scripts/contribution-completion-funnel.mjs
node --test apps/worker/scripts/contribution-completion-funnel.check.mjs
```

Tests use synthetic in-memory SQLite data and the real migration table
declarations. They cover cutoff exclusion, receipt/activity separation, staged
versus active/superseded generations, overflow, missing schema and contract
refusal, v1.2 staged/active recognition, and compilation across both database
roles. They do not qualify deployed database identity, authorization views,
production query cost or public serving behavior.

After a client repair ships, compare the same UTC windows across captures and
inspect whether latest activity catches up while staged work clears. Keep actual
daily uploaders separate from contributors represented in a public activity day.
The remedy for a stall belongs to the owning ingestion, projection or publication
workflow; this inspection has no repair mode.
