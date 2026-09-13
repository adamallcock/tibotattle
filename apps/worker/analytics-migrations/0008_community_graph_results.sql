-- Only completed shared-kernel output lives here. Raw records, credentials and
-- temporary prepared usage rows remain outside this storage family.
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
  source_kind TEXT NOT NULL CHECK(source_kind IN('v0.2','v1','v1.1','mixed')),
  PRIMARY KEY(source_id,owner_digest,metric,day)
) WITHOUT ROWID;
CREATE INDEX analytics_community_graph_day ON analytics_community_graph_results(source_id,metric,day,owner_digest);

-- Cursor positions are integers, so erasing an owner never leaves its ID in an
-- operational cursor. A changed cohort may revisit work; exact caches make that
-- harmless, and every owner is visited again on the next bounded sweep.
CREATE TABLE analytics_community_graph_scan (
 source_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0),
 tick INTEGER NOT NULL CHECK(tick>=0 AND tick<3),
 current_position INTEGER NOT NULL CHECK(current_position>=0),
 history_position INTEGER NOT NULL CHECK(history_position>=0)
) WITHOUT ROWID;
CREATE TABLE analytics_community_graph_execution (
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,day TEXT NOT NULL,dependency_digest TEXT NOT NULL,
 path TEXT NOT NULL CHECK(path='checkpoint'),
 PRIMARY KEY(source_id,owner_digest,day)
) WITHOUT ROWID;
