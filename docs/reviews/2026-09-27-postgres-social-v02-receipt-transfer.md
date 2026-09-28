---
title: PostgreSQL social v0.2 receipt transfer slice
date: 2026-09-27
type: review
status: snapshot
---

# PostgreSQL social v0.2 receipt transfer slice

**Scope:** local synthetic implementation against staged PostgreSQL migration
0094, based on integration revision `127360926ffc3b33e63a63b7e76e25f48747be6b`.
No production D1 rows were read by this work; no Cloudflare or GCP resources
were changed.

## Implemented boundary

`postgres-social-v02-receipt-transfer.mjs` accepts a read-only, hash-pinned
SQLite projection with a closed manifest/proof schema. It scans receipts in
bounded pages, then opens one local PostgreSQL 17 transaction. Before it inserts
any receipt, it verifies the target source identity and epoch, hashes the full
version-1 journal against the sealed manifest, and matches each tuple to its
participant, owner link, current input revision, exact journal event, and owner
revision head. Receipt insertion is idempotent only when a conflicting digest
reads back as the exact same tuple. A mismatch rolls the transaction back.

The adapter writes only `storage_legacy_event_sources`. It does not append
journal rows, create owner heads, infer receipts, or modify the existing journal
or applied-head transfer machinery. The local PG17 test verifies exact import,
rollback for a mismatched current input revision, bootstrap pending reaching
zero, and safe replay.

## Live-source boundary and remaining blocker

The projection format is a tested contract for a future sealed source exporter;
this change does not implement that exporter or prove that a generated file
came from D1. Its expected file hash pins an artifact but is not itself a D1
attestation. The parent agent's corrected metadata receipt,
`docs/receipts/2026-09-27-cloudflare-production-source-schema-inventory.md`
(integration commit `c675d2b03cbbf9c2949e79b49a23d849a9fd733f`), reports that the
100%-serving Worker version at the observation time binds to a separate
production ingestion D1 containing the legacy receipt, journal, and owner-head
tables. That corrected receipt supersedes the earlier inventory, which checked
only the older primary D1. It read no user rows and made no changes.

Real transfer remains blocked until a reviewed source fence/snapshot and
exporter can provide complete receipt, journal, input, owner-link, and head
evidence from one consistent source state, then reconcile it with the target.
This work did not inspect source rows, establish a fence/snapshot, or run the
adapter against production or Cloud SQL.

## Validation

- The focused offline checks passed for bounded scanning, source identity and
  hash enforcement, closed schema, invalid input-revision evidence, and trusted
  reader handles.
- The focused PostgreSQL 17 spec passed against a local Unix-socket test
  instance using entirely synthetic participant, contribution, journal, head,
  and receipt values. It verified exact target readback, rollback on mismatch,
  bootstrap readiness, and replay idempotency.
- No source fence, source snapshot/export, real private-data import, GCP write,
  deployment, or production migration was performed.
