-- Exact partition replacements retain the original fact/member/sample state.
-- Public tables remain the native publisher's atomic adoption boundary.
CREATE TABLE analytics_canonical_publication_parts (
 revision TEXT PRIMARY KEY CHECK(length(revision)=64),
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 day TEXT NOT NULL CHECK(length(day)=10),
 partition_key TEXT NOT NULL,
 content_revision TEXT NOT NULL REFERENCES analytics_canonical_manifests(content_revision) ON DELETE CASCADE,
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=1048576),
 payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
 fact_count INTEGER NOT NULL CHECK(fact_count BETWEEN 0 AND 128),
 created_ms INTEGER NOT NULL CHECK(created_ms>=0)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_publication_part_day ON analytics_canonical_publication_parts(source_id,day,partition_key);
CREATE TABLE analytics_canonical_publication_part_facts (
 part_revision TEXT NOT NULL REFERENCES analytics_canonical_publication_parts(revision) ON DELETE CASCADE,
 fact_revision TEXT NOT NULL REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 PRIMARY KEY(part_revision,fact_revision)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_publication_fact_reverse ON analytics_canonical_publication_part_facts(fact_revision,part_revision);
CREATE TABLE analytics_canonical_publication_part_subjects (
 part_revision TEXT NOT NULL REFERENCES analytics_canonical_publication_parts(revision) ON DELETE CASCADE,
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL,
 PRIMARY KEY(part_revision,source_id,owner_digest),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_publication_part_subject ON analytics_canonical_publication_part_subjects(source_id,owner_digest,part_revision);
CREATE TABLE analytics_canonical_publication_part_heads (
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 partition_key TEXT NOT NULL,
 revision TEXT NOT NULL REFERENCES analytics_canonical_publication_parts(revision) ON DELETE CASCADE,
 PRIMARY KEY(source_id,partition_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_publication_replacements (
 replacement_key TEXT PRIMARY KEY CHECK(length(replacement_key)=64),
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 partition_key TEXT NOT NULL,
 old_revision TEXT,
 new_revision TEXT NOT NULL REFERENCES analytics_canonical_publication_parts(revision) ON DELETE CASCADE,
 created_ms INTEGER NOT NULL CHECK(created_ms>=0)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_publication_closures (
 closure_key TEXT PRIMARY KEY CHECK(length(closure_key)=64),
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 day TEXT NOT NULL CHECK(length(day)=10),
 family TEXT NOT NULL CHECK(family IN('activity','fits','model','cache')),
 watermark INTEGER NOT NULL CHECK(watermark>=0),
 authority_digest TEXT NOT NULL CHECK(length(authority_digest)=64),
 expected_count INTEGER NOT NULL CHECK(expected_count BETWEEN 0 AND 65536),
 state TEXT NOT NULL CHECK(state IN('capturing','sealed','complete','invalidated')),
 created_ms INTEGER NOT NULL CHECK(created_ms>=0)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_publication_closure_day ON analytics_canonical_publication_closures(source_id,day,family,watermark);
CREATE TABLE analytics_canonical_publication_expected (
 closure_key TEXT NOT NULL REFERENCES analytics_canonical_publication_closures(closure_key) ON DELETE CASCADE,
 partition_key TEXT NOT NULL,
 content_revision TEXT NOT NULL CHECK(length(content_revision)=64),
 outcome TEXT NOT NULL CHECK(outcome IN('pending','changed','unchanged','empty')),
 part_revision TEXT REFERENCES analytics_canonical_publication_parts(revision) ON DELETE SET NULL,
 PRIMARY KEY(closure_key,partition_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_publication_subjects (
 closure_key TEXT NOT NULL REFERENCES analytics_canonical_publication_closures(closure_key) ON DELETE CASCADE,
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL,
 PRIMARY KEY(closure_key,source_id,owner_digest),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
-- Keep full native fit samples/weights in the existing graph-result store.
-- This relation pins the exact original result, never an averaged/subtracted median.
CREATE TABLE analytics_canonical_publication_graph_refs (
 closure_key TEXT NOT NULL REFERENCES analytics_canonical_publication_closures(closure_key) ON DELETE CASCADE,
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL,
 metric TEXT NOT NULL CHECK(metric IN('fits','model')),
 day TEXT NOT NULL,
 partition_key TEXT NOT NULL,
 content_revision TEXT NOT NULL CHECK(length(content_revision)=64),
 method TEXT NOT NULL,
 dependency_digest TEXT NOT NULL CHECK(length(dependency_digest)=64),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 PRIMARY KEY(closure_key,source_id,owner_digest,metric,day),
 FOREIGN KEY(source_id,owner_digest,metric,day) REFERENCES analytics_community_graph_results(source_id,owner_digest,metric,day) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_canonical_publication_part_admit BEFORE INSERT ON analytics_canonical_publication_parts
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_manifests m JOIN analytics_canonical_partition_heads h USING(content_revision)
 WHERE m.content_revision=NEW.content_revision AND m.partition_key=NEW.partition_key AND m.state='complete' AND NEW.fact_count=(SELECT count(*) FROM analytics_canonical_manifest_rows r
 JOIN analytics_canonical_facts f ON f.revision=r.revision WHERE r.content_revision=m.content_revision AND f.source_id=NEW.source_id)
 AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions d WHERE d.partition_key=m.root_partition_key),0)
 AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
 LEFT JOIN analytics_owner_state o ON o.source_id=f.source_id AND o.owner_digest=f.owner_digest
 WHERE r.content_revision=m.content_revision AND (o.state IS NOT 'active' OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e
 WHERE e.source_id=f.source_id AND e.owner_digest=f.owner_digest))))
BEGIN SELECT RAISE(ABORT,'canonical_publication_authority'); END;
CREATE TRIGGER analytics_canonical_publication_part_immutable BEFORE UPDATE ON analytics_canonical_publication_parts
BEGIN SELECT RAISE(ABORT,'canonical_publication_immutable'); END;
CREATE TRIGGER analytics_canonical_publication_part_delete BEFORE DELETE ON analytics_canonical_publication_parts
BEGIN
 UPDATE analytics_canonical_publication_closures SET state='invalidated' WHERE closure_key IN(
 SELECT closure_key FROM analytics_canonical_publication_expected WHERE part_revision=OLD.revision);
 DELETE FROM analytics_canonical_publication_replacements WHERE old_revision=OLD.revision;
END;
CREATE TRIGGER analytics_canonical_publication_fact_delete BEFORE DELETE ON analytics_canonical_facts
BEGIN
 DELETE FROM analytics_canonical_publication_closures WHERE closure_key IN(
 SELECT e.closure_key FROM analytics_canonical_publication_expected e
 JOIN analytics_canonical_publication_part_facts f ON f.part_revision=e.part_revision WHERE f.fact_revision=OLD.revision);
 DELETE FROM analytics_canonical_publication_parts WHERE revision IN(
 SELECT part_revision FROM analytics_canonical_publication_part_facts WHERE fact_revision=OLD.revision);
END;
CREATE TRIGGER analytics_canonical_publication_owner_terminal AFTER UPDATE OF state ON analytics_owner_state
WHEN NEW.state!='active'
BEGIN
 DELETE FROM analytics_canonical_publication_closures WHERE source_id=NEW.source_id AND state='capturing';
 DELETE FROM analytics_canonical_publication_closures WHERE closure_key IN(
 SELECT closure_key FROM analytics_canonical_publication_subjects WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest);
 DELETE FROM analytics_canonical_publication_parts WHERE revision IN(
 SELECT r.part_revision FROM analytics_canonical_publication_part_facts r JOIN analytics_canonical_facts f ON f.revision=r.fact_revision
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest);
END;
CREATE TRIGGER analytics_canonical_publication_erasure AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_canonical_publication_closures WHERE source_id=NEW.source_id AND state='capturing';
 DELETE FROM analytics_canonical_publication_closures WHERE closure_key IN(
 SELECT closure_key FROM analytics_canonical_publication_subjects WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest);
 DELETE FROM analytics_canonical_publication_parts WHERE revision IN(
 SELECT r.part_revision FROM analytics_canonical_publication_part_facts r JOIN analytics_canonical_facts f ON f.revision=r.fact_revision
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest);
END;

CREATE TRIGGER analytics_canonical_publication_expected_revision BEFORE INSERT ON analytics_canonical_publication_expected
WHEN EXISTS(SELECT 1 FROM analytics_canonical_publication_expected e WHERE e.closure_key=NEW.closure_key
 AND e.partition_key=NEW.partition_key AND e.content_revision!=NEW.content_revision)
BEGIN SELECT RAISE(ABORT,'canonical_publication_expected_conflict'); END;
CREATE TRIGGER analytics_canonical_publication_expected_immutable BEFORE UPDATE OF closure_key,partition_key,content_revision ON analytics_canonical_publication_expected
BEGIN SELECT RAISE(ABORT,'canonical_publication_immutable'); END;
CREATE TRIGGER analytics_canonical_publication_subject_admit BEFORE INSERT ON analytics_canonical_publication_subjects
WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_publication_authority'); END;
-- One native eligibility census is shared by output phases at a sealed source
-- watermark. Descriptors contain no private participant IDs or credentials.
CREATE TABLE analytics_canonical_publication_cohorts (
 cohort_key TEXT PRIMARY KEY CHECK(length(cohort_key)=64),
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64),
 member_count INTEGER NOT NULL CHECK(member_count BETWEEN 0 AND 65536),
 cursor_count INTEGER NOT NULL DEFAULT 0 CHECK(cursor_count>=0),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 state TEXT NOT NULL DEFAULT 'capturing' CHECK(state IN('capturing','complete')),
 valid_until_ms INTEGER NOT NULL CHECK(valid_until_ms>=0),
 created_ms INTEGER NOT NULL CHECK(created_ms>=0)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_publication_cohort_source ON analytics_canonical_publication_cohorts(source_id,state,created_ms);
CREATE TABLE analytics_canonical_publication_cohort_members (
 cohort_key TEXT NOT NULL REFERENCES analytics_canonical_publication_cohorts(cohort_key) ON DELETE CASCADE,
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 descriptor TEXT NOT NULL CHECK(json_valid(descriptor) AND length(CAST(descriptor AS BLOB))<=2048),
 PRIMARY KEY(cohort_key,owner_digest),UNIQUE(cohort_key,ordinal),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_canonical_publication_cohort_admit BEFORE INSERT ON analytics_canonical_publication_cohort_members
WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_publication_authority'); END;
CREATE TRIGGER analytics_canonical_publication_cohort_terminal AFTER UPDATE OF state ON analytics_owner_state WHEN NEW.state!='active'
BEGIN
 DELETE FROM analytics_canonical_publication_cohorts WHERE source_id=NEW.source_id AND state='capturing'; DELETE FROM analytics_canonical_publication_cohorts WHERE cohort_key IN(SELECT cohort_key FROM analytics_canonical_publication_cohort_members
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest); END;
CREATE TRIGGER analytics_canonical_publication_cohort_erasure AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_canonical_publication_cohorts WHERE source_id=NEW.source_id AND state='capturing'; DELETE FROM analytics_canonical_publication_cohorts WHERE cohort_key IN(SELECT cohort_key FROM analytics_canonical_publication_cohort_members
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest); END;
CREATE TRIGGER analytics_canonical_publication_cohort_owner_delete BEFORE DELETE ON analytics_owner_state
BEGIN
 DELETE FROM analytics_canonical_publication_cohorts WHERE source_id=OLD.source_id AND state='capturing'; DELETE FROM analytics_canonical_publication_cohorts WHERE cohort_key IN(SELECT cohort_key FROM analytics_canonical_publication_cohort_members
 WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest); END;

CREATE TRIGGER analytics_canonical_publication_graph_admit BEFORE INSERT ON analytics_canonical_publication_graph_refs
WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_community_graph_results g
 ON g.source_id=o.source_id AND g.owner_digest=o.owner_digest
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND g.metric=NEW.metric AND g.day=NEW.day AND g.method=NEW.method AND g.dependency_digest=NEW.dependency_digest AND g.payload_sha256=NEW.payload_sha256
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=o.source_id AND e.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_publication_authority'); END;
CREATE TRIGGER analytics_canonical_publication_graph_change AFTER UPDATE ON analytics_community_graph_results
WHEN OLD.dependency_digest!=NEW.dependency_digest OR OLD.payload_sha256!=NEW.payload_sha256 OR OLD.method!=NEW.method
BEGIN UPDATE analytics_canonical_publication_closures SET state='invalidated' WHERE closure_key IN(
 SELECT closure_key FROM analytics_canonical_publication_graph_refs WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest
 AND metric=OLD.metric AND day=OLD.day); END;
CREATE TRIGGER analytics_canonical_publication_graph_delete BEFORE DELETE ON analytics_community_graph_results
BEGIN DELETE FROM analytics_canonical_publication_closures WHERE closure_key IN(
 SELECT closure_key FROM analytics_canonical_publication_graph_refs WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest
 AND metric=OLD.metric AND day=OLD.day); END;

CREATE TRIGGER analytics_canonical_publication_head_changed AFTER UPDATE OF revision ON analytics_canonical_publication_part_heads
WHEN OLD.revision!=NEW.revision
BEGIN UPDATE analytics_canonical_publication_closures SET state='invalidated' WHERE closure_key IN(
 SELECT closure_key FROM analytics_canonical_publication_expected WHERE part_revision=OLD.revision); END;
CREATE TRIGGER analytics_canonical_publication_partition_dirty AFTER UPDATE OF generation ON analytics_canonical_dirty_partitions
BEGIN UPDATE analytics_canonical_publication_closures SET state='invalidated' WHERE closure_key IN(
 SELECT e.closure_key FROM analytics_canonical_publication_expected e JOIN analytics_canonical_manifests m
 ON m.content_revision=e.content_revision WHERE m.root_partition_key=NEW.partition_key AND m.generation!=NEW.generation); END;

CREATE TRIGGER analytics_canonical_publication_part_subject_admit BEFORE INSERT ON analytics_canonical_publication_part_subjects
WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_publication_authority'); END;
CREATE TRIGGER analytics_canonical_publication_part_subject_terminal AFTER UPDATE OF state ON analytics_owner_state WHEN NEW.state!='active'
BEGIN DELETE FROM analytics_canonical_publication_parts WHERE revision IN(SELECT part_revision FROM analytics_canonical_publication_part_subjects
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest); END;
CREATE TRIGGER analytics_canonical_publication_part_subject_erasure AFTER INSERT ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_canonical_publication_parts WHERE revision IN(SELECT part_revision FROM analytics_canonical_publication_part_subjects
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest); END;
CREATE TRIGGER analytics_canonical_publication_owner_delete BEFORE DELETE ON analytics_owner_state
BEGIN
 DELETE FROM analytics_canonical_publication_closures WHERE source_id=OLD.source_id AND state='capturing';
 DELETE FROM analytics_canonical_publication_closures WHERE closure_key IN(SELECT closure_key FROM analytics_canonical_publication_subjects
 WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest);
 DELETE FROM analytics_canonical_publication_parts WHERE revision IN(SELECT part_revision FROM analytics_canonical_publication_part_subjects
 WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest);
END;
CREATE TRIGGER analytics_canonical_publication_fence_replay AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_canonical_publication_cohorts WHERE source_id=NEW.source_id AND state='capturing';
 DELETE FROM analytics_canonical_publication_closures WHERE source_id=NEW.source_id AND state='capturing';
 DELETE FROM analytics_canonical_publication_closures WHERE closure_key IN(SELECT closure_key FROM analytics_canonical_publication_subjects
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest);
 DELETE FROM analytics_canonical_publication_cohorts WHERE cohort_key IN(SELECT cohort_key FROM analytics_canonical_publication_cohort_members
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest);
 DELETE FROM analytics_canonical_publication_parts WHERE revision IN(SELECT part_revision FROM analytics_canonical_publication_part_subjects
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest);
 DELETE FROM analytics_canonical_publication_parts WHERE revision IN(SELECT r.part_revision FROM analytics_canonical_publication_part_facts r
 JOIN analytics_canonical_facts f ON f.revision=r.fact_revision WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest);
END;

-- The public cache DTO is computed only by leased work. Its subject-linked
-- closure survives ordinary corrections as last-good output, and is removed
-- atomically by terminal/erasure hooks above.
CREATE TABLE analytics_canonical_cache_publications (
 source_id TEXT PRIMARY KEY REFERENCES analytics_runtime_sources(source_id),
 revision INTEGER NOT NULL CHECK(revision>0),
 closure_key TEXT NOT NULL REFERENCES analytics_canonical_publication_closures(closure_key) ON DELETE CASCADE,
 cohort_key TEXT NOT NULL REFERENCES analytics_canonical_publication_cohorts(cohort_key) ON DELETE CASCADE,
 cache_revision INTEGER NOT NULL CHECK(cache_revision>=0),
 anchor_day TEXT NOT NULL CHECK(length(anchor_day)=10),
 authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=1048576),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 computed_ms INTEGER NOT NULL CHECK(computed_ms>=0)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_canonical_cache_publication_admit BEFORE INSERT ON analytics_canonical_cache_publications
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_closures c
 JOIN analytics_canonical_publication_cohorts h ON h.cohort_key=NEW.cohort_key AND h.source_id=c.source_id
 WHERE c.closure_key=NEW.closure_key AND c.source_id=NEW.source_id AND c.family='cache' AND c.state='complete'
 AND h.state='complete' AND h.valid_until_ms>NEW.computed_ms
 AND NEW.cache_revision=(SELECT revision FROM analytics_canonical_cache_clock WHERE id=1))
BEGIN SELECT RAISE(ABORT,'canonical_cache_publication_changed'); END;
CREATE TRIGGER analytics_canonical_cache_publication_update BEFORE UPDATE ON analytics_canonical_cache_publications
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_closures c
 JOIN analytics_canonical_publication_cohorts h ON h.cohort_key=NEW.cohort_key AND h.source_id=c.source_id
 WHERE c.closure_key=NEW.closure_key AND c.source_id=NEW.source_id AND c.family='cache' AND c.state='complete'
 AND h.state='complete' AND h.valid_until_ms>NEW.computed_ms
 AND NEW.cache_revision=(SELECT revision FROM analytics_canonical_cache_clock WHERE id=1))
BEGIN SELECT RAISE(ABORT,'canonical_cache_publication_changed'); END;
