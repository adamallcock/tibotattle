-- A conservative, append-only day catalog. All staged and retired chunks
-- contribute presence: false positives keep the exact occurrence-link scan.
-- A negative lookup is therefore proof that no retained variant can be outside
-- a requested range. Store one row per participant, stream and source day,
-- regardless of source version, device, generation or record count.
CREATE TABLE storage_effective_source_days (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  stream INTEGER NOT NULL CHECK(stream IN (1,2,3)),
  source_day TEXT NOT NULL CHECK(length(source_day)=10),
  PRIMARY KEY(participant_id,stream,source_day)
) STRICT, WITHOUT ROWID;
CREATE TABLE storage_effective_source_days_runtime (
  id INTEGER PRIMARY KEY CHECK(id=1),
  method TEXT NOT NULL CHECK(method='effective-source-day-presence-v1')
) STRICT;

CREATE TRIGGER storage_effective_days_v1_insert AFTER INSERT ON telemetry_v1_chunks
BEGIN
  INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
  VALUES(NEW.participant_id,CASE NEW.stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 WHEN 'session' THEN 3 END,NEW.chunk_day)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER storage_effective_days_v1_update AFTER UPDATE OF participant_id,stream,chunk_day ON telemetry_v1_chunks
BEGIN
  INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
  VALUES(NEW.participant_id,CASE NEW.stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 WHEN 'session' THEN 3 END,NEW.chunk_day)
  ON CONFLICT DO NOTHING;
END;

INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
SELECT DISTINCT participant_id,CASE stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 WHEN 'session' THEN 3 END,chunk_day
FROM telemetry_v1_chunks WHERE true ON CONFLICT DO NOTHING;

CREATE TRIGGER storage_effective_days_v11_insert AFTER INSERT ON telemetry_v11_chunks
BEGIN
  INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
  VALUES(NEW.participant_id,CASE NEW.stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 WHEN 'session' THEN 3 END,NEW.chunk_day)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER storage_effective_days_v11_update AFTER UPDATE OF participant_id,stream,chunk_day ON telemetry_v11_chunks
BEGIN
  INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
  VALUES(NEW.participant_id,CASE NEW.stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 WHEN 'session' THEN 3 END,NEW.chunk_day)
  ON CONFLICT DO NOTHING;
END;

INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
SELECT DISTINCT participant_id,CASE stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 WHEN 'session' THEN 3 END,chunk_day
FROM telemetry_v11_chunks WHERE true ON CONFLICT DO NOTHING;

CREATE TRIGGER storage_effective_days_v12_insert AFTER INSERT ON telemetry_v12_chunks
BEGIN
  INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
  VALUES(NEW.participant_id,CASE NEW.stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 WHEN 'session' THEN 3 END,NEW.chunk_day)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER storage_effective_days_v12_update AFTER UPDATE OF participant_id,stream,chunk_day ON telemetry_v12_chunks
BEGIN
  INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
  VALUES(NEW.participant_id,CASE NEW.stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 WHEN 'session' THEN 3 END,NEW.chunk_day)
  ON CONFLICT DO NOTHING;
END;

INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
SELECT DISTINCT participant_id,CASE stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 WHEN 'session' THEN 3 END,chunk_day
FROM telemetry_v12_chunks WHERE true ON CONFLICT DO NOTHING;

CREATE TRIGGER storage_effective_days_correction_insert AFTER INSERT ON telemetry_usage_correction_history
BEGIN
  INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
  VALUES(NEW.participant_id,1,coalesce(date(NEW.event_time_ms/1000,'unixepoch'),'0000-01-01'))
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER storage_effective_days_correction_update AFTER UPDATE OF participant_id,event_time_ms ON telemetry_usage_correction_history
BEGIN
  INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
  VALUES(NEW.participant_id,1,coalesce(date(NEW.event_time_ms/1000,'unixepoch'),'0000-01-01'))
  ON CONFLICT DO NOTHING;
END;

INSERT INTO storage_effective_source_days(participant_id,stream,source_day)
SELECT DISTINCT participant_id,1,coalesce(date(event_time_ms/1000,'unixepoch'),'0000-01-01')
FROM telemetry_usage_correction_history WHERE true ON CONFLICT DO NOTHING;

-- Never remove presence during ordinary source replacement/retirement. It
-- may retain an unnecessary candidate, but cannot manufacture a negative.
CREATE TRIGGER storage_effective_days_immutable BEFORE UPDATE ON storage_effective_source_days
BEGIN SELECT RAISE(ABORT,'storage_effective_days_immutable'); END;
CREATE TRIGGER storage_effective_days_retained BEFORE DELETE ON storage_effective_source_days
WHEN EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id)
BEGIN SELECT RAISE(ABORT,'storage_effective_days_retained'); END;
CREATE TRIGGER storage_effective_days_runtime_immutable BEFORE UPDATE ON storage_effective_source_days_runtime
BEGIN SELECT RAISE(ABORT,'storage_effective_days_runtime_immutable'); END;
CREATE TRIGGER storage_effective_days_runtime_retained BEFORE DELETE ON storage_effective_source_days_runtime
BEGIN SELECT RAISE(ABORT,'storage_effective_days_runtime_retained'); END;

-- Seal only after every existing source family has contributed its days.
INSERT INTO storage_effective_source_days_runtime(id,method) VALUES(1,'effective-source-day-presence-v1');
