-- Forward prerequisite for namespace-preserving owner movement. This registry
-- qualifies readable provenance origins; it does not authorize copy, movement,
-- credentials, or a route switch. HTTP writes still use the format admission
-- singleton and exactly one current-write row.
CREATE TABLE typed_telemetry_origin_contracts (
 namespace_id INTEGER PRIMARY KEY REFERENCES typed_telemetry_namespaces(id),
 namespace_original BLOB NOT NULL CHECK(length(namespace_original) BETWEEN 2 AND 257),
 source_namespace TEXT GENERATED ALWAYS AS (CASE
  WHEN hex(substr(namespace_original,1,1))='00' THEN CAST(substr(namespace_original,2) AS TEXT)
  WHEN (hex(substr(namespace_original,1,1)) IN ('01','02','03','04','05','0B') AND length(namespace_original)=17)
    OR (hex(substr(namespace_original,1,1)) IN ('06','07','08','09','0A') AND length(namespace_original)=33)
  THEN (CASE hex(substr(namespace_original,1,1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
    WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
    WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
    WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
    || CASE WHEN hex(substr(namespace_original,1,1)) IN ('01','02','03','04','05','0B')
      THEN lower(hex(substr(namespace_original,2,4)))||'-'||lower(hex(substr(namespace_original,6,2)))||'-'
        ||lower(hex(substr(namespace_original,8,2)))||'-'||lower(hex(substr(namespace_original,10,2)))||'-'
        ||lower(hex(substr(namespace_original,12,6))) ELSE lower(hex(substr(namespace_original,2))) END
 END) VIRTUAL NOT NULL,
 access_mode TEXT NOT NULL CHECK(access_mode IN ('current-write','retained-read')),
 v1_read_contract_version INTEGER NOT NULL DEFAULT 0 CHECK(v1_read_contract_version IN (0,2)),
 v11_read_contract_version INTEGER NOT NULL DEFAULT 0 CHECK(v11_read_contract_version IN (0,2)),
 source_schema_digest TEXT NOT NULL CHECK(length(source_schema_digest)=64 AND source_schema_digest NOT GLOB '*[^0-9a-f]*'),
 registered_move_id TEXT,
 registered_at TEXT NOT NULL,
 UNIQUE(source_namespace),
 CHECK((access_mode='current-write' AND registered_move_id IS NULL)
   OR (access_mode='retained-read' AND length(registered_move_id) BETWEEN 1 AND 128))
) STRICT;
CREATE UNIQUE INDEX typed_telemetry_one_current_origin
 ON typed_telemetry_origin_contracts((1)) WHERE access_mode='current-write';

CREATE TRIGGER typed_telemetry_origin_insert_guard BEFORE INSERT ON typed_telemetry_origin_contracts
BEGIN
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM typed_telemetry_namespaces n
   WHERE n.id=NEW.namespace_id AND n.original_id=NEW.namespace_original)
  THEN RAISE(ABORT,'typed_origin_namespace_conflict') END);
END;
CREATE TRIGGER typed_telemetry_origin_identity_immutable BEFORE UPDATE ON typed_telemetry_origin_contracts
WHEN NEW.namespace_id IS NOT OLD.namespace_id OR NEW.namespace_original IS NOT OLD.namespace_original
 OR NEW.access_mode IS NOT OLD.access_mode OR NEW.source_schema_digest IS NOT OLD.source_schema_digest
 OR NEW.registered_move_id IS NOT OLD.registered_move_id OR NEW.registered_at IS NOT OLD.registered_at
 OR (NEW.v1_read_contract_version IS NOT OLD.v1_read_contract_version
   AND NOT(OLD.v1_read_contract_version=0 AND NEW.v1_read_contract_version=2))
 OR (NEW.v11_read_contract_version IS NOT OLD.v11_read_contract_version
   AND NOT(OLD.v11_read_contract_version=0 AND NEW.v11_read_contract_version=2))
BEGIN SELECT RAISE(ABORT,'typed_origin_immutable'); END;
CREATE TRIGGER typed_telemetry_origin_retained BEFORE DELETE ON typed_telemetry_origin_contracts
BEGIN SELECT RAISE(ABORT,'typed_origin_retained'); END;
