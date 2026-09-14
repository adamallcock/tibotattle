-- Existing accountless enrollments already consumed the global issuance budget.
-- Import their exact immutable reservation identities without firing the new-
-- issuance counter, then publish the authoritative baseline only after the
-- bounded roster is verified by trusted runtime code.
CREATE TABLE storage_accountless_historical_issuance_state (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  import_state TEXT NOT NULL CHECK (import_state IN ('importing','ready')),
  imported_count INTEGER NOT NULL CHECK (imported_count BETWEEN 0 AND 10000),
  import_revision INTEGER NOT NULL CHECK (import_revision BETWEEN 0 AND 10000),
  roster_digest TEXT CHECK (roster_digest IS NULL OR (
    length(roster_digest) = 64 AND roster_digest NOT GLOB '*[^0-9a-f]*')),
  baseline_budget_day TEXT CHECK (baseline_budget_day IS NULL OR (
    length(baseline_budget_day) = 10
    AND baseline_budget_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  baseline_daily_reserved INTEGER CHECK (
    baseline_daily_reserved IS NULL OR baseline_daily_reserved BETWEEN 0 AND 1000),
  baseline_lifetime_reserved INTEGER CHECK (
    baseline_lifetime_reserved IS NULL OR baseline_lifetime_reserved BETWEEN 0 AND 10000),
  baseline_digest TEXT CHECK (baseline_digest IS NULL OR (
    length(baseline_digest) = 64 AND baseline_digest NOT GLOB '*[^0-9a-f]*')),
  baseline_initialized_at INTEGER CHECK (
    baseline_initialized_at IS NULL OR baseline_initialized_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK (imported_count = import_revision),
  CHECK (
    (import_state = 'importing' AND roster_digest IS NULL
      AND baseline_budget_day IS NULL AND baseline_daily_reserved IS NULL
      AND baseline_lifetime_reserved IS NULL AND baseline_digest IS NULL
      AND baseline_initialized_at IS NULL)
    OR
    (import_state = 'ready' AND roster_digest IS NOT NULL
      AND baseline_budget_day IS NOT NULL AND baseline_daily_reserved IS NOT NULL
      AND baseline_lifetime_reserved IS NOT NULL AND baseline_digest IS NOT NULL
      AND baseline_initialized_at IS NOT NULL)
  )
) STRICT;

INSERT INTO storage_accountless_historical_issuance_state (
  singleton_id,import_state,imported_count,import_revision,roster_digest,
  baseline_budget_day,baseline_daily_reserved,baseline_lifetime_reserved,
  baseline_digest,baseline_initialized_at,updated_at
) VALUES (1,'importing',0,0,NULL,NULL,NULL,NULL,NULL,NULL,0);

CREATE TABLE storage_accountless_historical_issuance_reservations (
  reservation_key TEXT PRIMARY KEY NOT NULL
    CHECK (length(reservation_key) = 64
      AND reservation_key NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL UNIQUE REFERENCES storage_owner_routes(owner_id),
  device_digest TEXT NOT NULL UNIQUE
    CHECK (length(device_digest) = 64
      AND device_digest NOT GLOB '*[^0-9a-f]*'),
  budget_day TEXT NOT NULL CHECK (
    length(budget_day) = 10
    AND budget_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reserved_at INTEGER NOT NULL CHECK (reserved_at >= 0)
) STRICT;

CREATE TRIGGER storage_accountless_historical_issuance_import_gate
BEFORE INSERT ON storage_accountless_historical_issuance_reservations
WHEN NOT EXISTS (SELECT 1 FROM storage_accountless_historical_issuance_state
  WHERE singleton_id=1 AND import_state='importing' AND imported_count<10000)
BEGIN SELECT RAISE(ABORT,'STORAGE_ACCOUNTLESS_ISSUANCE_UNINITIALIZED'); END;

CREATE TRIGGER storage_accountless_historical_issuance_conflict
BEFORE INSERT ON storage_accountless_historical_issuance_reservations
WHEN EXISTS (SELECT 1 FROM storage_accountless_historical_issuance_reservations
  WHERE reservation_key=NEW.reservation_key OR owner_id=NEW.owner_id OR device_digest=NEW.device_digest)
 AND NOT EXISTS (SELECT 1 FROM storage_accountless_historical_issuance_reservations
  WHERE reservation_key=NEW.reservation_key AND owner_id=NEW.owner_id
    AND device_digest=NEW.device_digest AND budget_day=NEW.budget_day AND reserved_at=NEW.reserved_at)
BEGIN SELECT RAISE(ABORT,'STORAGE_ACCOUNTLESS_ENROLLMENT_CONFLICT'); END;

CREATE TRIGGER storage_accountless_historical_issuance_current_conflict
BEFORE INSERT ON storage_accountless_historical_issuance_reservations
WHEN EXISTS (SELECT 1 FROM storage_accountless_issuance_reservations
  WHERE reservation_key=NEW.reservation_key OR owner_id=NEW.owner_id OR device_digest=NEW.device_digest)
BEGIN SELECT RAISE(ABORT,'STORAGE_ACCOUNTLESS_ENROLLMENT_CONFLICT'); END;

CREATE TRIGGER storage_accountless_issuance_historical_conflict
BEFORE INSERT ON storage_accountless_issuance_reservations
WHEN EXISTS (SELECT 1 FROM storage_accountless_historical_issuance_reservations
  WHERE reservation_key=NEW.reservation_key OR owner_id=NEW.owner_id OR device_digest=NEW.device_digest)
BEGIN SELECT RAISE(ABORT,'STORAGE_ACCOUNTLESS_ENROLLMENT_CONFLICT'); END;

CREATE TRIGGER storage_accountless_historical_issuance_count
AFTER INSERT ON storage_accountless_historical_issuance_reservations BEGIN
  UPDATE storage_accountless_historical_issuance_state
    SET imported_count=imported_count+1,import_revision=import_revision+1,
      updated_at=MAX(updated_at,NEW.reserved_at)
    WHERE singleton_id=1 AND import_state='importing' AND imported_count<10000;
  SELECT (CASE WHEN changes()<>1
    THEN RAISE(ABORT,'STORAGE_ACCOUNTLESS_ISSUANCE_UNINITIALIZED') END);
END;

CREATE TRIGGER storage_accountless_historical_issuance_state_transition
BEFORE UPDATE ON storage_accountless_historical_issuance_state
WHEN NEW.singleton_id<>OLD.singleton_id OR OLD.import_state='ready'
 OR NOT (
   (OLD.import_state='importing' AND NEW.import_state='importing'
    AND NEW.imported_count=OLD.imported_count+1
    AND NEW.import_revision=OLD.import_revision+1
    AND NEW.roster_digest IS NULL AND NEW.baseline_budget_day IS NULL
    AND NEW.baseline_daily_reserved IS NULL AND NEW.baseline_lifetime_reserved IS NULL
    AND NEW.baseline_digest IS NULL AND NEW.baseline_initialized_at IS NULL
    AND NEW.updated_at>=OLD.updated_at)
   OR
   (OLD.import_state='importing' AND NEW.import_state='ready'
    AND NEW.imported_count=OLD.imported_count
    AND NEW.import_revision=OLD.import_revision
    AND NEW.roster_digest IS NOT NULL AND NEW.baseline_budget_day IS NOT NULL
    AND NEW.baseline_daily_reserved IS NOT NULL AND NEW.baseline_lifetime_reserved IS NOT NULL
    AND NEW.baseline_digest IS NOT NULL AND NEW.baseline_initialized_at IS NOT NULL
    AND NEW.updated_at>=OLD.updated_at
    AND NEW.imported_count=(SELECT COUNT(*) FROM storage_accountless_historical_issuance_reservations))
 )
BEGIN SELECT RAISE(ABORT,'STORAGE_ACCOUNTLESS_ISSUANCE_BASELINE_CONFLICT'); END;

CREATE TRIGGER storage_accountless_historical_issuance_finalize
AFTER UPDATE OF import_state ON storage_accountless_historical_issuance_state
WHEN OLD.import_state='importing' AND NEW.import_state='ready' BEGIN
  UPDATE storage_accountless_issuance_state
    SET budget_day=NEW.baseline_budget_day,initialization_state='ready',
      daily_reserved=NEW.baseline_daily_reserved,
      lifetime_reserved=NEW.baseline_lifetime_reserved,last_reservation_key='',
      baseline_digest=NEW.baseline_digest,initialized_at=NEW.baseline_initialized_at,
      updated_at=NEW.baseline_initialized_at
    WHERE singleton_id=1 AND initialization_state='uninitialized';
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM storage_accountless_issuance_state
    WHERE singleton_id=1 AND initialization_state='ready'
      AND budget_day=NEW.baseline_budget_day
      AND daily_reserved=NEW.baseline_daily_reserved
      AND lifetime_reserved=NEW.baseline_lifetime_reserved
      AND baseline_digest=NEW.baseline_digest
      AND initialized_at=NEW.baseline_initialized_at)
    THEN RAISE(ABORT,'STORAGE_ACCOUNTLESS_ISSUANCE_BASELINE_CONFLICT') END);
END;

CREATE TRIGGER storage_accountless_historical_issuance_immutable
BEFORE UPDATE ON storage_accountless_historical_issuance_reservations
BEGIN SELECT RAISE(ABORT,'STORAGE_ACCOUNTLESS_ISSUANCE_IMMUTABLE'); END;

CREATE TRIGGER storage_accountless_historical_issuance_no_delete
BEFORE DELETE ON storage_accountless_historical_issuance_reservations
BEGIN SELECT RAISE(ABORT,'STORAGE_ACCOUNTLESS_ISSUANCE_HISTORY_REQUIRED'); END;

CREATE TRIGGER storage_accountless_historical_issuance_state_no_delete
BEFORE DELETE ON storage_accountless_historical_issuance_state
BEGIN SELECT RAISE(ABORT,'STORAGE_ACCOUNTLESS_ISSUANCE_HISTORY_REQUIRED'); END;

-- The old aggregate-ready state alone is insufficient after this migration.
-- Exact historical and current retries are resolved without INSERT; every new
-- reservation must see both independently verified readiness rows.
DROP TRIGGER storage_accountless_issuance_requires_baseline;
CREATE TRIGGER storage_accountless_issuance_requires_baseline
BEFORE INSERT ON storage_accountless_issuance_reservations
WHEN NOT EXISTS (SELECT 1 FROM storage_accountless_issuance_state
  WHERE singleton_id=1 AND initialization_state='ready')
 OR NOT EXISTS (SELECT 1 FROM storage_accountless_historical_issuance_state
  WHERE singleton_id=1 AND import_state='ready')
BEGIN SELECT RAISE(ABORT,'STORAGE_ACCOUNTLESS_ISSUANCE_UNINITIALIZED'); END;
