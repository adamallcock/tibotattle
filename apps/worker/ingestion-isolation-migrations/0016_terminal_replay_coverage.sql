-- Current discovery stores an opaque owner digest. Reset both that cursor and
-- predecessor participant-ID cursors during erasure; no private resume ID is
-- required after the native owner-digest discovery migration.
CREATE TRIGGER storage_effective_selective_bootstrap_participant_erase BEFORE DELETE ON participants
BEGIN UPDATE storage_effective_selective_bootstrap SET owner_cursor='',complete=0
 WHERE owner_cursor=OLD.id OR owner_cursor=(SELECT owner_digest FROM storage_v11_owner_links WHERE participant_id=OLD.id); END;
CREATE TRIGGER storage_effective_selective_bootstrap_owner_erase AFTER UPDATE ON storage_owner_revisions WHEN NEW.state='erased'
BEGIN UPDATE storage_effective_selective_bootstrap SET owner_cursor='',complete=0
 WHERE owner_cursor=NEW.owner_digest OR owner_cursor=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest); END;
CREATE TRIGGER storage_effective_selective_bootstrap_link_erase AFTER UPDATE ON storage_v11_owner_links WHEN NEW.state='erased'
BEGIN UPDATE storage_effective_selective_bootstrap SET owner_cursor='',complete=0 WHERE owner_cursor IN(NEW.participant_id,NEW.owner_digest); END;
-- A predecessor cursor is not ordered in the current opaque digest keyspace.
UPDATE storage_effective_selective_bootstrap SET owner_cursor='',complete=0 WHERE owner_cursor!='' AND NOT EXISTS(
 SELECT 1 FROM storage_v11_owner_links l JOIN participants p ON p.id=l.participant_id
 JOIN storage_owner_revisions r ON r.owner_digest=l.owner_digest
 WHERE l.owner_digest=storage_effective_selective_bootstrap.owner_cursor AND p.state='active' AND l.state='active' AND r.state='active');
