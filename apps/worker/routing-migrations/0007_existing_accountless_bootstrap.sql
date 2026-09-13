-- Trusted, one-way activation receipt for the pre-catalog accountless source.
-- The manifest is content-free and immutable; raw participant ids stay on the
-- source shard. Progress may advance only one exact owner at a time.
CREATE TABLE storage_existing_accountless_bootstrap_manifests (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  manifest_digest TEXT NOT NULL UNIQUE CHECK (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  schema_version TEXT NOT NULL CHECK (schema_version='storage-existing-accountless-bootstrap-v1'),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 128),
  source_schema_digest TEXT NOT NULL CHECK (length(source_schema_digest)=64 AND source_schema_digest NOT GLOB '*[^0-9a-f]*'),
  source_closure_digest TEXT NOT NULL CHECK (length(source_closure_digest)=64 AND source_closure_digest NOT GLOB '*[^0-9a-f]*'),
  shard_id TEXT NOT NULL REFERENCES storage_shards(shard_id),
  binding_name TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation=1),
  route_reservation_bytes INTEGER NOT NULL CHECK (route_reservation_bytes BETWEEN 1 AND 9000000000),
  owner_count INTEGER NOT NULL CHECK (owner_count BETWEEN 0 AND 10000),
  owner_roster_digest TEXT NOT NULL CHECK (length(owner_roster_digest)=64 AND owner_roster_digest NOT GLOB '*[^0-9a-f]*'),
  historical_reservation_roster_digest TEXT NOT NULL CHECK (length(historical_reservation_roster_digest)=64 AND historical_reservation_roster_digest NOT GLOB '*[^0-9a-f]*'),
  baseline_budget_day TEXT NOT NULL CHECK (length(baseline_budget_day)=10),
  baseline_daily_reserved INTEGER NOT NULL CHECK (baseline_daily_reserved BETWEEN 0 AND 1000),
  baseline_lifetime_reserved INTEGER NOT NULL CHECK (baseline_lifetime_reserved BETWEEN 0 AND 10000),
  baseline_digest TEXT NOT NULL CHECK (length(baseline_digest)=64 AND baseline_digest NOT GLOB '*[^0-9a-f]*'),
  baseline_initialized_at INTEGER NOT NULL CHECK (baseline_initialized_at>=0),
  created_at INTEGER NOT NULL CHECK (created_at>=0),
  CHECK (baseline_daily_reserved<=baseline_lifetime_reserved AND owner_count<=baseline_lifetime_reserved)
) STRICT;

CREATE TABLE storage_existing_accountless_bootstrap_progress (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id=1),
  manifest_digest TEXT NOT NULL UNIQUE REFERENCES storage_existing_accountless_bootstrap_manifests(manifest_digest),
  state TEXT NOT NULL CHECK (state IN ('importing','ready')),
  after_owner_id TEXT NOT NULL,
  imported_count INTEGER NOT NULL CHECK (imported_count BETWEEN 0 AND 10000),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 10001),
  updated_at INTEGER NOT NULL CHECK (updated_at>=0)
) STRICT;

CREATE TRIGGER storage_existing_accountless_bootstrap_manifest_gate
BEFORE INSERT ON storage_existing_accountless_bootstrap_manifests BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_shards
    WHERE shard_id=NEW.shard_id AND binding_name=NEW.binding_name AND state='active')
    OR NOT EXISTS (SELECT 1 FROM storage_accountless_historical_issuance_state
      WHERE singleton_id=1 AND import_state='importing' AND imported_count=0 AND import_revision=0)
    OR NOT EXISTS (SELECT 1 FROM storage_accountless_issuance_state
      WHERE singleton_id=1 AND initialization_state='uninitialized'
        AND daily_reserved=0 AND lifetime_reserved=0)
  THEN RAISE(ABORT,'STORAGE_EXISTING_BOOTSTRAP_CLOSED') END;
END;

CREATE TRIGGER storage_existing_accountless_bootstrap_manifest_immutable
BEFORE UPDATE ON storage_existing_accountless_bootstrap_manifests
BEGIN SELECT RAISE(ABORT,'STORAGE_EXISTING_BOOTSTRAP_IMMUTABLE'); END;
CREATE TRIGGER storage_existing_accountless_bootstrap_manifest_no_delete
BEFORE DELETE ON storage_existing_accountless_bootstrap_manifests
BEGIN SELECT RAISE(ABORT,'STORAGE_EXISTING_BOOTSTRAP_HISTORY_REQUIRED'); END;

CREATE TRIGGER storage_existing_accountless_bootstrap_progress_transition
BEFORE UPDATE ON storage_existing_accountless_bootstrap_progress
WHEN NEW.singleton_id<>OLD.singleton_id OR NEW.manifest_digest<>OLD.manifest_digest OR OLD.state='ready'
 OR NOT ((NEW.state='importing' AND OLD.state='importing'
    AND NEW.imported_count=OLD.imported_count+1 AND NEW.revision=OLD.revision+1
    AND NEW.after_owner_id>OLD.after_owner_id AND NEW.updated_at>=OLD.updated_at)
  OR (NEW.state='ready' AND OLD.state='importing'
    AND NEW.imported_count=OLD.imported_count AND NEW.after_owner_id=OLD.after_owner_id
    AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at
    AND NEW.imported_count=(SELECT owner_count FROM storage_existing_accountless_bootstrap_manifests WHERE singleton_id=1)))
BEGIN SELECT RAISE(ABORT,'STORAGE_EXISTING_BOOTSTRAP_CONFLICT'); END;

CREATE TRIGGER storage_existing_accountless_bootstrap_progress_no_delete
BEFORE DELETE ON storage_existing_accountless_bootstrap_progress
BEGIN SELECT RAISE(ABORT,'STORAGE_EXISTING_BOOTSTRAP_HISTORY_REQUIRED'); END;
