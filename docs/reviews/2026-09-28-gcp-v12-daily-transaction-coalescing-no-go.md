---
title: GCP v1.2 daily authority coalescing no-go review
date: 2026-09-28
type: review
status: snapshot
---

# GCP v1.2 daily authority coalescing no-go review

Migration 0095 remains staged and unchanged. A prototype follow-up was rejected after PostgreSQL 17.10 tests showed that its durable transaction marker can suppress a required authority revision after logical restore, while a custom transaction-local GUC can be spoofed by a non-superuser role. No 0096 migration is retained or committed, and no remote database was changed.

## Measured opportunity

An uncommitted prototype using `last_advance_xid xid8` passed the focused publisher suite (41 passed, zero skipped) and one exact synthetic v1.2 client day path (1 passed, zero skipped) on 2026-09-28. That day completed one chunk and one record under both 0095 and the prototype. The summed authority revision delta was 24 under 0095 and 10 under the prototype; changed-shard counts were 9 and 10.

One elapsed-time sample was 155 ms under 0095 and 131 ms under the prototype. `pg_stat_wal` reported deltas of 50 and 0 bytes, but that counter is cluster-wide and these small observations are inconclusive. They do not establish throughput or WAL improvement. The revision count is the measured potential only; the prototype is not safe to integrate.

## Rejection evidence

The prototype stores the last advancing `xid8` on each shard. A disposable-schema PG17.10 probe simulated an imported marker equal to the current local transaction xid: with triggers temporarily set to replica mode, it set shard 114's marker to xid `1445865`, restored origin mode, then ran an empty source update. The revision stayed `1` to `1` (`sourceStatementAdvanced: false`). The transaction was rolled back and both synthetic schemas were dropped. This reproduces the logical-restore collision that can falsely allow a daily `unchanged` result.

A custom `SET LOCAL` GUC was also tested as transaction-scoped state. In a rolled-back probe, a temporary `NOSUPERUSER` role successfully called `set_config` for a custom GUC even after `REVOKE SET ON PARAMETER ... FROM PUBLIC`. PostgreSQL documents that SET ACLs are only meaningful for parameters that normally require superuser privilege, which excludes an arbitrary custom GUC ([PostgreSQL 17 privileges](https://www.postgresql.org/docs/17/ddl-priv.html)). A client could set the marker to its current transaction xid and make this coalescing guard skip an increment. Adding `SECURITY DEFINER` would not make that marker private and would introduce a privilege/search-path change without a safe transaction marker.

## Outcome and boundary

Do not integrate the 0096 prototype. Migration 0095's before-statement fence and publisher race tests remain the accepted source behavior. The 24-to-10 revision delta motivates future investigation only; it does not justify a durable xid marker or a spoofable GUC. This review records local synthetic evidence, not GCP application, deployment, production load, or end-to-end throughput qualification.
