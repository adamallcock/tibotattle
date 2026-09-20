-- No legacy daily values: baseline daily activity excludes v0.2.
CREATE TABLE analytics_legacy_authority_receipts (
 source_id TEXT NOT NULL,
 event_digest TEXT NOT NULL,
 owner_digest TEXT NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('legacy-fit-source','owner-withdrawn','owner-erased')),
 PRIMARY KEY(source_id,event_digest),
 FOREIGN KEY(source_id,event_digest) REFERENCES analytics_applied_events(source_id,event_digest)
) STRICT;
CREATE TRIGGER analytics_legacy_authority_receipt_immutable BEFORE UPDATE ON analytics_legacy_authority_receipts
BEGIN SELECT RAISE(ABORT,'analytics_legacy_receipt_immutable'); END;
