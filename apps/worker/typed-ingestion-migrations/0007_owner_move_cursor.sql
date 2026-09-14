-- Owner movement reads one already-authenticated owner without scanning other
-- owners that share the physical ingestion database.
CREATE INDEX typed_telemetry_owner_source_cursor
 ON typed_telemetry_records(owner_id,format,source_row_id);

CREATE TABLE storage_owner_move_cursor_contract (
 id INTEGER PRIMARY KEY CHECK(id=1),
 version INTEGER NOT NULL CHECK(version=1)
) STRICT;
INSERT INTO storage_owner_move_cursor_contract(id,version) VALUES(1,1);
