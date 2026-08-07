PRAGMA foreign_keys = ON;

-- telemetry-contribution-v1.0: incremental full-history contribution model.
-- v1.0 is additive alongside the deployed v0.1 prepared-sample path: it gets
-- its own append-only chunk journal, current record view, per-device daily
-- admission windows, and day-partitioned revisioned community aggregates.
-- The only v0.1-era object this migration touches is device_pairings, whose
-- pinned consent CHECKs are widened below (design doc section 8, item 8) so
-- a pairing can record the v1.0 ongoing-transport consent server-side.

-- ---------------------------------------------------------------------------
-- Widen device_pairings consent CHECKs (rebuild).
--
-- SQLite cannot alter a CHECK in place, and the textbook create-copy-drop-
-- rename recipe is unusable here: DROP TABLE device_pairings performs an
-- implicit DELETE whose ON DELETE CASCADE actions wipe the entire credential
-- subtree (empirically reproduced — device_credentials and everything under
-- it), and ALTER TABLE RENAME re-parses trigger bodies that reference the
-- table mid-dance. The safe form inside D1's single-transaction migration is
-- save/drop/recreate/restore: snapshot the subtree, let the drop cascade,
-- recreate the table with widened CHECKs, and restore the snapshot before
-- commit. PRAGMA defer_foreign_keys keeps the contributions rows' NO ACTION
-- references to device_upload_authorizations satisfied at commit. The two
-- BEFORE INSERT triggers are dropped for the restore (their admission
-- predicates must not re-judge historical rows) and recreated verbatim.
PRAGMA defer_foreign_keys = true;

CREATE TABLE device_pairings_save AS
  SELECT id, participant_id, issued_by_session_id, secret_hash,
    consent_version, state, issued_at, expires_at, consumed_at,
    revoked_at, claimed_device_id, transport_consent_version
  FROM device_pairings;

CREATE TABLE device_credentials_save AS
  SELECT id, participant_id, paired_via_pairing_id, secret_hash, state,
    issued_at, expires_at, last_used_at, revoked_at, social_verified_at,
    credential_generation
  FROM device_credentials;

CREATE TABLE device_upload_authorizations_save AS
  SELECT id, participant_id, issued_by_device_id, secret_hash,
    envelope_digest, body_bytes, content_type, state, issued_at,
    expires_at, consumed_at, revoked_at, consume_lease_expires_at,
    consumed_contribution_id
  FROM device_upload_authorizations;

CREATE TABLE device_credential_rotations_save AS
  SELECT id, device_id, participant_id, prior_secret_hash,
    replacement_secret_hash, attempt_id, generation, rotated_at, retire_at
  FROM device_credential_rotations;

CREATE TABLE device_pairing_events_save AS
  SELECT id, pairing_id, participant_id, kind, occurred_at
  FROM device_pairing_events;

DROP TRIGGER device_credentials_require_active_pairing;
DROP TRIGGER device_upload_authorizations_require_active_device;

DROP TABLE device_pairings;

CREATE TABLE device_pairings (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  issued_by_session_id TEXT NOT NULL,
  secret_hash BLOB NOT NULL CHECK (length(secret_hash) = 32),
  consent_version TEXT NOT NULL
    CHECK (consent_version IN (
      'ongoing-privacy-safe-telemetry-v0.1',
      'ongoing-privacy-safe-telemetry-v1.0'
    )),
  state TEXT NOT NULL DEFAULT 'unused'
    CHECK (state IN ('unused', 'consumed', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  claimed_device_id TEXT,
  transport_consent_version TEXT NOT NULL
    DEFAULT 'ongoing-privacy-safe-telemetry-v0.1'
    CHECK (transport_consent_version IN (
      'ongoing-privacy-safe-telemetry-v0.1',
      'ongoing-privacy-safe-telemetry-v0.2',
      'ongoing-privacy-safe-telemetry-v1.0'
    )),
  FOREIGN KEY (participant_id) REFERENCES participants(id)
    ON DELETE CASCADE,
  FOREIGN KEY (issued_by_session_id) REFERENCES web_sessions(id)
    ON DELETE CASCADE
) STRICT;

INSERT INTO device_pairings (
  id, participant_id, issued_by_session_id, secret_hash, consent_version,
  state, issued_at, expires_at, consumed_at, revoked_at,
  claimed_device_id, transport_consent_version
)
SELECT id, participant_id, issued_by_session_id, secret_hash,
  consent_version, state, issued_at, expires_at, consumed_at, revoked_at,
  claimed_device_id, transport_consent_version
FROM device_pairings_save;

INSERT INTO device_credentials (
  id, participant_id, paired_via_pairing_id, secret_hash, state,
  issued_at, expires_at, last_used_at, revoked_at, social_verified_at,
  credential_generation
)
SELECT id, participant_id, paired_via_pairing_id, secret_hash, state,
  issued_at, expires_at, last_used_at, revoked_at, social_verified_at,
  credential_generation
FROM device_credentials_save;

INSERT INTO device_upload_authorizations (
  id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
  body_bytes, content_type, state, issued_at, expires_at, consumed_at,
  revoked_at, consume_lease_expires_at, consumed_contribution_id
)
SELECT id, participant_id, issued_by_device_id, secret_hash,
  envelope_digest, body_bytes, content_type, state, issued_at, expires_at,
  consumed_at, revoked_at, consume_lease_expires_at,
  consumed_contribution_id
FROM device_upload_authorizations_save;

INSERT INTO device_credential_rotations (
  id, device_id, participant_id, prior_secret_hash,
  replacement_secret_hash, attempt_id, generation, rotated_at, retire_at
)
SELECT id, device_id, participant_id, prior_secret_hash,
  replacement_secret_hash, attempt_id, generation, rotated_at, retire_at
FROM device_credential_rotations_save;

INSERT INTO device_pairing_events (
  id, pairing_id, participant_id, kind, occurred_at
)
SELECT id, pairing_id, participant_id, kind, occurred_at
FROM device_pairing_events_save;

DROP TABLE device_pairings_save;
DROP TABLE device_credentials_save;
DROP TABLE device_upload_authorizations_save;
DROP TABLE device_credential_rotations_save;
DROP TABLE device_pairing_events_save;

CREATE INDEX device_pairings_participant_state
  ON device_pairings(participant_id, state, expires_at);

CREATE INDEX device_pairings_issued_by_session
  ON device_pairings(issued_by_session_id);

CREATE TRIGGER device_credentials_require_active_pairing
BEFORE INSERT ON device_credentials
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM device_pairings pairing
    JOIN participants participant ON participant.id = pairing.participant_id
   WHERE pairing.id = NEW.paired_via_pairing_id
     AND pairing.participant_id = NEW.participant_id
     AND pairing.state = 'unused'
     AND pairing.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND participant.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'pairing unavailable');
END;

CREATE TRIGGER device_upload_authorizations_require_active_device
BEFORE INSERT ON device_upload_authorizations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM device_credentials device
    JOIN participants participant ON participant.id = device.participant_id
   WHERE device.id = NEW.issued_by_device_id
     AND device.participant_id = NEW.participant_id
     AND device.state = 'active'
     AND device.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND participant.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'device unavailable');
END;

-- ---------------------------------------------------------------------------
-- v1.0 chunk journal, current view, consent, admission, and daily aggregates.

-- Journal: append-only, one row per accepted chunk revision. A superseded
-- revision keeps its row (superseded_at set); the current view of a chunk is
-- always the single row per (participant, device, stream, day, seq) with
-- superseded_at IS NULL.
CREATE TABLE telemetry_v1_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('usage', 'quota', 'session')),
  chunk_day TEXT NOT NULL
    CHECK (chunk_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  chunk_seq INTEGER NOT NULL CHECK (chunk_seq >= 0 AND chunk_seq <= 99999),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  chunk_digest TEXT NOT NULL
    CHECK (length(chunk_digest) = 64
      AND chunk_digest NOT GLOB '*[^0-9a-f]*'),
  envelope_digest TEXT NOT NULL
    CHECK (length(envelope_digest) = 64
      AND envelope_digest NOT GLOB '*[^0-9a-f]*'),
  parser_version TEXT NOT NULL,
  record_count INTEGER NOT NULL
    CHECK (record_count >= 1 AND record_count <= 200),
  accepted_record_count INTEGER NOT NULL
    CHECK (accepted_record_count >= 0
      AND accepted_record_count <= record_count),
  r2_key TEXT NOT NULL UNIQUE,
  device_upload_authorization_id TEXT NOT NULL UNIQUE
    REFERENCES device_upload_authorizations(id),
  superseded_at TEXT,
  quarantine_deleted_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES device_credentials(id) ON DELETE CASCADE,
  UNIQUE (participant_id, device_id, stream, chunk_day, chunk_seq, revision),
  UNIQUE (participant_id, envelope_digest)
) STRICT;

CREATE UNIQUE INDEX telemetry_v1_chunks_current_identity
  ON telemetry_v1_chunks(participant_id, device_id, stream, chunk_day,
    chunk_seq)
  WHERE superseded_at IS NULL;

-- Content digest identity for idempotent replay, scoped to the FULL chunk
-- identity: an equal digest at a different (device, stream, seq) is a
-- coincidence, not a replay, and proceeds as its own insert. The uniqueness
-- is deliberately partial — a re-scan that reverts a day to earlier content
-- must be able to insert a new revision whose digest equals an old
-- superseded revision's digest.
CREATE UNIQUE INDEX telemetry_v1_chunks_current_content
  ON telemetry_v1_chunks(participant_id, device_id, stream, chunk_day,
    chunk_seq, chunk_digest)
  WHERE superseded_at IS NULL;

CREATE INDEX telemetry_v1_chunks_device_day
  ON telemetry_v1_chunks(participant_id, device_id, chunk_day, stream,
    chunk_seq)
  WHERE superseded_at IS NULL;

-- Deletion-cascade child index (0030 convention): the device FK needs an
-- index so participant deletion does not scan the journal per device row.
CREATE INDEX telemetry_v1_chunks_device
  ON telemetry_v1_chunks(device_id);

CREATE INDEX telemetry_v1_chunks_participant_created
  ON telemetry_v1_chunks(participant_id, created_at, id);

-- Current record view: exactly the latest revision of every chunk. A
-- higher-revision chunk REPLACES its records; within a revision replay
-- stores nothing (the journal dedupe answers first).
CREATE TABLE telemetry_v1_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_row_id TEXT NOT NULL
    REFERENCES telemetry_v1_chunks(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('usage', 'quota', 'session')),
  occurrence_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_day TEXT NOT NULL
    CHECK (observed_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  provider TEXT,
  model_id TEXT,
  session_uuid TEXT,
  plan_type TEXT,
  plan_variant TEXT,
  limit_id TEXT,
  slot TEXT,
  used_percent REAL,
  window_duration_minutes INTEGER,
  resets_at TEXT,
  input_uncached_tokens INTEGER,
  input_cache_read_tokens INTEGER,
  input_cache_write_tokens INTEGER,
  output_text_tokens INTEGER,
  output_reasoning_tokens INTEGER,
  output_combined_tokens INTEGER,
  record_json TEXT NOT NULL,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  UNIQUE (participant_id, device_id, stream, occurrence_id)
) STRICT;

CREATE INDEX telemetry_v1_records_chunk
  ON telemetry_v1_records(chunk_row_id);

CREATE INDEX telemetry_v1_records_aggregate_day
  ON telemetry_v1_records(observed_day, stream, provider, model_id);

-- Consent-once: the server-recorded v1.0 consent grant for a device. The
-- row is written by the pairing claim of a v1.0-consented pairing (a
-- session-authorized, CSRF-protected grant), never by an upload; a chunk's
-- self-declared consent block must equal this record or the upload is
-- refused. The client's consentCurrent gate re-prompts before that happens.
CREATE TABLE telemetry_v1_device_consents (
  participant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  telemetry_schema_version TEXT NOT NULL
    CHECK (telemetry_schema_version = 'telemetry-contribution-v1.0'),
  field_dictionary_version TEXT NOT NULL,
  privacy_contract_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, device_id),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES device_credentials(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX telemetry_v1_device_consents_device
  ON telemetry_v1_device_consents(device_id);

-- Admission is a per-device, per-UTC-day circuit breaker, not a quota:
-- 2,000 accepted chunks/day steady state and 20,000/day for the first
-- 7 days after device registration (owner decision, design doc open
-- question 1). The counter contains no content, digest, model, or account
-- field.
CREATE TABLE telemetry_v1_chunk_admission_windows (
  participant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  window_day TEXT NOT NULL
    CHECK (window_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  accepted_count INTEGER NOT NULL
    CHECK (accepted_count >= 1 AND accepted_count <= 20000),
  last_accepted_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, device_id, window_day),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES device_credentials(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX telemetry_v1_chunk_admission_windows_device
  ON telemetry_v1_chunk_admission_windows(device_id);

CREATE TRIGGER telemetry_v1_chunks_require_active_participant
BEFORE INSERT ON telemetry_v1_chunks
FOR EACH ROW
WHEN (SELECT state FROM participants WHERE id = NEW.participant_id)
  IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'participant unavailable');
END;

CREATE TRIGGER telemetry_v1_chunks_require_consuming_upload
BEFORE INSERT ON telemetry_v1_chunks
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM device_upload_authorizations upload
   WHERE upload.id = NEW.device_upload_authorization_id
     AND upload.participant_id = NEW.participant_id
     AND upload.issued_by_device_id = NEW.device_id
     AND upload.state = 'consuming'
     AND upload.consume_lease_expires_at >
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND upload.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'upload unavailable');
END;

CREATE TRIGGER telemetry_v1_chunks_consume_device_upload
AFTER INSERT ON telemetry_v1_chunks
FOR EACH ROW
BEGIN
  UPDATE device_upload_authorizations
     SET state = 'consumed',
         consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL,
         consumed_contribution_id = NEW.id
   WHERE id = NEW.device_upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming';
END;

CREATE TRIGGER telemetry_v1_chunks_enforce_admission
BEFORE INSERT ON telemetry_v1_chunks
FOR EACH ROW
WHEN COALESCE((
  SELECT windows.accepted_count
    FROM telemetry_v1_chunk_admission_windows windows
   WHERE windows.participant_id = NEW.participant_id
     AND windows.device_id = NEW.device_id
     AND windows.window_day = substr(NEW.created_at, 1, 10)
), 0) >= CASE WHEN (
    SELECT device.issued_at FROM device_credentials device
     WHERE device.id = NEW.device_id
  ) > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '-7 days')
  THEN 20000 ELSE 2000 END
BEGIN
  SELECT RAISE(ABORT, 'chunk admission window exhausted');
END;

CREATE TRIGGER telemetry_v1_chunks_record_admission
AFTER INSERT ON telemetry_v1_chunks
FOR EACH ROW
BEGIN
  INSERT INTO telemetry_v1_chunk_admission_windows (
    participant_id, device_id, window_day, accepted_count, last_accepted_at
  ) VALUES (
    NEW.participant_id,
    NEW.device_id,
    substr(NEW.created_at, 1, 10),
    1,
    NEW.created_at
  )
  ON CONFLICT (participant_id, device_id, window_day)
  DO UPDATE SET
    accepted_count = accepted_count + 1,
    last_accepted_at = excluded.last_accepted_at;
END;

-- Day-partitioned community aggregates, revisioned instead of sealed
-- (design doc section 4). A published revision row is immutable; late or
-- revised data produces revision N+1. No per-day suppression threshold can
-- block publication (owner decision 4).
CREATE TABLE community_daily_aggregates (
  aggregate_id TEXT PRIMARY KEY NOT NULL,
  day TEXT NOT NULL
    CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  source_mutation_epoch INTEGER NOT NULL
    CHECK (source_mutation_epoch >= 0),
  policy_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL
    CHECK (length(payload_sha256) = 64
      AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  release_state TEXT NOT NULL
    CHECK (release_state IN ('published', 'withdrawn')),
  released_at TEXT NOT NULL,
  withdrawn_at TEXT,
  UNIQUE (day, revision),
  CHECK (
    (release_state = 'withdrawn' AND withdrawn_at IS NOT NULL)
    OR
    (release_state = 'published' AND withdrawn_at IS NULL)
  )
) STRICT;

CREATE INDEX community_daily_aggregates_latest
  ON community_daily_aggregates(day DESC, revision DESC);

CREATE TABLE community_daily_aggregate_rebuilds (
  day TEXT PRIMARY KEY NOT NULL,
  requested_epoch INTEGER NOT NULL CHECK (requested_epoch >= 0),
  requested_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER community_daily_aggregates_immutable
BEFORE UPDATE ON community_daily_aggregates
FOR EACH ROW
WHEN NEW.aggregate_id IS NOT OLD.aggregate_id
  OR NEW.day IS NOT OLD.day
  OR NEW.revision IS NOT OLD.revision
  OR NEW.source_mutation_epoch IS NOT OLD.source_mutation_epoch
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.released_at IS NOT OLD.released_at
  OR OLD.release_state = 'withdrawn'
  OR NEW.release_state NOT IN ('withdrawn')
BEGIN
  SELECT RAISE(ABORT, 'published aggregate revision immutable');
END;

CREATE TRIGGER community_daily_aggregates_no_delete
BEFORE DELETE ON community_daily_aggregates
BEGIN
  SELECT RAISE(ABORT, 'published aggregate revision immutable');
END;

-- "No sealing": every accepted chunk revision (new data, late data, or a
-- supersession) enqueues its day for recomputation. The hourly cron drains
-- the queue, so a burst of late data coalesces into one rebuild per day.
CREATE TRIGGER telemetry_v1_chunks_enqueue_daily_rebuild
AFTER INSERT ON telemetry_v1_chunks
FOR EACH ROW
BEGIN
  INSERT INTO community_daily_aggregate_rebuilds (
    day, requested_epoch, requested_at
  ) VALUES (
    NEW.chunk_day,
    (
      SELECT mutation_epoch FROM community_snapshot_mutation_control
       WHERE singleton_id = 1
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(day) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
END;

-- Participant deletion withdraws every published daily revision and
-- enqueues those days for rebuild without the deleted source — the 0012
-- withdrawal + rebuild-queue pattern retargeted at daily aggregates.
CREATE TRIGGER community_daily_aggregate_participant_withdrawal
BEFORE UPDATE OF state ON participants
FOR EACH ROW
WHEN OLD.state = 'active' AND NEW.state = 'deleting'
BEGIN
  INSERT INTO community_daily_aggregate_rebuilds (
    day, requested_epoch, requested_at
  )
  SELECT day,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_daily_aggregates
   WHERE release_state = 'published'
  ON CONFLICT(day) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_daily_aggregates
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE release_state = 'published';
END;
