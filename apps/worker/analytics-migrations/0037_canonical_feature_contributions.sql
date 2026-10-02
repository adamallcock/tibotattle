-- Normalized contributions of canonical revisions. The existing 0032 bounded
-- shared-feature heads/parts remain the single complete day-feature store.
CREATE TABLE analytics_canonical_feature_quantities (
 fact_revision TEXT PRIMARY KEY REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 method TEXT NOT NULL CHECK(method='canonical-feature-quantities-v1'),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=16384),
 payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_feature_prices (
 fact_revision TEXT NOT NULL REFERENCES analytics_canonical_feature_quantities(fact_revision) ON DELETE CASCADE,
 family TEXT NOT NULL CHECK(family IN ('daily','fit')),
 dependency_digest TEXT NOT NULL CHECK(length(dependency_digest)=64),
 method_digest TEXT NOT NULL CHECK(length(method_digest)=64),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=4096),
 payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
 PRIMARY KEY(fact_revision,family,dependency_digest)
) STRICT, WITHOUT ROWID;
-- Membership is an independently sealed role contract, never inferred from
-- source variant counts or from partition/job identity.
CREATE TABLE analytics_canonical_feature_membership (
 fact_revision TEXT NOT NULL REFERENCES analytics_canonical_feature_quantities(fact_revision) ON DELETE CASCADE,
 dependency_revision TEXT NOT NULL CHECK(length(dependency_revision)=64),
 method TEXT NOT NULL,
 contributor_key TEXT NOT NULL CHECK(length(contributor_key)=64),
 device_keys_json TEXT NOT NULL CHECK(json_valid(device_keys_json) AND json_type(device_keys_json)='array'),
 PRIMARY KEY(fact_revision,dependency_revision)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_activity_heads (
 content_revision TEXT PRIMARY KEY REFERENCES analytics_canonical_manifests(content_revision) ON DELETE CASCADE,
 method TEXT NOT NULL CHECK(method='canonical-activity-contributions-v1'),
 quantity_count INTEGER NOT NULL CHECK(quantity_count BETWEEN 0 AND 128)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_canonical_feature_quantity_admit BEFORE INSERT ON analytics_canonical_feature_quantities
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_facts f
 JOIN analytics_canonical_heads h ON h.revision=f.revision
 JOIN analytics_owner_state o ON o.source_id=f.source_id AND o.owner_digest=f.owner_digest AND o.state='active'
 JOIN analytics_runtime_sources s ON s.source_id=f.source_id AND s.contract_version=1
 WHERE f.revision=NEW.fact_revision AND f.status='compatible' AND f.coverage='complete'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e
  WHERE e.source_id=f.source_id AND e.owner_digest=f.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_feature_authority'); END;
CREATE TRIGGER analytics_canonical_feature_quantity_immutable BEFORE UPDATE ON analytics_canonical_feature_quantities
BEGIN SELECT RAISE(ABORT,'canonical_feature_immutable'); END;
CREATE TRIGGER analytics_canonical_feature_price_admit BEFORE INSERT ON analytics_canonical_feature_prices
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_facts f JOIN analytics_canonical_heads h ON h.revision=f.revision
 JOIN analytics_owner_state o ON o.source_id=f.source_id AND o.owner_digest=f.owner_digest AND o.state='active'
 JOIN analytics_runtime_sources s ON s.source_id=f.source_id AND s.contract_version=1
 WHERE f.revision=NEW.fact_revision AND f.stream='usage'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e
  WHERE e.source_id=f.source_id AND e.owner_digest=f.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_feature_authority'); END;
CREATE TRIGGER analytics_canonical_feature_price_immutable BEFORE UPDATE ON analytics_canonical_feature_prices
BEGIN SELECT RAISE(ABORT,'canonical_feature_immutable'); END;
CREATE TRIGGER analytics_canonical_feature_membership_admit BEFORE INSERT ON analytics_canonical_feature_membership
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_facts f JOIN analytics_canonical_heads h ON h.revision=f.revision
 JOIN analytics_owner_state o ON o.source_id=f.source_id AND o.owner_digest=f.owner_digest AND o.state='active'
 WHERE f.revision=NEW.fact_revision AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e
 WHERE e.source_id=f.source_id AND e.owner_digest=f.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_feature_authority'); END;
CREATE TRIGGER analytics_canonical_feature_membership_immutable BEFORE UPDATE ON analytics_canonical_feature_membership
BEGIN SELECT RAISE(ABORT,'canonical_feature_immutable'); END;
CREATE TRIGGER analytics_canonical_activity_admit BEFORE INSERT ON analytics_canonical_activity_heads
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_manifests m JOIN analytics_canonical_partition_heads h
 ON h.content_revision=m.content_revision WHERE m.content_revision=NEW.content_revision AND m.state='complete'
 AND m.row_count=NEW.quantity_count AND m.generation=COALESCE((SELECT generation
 FROM analytics_canonical_dirty_partitions d WHERE d.partition_key=m.root_partition_key),0)
 AND m.row_count=(SELECT count(*) FROM analytics_canonical_manifest_rows r
 JOIN analytics_canonical_feature_quantities q ON q.fact_revision=r.revision
 JOIN analytics_canonical_heads c ON c.revision=r.revision WHERE r.content_revision=m.content_revision))
BEGIN SELECT RAISE(ABORT,'canonical_feature_incomplete'); END;
CREATE TRIGGER analytics_canonical_activity_immutable BEFORE UPDATE ON analytics_canonical_activity_heads
BEGIN SELECT RAISE(ABORT,'canonical_feature_immutable'); END;
