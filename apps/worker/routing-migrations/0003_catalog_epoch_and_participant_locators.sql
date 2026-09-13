CREATE TABLE storage_routing_state (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  catalog_epoch INTEGER NOT NULL CHECK (catalog_epoch BETWEEN 0 AND 9007199254740990)
) STRICT;
INSERT INTO storage_routing_state (singleton_id, catalog_epoch) VALUES (1, 0);

-- Server-only locator for Access-owner erasure. The raw participant id never
-- enters the catalog and this retained locator is not an authentication grant.
CREATE TABLE storage_participant_owner_locators (
  participant_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(participant_digest) = 64
      AND participant_digest NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES storage_owner_routes(owner_id),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (owner_id)
) STRICT;

CREATE TRIGGER storage_participant_owner_locator_immutable
BEFORE UPDATE ON storage_participant_owner_locators BEGIN
  SELECT RAISE(ABORT, 'STORAGE_PARTICIPANT_LOCATOR_IMMUTABLE');
END;
CREATE TRIGGER storage_participant_owner_locator_no_delete
BEFORE DELETE ON storage_participant_owner_locators BEGIN
  SELECT RAISE(ABORT, 'STORAGE_PARTICIPANT_LOCATOR_HISTORY_REQUIRED');
END;

CREATE TRIGGER storage_routing_epoch_owner_insert
AFTER INSERT ON storage_owner_routes BEGIN
  UPDATE storage_routing_state SET catalog_epoch = catalog_epoch + 1
   WHERE singleton_id = 1;
END;
CREATE TRIGGER storage_routing_epoch_owner_update
AFTER UPDATE OF shard_id, route_generation, state ON storage_owner_routes
WHEN NEW.shard_id <> OLD.shard_id
  OR NEW.route_generation <> OLD.route_generation
  OR NEW.state <> OLD.state BEGIN
  UPDATE storage_routing_state SET catalog_epoch = catalog_epoch + 1
   WHERE singleton_id = 1;
END;
CREATE TRIGGER storage_routing_epoch_shard_state
AFTER UPDATE OF state ON storage_shards
WHEN NEW.state <> OLD.state BEGIN
  UPDATE storage_routing_state SET catalog_epoch = catalog_epoch + 1
   WHERE singleton_id = 1;
END;
