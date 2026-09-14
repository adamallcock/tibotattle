-- A fenced owner move must preserve the accountless participant's private
-- attribution namespace and transport floor.  This temporary seed is exact,
-- owner-bound and immutable after materialization; ordinary participant
-- creation retains the existing random namespace and owner-kind floor.
CREATE TABLE storage_owner_move_authority_seeds (
 participant_id TEXT PRIMARY KEY NOT NULL CHECK(length(participant_id) BETWEEN 1 AND 256),
 device_id TEXT NOT NULL CHECK(length(device_id) BETWEEN 1 AND 256),
 move_id TEXT NOT NULL UNIQUE CHECK(length(move_id) BETWEEN 1 AND 128),
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 attribution_namespace TEXT NOT NULL UNIQUE CHECK(length(attribution_namespace)=64 AND attribution_namespace NOT GLOB '*[^0-9a-f]*'),
 attribution_created_at TEXT NOT NULL,
 floor_minimum_rank INTEGER NOT NULL CHECK(floor_minimum_rank IN(1,11)),
 floor_revision INTEGER NOT NULL CHECK(floor_revision BETWEEN 0 AND 2147483647),
 floor_changed_at TEXT NOT NULL,
 authority_digest TEXT NOT NULL CHECK(length(authority_digest)=64 AND authority_digest NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN('prepared','materialized'))
) STRICT;
CREATE INDEX storage_owner_move_authority_owner ON storage_owner_move_authority_seeds(owner_id,state);
CREATE TRIGGER storage_owner_move_authority_seed_immutable BEFORE UPDATE ON storage_owner_move_authority_seeds
WHEN NEW.participant_id<>OLD.participant_id OR NEW.device_id<>OLD.device_id
 OR NEW.move_id<>OLD.move_id OR NEW.owner_id<>OLD.owner_id
 OR NEW.attribution_namespace<>OLD.attribution_namespace OR NEW.attribution_created_at<>OLD.attribution_created_at
 OR NEW.floor_minimum_rank<>OLD.floor_minimum_rank OR NEW.floor_revision<>OLD.floor_revision
 OR NEW.floor_changed_at<>OLD.floor_changed_at OR NEW.authority_digest<>OLD.authority_digest
 OR OLD.state='materialized' OR NEW.state<>'materialized'
BEGIN SELECT (RAISE(ABORT,'STORAGE_MOVE_AUTHORITY_CONFLICT')); END;

CREATE TABLE storage_owner_move_authority_contract (
 id INTEGER PRIMARY KEY CHECK(id=1),
 version INTEGER NOT NULL CHECK(version=1)
) STRICT;
INSERT INTO storage_owner_move_authority_contract(id,version) VALUES(1,1);

DROP TRIGGER attribution_enrollment_created;
CREATE TRIGGER attribution_enrollment_created AFTER INSERT ON participants BEGIN
 INSERT INTO attribution_enrollments(participant_id,namespace,created_at)
 SELECT NEW.id,seed.attribution_namespace,seed.attribution_created_at
 FROM storage_owner_move_authority_seeds seed WHERE seed.participant_id=NEW.id AND seed.state='prepared'
 UNION ALL SELECT NEW.id,lower(hex(randomblob(32))),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NOT EXISTS(SELECT 1 FROM storage_owner_move_authority_seeds WHERE participant_id=NEW.id AND state='prepared');
END;

DROP TRIGGER telemetry_transport_floor_created;
CREATE TRIGGER telemetry_transport_floor_created AFTER INSERT ON participants BEGIN
 INSERT INTO telemetry_transport_participant_floors(participant_id,minimum_rank,revision,changed_at)
 SELECT NEW.id,seed.floor_minimum_rank,seed.floor_revision,seed.floor_changed_at
 FROM storage_owner_move_authority_seeds seed WHERE seed.participant_id=NEW.id AND seed.state='prepared'
 UNION ALL SELECT NEW.id,(CASE WHEN NEW.owner_kind='accountless' THEN 11 ELSE 1 END),0,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NOT EXISTS(SELECT 1 FROM storage_owner_move_authority_seeds WHERE participant_id=NEW.id AND state='prepared');
END;
