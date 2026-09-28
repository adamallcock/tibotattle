-- Local, opt-in, content-free shared effective owner/day features.
-- A head points only to a fully framed generation. Parts may be written by a
-- live claimant, but cannot become readable until an exact CAS promotes them.
CREATE TABLE analytics_shared_feature_days (
  job_key TEXT PRIMARY KEY CHECK(length(job_key)=64 AND job_key NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  source_namespace TEXT NOT NULL CHECK(length(source_namespace) BETWEEN 1 AND 256),
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10),
  method_digest TEXT NOT NULL CHECK(length(method_digest)=64 AND method_digest NOT GLOB '*[^0-9a-f]*'),
  dependency_digest TEXT NOT NULL CHECK(length(dependency_digest)=64 AND dependency_digest NOT GLOB '*[^0-9a-f]*'),
  owner_revision INTEGER NOT NULL CHECK(owner_revision BETWEEN 1 AND 9007199254740991),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch BETWEEN 1 AND 9007199254740991),
  input_revision INTEGER NOT NULL CHECK(input_revision BETWEEN 0 AND 9007199254740991),
  head_revision INTEGER NOT NULL DEFAULT 0 CHECK(head_revision BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'building' CHECK(state IN ('building','complete','refused')),
  payload_digest TEXT CHECK(payload_digest IS NULL OR length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(payload_bytes BETWEEN 0 AND 4194304),
  part_count INTEGER NOT NULL DEFAULT 0 CHECK(part_count BETWEEN 0 AND 33),
  claim_token TEXT CHECK(claim_token IS NULL OR length(claim_token)=36),
  claim_expires_ms INTEGER CHECK(claim_expires_ms IS NULL OR claim_expires_ms BETWEEN 0 AND 9007199254740991),
  updated_ms INTEGER NOT NULL CHECK(updated_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE(job_key,source_id,owner_digest),
  CHECK((head_revision=0 AND state='building' AND payload_digest IS NULL AND payload_bytes=0 AND part_count=0)
    OR (head_revision>0 AND payload_digest IS NOT NULL AND payload_bytes BETWEEN 1 AND 4194304
      AND part_count BETWEEN 1 AND 33)),
  CHECK((claim_token IS NULL AND claim_expires_ms IS NULL)
    OR (state='building' AND claim_expires_ms IS NOT NULL AND claim_expires_ms>updated_ms))
) STRICT;
CREATE INDEX analytics_shared_feature_owner_day ON analytics_shared_feature_days
  (source_id,owner_digest,day,method_digest);
CREATE INDEX analytics_shared_feature_source ON analytics_shared_feature_days(source_id);

-- A source-only numeric position permits capacity cleanup without retaining
-- any owner or job identity, and without scanning all source owners first.
CREATE TABLE analytics_shared_feature_sweep_cursor (
  source_id TEXT PRIMARY KEY CHECK(length(source_id) BETWEEN 1 AND 128),
  after_rowid INTEGER NOT NULL DEFAULT 0 CHECK(after_rowid BETWEEN 0 AND 9007199254740991),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE analytics_shared_feature_parts (
  job_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 32),
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 131072
    AND payload_bytes=length(CAST(payload AS BLOB))),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  claim_token TEXT NOT NULL CHECK(length(claim_token)=36),
  saved_ms INTEGER NOT NULL CHECK(saved_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(job_key,revision,part_index),
  FOREIGN KEY(job_key,source_id,owner_digest)
    REFERENCES analytics_shared_feature_days(job_key,source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_shared_feature_parts_owner ON analytics_shared_feature_parts(source_id,owner_digest);

CREATE TRIGGER analytics_shared_feature_day_insert BEFORE INSERT ON analytics_shared_feature_days
BEGIN
  SELECT CASE WHEN NEW.head_revision!=0 OR NEW.state!='building' OR NEW.claim_token IS NOT NULL
    OR (SELECT count(*) FROM analytics_shared_feature_days h
      WHERE h.source_id=NEW.source_id AND h.owner_digest=NEW.owner_digest
        AND h.day=NEW.day AND h.method_digest=NEW.method_digest)>=4
    OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o
      JOIN analytics_runtime_sources r ON r.source_id=o.source_id
      WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest
        AND o.state='active' AND o.revision=NEW.owner_revision
        AND o.authority_epoch=NEW.authority_epoch
        AND r.source_namespace=NEW.source_namespace AND r.contract_version=1
        AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
          WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
    THEN RAISE(ABORT,'analytics_shared_feature_ineligible') END;
END;
CREATE TRIGGER analytics_shared_feature_day_update BEFORE UPDATE ON analytics_shared_feature_days
BEGIN
  SELECT CASE WHEN NEW.job_key!=OLD.job_key OR NEW.source_id!=OLD.source_id
    OR NEW.source_namespace!=OLD.source_namespace OR NEW.owner_digest!=OLD.owner_digest
    OR NEW.day!=OLD.day OR NEW.method_digest!=OLD.method_digest
    OR NEW.dependency_digest!=OLD.dependency_digest OR NEW.authority_epoch!=OLD.authority_epoch
    OR NEW.owner_revision<OLD.owner_revision OR NEW.input_revision<OLD.input_revision
    OR NEW.updated_ms<OLD.updated_ms OR OLD.state!='building'
    OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o
      JOIN analytics_runtime_sources r ON r.source_id=o.source_id
      WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest
        AND o.state='active' AND o.revision=NEW.owner_revision
        AND o.authority_epoch=NEW.authority_epoch
        AND r.source_namespace=NEW.source_namespace AND r.contract_version=1
        AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
          WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
    OR NOT (
      (NEW.head_revision=OLD.head_revision AND NEW.state='building'
        AND NEW.payload_digest IS OLD.payload_digest AND NEW.payload_bytes=OLD.payload_bytes
        AND NEW.part_count=OLD.part_count AND NEW.claim_token IS NOT NULL
        AND (OLD.claim_token IS NULL OR OLD.claim_expires_ms<=NEW.updated_ms))
      OR
      (NEW.head_revision=OLD.head_revision+1 AND OLD.claim_token IS NOT NULL
        AND OLD.claim_expires_ms>NEW.updated_ms AND NEW.claim_token IS NULL
        AND NEW.state IN ('building','complete','refused')
        AND NEW.part_count=(SELECT count(*) FROM analytics_shared_feature_parts p
          WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision
            AND p.claim_token=OLD.claim_token AND p.saved_ms=NEW.updated_ms)
        AND NEW.payload_bytes=(SELECT sum(payload_bytes) FROM analytics_shared_feature_parts p
          WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision)
        AND 0=(SELECT min(part_index) FROM analytics_shared_feature_parts p
          WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision)
        AND NEW.part_count-1=(SELECT max(part_index) FROM analytics_shared_feature_parts p
          WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision))
    ) THEN RAISE(ABORT,'analytics_shared_feature_head_conflict') END;
END;
CREATE TRIGGER analytics_shared_feature_part_insert BEFORE INSERT ON analytics_shared_feature_parts
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analytics_shared_feature_days h
    JOIN analytics_owner_state o ON o.source_id=h.source_id AND o.owner_digest=h.owner_digest
    JOIN analytics_runtime_sources r ON r.source_id=h.source_id
    WHERE h.job_key=NEW.job_key AND h.source_id=NEW.source_id AND h.owner_digest=NEW.owner_digest
      AND h.head_revision+1=NEW.revision AND h.state='building'
      AND h.claim_token=NEW.claim_token AND h.claim_expires_ms>NEW.saved_ms
      AND o.state='active' AND o.revision=h.owner_revision AND o.authority_epoch=h.authority_epoch
      AND r.source_namespace=h.source_namespace AND r.contract_version=1
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=h.source_id AND f.owner_digest=h.owner_digest))
    THEN RAISE(ABORT,'analytics_shared_feature_part_ineligible') END;
END;
CREATE TRIGGER analytics_shared_feature_part_immutable BEFORE UPDATE ON analytics_shared_feature_parts
BEGIN SELECT RAISE(ABORT,'analytics_shared_feature_part_immutable'); END;
CREATE TRIGGER analytics_shared_feature_part_retained BEFORE DELETE ON analytics_shared_feature_parts
WHEN EXISTS(SELECT 1 FROM analytics_shared_feature_days h
  WHERE h.job_key=OLD.job_key AND h.head_revision=OLD.revision)
BEGIN SELECT RAISE(ABORT,'analytics_shared_feature_part_retained'); END;

CREATE TRIGGER analytics_shared_feature_owner_update AFTER UPDATE OF state,authority_epoch ON analytics_owner_state
WHEN NEW.state!='active' OR NEW.authority_epoch!=OLD.authority_epoch
BEGIN DELETE FROM analytics_shared_feature_days
  WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest
    AND (NEW.state!='active' OR state!='complete'); END;
CREATE TRIGGER analytics_shared_feature_owner_delete AFTER DELETE ON analytics_owner_state
BEGIN DELETE FROM analytics_shared_feature_days
  WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END;
CREATE TRIGGER analytics_shared_feature_runtime_update AFTER UPDATE OF source_id,source_namespace,contract_version
ON analytics_runtime_sources
WHEN NEW.source_id!=OLD.source_id OR NEW.source_namespace!=OLD.source_namespace OR NEW.contract_version!=1
BEGIN
  DELETE FROM analytics_shared_feature_days WHERE source_id=OLD.source_id;
  DELETE FROM analytics_shared_feature_sweep_cursor WHERE source_id=OLD.source_id;
END;
CREATE TRIGGER analytics_shared_feature_runtime_delete AFTER DELETE ON analytics_runtime_sources
BEGIN
  DELETE FROM analytics_shared_feature_days WHERE source_id=OLD.source_id;
  DELETE FROM analytics_shared_feature_sweep_cursor WHERE source_id=OLD.source_id;
END;
CREATE TRIGGER analytics_shared_feature_terminal_insert AFTER INSERT ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_shared_feature_days
  WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_shared_feature_terminal_update AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_shared_feature_days
  WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;

-- An exact marker makes partial schema installation an unsupported capability.
CREATE TRIGGER analytics_shared_feature_contract_v1 BEFORE UPDATE ON analytics_shared_feature_days WHEN 0
BEGIN SELECT RAISE(ABORT,'analytics_shared_feature_contract_v1'); END;
