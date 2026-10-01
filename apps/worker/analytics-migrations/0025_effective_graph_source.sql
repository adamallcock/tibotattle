-- The effective owner/day lane is a fourth graph source family. Widen the
-- result table forward-only while retaining every completed v0.2/v1/v1.1/mixed
-- result and the owner-erasure fences that protect this table.
PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS analytics_graph_result_erased_insert;
DROP TRIGGER IF EXISTS analytics_graph_result_erased_update;
DROP TRIGGER IF EXISTS analytics_community_graph_results_terminal_insert;
DROP TRIGGER IF EXISTS analytics_community_graph_results_terminal_update;

ALTER TABLE analytics_community_graph_results RENAME TO analytics_community_graph_results_0025;

CREATE TABLE analytics_community_graph_results (
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
  metric TEXT NOT NULL CHECK(metric IN ('fits','model')),
  day TEXT NOT NULL CHECK(length(day)=10),
  method TEXT NOT NULL,
  dependency_digest TEXT NOT NULL CHECK(length(dependency_digest)=64),
  input_revision INTEGER NOT NULL CHECK(input_revision>=0),
  payload_fingerprint TEXT NOT NULL CHECK(length(payload_fingerprint)=64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=1048576),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
  computed_ms INTEGER NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN('v0.2','v1','v1.1','mixed','effective')),
  PRIMARY KEY(source_id,owner_digest,metric,day)
) WITHOUT ROWID;

INSERT INTO analytics_community_graph_results
  (source_id,owner_digest,metric,day,method,dependency_digest,input_revision,
   payload_fingerprint,payload_json,payload_sha256,authority_json,computed_ms,source_kind)
SELECT source_id,owner_digest,metric,day,method,dependency_digest,input_revision,
   payload_fingerprint,payload_json,payload_sha256,authority_json,computed_ms,source_kind
  FROM analytics_community_graph_results_0025;

DROP TABLE analytics_community_graph_results_0025;
CREATE INDEX analytics_community_graph_day
  ON analytics_community_graph_results(source_id,metric,day,owner_digest);

CREATE TRIGGER analytics_graph_result_erased_insert BEFORE INSERT ON analytics_community_graph_results
WHEN EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
BEGIN SELECT RAISE(ABORT,'analytics_graph_owner_erased'); END;
CREATE TRIGGER analytics_graph_result_erased_update BEFORE UPDATE ON analytics_community_graph_results
WHEN EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
BEGIN SELECT RAISE(ABORT,'analytics_graph_owner_erased'); END;
CREATE TRIGGER analytics_community_graph_results_terminal_insert BEFORE INSERT ON analytics_community_graph_results
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_community_graph_results_terminal_update BEFORE UPDATE ON analytics_community_graph_results
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;

PRAGMA foreign_keys = ON;
