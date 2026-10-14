-- Preparation progress is the retained head ledger, not a count of derived
-- child rows. A checkpoint writes its children and head atomically; retirement
-- can drain children before removing the head. Preserve those v2 semantics.
CREATE TABLE community_preparation_progress_counters (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  is_exact INTEGER NOT NULL CHECK (is_exact IN (0, 1)),
  tracked_days INTEGER NOT NULL CHECK (tracked_days BETWEEN 0 AND 9007199254740991),
  complete_days INTEGER NOT NULL CHECK (complete_days BETWEEN 0 AND 9007199254740991),
  building_days INTEGER NOT NULL CHECK (building_days BETWEEN 0 AND 9007199254740991),
  retiring_days INTEGER NOT NULL CHECK (retiring_days BETWEEN 0 AND 9007199254740991),
  checkpoint_steps INTEGER NOT NULL CHECK (checkpoint_steps BETWEEN 0 AND 9007199254740991),
  quota_observations INTEGER NOT NULL CHECK (quota_observations BETWEEN 0 AND 9007199254740991),
  usage_events INTEGER NOT NULL CHECK (usage_events BETWEEN 0 AND 9007199254740991),
  CHECK (complete_days + building_days + retiring_days = tracked_days)
) STRICT;

-- One metadata-only bootstrap at migration time. TOTAL keeps an impossible
-- aggregate from overflowing SQLite's integer accumulator. Nonnegative sums
-- are exact throughout the safe-integer range; anything larger stays unknown.
INSERT INTO community_preparation_progress_counters
  (singleton_id,is_exact,tracked_days,complete_days,building_days,retiring_days,
   checkpoint_steps,quota_observations,usage_events)
SELECT 1,
  (CASE WHEN checkpoint_steps<=9007199254740991 AND quota_observations<=9007199254740991
    AND usage_events<=9007199254740991 THEN 1 ELSE 0 END),
  tracked_days,complete_days,building_days,retiring_days,
  (CASE WHEN checkpoint_steps<=9007199254740991 THEN checkpoint_steps ELSE 0 END),
  (CASE WHEN quota_observations<=9007199254740991 THEN quota_observations ELSE 0 END),
  (CASE WHEN usage_events<=9007199254740991 THEN usage_events ELSE 0 END)
FROM (SELECT COUNT(*) AS tracked_days,
  TOTAL(phase='complete') AS complete_days,
  TOTAL(phase IN ('quota','usage')) AS building_days,
  TOTAL(phase='discarding') AS retiring_days,
  TOTAL(progress_revision) AS checkpoint_steps,TOTAL(quota_count) AS quota_observations,
  TOTAL(usage_count) AS usage_events FROM community_prepared_source_days);

-- Delta maintenance is part of the source-head transaction, including foreign
-- key erasure and rollback. Impossible totals disable only this optional view;
-- they must not block preparation or manufacture a new zero-based baseline.
CREATE TRIGGER community_preparation_progress_insert AFTER INSERT ON community_prepared_source_days
BEGIN
  UPDATE community_preparation_progress_counters SET is_exact=0
  WHERE singleton_id=1 AND is_exact=1 AND (tracked_days=9007199254740991
    OR checkpoint_steps>9007199254740991-NEW.progress_revision
    OR quota_observations>9007199254740991-NEW.quota_count
    OR usage_events>9007199254740991-NEW.usage_count);
  UPDATE community_preparation_progress_counters SET tracked_days=tracked_days+1,
    complete_days=complete_days+(NEW.phase='complete'),
    building_days=building_days+(NEW.phase IN ('quota','usage')),
    retiring_days=retiring_days+(NEW.phase='discarding'),
    checkpoint_steps=checkpoint_steps+NEW.progress_revision,
    quota_observations=quota_observations+NEW.quota_count,usage_events=usage_events+NEW.usage_count
  WHERE singleton_id=1 AND is_exact=1;
END;

CREATE TRIGGER community_preparation_progress_update AFTER UPDATE ON community_prepared_source_days
WHEN OLD.phase IS NOT NEW.phase OR OLD.progress_revision IS NOT NEW.progress_revision
  OR OLD.quota_count IS NOT NEW.quota_count OR OLD.usage_count IS NOT NEW.usage_count
BEGIN
  UPDATE community_preparation_progress_counters SET is_exact=0
  WHERE singleton_id=1 AND is_exact=1 AND (tracked_days=0
    OR complete_days<(OLD.phase='complete') OR building_days<(OLD.phase IN ('quota','usage'))
    OR retiring_days<(OLD.phase='discarding') OR checkpoint_steps<OLD.progress_revision
    OR quota_observations<OLD.quota_count OR usage_events<OLD.usage_count
    OR checkpoint_steps-OLD.progress_revision>9007199254740991-NEW.progress_revision
    OR quota_observations-OLD.quota_count>9007199254740991-NEW.quota_count
    OR usage_events-OLD.usage_count>9007199254740991-NEW.usage_count);
  UPDATE community_preparation_progress_counters SET
    complete_days=complete_days-(OLD.phase='complete')+(NEW.phase='complete'),
    building_days=building_days-(OLD.phase IN ('quota','usage'))+(NEW.phase IN ('quota','usage')),
    retiring_days=retiring_days-(OLD.phase='discarding')+(NEW.phase='discarding'),
    checkpoint_steps=checkpoint_steps-OLD.progress_revision+NEW.progress_revision,
    quota_observations=quota_observations-OLD.quota_count+NEW.quota_count,
    usage_events=usage_events-OLD.usage_count+NEW.usage_count
  WHERE singleton_id=1 AND is_exact=1;
END;

CREATE TRIGGER community_preparation_progress_delete AFTER DELETE ON community_prepared_source_days
BEGIN
  UPDATE community_preparation_progress_counters SET is_exact=0
  WHERE singleton_id=1 AND is_exact=1 AND (tracked_days=0
    OR complete_days<(OLD.phase='complete') OR building_days<(OLD.phase IN ('quota','usage'))
    OR retiring_days<(OLD.phase='discarding') OR checkpoint_steps<OLD.progress_revision
    OR quota_observations<OLD.quota_count OR usage_events<OLD.usage_count);
  UPDATE community_preparation_progress_counters SET tracked_days=tracked_days-1,
    complete_days=complete_days-(OLD.phase='complete'),
    building_days=building_days-(OLD.phase IN ('quota','usage')),
    retiring_days=retiring_days-(OLD.phase='discarding'),
    checkpoint_steps=checkpoint_steps-OLD.progress_revision,
    quota_observations=quota_observations-OLD.quota_count,usage_events=usage_events-OLD.usage_count
  WHERE singleton_id=1 AND is_exact=1;
END;
