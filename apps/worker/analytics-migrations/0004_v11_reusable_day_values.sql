-- Preserve already calculated role-local results. They lack the complete day
-- manifest/method identity needed for safe reuse and are retired normally.
ALTER TABLE analytics_v11_day_values RENAME TO analytics_v11_legacy_day_values;

CREATE TABLE analytics_v11_reusable_values (
  value_key TEXT PRIMARY KEY CHECK(length(value_key)=64),
  source_id TEXT NOT NULL,
  source_layout TEXT NOT NULL CHECK(source_layout IN ('json-v11','typed-v11')),
  source_namespace TEXT NOT NULL,
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
  device_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64),
  day TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  pricing_method TEXT NOT NULL,
  registry_sha256 TEXT NOT NULL CHECK(length(registry_sha256)=64),
  record_count INTEGER NOT NULL CHECK(record_count>=0),
  values_digest TEXT NOT NULL CHECK(length(values_digest)=64),
  values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  CHECK((source_layout='json-v11' AND source_namespace='') OR (source_layout='typed-v11' AND length(source_namespace)>0)),
  CHECK(json_extract(values_json,'$.day')=day AND json_extract(values_json,'$.schemaVersion')=schema_version
    AND json_extract(values_json,'$.pricingMethodVersion')=pricing_method AND json_extract(values_json,'$.registrySha256')=registry_sha256
    AND json_extract(values_json,'$.counts.usage')+json_extract(values_json,'$.counts.quota')+json_extract(values_json,'$.counts.session')=record_count),
  UNIQUE(source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,schema_version,pricing_method,registry_sha256)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_v11_reusable_owner ON analytics_v11_reusable_values(source_id,owner_digest,value_key);
CREATE TRIGGER analytics_v11_reusable_immutable BEFORE UPDATE ON analytics_v11_reusable_values
WHEN OLD.value_key IS NOT NEW.value_key OR OLD.source_id IS NOT NEW.source_id OR OLD.source_layout IS NOT NEW.source_layout
  OR OLD.source_namespace IS NOT NEW.source_namespace OR OLD.owner_digest IS NOT NEW.owner_digest OR OLD.device_id IS NOT NEW.device_id
  OR OLD.manifest_id IS NOT NEW.manifest_id OR OLD.manifest_digest IS NOT NEW.manifest_digest OR OLD.day IS NOT NEW.day
  OR OLD.schema_version IS NOT NEW.schema_version OR OLD.pricing_method IS NOT NEW.pricing_method OR OLD.registry_sha256 IS NOT NEW.registry_sha256
  OR OLD.record_count IS NOT NEW.record_count OR OLD.values_digest IS NOT NEW.values_digest OR OLD.values_json IS NOT NEW.values_json
BEGIN SELECT RAISE(ABORT,'analytics_v11_reusable_value_conflict'); END;

CREATE TABLE analytics_v11_day_references (
  source_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  day TEXT NOT NULL,
  value_key TEXT NOT NULL REFERENCES analytics_v11_reusable_values(value_key),
  PRIMARY KEY(source_id,event_digest,day),
  FOREIGN KEY(source_id,event_digest) REFERENCES analytics_v11_projection_work(source_id,event_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_v11_references_value ON analytics_v11_day_references(value_key);
CREATE TRIGGER analytics_v11_reference_valid BEFORE INSERT ON analytics_v11_day_references
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analytics_v11_projection_work w JOIN analytics_v11_reusable_values v
    ON v.value_key=NEW.value_key AND v.source_id=w.source_id AND v.owner_digest=w.owner_digest
      AND v.source_layout=w.source_layout AND v.source_namespace=COALESCE(w.source_namespace,'')
    WHERE w.source_id=NEW.source_id AND w.event_digest=NEW.event_digest AND w.next_day=NEW.day AND v.day=NEW.day AND w.phase='building'
      AND v.schema_version=json_extract(w.values_json,'$.schemaVersion')
      AND v.pricing_method=json_extract(w.values_json,'$.pricingMethodVersion')
      AND v.registry_sha256=json_extract(w.values_json,'$.registrySha256'))
    OR EXISTS(SELECT 1 FROM analytics_v11_legacy_day_values WHERE source_id=NEW.source_id AND event_digest=NEW.event_digest AND day=NEW.day)
    THEN RAISE(ABORT,'analytics_v11_reference_conflict') END;
END;
CREATE TRIGGER analytics_v11_reference_immutable BEFORE UPDATE ON analytics_v11_day_references
BEGIN SELECT RAISE(ABORT,'analytics_v11_reference_conflict'); END;
CREATE TRIGGER analytics_v11_reference_retained BEFORE DELETE ON analytics_v11_day_references
WHEN EXISTS(SELECT 1 FROM analytics_v11_projection_work WHERE source_id=OLD.source_id AND event_digest=OLD.event_digest AND phase!='retiring')
BEGIN SELECT RAISE(ABORT,'analytics_v11_reference_retained'); END;

-- Existing bounded readers and retirement paths retain their analytical shape.
-- No new generation writes a copy of the completed values JSON.
CREATE VIEW analytics_v11_day_values AS
  SELECT source_id,event_digest,day,record_count,values_json FROM analytics_v11_legacy_day_values
  UNION ALL
  SELECT r.source_id,r.event_digest,r.day,v.record_count,v.values_json
    FROM analytics_v11_day_references r JOIN analytics_v11_reusable_values v ON v.value_key=r.value_key;
CREATE TRIGGER analytics_v11_day_view_immutable INSTEAD OF UPDATE ON analytics_v11_day_values
BEGIN SELECT RAISE(ABORT,'analytics_v11_day_immutable'); END;
CREATE TRIGGER analytics_v11_day_view_delete INSTEAD OF DELETE ON analytics_v11_day_values
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM analytics_v11_projection_work WHERE source_id=OLD.source_id AND event_digest=OLD.event_digest AND phase!='retiring')
    THEN RAISE(ABORT,'analytics_v11_reference_retained') END;
  DELETE FROM analytics_v11_legacy_day_values WHERE source_id=OLD.source_id AND event_digest=OLD.event_digest AND day=OLD.day;
  DELETE FROM analytics_v11_day_references WHERE source_id=OLD.source_id AND event_digest=OLD.event_digest AND day=OLD.day;
END;
