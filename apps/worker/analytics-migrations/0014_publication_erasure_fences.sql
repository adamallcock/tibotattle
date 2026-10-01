-- Full isolated role only: the following 0015 migration owns the independent
-- source-proven analytics_storage_erasure_fences table. Role installation must
-- finish before writers run. Its priority fence never advances ordered delivery.
CREATE TRIGGER analytics_daily_owner_erased_insert BEFORE INSERT ON analytics_community_daily_owners
WHEN EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
 OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'analytics_daily_owner_erased'); END;
CREATE TRIGGER analytics_daily_owner_erased_update BEFORE UPDATE ON analytics_community_daily_owners
WHEN EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
 OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'analytics_daily_owner_erased'); END;

-- The target remembers the highest independently delivered privacy epoch.
-- A writer captured before erasure cannot recreate an aggregate after physical
-- cleanup, even if its original source read preceded a delayed target write.
CREATE TRIGGER analytics_daily_authority_insert BEFORE INSERT ON analytics_community_daily_publications
WHEN json_type(NEW.authority_json,'$.publicAuthorityEpoch') IS NOT 'integer'
 OR json_extract(NEW.authority_json,'$.sourceId') IS NOT NEW.source_id
 OR json_extract(NEW.authority_json,'$.publicAuthorityEpoch')<max(
  COALESCE((SELECT authority_epoch FROM analytics_source_cursors WHERE source_id=NEW.source_id),0),
  COALESCE((SELECT max(public_authority_epoch) FROM analytics_storage_erasure_fences WHERE source_id=NEW.source_id),0))
BEGIN SELECT RAISE(ABORT,'analytics_publication_authority_stale'); END;

CREATE TRIGGER analytics_model_authority_insert BEFORE INSERT ON analytics_community_model_publications
WHEN json_type(NEW.authority_json,'$.publicAuthorityEpoch') IS NOT 'integer'
 OR json_extract(NEW.authority_json,'$.sourceId') IS NOT NEW.source_id
 OR json_extract(NEW.authority_json,'$.publicAuthorityEpoch')<max(
  COALESCE((SELECT authority_epoch FROM analytics_source_cursors WHERE source_id=NEW.source_id),0),
  COALESCE((SELECT max(public_authority_epoch) FROM analytics_storage_erasure_fences WHERE source_id=NEW.source_id),0))
BEGIN SELECT RAISE(ABORT,'analytics_publication_authority_stale'); END;
CREATE TRIGGER analytics_model_authority_update BEFORE UPDATE ON analytics_community_model_publications
WHEN json_type(NEW.authority_json,'$.publicAuthorityEpoch') IS NOT 'integer'
 OR json_extract(NEW.authority_json,'$.sourceId') IS NOT NEW.source_id
 OR json_extract(NEW.authority_json,'$.publicAuthorityEpoch')<max(
  COALESCE((SELECT authority_epoch FROM analytics_source_cursors WHERE source_id=NEW.source_id),0),
  COALESCE((SELECT max(public_authority_epoch) FROM analytics_storage_erasure_fences WHERE source_id=NEW.source_id),0))
BEGIN SELECT RAISE(ABORT,'analytics_publication_authority_stale'); END;

CREATE TRIGGER analytics_preview_authority_insert BEFORE INSERT ON analytics_community_graph_previews
WHEN json_type(NEW.authority_json,'$.publicAuthorityEpoch') IS NOT 'integer'
 OR json_extract(NEW.authority_json,'$.sourceId') IS NOT NEW.source_id
 OR json_extract(NEW.authority_json,'$.publicAuthorityEpoch')<max(
  COALESCE((SELECT authority_epoch FROM analytics_source_cursors WHERE source_id=NEW.source_id),0),
  COALESCE((SELECT max(public_authority_epoch) FROM analytics_storage_erasure_fences WHERE source_id=NEW.source_id),0))
BEGIN SELECT RAISE(ABORT,'analytics_publication_authority_stale'); END;
CREATE TRIGGER analytics_preview_authority_update BEFORE UPDATE ON analytics_community_graph_previews
WHEN json_type(NEW.authority_json,'$.publicAuthorityEpoch') IS NOT 'integer'
 OR json_extract(NEW.authority_json,'$.sourceId') IS NOT NEW.source_id
 OR json_extract(NEW.authority_json,'$.publicAuthorityEpoch')<max(
  COALESCE((SELECT authority_epoch FROM analytics_source_cursors WHERE source_id=NEW.source_id),0),
  COALESCE((SELECT max(public_authority_epoch) FROM analytics_storage_erasure_fences WHERE source_id=NEW.source_id),0))
BEGIN SELECT RAISE(ABORT,'analytics_publication_authority_stale'); END;
