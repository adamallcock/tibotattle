PRAGMA foreign_keys = ON;

-- Legacy v0.1 records remain explicitly unattributed. The disabled v0.2
-- validator is not connected to ingestion by this forward-only migration.
ALTER TABLE telemetry_records
  ADD COLUMN account_track_id TEXT NOT NULL DEFAULT 'unattributed'
  CHECK (
    account_track_id = 'unattributed'
    OR (
      length(account_track_id) = 81
      AND substr(account_track_id, 1, 17) = 'account-track:v1:'
      AND substr(account_track_id, 18) NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE telemetry_records
  ADD COLUMN dataset_id TEXT
  CHECK (
    dataset_id IS NULL
    OR (
      length(dataset_id) = 75
      AND substr(dataset_id, 1, 11) = 'dataset:v1:'
      AND substr(dataset_id, 12) NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE telemetry_records
  ADD COLUMN policy_epoch TEXT
  CHECK (
    policy_epoch IS NULL
    OR (
      length(policy_epoch) BETWEEN 1 AND 128
      AND policy_epoch NOT GLOB '*[^a-z0-9_.:-]*'
    )
  );

-- Nullable dataset columns preserve existing v0.1 contribution rows. A future
-- activation migration must rebuild the schema-version CHECK before v0.2 can
-- be accepted.
ALTER TABLE telemetry_contributions
  ADD COLUMN transport_schema_version TEXT NOT NULL
  DEFAULT 'telemetry-contribution-v0.1'
  CHECK (
    transport_schema_version IN (
      'telemetry-contribution-v0.1',
      'telemetry-contribution-v0.2'
    )
  );
ALTER TABLE telemetry_contributions
  ADD COLUMN dataset_id TEXT
  CHECK (
    dataset_id IS NULL
    OR (
      length(dataset_id) = 75
      AND substr(dataset_id, 1, 11) = 'dataset:v1:'
      AND substr(dataset_id, 12) NOT GLOB '*[^0-9a-f]*'
    )
  );
ALTER TABLE telemetry_contributions
  ADD COLUMN dataset_part_index INTEGER
  CHECK (dataset_part_index IS NULL OR dataset_part_index BETWEEN 1 AND 100);
ALTER TABLE telemetry_contributions
  ADD COLUMN dataset_part_count INTEGER
  CHECK (dataset_part_count IS NULL OR dataset_part_count BETWEEN 1 AND 100);
ALTER TABLE telemetry_contributions
  ADD COLUMN dataset_completeness TEXT
  CHECK (
    dataset_completeness IS NULL
    OR dataset_completeness IN ('complete', 'partial')
  );
ALTER TABLE telemetry_contributions
  ADD COLUMN dataset_range_start TEXT;
ALTER TABLE telemetry_contributions
  ADD COLUMN dataset_range_end TEXT;

ALTER TABLE telemetry_contribution_occurrences
  ADD COLUMN dataset_id TEXT
  CHECK (
    dataset_id IS NULL
    OR (
      length(dataset_id) = 75
      AND substr(dataset_id, 1, 11) = 'dataset:v1:'
      AND substr(dataset_id, 12) NOT GLOB '*[^0-9a-f]*'
    )
  );
ALTER TABLE telemetry_contribution_occurrences
  ADD COLUMN account_track_id TEXT NOT NULL DEFAULT 'unattributed'
  CHECK (
    account_track_id = 'unattributed'
    OR (
      length(account_track_id) = 81
      AND substr(account_track_id, 1, 17) = 'account-track:v1:'
      AND substr(account_track_id, 18) NOT GLOB '*[^0-9a-f]*'
    )
  );
ALTER TABLE telemetry_contribution_occurrences
  ADD COLUMN policy_epoch TEXT
  CHECK (
    policy_epoch IS NULL
    OR (
      length(policy_epoch) BETWEEN 1 AND 128
      AND policy_epoch NOT GLOB '*[^a-z0-9_.:-]*'
    )
  );

CREATE UNIQUE INDEX telemetry_contributions_participant_dataset_part
  ON telemetry_contributions(participant_id, dataset_id, dataset_part_index)
  WHERE dataset_id IS NOT NULL;

CREATE INDEX telemetry_contributions_participant_dataset
  ON telemetry_contributions(
    participant_id,
    dataset_id,
    dataset_part_count,
    dataset_completeness,
    dataset_range_start,
    dataset_range_end
  )
  WHERE dataset_id IS NOT NULL;

CREATE INDEX telemetry_records_usage_account_time
  ON telemetry_records(
    participant_id,
    account_track_id,
    provider,
    dataset_id,
    observed_at,
    id
  )
  WHERE record_kind = 'usage';

CREATE INDEX telemetry_records_quota_account_reset
  ON telemetry_records(
    participant_id,
    account_track_id,
    provider,
    dataset_id,
    plan_type,
    plan_variant,
    limit_id,
    window_duration_minutes,
    resets_at,
    observed_at,
    id
  )
  WHERE record_kind = 'quota';

CREATE INDEX telemetry_occurrences_account_dataset
  ON telemetry_contribution_occurrences(
    participant_id,
    account_track_id,
    dataset_id,
    record_kind,
    occurrence_id
  )
  WHERE dataset_id IS NOT NULL;

CREATE TRIGGER telemetry_contributions_dataset_metadata_insert
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN
  (
    NEW.dataset_id IS NULL
    AND (
      NEW.dataset_part_index IS NOT NULL
      OR NEW.dataset_part_count IS NOT NULL
      OR NEW.dataset_completeness IS NOT NULL
      OR NEW.dataset_range_start IS NOT NULL
      OR NEW.dataset_range_end IS NOT NULL
    )
  )
  OR (
    NEW.dataset_id IS NOT NULL
    AND (
      NEW.dataset_part_index IS NULL
      OR NEW.dataset_part_count IS NULL
      OR NEW.dataset_completeness IS NULL
      OR NEW.dataset_range_start IS NULL
      OR NEW.dataset_range_end IS NULL
      OR NEW.dataset_part_index > NEW.dataset_part_count
      OR NEW.dataset_range_end < NEW.dataset_range_start
    )
  )
  OR (
    NEW.dataset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM telemetry_contributions existing
       WHERE existing.participant_id = NEW.participant_id
         AND existing.dataset_id = NEW.dataset_id
         AND (
           existing.dataset_part_count != NEW.dataset_part_count
           OR existing.dataset_completeness != NEW.dataset_completeness
           OR existing.dataset_range_start != NEW.dataset_range_start
           OR existing.dataset_range_end != NEW.dataset_range_end
         )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid telemetry dataset metadata');
END;

CREATE TRIGGER telemetry_contributions_dataset_metadata_update
BEFORE UPDATE OF
  participant_id,
  dataset_id,
  dataset_part_index,
  dataset_part_count,
  dataset_completeness,
  dataset_range_start,
  dataset_range_end
ON telemetry_contributions
FOR EACH ROW
WHEN
  (
    NEW.dataset_id IS NULL
    AND (
      NEW.dataset_part_index IS NOT NULL
      OR NEW.dataset_part_count IS NOT NULL
      OR NEW.dataset_completeness IS NOT NULL
      OR NEW.dataset_range_start IS NOT NULL
      OR NEW.dataset_range_end IS NOT NULL
    )
  )
  OR (
    NEW.dataset_id IS NOT NULL
    AND (
      NEW.dataset_part_index IS NULL
      OR NEW.dataset_part_count IS NULL
      OR NEW.dataset_completeness IS NULL
      OR NEW.dataset_range_start IS NULL
      OR NEW.dataset_range_end IS NULL
      OR NEW.dataset_part_index > NEW.dataset_part_count
      OR NEW.dataset_range_end < NEW.dataset_range_start
    )
  )
  OR (
    NEW.dataset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM telemetry_contributions existing
       WHERE existing.participant_id = NEW.participant_id
         AND existing.dataset_id = NEW.dataset_id
         AND existing.id != OLD.id
         AND (
           existing.dataset_part_count != NEW.dataset_part_count
           OR existing.dataset_completeness != NEW.dataset_completeness
           OR existing.dataset_range_start != NEW.dataset_range_start
           OR existing.dataset_range_end != NEW.dataset_range_end
         )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid telemetry dataset metadata');
END;
