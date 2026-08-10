PRAGMA foreign_keys = ON;

-- Account deletion is a single `DELETE FROM participants WHERE id = ?`, and
-- its cost is set by foreign-key enforcement, not by the statement itself.
-- Four child columns that ON DELETE CASCADE must probe carried no index, so
-- SQLite fell back to a full table scan of the child for every deleted parent
-- row (EXPLAIN QUERY PLAN shows `SCAN <child>` inside the delete):
--
--   participants(id)  <- device_credential_rotations.participant_id
--   participants(id)  <- recovery_retry_receipts.participant_id
--   web_sessions(id)  <- device_pairings.issued_by_session_id
--   web_sessions(id)  <- upload_authorizations.issued_by_session_id
--
-- The session-keyed pair is the one that grows without bound: deleting one
-- participant cascades through each of their web sessions, and every deleted
-- session re-scans the whole `upload_authorizations` table, which holds one
-- row per accepted upload across ALL participants and is never pruned. The
-- deletion path therefore reads sessions x total-uploads rows: measured
-- against the load-lab shape (100 contributions per participant, 6 sessions),
-- the cascade term alone grew 0.6ms -> 3.9ms -> 7.3ms from 10 -> 50 -> 100
-- participants (flat at ~0.4ms with these indexes), and every one of those
-- row visits is billed D1 rows_read.
-- The participant-keyed pair grows more slowly (rotations and recovery
-- receipts), but scans on the same request path for the same reason.
--
-- Indexing the child key turns each probe into a SEARCH of exactly the rows
-- being deleted. No trigger fires on index creation, and none of the
-- immutability triggers (0005/0012) touch these four tables.

CREATE INDEX upload_authorizations_issued_by_session
  ON upload_authorizations(issued_by_session_id);

CREATE INDEX device_pairings_issued_by_session
  ON device_pairings(issued_by_session_id);

CREATE INDEX device_credential_rotations_participant
  ON device_credential_rotations(participant_id);

CREATE INDEX recovery_retry_receipts_participant
  ON recovery_retry_receipts(participant_id);
