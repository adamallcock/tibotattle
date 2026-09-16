-- One content-free durable target for a resumable graph calculation. Source
-- pseudonyms exist only while the target owner authority epoch remains active;
-- withdrawal and erasure delete the row rather than retaining that metadata.
CREATE TABLE analytics_community_graph_work_selection (
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  metric TEXT NOT NULL CHECK(metric IN ('fits','model')),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch>=0),
  selection_revision INTEGER NOT NULL CHECK(selection_revision>0),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','complete')),
  envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json) AND json_type(envelope_json)='object'
    AND length(CAST(envelope_json AS BLOB))<=16384),
  envelope_sha256 TEXT NOT NULL CHECK(length(envelope_sha256)=64 AND envelope_sha256 NOT GLOB '*[^0-9a-f]*'),
  claim_token TEXT,
  claim_expires_ms INTEGER,
  created_ms INTEGER NOT NULL CHECK(created_ms>=0),
  updated_ms INTEGER NOT NULL CHECK(updated_ms>=0),
  PRIMARY KEY(source_id,owner_digest,day,metric),
  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id),
  CHECK((state='claimed')=(claim_token IS NOT NULL AND claim_expires_ms IS NOT NULL)),
  CHECK((state!='claimed')=(claim_token IS NULL AND claim_expires_ms IS NULL)),
  CHECK(claim_token IS NULL OR length(claim_token) BETWEEN 16 AND 128)
) STRICT, WITHOUT ROWID;

CREATE INDEX analytics_graph_work_selection_pending
  ON analytics_community_graph_work_selection(source_id,state,updated_ms,owner_digest,day,metric);

CREATE TRIGGER analytics_graph_work_selection_erasure_fence
AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
  DELETE FROM analytics_community_graph_work_selection
   WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;

CREATE TRIGGER analytics_graph_work_selection_owner_update
AFTER UPDATE OF state,authority_epoch ON analytics_owner_state
WHEN NEW.state!='active' OR OLD.authority_epoch IS NOT NEW.authority_epoch
BEGIN
  DELETE FROM analytics_community_graph_work_selection
   WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;

CREATE TRIGGER analytics_graph_work_selection_owner_delete
AFTER DELETE ON analytics_owner_state
BEGIN
  DELETE FROM analytics_community_graph_work_selection
   WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
END;
