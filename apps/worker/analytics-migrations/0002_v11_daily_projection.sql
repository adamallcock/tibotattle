-- Repeatable, generation-pinned calculation state. values_json contains bounded
-- aggregate counters/cells, never accepted raw telemetry records or credentials.
CREATE TABLE analytics_v11_projection_work (
  source_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  owner_digest TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  from_day TEXT NOT NULL,
  through_day TEXT NOT NULL,
  next_day TEXT NOT NULL,
  after_stream TEXT NOT NULL DEFAULT '',
  after_occurrence TEXT NOT NULL DEFAULT '',
  day_records INTEGER NOT NULL DEFAULT 0 CHECK(day_records>=0),
  values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  phase TEXT NOT NULL DEFAULT 'building' CHECK(phase IN ('building','ready','retiring')),
  PRIMARY KEY(source_id,event_digest)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_v11_work_owner ON analytics_v11_projection_work(source_id,owner_digest);
CREATE INDEX analytics_v11_work_retiring ON analytics_v11_projection_work(source_id,event_digest) WHERE phase='retiring';

CREATE TABLE analytics_v11_projection_steps (
  source_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  revision INTEGER NOT NULL,
  step_digest TEXT NOT NULL,
  PRIMARY KEY(source_id,event_digest,revision),
  FOREIGN KEY(source_id,event_digest) REFERENCES analytics_v11_projection_work(source_id,event_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_v11_step_validate BEFORE INSERT ON analytics_v11_projection_steps
BEGIN
  SELECT CASE WHEN NEW.revision != COALESCE((SELECT revision+1 FROM analytics_v11_projection_work
    WHERE source_id=NEW.source_id AND event_digest=NEW.event_digest AND phase='building'),-1)
    THEN RAISE(ABORT,'analytics_v11_step_conflict') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM analytics_applied_events
    WHERE source_id=NEW.source_id AND event_digest=NEW.event_digest)
    THEN RAISE(ABORT,'analytics_v11_event_already_applied') END;
END;

CREATE TABLE analytics_v11_day_values (
  source_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  day TEXT NOT NULL,
  record_count INTEGER NOT NULL CHECK(record_count>=0),
  values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  PRIMARY KEY(source_id,event_digest,day),
  FOREIGN KEY(source_id,event_digest) REFERENCES analytics_v11_projection_work(source_id,event_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_v11_day_immutable BEFORE UPDATE ON analytics_v11_day_values
BEGIN SELECT RAISE(ABORT,'analytics_v11_day_immutable'); END;

CREATE TABLE analytics_v11_owner_heads (
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  PRIMARY KEY(source_id,owner_digest),
  FOREIGN KEY(source_id,event_digest) REFERENCES analytics_v11_projection_work(source_id,event_digest)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_v11_head_ready BEFORE INSERT ON analytics_v11_owner_heads
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analytics_v11_projection_work w
    JOIN analytics_applied_events e ON e.source_id=w.source_id AND e.event_digest=w.event_digest
    WHERE w.source_id=NEW.source_id AND w.event_digest=NEW.event_digest
      AND w.owner_digest=NEW.owner_digest AND w.phase='ready' AND e.sequence=NEW.sequence)
    THEN RAISE(ABORT,'analytics_v11_generation_unready') END;
END;
CREATE TRIGGER analytics_v11_head_update_ready BEFORE UPDATE ON analytics_v11_owner_heads
BEGIN
  SELECT CASE WHEN NEW.source_id IS NOT OLD.source_id OR NEW.owner_digest IS NOT OLD.owner_digest
    OR NEW.sequence<=OLD.sequence OR NOT EXISTS(SELECT 1 FROM analytics_v11_projection_work w
    JOIN analytics_applied_events e ON e.source_id=w.source_id AND e.event_digest=w.event_digest
    WHERE w.source_id=NEW.source_id AND w.event_digest=NEW.event_digest
      AND w.owner_digest=NEW.owner_digest AND w.phase='ready' AND e.sequence=NEW.sequence)
    THEN RAISE(ABORT,'analytics_v11_generation_unready') END;
END;

-- An obsolete source is explicitly discarded, never labelled projected. These
-- digest-only receipts survive removal of the owner's repeatable projection.
CREATE TABLE analytics_v11_discard_receipts (
  source_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  owner_digest TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('owner-withdrawn','owner-erased')),
  terminal_revision INTEGER NOT NULL,
  terminal_sequence INTEGER NOT NULL,
  authority_epoch INTEGER NOT NULL,
  public_authority_epoch INTEGER NOT NULL,
  PRIMARY KEY(source_id,event_digest)
) STRICT, WITHOUT ROWID;

CREATE TABLE analytics_v11_retirement_receipts (
  source_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  owner_digest TEXT NOT NULL,
  PRIMARY KEY(source_id,event_digest)
) STRICT, WITHOUT ROWID;
