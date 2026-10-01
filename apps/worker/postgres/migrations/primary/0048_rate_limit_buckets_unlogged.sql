-- Limiter bucket state is ephemeral by design: a lost bucket only restarts a
-- fixed window early. Marking the table UNLOGGED keeps its keyed digests out
-- of WAL, replicas and point-in-time recovery, and PostgreSQL truncates it on
-- crash recovery. With the edge-first topology only the identity-keyed
-- origin-tier buckets (UPLOAD_AUTHORIZATION and UPLOAD_PRINCIPAL) are written
-- here and no address-derived key reaches PostgreSQL; scheduled maintenance
-- purges rows older than twice their window
-- (purgeExpiredPostgresRateLimitBuckets in src/postgres-rate-limiter.ts).
-- No column, constraint or index changes; the indexes become unlogged with
-- the table.

ALTER TABLE postgres_rate_limit_buckets SET UNLOGGED;
