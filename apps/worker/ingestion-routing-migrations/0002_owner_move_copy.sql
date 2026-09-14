-- Private, destination-local pre-copy.  Rows remain invisible to admission and
-- analytics until a separately fenced materialization and route switch.
CREATE TABLE storage_owner_move_staged_records (
 move_id TEXT NOT NULL CHECK(length(move_id) BETWEEN 1 AND 128),
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 participant_id TEXT NOT NULL CHECK(length(participant_id) BETWEEN 1 AND 256),
 source_namespace TEXT NOT NULL CHECK(length(source_namespace) BETWEEN 1 AND 256),
 source_row_id INTEGER NOT NULL CHECK(source_row_id BETWEEN 1 AND 9007199254740991),
 device_id TEXT NOT NULL CHECK(length(device_id) BETWEEN 1 AND 256),
 chunk_row_id TEXT NOT NULL CHECK(length(chunk_row_id) BETWEEN 1 AND 256),
 manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 256),
 chunk_day TEXT NOT NULL CHECK(length(chunk_day)=10),
 observed_day TEXT NOT NULL CHECK(length(observed_day)=10),
 canonical_record TEXT NOT NULL CHECK(json_valid(canonical_record) AND length(canonical_record)<=100000),
 record_digest TEXT NOT NULL CHECK(length(record_digest)=64 AND record_digest NOT GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(move_id,source_namespace,source_row_id),
 UNIQUE(move_id,source_namespace,chunk_row_id,source_row_id)
) STRICT;
CREATE INDEX storage_owner_move_staged_participant
 ON storage_owner_move_staged_records(participant_id,move_id);

CREATE TABLE storage_owner_move_copy_controls (
 move_id TEXT PRIMARY KEY NOT NULL CHECK(length(move_id) BETWEEN 1 AND 128),
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 state TEXT NOT NULL CHECK(state IN('open','closed'))
) STRICT;
CREATE INDEX storage_owner_move_copy_control_owner
 ON storage_owner_move_copy_controls(owner_id,state);
CREATE TABLE storage_owner_move_erasure_controls (
 move_id TEXT PRIMARY KEY NOT NULL CHECK(length(move_id) BETWEEN 1 AND 128),
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 participant_id TEXT NOT NULL CHECK(length(participant_id) BETWEEN 1 AND 256)
) STRICT;
CREATE TABLE storage_owner_move_erasure_receipts (
 move_id TEXT PRIMARY KEY NOT NULL CHECK(length(move_id) BETWEEN 1 AND 128),
 completed INTEGER NOT NULL CHECK(completed=1)
) STRICT;
CREATE TRIGGER storage_owner_move_erasure_receipt_immutable BEFORE UPDATE ON storage_owner_move_erasure_receipts
BEGIN SELECT RAISE(ABORT,'STORAGE_MOVE_ERASURE_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER storage_owner_move_erasure_receipt_retained BEFORE DELETE ON storage_owner_move_erasure_receipts
BEGIN SELECT RAISE(ABORT,'STORAGE_MOVE_ERASURE_RECEIPT_REQUIRED'); END;
CREATE TRIGGER storage_owner_move_copy_control_transition BEFORE UPDATE ON storage_owner_move_copy_controls
WHEN NEW.move_id<>OLD.move_id OR NEW.owner_id<>OLD.owner_id
 OR NOT(OLD.state='open' AND NEW.state='closed')
BEGIN SELECT RAISE(ABORT,'STORAGE_MOVE_COPY_CONTROL_INVALID'); END;
CREATE TRIGGER storage_owner_move_copy_control_retained BEFORE DELETE ON storage_owner_move_copy_controls
WHEN NOT EXISTS(SELECT 1 FROM storage_owner_move_erasure_controls erasure
 WHERE erasure.move_id=OLD.move_id AND erasure.owner_id=OLD.owner_id)
 OR EXISTS(SELECT 1 FROM storage_owner_move_staged_records staged
 WHERE staged.move_id=OLD.move_id AND staged.owner_id=OLD.owner_id)
 OR EXISTS(SELECT 1 FROM storage_owner_move_authority_seeds seed
 WHERE seed.move_id=OLD.move_id AND seed.owner_id=OLD.owner_id)
 OR EXISTS(SELECT 1 FROM storage_owner_move_history_imports history
 WHERE history.move_id=OLD.move_id AND history.owner_id=OLD.owner_id)
BEGIN SELECT RAISE(ABORT,'STORAGE_MOVE_COPY_CONTROL_REQUIRED'); END;

CREATE TRIGGER storage_owner_move_erasure_exact BEFORE INSERT ON storage_owner_move_erasure_controls
WHEN EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id)
 OR NOT EXISTS(SELECT 1 FROM storage_owner_move_copy_controls control
  WHERE control.move_id=NEW.move_id AND control.owner_id=NEW.owner_id AND control.state='closed')
 OR EXISTS(SELECT 1 FROM storage_owner_move_staged_records staged
  WHERE staged.move_id=NEW.move_id AND staged.owner_id=NEW.owner_id)
 OR EXISTS(SELECT 1 FROM storage_owner_move_authority_seeds seed
  WHERE seed.move_id=NEW.move_id AND seed.owner_id=NEW.owner_id)
 OR EXISTS(SELECT 1 FROM storage_owner_move_history_imports history
  WHERE history.move_id=NEW.move_id AND history.owner_id=NEW.owner_id)
BEGIN SELECT RAISE(ABORT,'STORAGE_MOVE_ERASURE_UNPROVEN'); END;
CREATE TRIGGER storage_owner_move_erasure_apply AFTER INSERT ON storage_owner_move_erasure_controls
BEGIN
 DELETE FROM storage_owner_move_copy_controls WHERE move_id=NEW.move_id AND owner_id=NEW.owner_id;
 INSERT INTO storage_owner_move_erasure_receipts(move_id,completed) VALUES(NEW.move_id,1);
 DELETE FROM storage_owner_move_erasure_controls WHERE move_id=NEW.move_id AND owner_id=NEW.owner_id;
END;

CREATE TABLE storage_owner_move_copy_contract (
 id INTEGER PRIMARY KEY CHECK(id=1),
 version INTEGER NOT NULL CHECK(version=1)
) STRICT;
INSERT INTO storage_owner_move_copy_contract(id,version) VALUES(1,1);

CREATE TRIGGER storage_owner_move_staged_authorized BEFORE INSERT ON storage_owner_move_staged_records
WHEN NOT EXISTS(SELECT 1 FROM storage_owner_move_copy_controls control
 WHERE control.move_id=NEW.move_id AND control.owner_id=NEW.owner_id AND control.state='open')
BEGIN SELECT RAISE(ABORT,'STORAGE_MOVE_COPY_CLOSED'); END;

CREATE TRIGGER storage_owner_move_staged_immutable BEFORE UPDATE ON storage_owner_move_staged_records
BEGIN SELECT RAISE(ABORT,'STORAGE_MOVE_COPY_CONFLICT'); END;
