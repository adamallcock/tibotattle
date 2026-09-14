-- Global accountless issuance admission belongs to the routing catalog so
-- adding ingestion shards cannot multiply the daily or lifetime ceilings.
-- Reservations are permanent: an unavailable or ambiguous shard write may be
-- retried against the same owner, but it never returns capacity to the budget.
CREATE TABLE storage_accountless_issuance_state (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  budget_day TEXT NOT NULL CHECK (
    length(budget_day) = 10
    AND budget_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  initialization_state TEXT NOT NULL
    CHECK (initialization_state IN ('uninitialized', 'ready')),
  daily_reserved INTEGER NOT NULL CHECK (daily_reserved BETWEEN 0 AND 1000),
  lifetime_reserved INTEGER NOT NULL CHECK (lifetime_reserved BETWEEN 0 AND 10000),
  last_reservation_key TEXT NOT NULL CHECK (
    last_reservation_key = '' OR (
      length(last_reservation_key) = 64
      AND last_reservation_key NOT GLOB '*[^0-9a-f]*'
    )
  ),
  baseline_digest TEXT CHECK (baseline_digest IS NULL OR (
    length(baseline_digest) = 64
    AND baseline_digest NOT GLOB '*[^0-9a-f]*'
  )),
  initialized_at INTEGER CHECK (initialized_at IS NULL OR initialized_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK (
    (initialization_state = 'uninitialized'
      AND baseline_digest IS NULL AND initialized_at IS NULL
      AND daily_reserved = 0 AND lifetime_reserved = 0)
    OR
    (initialization_state = 'ready'
      AND baseline_digest IS NOT NULL AND initialized_at IS NOT NULL)
  )
) STRICT;

INSERT INTO storage_accountless_issuance_state (
  singleton_id, budget_day, initialization_state, daily_reserved,
  lifetime_reserved, last_reservation_key, baseline_digest,
  initialized_at, updated_at
) VALUES (1, '1970-01-01', 'uninitialized', 0, 0, '', NULL, NULL, 0);

CREATE TABLE storage_accountless_issuance_reservations (
  reservation_key TEXT PRIMARY KEY NOT NULL
    CHECK (length(reservation_key) = 64
      AND reservation_key NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL UNIQUE REFERENCES storage_owner_routes(owner_id),
  device_digest TEXT NOT NULL UNIQUE
    CHECK (length(device_digest) = 64
      AND device_digest NOT GLOB '*[^0-9a-f]*'),
  budget_day TEXT NOT NULL CHECK (
    length(budget_day) = 10
    AND budget_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  reserved_at INTEGER NOT NULL CHECK (reserved_at >= 0)
) STRICT;

-- The client device id never selects or authenticates an owner. Its
-- domain-separated digest only prevents the same claimed device from being
-- split across shards by presenting a different secret hash.
CREATE TRIGGER storage_accountless_issuance_device_conflict
BEFORE INSERT ON storage_accountless_issuance_reservations
WHEN EXISTS (
  SELECT 1 FROM storage_accountless_issuance_reservations
   WHERE device_digest = NEW.device_digest
     AND reservation_key <> NEW.reservation_key
) BEGIN
  SELECT RAISE(ABORT, 'STORAGE_ACCOUNTLESS_ENROLLMENT_CONFLICT');
END;

-- The counter advances only when a new immutable reservation row is inserted.
-- INSERT ... ON CONFLICT replays therefore do not consume another slot. Any
-- limit or backward-clock refusal aborts the surrounding catalog transaction,
-- including a new owner route and capability locator created in that batch.
CREATE TRIGGER storage_accountless_issuance_requires_baseline
BEFORE INSERT ON storage_accountless_issuance_reservations
WHEN NOT EXISTS (
  SELECT 1 FROM storage_accountless_issuance_state
   WHERE singleton_id = 1 AND initialization_state = 'ready'
) BEGIN
  SELECT RAISE(ABORT, 'STORAGE_ACCOUNTLESS_ISSUANCE_UNINITIALIZED');
END;

CREATE TRIGGER storage_accountless_issuance_reserve
AFTER INSERT ON storage_accountless_issuance_reservations BEGIN
  UPDATE storage_accountless_issuance_state
     SET budget_day = NEW.budget_day,
         daily_reserved = CASE
           WHEN budget_day = NEW.budget_day THEN daily_reserved + 1
           ELSE 1
         END,
         lifetime_reserved = lifetime_reserved + 1,
         last_reservation_key = NEW.reservation_key,
         updated_at = NEW.reserved_at
   WHERE singleton_id = 1
     AND initialization_state = 'ready'
     AND lifetime_reserved < 10000
     AND budget_day <= NEW.budget_day
     AND (budget_day <> NEW.budget_day OR daily_reserved < 1000);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM storage_accountless_issuance_state
     WHERE singleton_id = 1
       AND last_reservation_key = NEW.reservation_key
  )
    THEN RAISE(ABORT, 'STORAGE_ACCOUNTLESS_ISSUANCE_LIMIT') END);
END;

CREATE TRIGGER storage_accountless_issuance_reservation_immutable
BEFORE UPDATE ON storage_accountless_issuance_reservations BEGIN
  SELECT RAISE(ABORT, 'STORAGE_ACCOUNTLESS_ISSUANCE_IMMUTABLE');
END;

CREATE TRIGGER storage_accountless_issuance_reservation_no_delete
BEFORE DELETE ON storage_accountless_issuance_reservations BEGIN
  SELECT RAISE(ABORT, 'STORAGE_ACCOUNTLESS_ISSUANCE_HISTORY_REQUIRED');
END;
