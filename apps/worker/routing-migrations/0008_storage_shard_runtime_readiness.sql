-- A shard may accept a new owner or a move only after a root-only operator has
-- qualified the exact ingestion, analytics, publication and erasure tuple.
-- Receipts are immutable evidence. Revocation is one-way and immediately
-- closes admission without changing existing owner routes.
CREATE TABLE storage_shard_runtime_readiness (
  readiness_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(readiness_digest)=64 AND readiness_digest NOT GLOB '*[^0-9a-f]*'),
  qualification_id TEXT NOT NULL UNIQUE CHECK (length(qualification_id)=36
    AND substr(qualification_id,9,1)='-' AND substr(qualification_id,14,1)='-'
    AND substr(qualification_id,19,1)='-' AND substr(qualification_id,24,1)='-'
    AND replace(qualification_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  shard_id TEXT NOT NULL REFERENCES storage_shards(shard_id),
  catalog_database_id TEXT NOT NULL CHECK (length(catalog_database_id)=36),
  catalog_binding_name TEXT NOT NULL CHECK (catalog_binding_name='STORAGE_ROUTING_DB'),
  catalog_schema_digest TEXT NOT NULL
    CHECK (length(catalog_schema_digest)=64 AND catalog_schema_digest NOT GLOB '*[^0-9a-f]*'),
  binding_name TEXT NOT NULL,
  ingestion_database_id TEXT NOT NULL CHECK (length(ingestion_database_id)=36),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 128),
  source_namespace TEXT NOT NULL CHECK (length(source_namespace) BETWEEN 1 AND 256),
  ingestion_schema_digest TEXT NOT NULL
    CHECK (length(ingestion_schema_digest)=64 AND ingestion_schema_digest NOT GLOB '*[^0-9a-f]*'),
  analytics_target_id TEXT NOT NULL CHECK (length(analytics_target_id) BETWEEN 1 AND 128),
  analytics_binding_name TEXT NOT NULL,
  analytics_database_id TEXT NOT NULL CHECK (length(analytics_database_id)=36),
  analytics_schema_digest TEXT NOT NULL
    CHECK (length(analytics_schema_digest)=64 AND analytics_schema_digest NOT GLOB '*[^0-9a-f]*'),
  erasure_target_id TEXT NOT NULL CHECK (length(erasure_target_id) BETWEEN 1 AND 128),
  deletion_ledger_binding_name TEXT NOT NULL,
  deletion_ledger_database_id TEXT NOT NULL CHECK (length(deletion_ledger_database_id)=36),
  deletion_schema_digest TEXT NOT NULL
    CHECK (length(deletion_schema_digest)=64 AND deletion_schema_digest NOT GLOB '*[^0-9a-f]*'),
  publication_database_id TEXT NOT NULL CHECK (length(publication_database_id)=36),
  publication_binding_name TEXT NOT NULL,
  publication_schema_digest TEXT NOT NULL
    CHECK (length(publication_schema_digest)=64 AND publication_schema_digest NOT GLOB '*[^0-9a-f]*'),
  qualified_at INTEGER NOT NULL CHECK (qualified_at >= 0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  revoked_at INTEGER,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version=1),
  UNIQUE (shard_id, readiness_digest),
  CHECK (erasure_target_id=analytics_target_id),
  CHECK (deletion_ledger_binding_name='DELETION_LEDGER'),
  CHECK (publication_binding_name='STORAGE_PUBLICATION_DB'),
  CHECK ((state='active' AND revoked_at IS NULL)
    OR (state='revoked' AND revoked_at IS NOT NULL AND revoked_at>=qualified_at))
) STRICT;

CREATE UNIQUE INDEX storage_shard_runtime_readiness_active
 ON storage_shard_runtime_readiness(shard_id) WHERE state='active';

CREATE TRIGGER storage_shard_runtime_readiness_initial_state
BEFORE INSERT ON storage_shard_runtime_readiness
WHEN NEW.state<>'active' OR NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'STORAGE_SHARD_READINESS_INITIAL_STATE'); END;

CREATE TRIGGER storage_shard_runtime_readiness_transition
BEFORE UPDATE ON storage_shard_runtime_readiness
WHEN NEW.readiness_digest<>OLD.readiness_digest OR NEW.shard_id<>OLD.shard_id
 OR NEW.qualification_id<>OLD.qualification_id
 OR NEW.catalog_database_id<>OLD.catalog_database_id
 OR NEW.catalog_binding_name<>OLD.catalog_binding_name
 OR NEW.catalog_schema_digest<>OLD.catalog_schema_digest
 OR NEW.binding_name<>OLD.binding_name OR NEW.ingestion_database_id<>OLD.ingestion_database_id
 OR NEW.source_id<>OLD.source_id OR NEW.source_namespace<>OLD.source_namespace
 OR NEW.ingestion_schema_digest<>OLD.ingestion_schema_digest
 OR NEW.analytics_target_id<>OLD.analytics_target_id
 OR NEW.analytics_binding_name<>OLD.analytics_binding_name
 OR NEW.analytics_database_id<>OLD.analytics_database_id
 OR NEW.analytics_schema_digest<>OLD.analytics_schema_digest
 OR NEW.erasure_target_id<>OLD.erasure_target_id
 OR NEW.deletion_ledger_binding_name<>OLD.deletion_ledger_binding_name
 OR NEW.deletion_ledger_database_id<>OLD.deletion_ledger_database_id
 OR NEW.deletion_schema_digest<>OLD.deletion_schema_digest
 OR NEW.publication_database_id<>OLD.publication_database_id
 OR NEW.publication_binding_name<>OLD.publication_binding_name
 OR NEW.publication_schema_digest<>OLD.publication_schema_digest
 OR NEW.qualified_at<>OLD.qualified_at OR NEW.contract_version<>OLD.contract_version
 OR OLD.state='revoked' OR NEW.state<>'revoked' OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'STORAGE_SHARD_READINESS_IMMUTABLE'); END;

CREATE TRIGGER storage_shard_runtime_readiness_no_delete
BEFORE DELETE ON storage_shard_runtime_readiness
BEGIN SELECT RAISE(ABORT,'STORAGE_SHARD_READINESS_HISTORY_REQUIRED'); END;

ALTER TABLE storage_shard_allocation_policy ADD COLUMN qualification_digest TEXT
 REFERENCES storage_shard_runtime_readiness(readiness_digest);

CREATE TRIGGER storage_shard_allocation_policy_readiness_insert
BEFORE INSERT ON storage_shard_allocation_policy
WHEN NEW.allocation_enabled=1 AND NOT EXISTS (
  SELECT 1 FROM storage_shard_runtime_readiness readiness
  JOIN storage_shards shard ON shard.shard_id=readiness.shard_id
  WHERE readiness.readiness_digest=NEW.qualification_digest
    AND readiness.shard_id=NEW.shard_id AND readiness.binding_name=shard.binding_name
    AND readiness.state='active' AND readiness.contract_version=1
)
BEGIN SELECT RAISE(ABORT,'STORAGE_SHARD_NOT_QUALIFIED'); END;

CREATE TRIGGER storage_shard_allocation_policy_readiness_update
BEFORE UPDATE OF allocation_enabled,qualification_digest ON storage_shard_allocation_policy
WHEN NEW.allocation_enabled=1 AND NOT EXISTS (
  SELECT 1 FROM storage_shard_runtime_readiness readiness
  JOIN storage_shards shard ON shard.shard_id=readiness.shard_id
  WHERE readiness.readiness_digest=NEW.qualification_digest
    AND readiness.shard_id=NEW.shard_id AND readiness.binding_name=shard.binding_name
    AND readiness.state='active' AND readiness.contract_version=1
)
BEGIN SELECT RAISE(ABORT,'STORAGE_SHARD_NOT_QUALIFIED'); END;

DROP TRIGGER storage_owner_reserve;
CREATE TRIGGER storage_owner_reserve BEFORE INSERT ON storage_owner_routes BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
      FROM storage_shards shard
      JOIN storage_shard_capacity_observations observation USING (shard_id)
      JOIN storage_shard_allocation_policy policy USING (shard_id)
      JOIN storage_shard_runtime_readiness readiness
        ON readiness.readiness_digest=policy.qualification_digest
       AND readiness.shard_id=shard.shard_id
       AND readiness.binding_name=shard.binding_name
     WHERE shard.shard_id=NEW.shard_id AND shard.state='active'
       AND readiness.state='active' AND readiness.contract_version=1
       AND observation.pressure_state='normal' AND policy.allocation_enabled=1
       AND observation.observed_at<=NEW.updated_at AND observation.valid_until>=NEW.updated_at
       AND observation.observed_bytes<6000000000
       AND observation.observed_bytes+shard.reserved_bytes+NEW.reservation_bytes<=shard.capacity_bytes
  ) THEN RAISE(ABORT,'STORAGE_CAPACITY_UNAVAILABLE') END);
END;

DROP TRIGGER storage_move_reserve;
CREATE TRIGGER storage_move_reserve BEFORE INSERT ON storage_owner_moves BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM storage_owner_routes WHERE owner_id=NEW.owner_id
      AND shard_id=NEW.source_shard_id AND route_generation=NEW.source_generation
      AND state='active' AND reservation_bytes=NEW.reservation_bytes
  ) THEN RAISE(ABORT,'STORAGE_ROUTE_STALE') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
      FROM storage_shards shard
      JOIN storage_shard_capacity_observations observation USING (shard_id)
      JOIN storage_shard_allocation_policy policy USING (shard_id)
      JOIN storage_shard_runtime_readiness readiness
        ON readiness.readiness_digest=policy.qualification_digest
       AND readiness.shard_id=shard.shard_id
       AND readiness.binding_name=shard.binding_name
     WHERE shard.shard_id=NEW.destination_shard_id AND shard.state='active'
       AND readiness.state='active' AND readiness.contract_version=1
       AND observation.pressure_state='normal' AND policy.allocation_enabled=1
       AND observation.observed_at<=NEW.updated_at AND observation.valid_until>=NEW.updated_at
       AND observation.observed_bytes<6000000000
       AND observation.observed_bytes+shard.reserved_bytes+NEW.reservation_bytes<=shard.capacity_bytes
  ) THEN RAISE(ABORT,'STORAGE_CAPACITY_UNAVAILABLE') END);
END;
