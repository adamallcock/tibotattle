-- Independent derived target. No participant, device, session or occurrence
-- identifiers are stored here; slot/device/chunk references are scoped digests.
CREATE TABLE analytics_v1_chunk_values (
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,slot_digest TEXT NOT NULL,
 namespace_digest TEXT NOT NULL,device_digest TEXT NOT NULL,chunk_digest TEXT NOT NULL,
 event_digest TEXT NOT NULL,content_digest TEXT NOT NULL,observed_day TEXT NOT NULL,
 chunk_revision INTEGER NOT NULL CHECK(chunk_revision>0),owner_revision INTEGER NOT NULL CHECK(owner_revision>0),
 values_json TEXT NOT NULL CHECK(json_valid(values_json)),
 PRIMARY KEY(source_id,owner_digest,slot_digest)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_v1_chunk_day ON analytics_v1_chunk_values(source_id,owner_digest,observed_day,device_digest);
CREATE TABLE analytics_v1_projection_receipts (
 source_id TEXT NOT NULL,event_digest TEXT NOT NULL,owner_digest TEXT NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('chunk','superseded','owner-withdrawn','owner-erased')),
 proof_event_digest TEXT,PRIMARY KEY(source_id,event_digest)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_v1_receipt_immutable BEFORE UPDATE ON analytics_v1_projection_receipts
BEGIN SELECT RAISE(ABORT,'analytics_v1_receipt_immutable'); END;
CREATE TABLE analytics_v1_owner_fences (
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,terminal_revision INTEGER NOT NULL CHECK(terminal_revision>0),
 terminal_sequence INTEGER NOT NULL CHECK(terminal_sequence>0),
 state TEXT NOT NULL CHECK(state IN ('owner-withdrawn','owner-erased')),
 PRIMARY KEY(source_id,owner_digest)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_v1_fence_monotonic BEFORE UPDATE ON analytics_v1_owner_fences
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.owner_digest IS NOT OLD.owner_digest
 OR NEW.terminal_revision<OLD.terminal_revision OR NEW.terminal_sequence<OLD.terminal_sequence
 OR (OLD.state='owner-erased' AND NEW.state!='owner-erased')
BEGIN SELECT RAISE(ABORT,'analytics_v1_fence_conflict'); END;

CREATE TRIGGER analytics_v1_chunk_forward BEFORE UPDATE ON analytics_v1_chunk_values
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.owner_digest IS NOT OLD.owner_digest
 OR NEW.slot_digest IS NOT OLD.slot_digest OR NEW.namespace_digest IS NOT OLD.namespace_digest
 OR NEW.device_digest IS NOT OLD.device_digest OR NEW.observed_day IS NOT OLD.observed_day
 OR NEW.chunk_revision<=OLD.chunk_revision OR NEW.owner_revision<=OLD.owner_revision
BEGIN SELECT RAISE(ABORT,'analytics_v1_chunk_revision_conflict'); END;
