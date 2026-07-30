---
title: R7 SQLite Batch Semantics Decision
date: 2026-07-26
type: decision-record
status: implemented
---

# R7 SQLite batch semantics decision

## Decision

`maximumSqliteBatchRecords` is an internal transaction batching policy, not an
accepted-input ceiling.

The verifier must commit a non-empty SQLite transaction after at most 1,000
record identifiers and continue in a fresh transaction. Record 1,001 is
therefore expected to pass in a second transaction. It must not be represented
as a value-plus-one rejection.

True safety ceilings remain independently enforced by the export-set record,
expanded-byte, decoded-byte, encoded-byte, workspace-byte, elapsed-time, and
RSS policies.

## Implemented evidence

The production verifier now returns only content-free verification-index
metrics:

- selected batch size;
- total indexed records;
- non-empty batch count;
- full batch count;
- largest batch size; and
- final batch size.

The materialized R7 harness constructs a content-free 1,001-record export,
passes it through the real workspace, materializer, compressed export-set, and
verifier pathways, and requires exactly:

- a 1,000-record batching policy;
- 1,001 indexed records;
- two non-empty transactions;
- one full transaction;
- no transaction larger than 1,000 records; and
- a final one-record transaction.

The receipt contract records both the at-policy batch and the record-1,001
rollover as passed. The dimension remains `not_identified` as a rejection
boundary because no such boundary exists.

## Release impact

This closes the previously unexecuted SQLite batching pathway without
promoting a fictitious ceiling. It does not promote the overall R7 release:
machine pairing, absent-network evidence, engineering rounding, independently
measured headroom, and other ceiling-selection requirements remain separate
open gates.

Any source, schema, policy, or workload change still invalidates retained R7
receipts and requires complete dual-runtime regeneration.
