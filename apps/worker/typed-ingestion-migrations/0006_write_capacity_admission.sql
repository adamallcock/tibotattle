-- Shard-local physical capacity admission for new typed telemetry writes.
-- Observations come from D1 response metadata. Pending reservations bridge the
-- gap between an observation and a later physical-size reconciliation.
CREATE TABLE storage_write_capacity_sample_clock (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740990),
  reserved_total_bytes INTEGER NOT NULL CHECK (reserved_total_bytes BETWEEN 0 AND 9007199254740990)
) STRICT;

INSERT INTO storage_write_capacity_sample_clock(singleton_id,revision,reserved_total_bytes) VALUES(1,0,0);

CREATE TABLE storage_write_capacity_observations (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  observed_bytes INTEGER NOT NULL CHECK (observed_bytes BETWEEN 0 AND 9000000000),
  sampled_through_sequence INTEGER NOT NULL CHECK (sampled_through_sequence >= 0),
  sampled_reserved_total_bytes INTEGER NOT NULL CHECK (sampled_reserved_total_bytes BETWEEN 0 AND 9007199254740990),
  sample_revision INTEGER NOT NULL CHECK (sample_revision BETWEEN 1 AND 9007199254740990),
  sampled_at_epoch INTEGER NOT NULL CHECK (sampled_at_epoch >= 0),
  expires_at_epoch INTEGER NOT NULL CHECK (expires_at_epoch >= sampled_at_epoch)
) STRICT;

CREATE TABLE storage_write_capacity_reservations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL UNIQUE CHECK (length(reservation_id) = 36),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  shard_id TEXT NOT NULL CHECK (length(shard_id) BETWEEN 1 AND 128),
  route_generation INTEGER NOT NULL CHECK (route_generation BETWEEN 1 AND 9007199254740990),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes BETWEEN 1 AND 67108864),
  created_at_epoch INTEGER NOT NULL CHECK (created_at_epoch >= 0)
) STRICT;

CREATE TRIGGER storage_write_capacity_reservation_guard
BEFORE INSERT ON storage_write_capacity_reservations BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_write_capacity_sample_clock WHERE singleton_id = 1)
    OR NOT EXISTS (
    SELECT 1 FROM storage_write_capacity_observations
    WHERE singleton_id = 1
      AND expires_at_epoch >= CAST(strftime('%s', 'now') AS INTEGER)
  ) THEN RAISE(ABORT, 'STORAGE_WRITE_CAPACITY_UNAVAILABLE') END;
  SELECT CASE WHEN (
    SELECT reserved_total_bytes < sampled_reserved_total_bytes
      OR reserved_total_bytes > 9007199254740990 - NEW.reserved_bytes
    FROM storage_write_capacity_sample_clock
    CROSS JOIN storage_write_capacity_observations
    WHERE storage_write_capacity_sample_clock.singleton_id = 1
      AND storage_write_capacity_observations.singleton_id = 1
  ) THEN RAISE(ABORT, 'STORAGE_WRITE_CAPACITY_UNAVAILABLE') END;
  SELECT CASE WHEN (
    SELECT observed_bytes
      + ((SELECT reserved_total_bytes FROM storage_write_capacity_sample_clock WHERE singleton_id = 1)
        - sampled_reserved_total_bytes)
      + NEW.reserved_bytes
    FROM storage_write_capacity_observations
    WHERE singleton_id = 1
  ) > 9000000000 THEN RAISE(ABORT, 'STORAGE_WRITE_CAPACITY_UNAVAILABLE') END;
  UPDATE storage_write_capacity_sample_clock
  SET revision = revision + 1, reserved_total_bytes = reserved_total_bytes + NEW.reserved_bytes
  WHERE singleton_id = 1;
END;
