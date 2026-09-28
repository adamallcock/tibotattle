-- Local experimental model blocks. No production lane reads these tables.
-- Checkpoints and private outputs share an atomic, claimed head; unreferenced
-- parts are never results. The final marker is the runtime capability gate.
CREATE TABLE analytics_model_blocks (
  job_key TEXT PRIMARY KEY CHECK(length(job_key)=64 AND job_key NOT GLOB '*[^0-9a-f]*'),
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
  source_id TEXT NOT NULL CHECK(length(source_id)>0),
  source_namespace TEXT NOT NULL CHECK(length(source_namespace)>0),
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch BETWEEN 1 AND 9007199254740991),
  admission_revision INTEGER CHECK(admission_revision IS NULL OR admission_revision BETWEEN 1 AND 9007199254740991),
  head_revision INTEGER NOT NULL DEFAULT 0 CHECK(head_revision BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete')),
  checkpoint_digest TEXT,
  checkpoint_bytes INTEGER NOT NULL DEFAULT 0,
  part_count INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claim_expires_ms INTEGER,
  updated_ms INTEGER NOT NULL CHECK(updated_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE(job_key,source_id,owner_digest),
  CHECK((head_revision=0 AND state='pending' AND checkpoint_digest IS NULL AND checkpoint_bytes=0 AND part_count=0)
    OR (head_revision>0 AND checkpoint_digest IS NOT NULL AND length(checkpoint_digest)=64 AND checkpoint_digest NOT GLOB '*[^0-9a-f]*'
      AND checkpoint_bytes BETWEEN 1 AND 10485760 AND part_count BETWEEN 1 AND 81)),
  CHECK((claim_token IS NULL AND claim_expires_ms IS NULL)
    OR (head_revision>0 AND state='pending' AND length(claim_token)=36
      AND claim_expires_ms IS NOT NULL AND claim_expires_ms BETWEEN 0 AND 9007199254740991 AND claim_expires_ms>updated_ms))
) STRICT;
CREATE INDEX analytics_model_blocks_owner ON analytics_model_blocks(source_id,owner_digest);
-- A source-only index orders its implicit rowid inside each source. Capacity
-- cleanup scans four physical heads at a time, independent of owner count.
CREATE INDEX analytics_model_blocks_source_cursor ON analytics_model_blocks(source_id);
CREATE TABLE analytics_model_block_parts (
  job_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 80),
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 131072 AND payload_bytes=length(CAST(payload AS BLOB))),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  claim_token TEXT,
  saved_ms INTEGER NOT NULL CHECK(saved_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(job_key,revision,part_index),
  FOREIGN KEY(job_key,source_id,owner_digest) REFERENCES analytics_model_blocks(job_key,source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_model_block_parts_owner ON analytics_model_block_parts(source_id,owner_digest);

-- One bounded policy per owner. The caller captures the source after reading
-- this row, then advances its revision with a target-side CAS. Jobs may carry
-- an older admission revision while their exact authority/range stays current;
-- each read/claim/save still presents the newest policy token.
CREATE TABLE analytics_model_block_policy (
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK(policy_revision BETWEEN 1 AND 9007199254740991),
  source_namespace TEXT NOT NULL,
  owner_revision INTEGER NOT NULL CHECK(owner_revision BETWEEN 1 AND 9007199254740991),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch BETWEEN 1 AND 9007199254740991),
  input_revision INTEGER NOT NULL CHECK(input_revision BETWEEN 0 AND 9007199254740991),
  method TEXT NOT NULL,
  authority_digest TEXT NOT NULL CHECK(length(authority_digest)=64 AND authority_digest NOT GLOB '*[^0-9a-f]*'),
  today_day TEXT NOT NULL CHECK(length(today_day)=10),
  range0_from TEXT CHECK(range0_from IS NULL OR length(range0_from)=10),
  range0_through TEXT CHECK(range0_through IS NULL OR length(range0_through)=10),
  range1_from TEXT CHECK(range1_from IS NULL OR length(range1_from)=10),
  range1_through TEXT CHECK(range1_through IS NULL OR length(range1_through)=10),
  updated_ms INTEGER NOT NULL CHECK(updated_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(source_id,owner_digest),
  CHECK((range0_from IS NULL)=(range0_through IS NULL)),
  CHECK((range1_from IS NULL)=(range1_through IS NULL)),
  CHECK(range0_from IS NOT NULL OR range1_from IS NULL)
) STRICT, WITHOUT ROWID;

-- No owner or job identity is retained in this progress cursor.
CREATE TABLE analytics_model_block_retirement_cursors (
  source_id TEXT PRIMARY KEY CHECK(length(source_id)>0),
  after_rowid INTEGER NOT NULL DEFAULT 0 CHECK(after_rowid BETWEEN 0 AND 9007199254740991),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_model_block_cursor_runtime_update AFTER UPDATE OF source_id,source_namespace,contract_version
ON analytics_runtime_sources
WHEN NEW.source_id!=OLD.source_id OR NEW.source_namespace!=OLD.source_namespace OR NEW.contract_version!=1
BEGIN DELETE FROM analytics_model_block_retirement_cursors WHERE source_id=OLD.source_id; END;
CREATE TRIGGER analytics_model_block_cursor_runtime_delete AFTER DELETE ON analytics_runtime_sources
BEGIN DELETE FROM analytics_model_block_retirement_cursors WHERE source_id=OLD.source_id; END;

CREATE TRIGGER analytics_model_block_policy_insert BEFORE INSERT ON analytics_model_block_policy
BEGIN
  SELECT CASE WHEN NEW.policy_revision!=1 OR NOT EXISTS(
    SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id
    WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
      AND o.revision=NEW.owner_revision AND o.authority_epoch=NEW.authority_epoch
      AND r.source_namespace=NEW.source_namespace AND r.contract_version=1
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
    THEN RAISE(ABORT,'analytics_model_block_policy_ineligible') END;
END;
CREATE TRIGGER analytics_model_block_policy_update BEFORE UPDATE ON analytics_model_block_policy
BEGIN
  SELECT CASE WHEN NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest
    OR NEW.policy_revision!=OLD.policy_revision+1 OR NEW.today_day<OLD.today_day
    OR NEW.updated_ms<OLD.updated_ms OR NOT EXISTS(
      SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id
      WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
        AND o.revision=NEW.owner_revision AND o.authority_epoch=NEW.authority_epoch
        AND r.source_namespace=NEW.source_namespace AND r.contract_version=1
        AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
          WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
    THEN RAISE(ABORT,'analytics_model_block_policy_ineligible') END;
END;

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
        OR NOT ((p.range0_from=json_extract(NEW.identity_json,'$.outputFromDay')
          AND p.range0_through=json_extract(NEW.identity_json,'$.outputThroughDay'))
          OR (p.range1_from=json_extract(NEW.identity_json,'$.outputFromDay')
          AND p.range1_through=json_extract(NEW.identity_json,'$.outputThroughDay')))))
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
          OR (p.range1_from=json_extract(h.identity_json,'$.outputFromDay')
          AND p.range1_through=json_extract(h.identity_json,'$.outputThroughDay')))))
      AND h.head_revision+1=NEW.revision AND h.state='pending' AND NEW.saved_ms>=h.updated_ms
      AND NEW.claim_token IS h.claim_token
      AND (h.head_revision=0 OR h.claim_expires_ms>NEW.saved_ms)
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=h.source_id AND f.owner_digest=h.owner_digest))
    THEN RAISE(ABORT,'analytics_model_block_part_ineligible') END;
END;
CREATE TRIGGER analytics_model_block_parts_immutable BEFORE UPDATE ON analytics_model_block_parts
BEGIN SELECT RAISE(ABORT,'analytics_model_block_part_immutable'); END;
CREATE TRIGGER analytics_model_block_parts_retained BEFORE DELETE ON analytics_model_block_parts
WHEN EXISTS(SELECT 1 FROM analytics_model_blocks h WHERE h.job_key=OLD.job_key AND h.head_revision=OLD.revision)
BEGIN SELECT RAISE(ABORT,'analytics_model_block_part_retained'); END;

CREATE TRIGGER analytics_model_blocks_owner_update AFTER UPDATE OF state,authority_epoch ON analytics_owner_state
WHEN NEW.state!='active' OR NEW.authority_epoch!=OLD.authority_epoch
BEGIN DELETE FROM analytics_model_blocks WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END;
CREATE TRIGGER analytics_model_blocks_owner_delete AFTER DELETE ON analytics_owner_state
BEGIN DELETE FROM analytics_model_blocks WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END;
CREATE TRIGGER analytics_model_blocks_runtime_update AFTER UPDATE OF source_id,source_namespace,contract_version ON analytics_runtime_sources
WHEN NEW.source_id!=OLD.source_id OR NEW.source_namespace!=OLD.source_namespace OR NEW.contract_version!=1
BEGIN DELETE FROM analytics_model_blocks WHERE source_id=OLD.source_id; END;
CREATE TRIGGER analytics_model_blocks_runtime_delete AFTER DELETE ON analytics_runtime_sources
BEGIN DELETE FROM analytics_model_blocks WHERE source_id=OLD.source_id; END;
CREATE TRIGGER analytics_model_blocks_terminal_insert AFTER INSERT ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_model_blocks WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_model_blocks_terminal_update AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_model_blocks WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;

CREATE TRIGGER analytics_model_block_policy_owner_update AFTER UPDATE OF state,authority_epoch ON analytics_owner_state
WHEN NEW.state!='active' OR NEW.authority_epoch!=OLD.authority_epoch
BEGIN DELETE FROM analytics_model_block_policy WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END;
CREATE TRIGGER analytics_model_block_policy_owner_delete AFTER DELETE ON analytics_owner_state
BEGIN DELETE FROM analytics_model_block_policy WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END;
CREATE TRIGGER analytics_model_block_policy_runtime_update AFTER UPDATE OF source_id,source_namespace,contract_version ON analytics_runtime_sources
WHEN NEW.source_id!=OLD.source_id OR NEW.source_namespace!=OLD.source_namespace OR NEW.contract_version!=1
BEGIN DELETE FROM analytics_model_block_policy WHERE source_id=OLD.source_id; END;
CREATE TRIGGER analytics_model_block_policy_runtime_delete AFTER DELETE ON analytics_runtime_sources
BEGIN DELETE FROM analytics_model_block_policy WHERE source_id=OLD.source_id; END;
CREATE TRIGGER analytics_model_block_policy_terminal_insert AFTER INSERT ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_model_block_policy WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_model_block_policy_terminal_update AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_model_block_policy WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;

CREATE TRIGGER analytics_model_block_contract_v1 BEFORE UPDATE ON analytics_model_blocks WHEN 0
BEGIN SELECT RAISE(ABORT,'analytics_model_block_contract_v1'); END;

-- Counts every physical parent, including obsolete leased jobs. The writer's
-- SELECT guard keeps expected capacity refusal non-exceptional; this trigger
-- also protects direct inserts and racing callers in the serialized target.
CREATE TRIGGER analytics_model_block_admission_v2 BEFORE INSERT ON analytics_model_blocks
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM analytics_model_blocks
    WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest)>=4
    THEN RAISE(ABORT,'analytics_model_block_capacity') END;
END;
