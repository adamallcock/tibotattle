-- Bounded analytical pages retain every model cell; this is not another raw
-- record ledger. A reusable summary is admitted only after all pages exist.
CREATE TABLE analytics_v11_value_pages (
  value_key TEXT NOT NULL CHECK(length(value_key)=64),
  page_index INTEGER NOT NULL CHECK(page_index>=0 AND page_index<30000),
  source_id TEXT NOT NULL, owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
  producer_event TEXT NOT NULL CHECK(length(producer_event)=64),
  day TEXT NOT NULL, record_count INTEGER NOT NULL CHECK(record_count BETWEEN 1 AND 200),
  page_digest TEXT NOT NULL CHECK(length(page_digest)=64),
  values_json TEXT NOT NULL CHECK(json_valid(values_json) AND length(CAST(values_json AS BLOB))<=262144),
  PRIMARY KEY(value_key,page_index),
  CHECK(json_extract(values_json,'$.schemaVersion')='v11-daily-projection-values-v2'
    AND json_extract(values_json,'$.day')=day AND json_extract(values_json,'$.omitted.usageEvents')=0
    AND json_extract(values_json,'$.counts.usage')+json_extract(values_json,'$.counts.quota')+json_extract(values_json,'$.counts.session')=record_count)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_v11_pages_owner ON analytics_v11_value_pages(source_id,owner_digest,value_key,page_index);
CREATE TRIGGER analytics_v11_page_valid BEFORE INSERT ON analytics_v11_value_pages
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analytics_v11_projection_work w
    WHERE w.source_id=NEW.source_id AND w.event_digest=NEW.producer_event AND w.owner_digest=NEW.owner_digest
      AND w.phase='building' AND w.next_day=NEW.day AND w.day_records=NEW.page_index*200)
    THEN RAISE(ABORT,'analytics_v11_page_conflict') END;
END;
CREATE TRIGGER analytics_v11_page_immutable BEFORE UPDATE ON analytics_v11_value_pages
WHEN OLD.value_key IS NOT NEW.value_key OR OLD.page_index IS NOT NEW.page_index
 OR OLD.source_id IS NOT NEW.source_id OR OLD.owner_digest IS NOT NEW.owner_digest
 OR OLD.producer_event IS NOT NEW.producer_event OR OLD.day IS NOT NEW.day
 OR OLD.record_count IS NOT NEW.record_count OR OLD.page_digest IS NOT NEW.page_digest OR OLD.values_json IS NOT NEW.values_json
BEGIN SELECT RAISE(ABORT,'analytics_v11_page_conflict'); END;
CREATE TRIGGER analytics_v11_page_retained BEFORE DELETE ON analytics_v11_value_pages
WHEN EXISTS(SELECT 1 FROM analytics_v11_day_references r WHERE r.value_key=OLD.value_key)
 OR EXISTS(SELECT 1 FROM analytics_v11_projection_work w WHERE w.source_id=OLD.source_id
   AND w.event_digest=OLD.producer_event AND w.phase!='retiring')
BEGIN SELECT RAISE(ABORT,'analytics_v11_page_retained'); END;
CREATE TRIGGER analytics_v11_summary_pages_complete BEFORE INSERT ON analytics_v11_reusable_values
WHEN NEW.schema_version='v11-daily-projection-values-v2'
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM analytics_v11_value_pages WHERE value_key=NEW.value_key)!=(NEW.record_count+199)/200
    OR COALESCE((SELECT SUM(record_count) FROM analytics_v11_value_pages WHERE value_key=NEW.value_key),0)!=NEW.record_count
    OR EXISTS(SELECT 1 FROM analytics_v11_value_pages p WHERE p.value_key=NEW.value_key
      AND (p.source_id!=NEW.source_id OR p.owner_digest!=NEW.owner_digest OR p.day!=NEW.day
        OR p.page_index>=(NEW.record_count+199)/200
        OR (p.page_index<(NEW.record_count-1)/200 AND p.record_count!=200)))
    THEN RAISE(ABORT,'analytics_v11_pages_incomplete') END;
END;
-- Previous arithmetic checkpoints were complete <=200-cell states. This exact
-- shape upgrade adds a zero omitted subtotal without changing any accounting.
UPDATE analytics_v11_projection_work SET values_json=json_set(values_json,
  '$.schemaVersion','v11-daily-projection-values-v2','$.omitted',json('{"usageEvents":0,"tokens":{"inputUncachedTokens":{"knownSum":"0","unavailable":0},"inputCacheReadTokens":{"knownSum":"0","unavailable":0},"inputCacheWriteTokens":{"knownSum":"0","unavailable":0},"outputTextTokens":{"knownSum":"0","unavailable":0},"outputReasoningTokens":{"knownSum":"0","unavailable":0},"outputCombinedTokens":{"knownSum":"0","unavailable":0},"effectiveOutput":{"knownSum":"0","unavailable":0},"nonOverlappingTotal":{"knownSum":"0","unavailable":0}},"pricing":{"knownNanousd":"0","fullyPriced":0,"partiallyPriced":0,"unpriced":0}}'))
WHERE json_extract(values_json,'$.schemaVersion')='v11-daily-projection-values-v1' AND day_records=0;
-- In-progress older days have no retained value pages. Refuse rather than
-- blessing missing detail; the normal explicit event retirement/replay path
-- must reconcile them before this local-role schema can be qualified.
CREATE TABLE analytics_v11_pages_upgrade_guard(ok INTEGER CHECK(ok=1));
INSERT INTO analytics_v11_pages_upgrade_guard SELECT CASE WHEN EXISTS(
 SELECT 1 FROM analytics_v11_projection_work WHERE json_extract(values_json,'$.schemaVersion')='v11-daily-projection-values-v1' AND day_records!=0
) THEN 0 ELSE 1 END;
DROP TABLE analytics_v11_pages_upgrade_guard;
