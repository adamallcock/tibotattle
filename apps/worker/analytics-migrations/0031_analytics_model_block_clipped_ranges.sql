-- Extend bounded owner policy to four exact clipped ranges. Existing jobs,
-- part rows, and 0030 policy rows remain in place during this forward step.
ALTER TABLE analytics_model_block_policy ADD COLUMN range2_from TEXT CHECK(range2_from IS NULL OR length(range2_from)=10);
ALTER TABLE analytics_model_block_policy ADD COLUMN range2_through TEXT CHECK(range2_through IS NULL OR length(range2_through)=10);
ALTER TABLE analytics_model_block_policy ADD COLUMN range3_from TEXT CHECK(range3_from IS NULL OR length(range3_from)=10);
ALTER TABLE analytics_model_block_policy ADD COLUMN range3_through TEXT CHECK(range3_through IS NULL OR length(range3_through)=10);

DROP TRIGGER analytics_model_blocks_insert;
DROP TRIGGER analytics_model_blocks_update;
DROP TRIGGER analytics_model_block_parts_insert;

CREATE TRIGGER analytics_model_blocks_insert BEFORE INSERT ON analytics_model_blocks
BEGIN
  SELECT CASE WHEN NEW.head_revision!=0 OR NEW.claim_token IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id
    WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
      AND o.authority_epoch=NEW.authority_epoch AND o.revision=json_extract(NEW.identity_json,'$.ownerRevision')
      AND r.contract_version=1 AND r.source_namespace=NEW.source_namespace
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
    OR NOT ((NEW.admission_revision IS NULL AND NOT EXISTS(SELECT 1 FROM analytics_model_block_policy p
        WHERE p.source_id=NEW.source_id AND p.owner_digest=NEW.owner_digest))
      OR EXISTS(SELECT 1 FROM analytics_model_block_policy p WHERE p.source_id=NEW.source_id
        AND p.owner_digest=NEW.owner_digest AND p.policy_revision=NEW.admission_revision
        AND p.source_namespace=NEW.source_namespace
        AND p.owner_revision=json_extract(NEW.identity_json,'$.ownerRevision')
        AND p.authority_epoch=NEW.authority_epoch
        AND p.input_revision=json_extract(NEW.identity_json,'$.inputRevision')
        AND p.method=json_extract(NEW.identity_json,'$.method')
        AND p.authority_digest=json_extract(NEW.identity_json,'$.authorityDigest')
        AND ((p.range0_from=json_extract(NEW.identity_json,'$.outputFromDay')
          AND p.range0_through=json_extract(NEW.identity_json,'$.outputThroughDay'))
          OR (p.range2_from=json_extract(NEW.identity_json,'$.outputFromDay')
          AND p.range2_through=json_extract(NEW.identity_json,'$.outputThroughDay'))
          OR (p.range3_from=json_extract(NEW.identity_json,'$.outputFromDay')
          AND p.range3_through=json_extract(NEW.identity_json,'$.outputThroughDay'))
          OR (p.range1_from=json_extract(NEW.identity_json,'$.outputFromDay')
          AND p.range1_through=json_extract(NEW.identity_json,'$.outputThroughDay')))))
    THEN RAISE(ABORT,'analytics_model_block_ineligible') END;
END;

CREATE TRIGGER analytics_model_blocks_update BEFORE UPDATE ON analytics_model_blocks
BEGIN
  SELECT CASE WHEN NEW.job_key!=OLD.job_key OR NEW.identity_json!=OLD.identity_json
    OR NEW.source_id!=OLD.source_id OR NEW.source_namespace!=OLD.source_namespace
    OR NEW.owner_digest!=OLD.owner_digest OR NEW.authority_epoch!=OLD.authority_epoch
    OR NEW.admission_revision IS NOT OLD.admission_revision
    OR NEW.updated_ms<OLD.updated_ms OR OLD.state='complete' OR NOT EXISTS(
      SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id
      WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
        AND o.authority_epoch=NEW.authority_epoch AND o.revision=json_extract(NEW.identity_json,'$.ownerRevision')
        AND r.contract_version=1 AND r.source_namespace=NEW.source_namespace
        AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
          WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
    OR EXISTS(SELECT 1 FROM analytics_model_block_policy p WHERE p.source_id=NEW.source_id
      AND p.owner_digest=NEW.owner_digest AND (p.source_namespace!=NEW.source_namespace
        OR p.owner_revision!=json_extract(NEW.identity_json,'$.ownerRevision')
        OR p.authority_epoch!=NEW.authority_epoch
        OR p.input_revision!=json_extract(NEW.identity_json,'$.inputRevision')
        OR p.method!=json_extract(NEW.identity_json,'$.method')
        OR p.authority_digest!=json_extract(NEW.identity_json,'$.authorityDigest')
        OR NOT COALESCE(((p.range0_from=json_extract(NEW.identity_json,'$.outputFromDay')
          AND p.range0_through=json_extract(NEW.identity_json,'$.outputThroughDay'))
          OR (p.range2_from=json_extract(NEW.identity_json,'$.outputFromDay')
          AND p.range2_through=json_extract(NEW.identity_json,'$.outputThroughDay'))
          OR (p.range3_from=json_extract(NEW.identity_json,'$.outputFromDay')
          AND p.range3_through=json_extract(NEW.identity_json,'$.outputThroughDay'))
          OR (p.range1_from=json_extract(NEW.identity_json,'$.outputFromDay')
          AND p.range1_through=json_extract(NEW.identity_json,'$.outputThroughDay'))),0)))
    THEN RAISE(ABORT,'analytics_model_block_ineligible') END;
  SELECT CASE WHEN NOT (
    (NEW.head_revision=OLD.head_revision AND OLD.head_revision>0
      AND NEW.state=OLD.state AND NEW.checkpoint_digest IS OLD.checkpoint_digest
      AND NEW.checkpoint_bytes=OLD.checkpoint_bytes AND NEW.part_count=OLD.part_count
      AND ((NEW.claim_token IS NULL AND OLD.claim_token IS NOT NULL)
        OR (NEW.claim_token IS NOT NULL AND (OLD.claim_token IS NULL OR OLD.claim_expires_ms<=NEW.updated_ms))))
    OR (NEW.head_revision=OLD.head_revision+1 AND NEW.claim_token IS NULL
      AND (OLD.head_revision=0 OR (OLD.claim_token IS NOT NULL AND OLD.claim_expires_ms>NEW.updated_ms))
      AND NEW.part_count=(SELECT COUNT(*) FROM analytics_model_block_parts p WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision)
      AND NEW.checkpoint_bytes=(SELECT SUM(payload_bytes) FROM analytics_model_block_parts p WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision)
      AND 0=(SELECT MIN(part_index) FROM analytics_model_block_parts p WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision)
      AND NEW.part_count-1=(SELECT MAX(part_index) FROM analytics_model_block_parts p WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision)
      AND NOT EXISTS(SELECT 1 FROM analytics_model_block_parts p WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision
        AND (p.claim_token IS NOT OLD.claim_token OR p.saved_ms!=NEW.updated_ms))))
    THEN RAISE(ABORT,'analytics_model_block_head_conflict') END;
END;

CREATE TRIGGER analytics_model_block_parts_insert BEFORE INSERT ON analytics_model_block_parts
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analytics_model_blocks h
    JOIN analytics_owner_state o ON o.source_id=h.source_id AND o.owner_digest=h.owner_digest
    JOIN analytics_runtime_sources r ON r.source_id=h.source_id
    WHERE h.job_key=NEW.job_key AND h.source_id=NEW.source_id AND h.owner_digest=NEW.owner_digest
      AND o.state='active' AND o.authority_epoch=h.authority_epoch
      AND o.revision=json_extract(h.identity_json,'$.ownerRevision')
      AND r.contract_version=1 AND r.source_namespace=h.source_namespace
      AND (NOT EXISTS(SELECT 1 FROM analytics_model_block_policy p WHERE p.source_id=h.source_id
        AND p.owner_digest=h.owner_digest) OR EXISTS(SELECT 1 FROM analytics_model_block_policy p
        WHERE p.source_id=h.source_id AND p.owner_digest=h.owner_digest
        AND p.source_namespace=h.source_namespace
        AND p.owner_revision=json_extract(h.identity_json,'$.ownerRevision')
        AND p.authority_epoch=h.authority_epoch
        AND p.input_revision=json_extract(h.identity_json,'$.inputRevision')
        AND p.method=json_extract(h.identity_json,'$.method')
        AND p.authority_digest=json_extract(h.identity_json,'$.authorityDigest')
        AND ((p.range0_from=json_extract(h.identity_json,'$.outputFromDay')
          AND p.range0_through=json_extract(h.identity_json,'$.outputThroughDay'))
          OR (p.range2_from=json_extract(h.identity_json,'$.outputFromDay')
          AND p.range2_through=json_extract(h.identity_json,'$.outputThroughDay'))
          OR (p.range3_from=json_extract(h.identity_json,'$.outputFromDay')
          AND p.range3_through=json_extract(h.identity_json,'$.outputThroughDay'))
          OR (p.range1_from=json_extract(h.identity_json,'$.outputFromDay')
          AND p.range1_through=json_extract(h.identity_json,'$.outputThroughDay')))))
      AND h.head_revision+1=NEW.revision AND h.state='pending' AND NEW.saved_ms>=h.updated_ms
      AND NEW.claim_token IS h.claim_token
      AND (h.head_revision=0 OR h.claim_expires_ms>NEW.saved_ms)
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=h.source_id AND f.owner_digest=h.owner_digest))
    THEN RAISE(ABORT,'analytics_model_block_part_ineligible') END;
END;

-- A capability marker that also closes the two added nullable pairs.
CREATE TRIGGER analytics_model_block_clipped_ranges_v1 BEFORE INSERT ON analytics_model_block_policy
BEGIN
  SELECT CASE WHEN (NEW.range2_from IS NULL)!=(NEW.range2_through IS NULL)
    OR (NEW.range3_from IS NULL)!=(NEW.range3_through IS NULL)
    OR (NEW.range2_from IS NOT NULL AND NEW.range1_from IS NULL)
    OR (NEW.range3_from IS NOT NULL AND NEW.range2_from IS NULL)
    OR (NEW.range2_from IS NOT NULL AND NEW.range2_from<=NEW.range1_through)
    OR (NEW.range3_from IS NOT NULL AND NEW.range3_from<=NEW.range2_through)
    THEN RAISE(ABORT,'analytics_model_block_policy_ineligible') END;
END;

-- A capability marker that also closes the two added nullable pairs.
CREATE TRIGGER analytics_model_block_clipped_ranges_update_v1 BEFORE UPDATE ON analytics_model_block_policy
BEGIN
  SELECT CASE WHEN (NEW.range2_from IS NULL)!=(NEW.range2_through IS NULL)
    OR (NEW.range3_from IS NULL)!=(NEW.range3_through IS NULL)
    OR (NEW.range2_from IS NOT NULL AND NEW.range1_from IS NULL)
    OR (NEW.range3_from IS NOT NULL AND NEW.range2_from IS NULL)
    OR (NEW.range2_from IS NOT NULL AND NEW.range2_from<=NEW.range1_through)
    OR (NEW.range3_from IS NOT NULL AND NEW.range3_from<=NEW.range2_through)
    THEN RAISE(ABORT,'analytics_model_block_policy_ineligible') END;
END;
