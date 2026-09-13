-- A projection work item is bound to one configured ingestion database and
-- current-write namespace, while each immutable manifest may retain its
-- original qualified namespace after an owner move. Refuse older partial typed
-- work because its stream/occurrence cursor has no durable origin-set pin.
CREATE TABLE analytics_v11_origin_cursor_upgrade_guard(ok INTEGER CHECK(ok=1));
INSERT INTO analytics_v11_origin_cursor_upgrade_guard SELECT CASE WHEN EXISTS(
  SELECT 1 FROM analytics_v11_projection_work
  WHERE source_layout='typed-v11' AND phase='building' AND day_records!=0
) THEN 0 ELSE 1 END;
DROP TABLE analytics_v11_origin_cursor_upgrade_guard;

ALTER TABLE analytics_v11_projection_work ADD COLUMN day_source_namespace TEXT;
ALTER TABLE analytics_v11_projection_work ADD COLUMN day_origin_set_digest TEXT;

CREATE TRIGGER analytics_v11_day_origin_pin_insert_valid BEFORE INSERT ON analytics_v11_projection_work
WHEN NEW.day_source_namespace IS NOT NULL OR NEW.day_origin_set_digest IS NOT NULL
BEGIN SELECT RAISE(ABORT,'analytics_v11_day_origin_pin_conflict'); END;
CREATE TRIGGER analytics_v11_day_origin_pin_valid BEFORE UPDATE ON analytics_v11_projection_work
WHEN (NEW.day_source_namespace IS NULL)!=(NEW.day_origin_set_digest IS NULL)
 OR (NEW.day_source_namespace IS NOT NULL AND
   (NEW.phase NOT IN ('building','retiring') OR length(NEW.day_origin_set_digest)!=64
    OR (NEW.source_layout='json-v11' AND NEW.day_source_namespace!='')
    OR (NEW.source_layout='typed-v11' AND length(NEW.day_source_namespace)=0)))
 OR (NEW.day_records!=0 AND NEW.day_source_namespace IS NULL)
 OR (NEW.phase='ready' AND NEW.day_source_namespace IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'analytics_v11_day_origin_pin_conflict'); END;

DROP TRIGGER analytics_v11_reference_valid;
CREATE TRIGGER analytics_v11_reference_valid BEFORE INSERT ON analytics_v11_day_references
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analytics_v11_projection_work w JOIN analytics_v11_reusable_values v
    ON v.value_key=NEW.value_key AND v.source_id=w.source_id AND v.owner_digest=w.owner_digest
      AND v.source_layout=w.source_layout AND v.source_namespace=w.day_source_namespace
    WHERE w.source_id=NEW.source_id AND w.event_digest=NEW.event_digest AND w.next_day=NEW.day AND v.day=NEW.day
      AND w.phase='building' AND w.day_origin_set_digest IS NOT NULL
      AND v.schema_version=json_extract(w.values_json,'$.schemaVersion')
      AND v.pricing_method=json_extract(w.values_json,'$.pricingMethodVersion')
      AND v.registry_sha256=json_extract(w.values_json,'$.registrySha256'))
    OR EXISTS(SELECT 1 FROM analytics_v11_legacy_day_values WHERE source_id=NEW.source_id AND event_digest=NEW.event_digest AND day=NEW.day)
    THEN RAISE(ABORT,'analytics_v11_reference_conflict') END;
END;
