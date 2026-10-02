-- Maintained selective dependencies. Native proofs remain authoritative until
-- an owner's bounded catalog bootstrap and all source work have completed.
-- Every stamp comes from this ONE source-global sequence; independent per-day
-- counters are never combined. Source triggers only journal bounded metadata.
CREATE TABLE storage_effective_selective_runtime (
 id INTEGER PRIMARY KEY CHECK(id=1), method TEXT NOT NULL CHECK(method='effective-selective-v1'),
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 9007199254740991),
 policy_stamp INTEGER NOT NULL CHECK(policy_stamp BETWEEN 0 AND sequence),
 acknowledged_policy_stamp INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_policy_stamp BETWEEN 0 AND policy_stamp)
) STRICT;
INSERT INTO storage_effective_selective_runtime VALUES(1,'effective-selective-v1',1,1,0);
CREATE TABLE storage_effective_selective_bootstrap (
 id INTEGER PRIMARY KEY CHECK(id=1), owner_cursor TEXT NOT NULL DEFAULT '',
 complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN(0,1))
) STRICT;
INSERT INTO storage_effective_selective_bootstrap(id) VALUES(1);
CREATE TABLE storage_effective_selective_owners (
 participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
 needs_work INTEGER NOT NULL DEFAULT 1 CHECK(needs_work IN(0,1)),
 seeded INTEGER NOT NULL DEFAULT 0 CHECK(seeded IN(0,1)),
 seed_day TEXT NOT NULL DEFAULT '', broad_stamp INTEGER NOT NULL DEFAULT 0,
 source_namespace TEXT NOT NULL DEFAULT '', owner_digest TEXT NOT NULL DEFAULT ''
) STRICT, WITHOUT ROWID;
CREATE INDEX storage_effective_selective_owner_pending ON storage_effective_selective_owners(needs_work,participant_id);
CREATE TABLE storage_effective_selective_work (
 id INTEGER PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 from_day TEXT NOT NULL, through_day TEXT NOT NULL, stamp INTEGER NOT NULL CHECK(stamp>0),
 day_cursor TEXT NOT NULL DEFAULT '', family INTEGER NOT NULL DEFAULT 0 CHECK(family BETWEEN 0 AND 4),
 row_cursor INTEGER NOT NULL DEFAULT 0 CHECK(row_cursor>=0),
 CHECK(length(from_day)=10 AND length(through_day)=10 AND from_day<=through_day),
 UNIQUE(participant_id,from_day,through_day)
) STRICT;
CREATE INDEX storage_effective_selective_work_owner ON storage_effective_selective_work(participant_id,id);
CREATE TABLE storage_effective_selective_variants (
 id INTEGER PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 family INTEGER NOT NULL CHECK(family BETWEEN 0 AND 2), source_row INTEGER NOT NULL,
 occurrence_id BLOB NOT NULL CHECK(length(occurrence_id) BETWEEN 2 AND 257),
 occurrence_key TEXT NOT NULL CHECK(length(occurrence_key)=64),
 stream INTEGER NOT NULL CHECK(stream IN(1,2,3)), source_day TEXT NOT NULL CHECK(length(source_day)=10),
 observed_at_ms INTEGER NOT NULL, session_key BLOB,
 variant_digest BLOB NOT NULL CHECK(length(variant_digest)=32),
 UNIQUE(participant_id,family,source_row,variant_digest)
) STRICT;
CREATE INDEX storage_effective_selective_variant_day ON storage_effective_selective_variants(participant_id,source_day,id);
CREATE INDEX storage_effective_selective_variant_key ON storage_effective_selective_variants(participant_id,occurrence_key,observed_at_ms);
CREATE INDEX storage_effective_selective_variant_occurrence ON storage_effective_selective_variants(participant_id,occurrence_id,source_day,stream);
CREATE TABLE storage_effective_selective_reverse_work (
 participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 occurrence_id BLOB NOT NULL CHECK(length(occurrence_id) BETWEEN 2 AND 257),
 stamp INTEGER NOT NULL CHECK(stamp>0), day_cursor TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(participant_id,occurrence_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE storage_effective_selective_days (
 participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 source_day TEXT NOT NULL CHECK(length(source_day)=10),
 stream INTEGER NOT NULL CHECK(stream IN(1,2,3)), stamp INTEGER NOT NULL CHECK(stamp>0),
 PRIMARY KEY(participant_id,source_day,stream)
) STRICT, WITHOUT ROWID;
-- Durable discoverable affected work. Delivery uses exact row/stamp ACK rather
-- than a high-water cursor, so delayed fanout cannot strand an older effect.
CREATE TABLE storage_effective_selective_ranges (
 participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 from_day TEXT NOT NULL, through_day TEXT NOT NULL, stamp INTEGER NOT NULL CHECK(stamp>0),
 PRIMARY KEY(participant_id,from_day,through_day)
) STRICT, WITHOUT ROWID;
CREATE TABLE storage_effective_selective_effects (
 participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 source_day TEXT NOT NULL, through_day TEXT NOT NULL, stream INTEGER NOT NULL CHECK(stream IN(0,1,2,3)),
 stamp INTEGER NOT NULL CHECK(stamp>0),
 PRIMARY KEY(participant_id,source_day,through_day,stream)
) STRICT, WITHOUT ROWID;
CREATE INDEX storage_effective_selective_effect_order ON storage_effective_selective_effects(stamp,participant_id,source_day,stream);
CREATE TRIGGER storage_effective_selective_sequence_guard BEFORE UPDATE ON storage_effective_selective_runtime
WHEN NEW.id IS NOT OLD.id OR NEW.method IS NOT OLD.method
 OR NOT ((NEW.sequence=OLD.sequence+1 AND NEW.policy_stamp>=OLD.policy_stamp AND NEW.policy_stamp<=NEW.sequence
   AND NEW.acknowledged_policy_stamp=OLD.acknowledged_policy_stamp)
  OR (NEW.sequence=OLD.sequence AND NEW.policy_stamp=OLD.policy_stamp
   AND NEW.acknowledged_policy_stamp=NEW.policy_stamp AND NEW.acknowledged_policy_stamp>=OLD.acknowledged_policy_stamp))
BEGIN SELECT RAISE(ABORT,'storage_effective_selective_sequence'); END;
CREATE TRIGGER storage_effective_selective_runtime_retained BEFORE DELETE ON storage_effective_selective_runtime
BEGIN SELECT RAISE(ABORT,'storage_effective_selective_runtime_retained'); END;

CREATE TRIGGER storage_effective_selective_participants_update AFTER UPDATE ON participants
WHEN NEW.id IS NOT OLD.id OR NEW.state IS NOT OLD.state OR NEW.consent_version IS NOT OLD.consent_version OR NEW.owner_kind IS NOT OLD.owner_kind
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.id WHERE OLD.id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.id WHERE NEW.id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_participants_delete BEFORE DELETE ON participants
BEGIN
 UPDATE storage_effective_selective_bootstrap SET owner_cursor='',complete=0
 WHERE owner_cursor=(SELECT owner_digest FROM storage_v11_owner_links WHERE participant_id=OLD.id);
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.id WHERE OLD.id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_device_credentials_insert AFTER INSERT ON device_credentials
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_device_credentials_update AFTER UPDATE ON device_credentials
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.state IS NOT OLD.state OR NEW.authority_kind IS NOT OLD.authority_kind OR NEW.accountless_enrollment_device_id IS NOT OLD.accountless_enrollment_device_id OR ((OLD.authority_kind='accountless' OR NEW.authority_kind='accountless') AND NEW.expires_at IS NOT OLD.expires_at)
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_device_credentials_delete BEFORE DELETE ON device_credentials
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_storage_v11_owner_links_insert AFTER INSERT ON storage_v11_owner_links
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_storage_v11_owner_links_update AFTER UPDATE ON storage_v11_owner_links
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.owner_digest IS NOT OLD.owner_digest OR NEW.state IS NOT OLD.state
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_storage_v11_owner_links_delete BEFORE DELETE ON storage_v11_owner_links
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_storage_owner_revisions_insert AFTER INSERT ON storage_owner_revisions
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) WHERE (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_storage_owner_revisions_update AFTER UPDATE ON storage_owner_revisions
WHEN NEW.owner_digest IS NOT OLD.owner_digest OR NEW.state IS NOT OLD.state OR
 (NEW.authority_epoch IS NOT OLD.authority_epoch AND NOT (
   OLD.state='active' AND NEW.state='active' AND EXISTS(SELECT 1 FROM storage_ingestion_changes c
   WHERE c.owner_digest=NEW.owner_digest AND c.revision=NEW.revision AND c.kind='owner-active'
     AND c.authority_epoch=NEW.authority_epoch AND c.authority_epoch=OLD.authority_epoch+1
     AND (EXISTS(SELECT 1 FROM storage_v11_event_sources e WHERE e.event_digest=c.event_digest AND e.owner_digest=c.owner_digest)
 OR EXISTS(SELECT 1 FROM storage_v12_event_sources e WHERE e.event_digest=c.event_digest AND e.owner_digest=c.owner_digest)))))
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) WHERE (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) WHERE (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_storage_owner_revisions_delete BEFORE DELETE ON storage_owner_revisions
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) WHERE (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v1_chunks_insert AFTER INSERT ON telemetry_v1_chunks
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.chunk_day,NEW.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.chunk_day IS NOT NULL AND NEW.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v1_chunks_update AFTER UPDATE ON telemetry_v1_chunks
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.stream IS NOT OLD.stream OR NEW.chunk_day IS NOT OLD.chunk_day OR NEW.chunk_seq IS NOT OLD.chunk_seq OR NEW.revision IS NOT OLD.revision OR NEW.chunk_digest IS NOT OLD.chunk_digest OR NEW.envelope_digest IS NOT OLD.envelope_digest OR NEW.parser_version IS NOT OLD.parser_version OR NEW.record_count IS NOT OLD.record_count OR NEW.accepted_record_count IS NOT OLD.accepted_record_count OR NEW.r2_key IS NOT OLD.r2_key OR NEW.device_upload_authorization_id IS NOT OLD.device_upload_authorization_id OR NEW.superseded_at IS NOT OLD.superseded_at OR NEW.quarantine_deleted_at IS NOT OLD.quarantine_deleted_at OR NEW.created_at IS NOT OLD.created_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.chunk_day,OLD.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.chunk_day IS NOT NULL AND OLD.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.chunk_day,NEW.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.chunk_day IS NOT NULL AND NEW.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v1_chunks_delete BEFORE DELETE ON telemetry_v1_chunks
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.chunk_day,OLD.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.chunk_day IS NOT NULL AND OLD.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_event_sources_insert AFTER INSERT ON typed_v1_event_sources
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_event_sources_update AFTER UPDATE ON typed_v1_event_sources
WHEN NEW.event_digest IS NOT OLD.event_digest OR NEW.owner_digest IS NOT OLD.owner_digest OR NEW.participant_id IS NOT OLD.participant_id OR NEW.chunk_id IS NOT OLD.chunk_id OR NEW.source_namespace IS NOT OLD.source_namespace
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_event_sources_delete BEFORE DELETE ON typed_v1_event_sources
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_owner_memberships_insert AFTER INSERT ON typed_v1_owner_memberships
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
 UPDATE storage_effective_selective_owners SET seeded=0,seed_day='' WHERE participant_id=NEW.participant_id;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_owner_memberships_update AFTER UPDATE ON typed_v1_owner_memberships
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.typed_owner_id IS NOT OLD.typed_owner_id
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
 UPDATE storage_effective_selective_owners SET seeded=0,seed_day='' WHERE participant_id=OLD.participant_id;
 UPDATE storage_effective_selective_owners SET seeded=0,seed_day='' WHERE participant_id=NEW.participant_id;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_owner_memberships_delete BEFORE DELETE ON typed_v1_owner_memberships
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 UPDATE storage_effective_selective_owners SET seeded=0,seed_day='' WHERE participant_id=OLD.participant_id;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_chunk_allocations_insert AFTER INSERT ON typed_v1_chunk_allocations
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) WHERE (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_chunk_allocations_update AFTER UPDATE ON typed_v1_chunk_allocations
WHEN NEW.chunk_id IS NOT OLD.chunk_id OR NEW.namespace_id IS NOT OLD.namespace_id OR NEW.chunk_original IS NOT OLD.chunk_original OR NEW.first_source_row_id IS NOT OLD.first_source_row_id OR NEW.record_count IS NOT OLD.record_count
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) WHERE (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) WHERE (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_chunk_allocations_delete BEFORE DELETE ON typed_v1_chunk_allocations
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) WHERE (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),(SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_day_manifests_insert AFTER INSERT ON telemetry_v11_day_manifests
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.chunk_day,NEW.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.chunk_day IS NOT NULL AND NEW.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_day_manifests_update AFTER UPDATE ON telemetry_v11_day_manifests
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.chunk_day IS NOT OLD.chunk_day OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.parser_version IS NOT OLD.parser_version OR NEW.manifest_json IS NOT OLD.manifest_json OR NEW.expected_chunk_count IS NOT OLD.expected_chunk_count OR NEW.state IS NOT OLD.state OR NEW.created_at IS NOT OLD.created_at OR NEW.ready_at IS NOT OLD.ready_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.chunk_day,OLD.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.chunk_day IS NOT NULL AND OLD.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.chunk_day,NEW.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.chunk_day IS NOT NULL AND NEW.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_day_manifests_delete BEFORE DELETE ON telemetry_v11_day_manifests
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.chunk_day,OLD.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.chunk_day IS NOT NULL AND OLD.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_chunks_insert AFTER INSERT ON telemetry_v11_chunks
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.chunk_day,NEW.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.chunk_day IS NOT NULL AND NEW.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_chunks_update AFTER UPDATE ON telemetry_v11_chunks
WHEN NEW.id IS NOT OLD.id OR NEW.manifest_id IS NOT OLD.manifest_id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.stream IS NOT OLD.stream OR NEW.chunk_day IS NOT OLD.chunk_day OR NEW.chunk_seq IS NOT OLD.chunk_seq OR NEW.chunk_id IS NOT OLD.chunk_id OR NEW.chunk_digest IS NOT OLD.chunk_digest OR NEW.envelope_digest IS NOT OLD.envelope_digest OR NEW.parser_version IS NOT OLD.parser_version OR NEW.record_count IS NOT OLD.record_count OR NEW.r2_key IS NOT OLD.r2_key OR NEW.device_upload_authorization_id IS NOT OLD.device_upload_authorization_id OR NEW.quarantine_deleted_at IS NOT OLD.quarantine_deleted_at OR NEW.created_at IS NOT OLD.created_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.chunk_day,OLD.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.chunk_day IS NOT NULL AND OLD.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.chunk_day,NEW.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.chunk_day IS NOT NULL AND NEW.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_chunks_delete BEFORE DELETE ON telemetry_v11_chunks
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.chunk_day,OLD.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.chunk_day IS NOT NULL AND OLD.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;


CREATE TRIGGER storage_effective_selective_telemetry_v11_domains_update AFTER UPDATE ON telemetry_v11_domains
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.predecessor_token_hash IS NOT OLD.predecessor_token_hash OR NEW.previous_generation_id IS NOT OLD.previous_generation_id OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.legacy_fingerprint IS NOT OLD.legacy_fingerprint OR NEW.input_revision IS NOT OLD.input_revision OR NEW.from_day IS NOT OLD.from_day OR NEW.through_day IS NOT OLD.through_day OR NEW.days_json IS NOT OLD.days_json OR NEW.created_at IS NOT OLD.created_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.from_day,OLD.through_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.from_day IS NOT NULL AND OLD.through_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.from_day IS NULL OR OLD.through_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.from_day IS NULL OR OLD.through_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.from_day,NEW.through_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.from_day IS NOT NULL AND NEW.through_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.from_day IS NULL OR NEW.through_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.from_day IS NULL OR NEW.through_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_domains_delete BEFORE DELETE ON telemetry_v11_domains
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.from_day,OLD.through_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.from_day IS NOT NULL AND OLD.through_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.from_day IS NULL OR OLD.through_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.from_day IS NULL OR OLD.through_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_domain_days_insert AFTER INSERT ON telemetry_v11_domain_days
WHEN NOT EXISTS(SELECT 1 FROM telemetry_v11_domain_days prior
 JOIN telemetry_v11_domains old_generation ON old_generation.id=prior.generation_id
 JOIN telemetry_v11_domains next_generation ON next_generation.id=NEW.generation_id
 JOIN storage_v11_event_sources event ON event.generation_id=prior.generation_id AND event.participant_id=old_generation.participant_id
 WHERE prior.generation_id!=NEW.generation_id AND prior.manifest_id=NEW.manifest_id
 AND prior.observed_day=NEW.observed_day AND old_generation.participant_id=next_generation.participant_id
 AND old_generation.device_id=next_generation.device_id)
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) WHERE (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id),NEW.observed_day,NEW.observed_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NOT NULL AND NEW.observed_day IS NOT NULL AND NEW.observed_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) AND (NEW.observed_day IS NULL OR NEW.observed_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.observed_day IS NULL OR NEW.observed_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_domain_days_update AFTER UPDATE ON telemetry_v11_domain_days
WHEN NEW.generation_id IS NOT OLD.generation_id OR NEW.observed_day IS NOT OLD.observed_day OR NEW.manifest_id IS NOT OLD.manifest_id
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) WHERE (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id),OLD.observed_day,OLD.observed_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) IS NOT NULL AND OLD.observed_day IS NOT NULL AND OLD.observed_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (OLD.observed_day IS NULL OR OLD.observed_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.observed_day IS NULL OR OLD.observed_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) WHERE (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id),NEW.observed_day,NEW.observed_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NOT NULL AND NEW.observed_day IS NOT NULL AND NEW.observed_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) AND (NEW.observed_day IS NULL OR NEW.observed_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.observed_day IS NULL OR NEW.observed_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_domain_days_delete BEFORE DELETE ON telemetry_v11_domain_days
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) WHERE (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id),OLD.observed_day,OLD.observed_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) IS NOT NULL AND OLD.observed_day IS NOT NULL AND OLD.observed_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (OLD.observed_day IS NULL OR OLD.observed_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.observed_day IS NULL OR OLD.observed_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_storage_v11_event_sources_insert AFTER INSERT ON storage_v11_event_sources
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,d.observed_day,d.observed_day,r.sequence
 FROM telemetry_v11_domain_days d CROSS JOIN storage_effective_selective_runtime r
 WHERE d.generation_id=NEW.generation_id AND r.id=1
 AND NOT EXISTS(SELECT 1 FROM telemetry_v11_domain_days prior
   JOIN telemetry_v11_domains g ON g.id=prior.generation_id
   JOIN storage_v11_event_sources e ON e.generation_id=g.id AND e.participant_id=g.participant_id
   WHERE prior.manifest_id=d.manifest_id AND prior.observed_day=d.observed_day
     AND g.device_id=NEW.device_id AND e.participant_id=NEW.participant_id AND e.event_digest!=NEW.event_digest)
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
END;

CREATE TRIGGER storage_effective_selective_storage_v11_event_sources_update AFTER UPDATE ON storage_v11_event_sources
WHEN NEW.event_digest IS NOT OLD.event_digest OR NEW.owner_digest IS NOT OLD.owner_digest OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.generation_id IS NOT OLD.generation_id OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.from_day IS NOT OLD.from_day OR NEW.through_day IS NOT OLD.through_day OR NEW.head_revision IS NOT OLD.head_revision OR NEW.input_revision IS NOT OLD.input_revision OR NEW.recorded_ms IS NOT OLD.recorded_ms
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.from_day,OLD.through_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.from_day IS NOT NULL AND OLD.through_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.from_day IS NULL OR OLD.through_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.from_day IS NULL OR OLD.through_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.from_day,NEW.through_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.from_day IS NOT NULL AND NEW.through_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.from_day IS NULL OR NEW.through_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.from_day IS NULL OR NEW.through_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_storage_v11_event_sources_delete BEFORE DELETE ON storage_v11_event_sources
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.from_day,OLD.through_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.from_day IS NOT NULL AND OLD.through_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.from_day IS NULL OR OLD.through_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.from_day IS NULL OR OLD.through_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_owner_memberships_insert AFTER INSERT ON typed_v11_owner_memberships
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
 UPDATE storage_effective_selective_owners SET seeded=0,seed_day='' WHERE participant_id=NEW.participant_id;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_owner_memberships_update AFTER UPDATE ON typed_v11_owner_memberships
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.typed_owner_id IS NOT OLD.typed_owner_id
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
 UPDATE storage_effective_selective_owners SET seeded=0,seed_day='' WHERE participant_id=OLD.participant_id;
 UPDATE storage_effective_selective_owners SET seeded=0,seed_day='' WHERE participant_id=NEW.participant_id;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_owner_memberships_delete BEFORE DELETE ON typed_v11_owner_memberships
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 UPDATE storage_effective_selective_owners SET seeded=0,seed_day='' WHERE participant_id=OLD.participant_id;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_manifest_memberships_insert AFTER INSERT ON typed_v11_manifest_memberships
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) WHERE (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id),(SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id),(SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) AND ((SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_manifest_memberships_update AFTER UPDATE ON typed_v11_manifest_memberships
WHEN NEW.manifest_id IS NOT OLD.manifest_id OR NEW.typed_manifest_id IS NOT OLD.typed_manifest_id
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) WHERE (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id),(SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id),(SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND ((SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) WHERE (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id),(SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id),(SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) AND ((SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_manifest_memberships_delete BEFORE DELETE ON typed_v11_manifest_memberships
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) WHERE (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id),(SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id),(SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND ((SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_chunk_allocations_insert AFTER INSERT ON typed_v11_chunk_allocations
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) WHERE (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id),(SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id),(SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) AND ((SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_chunk_allocations_update AFTER UPDATE ON typed_v11_chunk_allocations
WHEN NEW.chunk_id IS NOT OLD.chunk_id OR NEW.namespace_id IS NOT OLD.namespace_id OR NEW.chunk_original IS NOT OLD.chunk_original OR NEW.first_source_row_id IS NOT OLD.first_source_row_id OR NEW.record_count IS NOT OLD.record_count
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) WHERE (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id),(SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id),(SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND ((SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) WHERE (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id),(SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id),(SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) AND ((SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_chunk_allocations_delete BEFORE DELETE ON typed_v11_chunk_allocations
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) WHERE (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id),(SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id),(SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND ((SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL OR (SELECT chunk_day FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_day_manifests_insert AFTER INSERT ON telemetry_v12_day_manifests
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.chunk_day,NEW.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.chunk_day IS NOT NULL AND NEW.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_day_manifests_update AFTER UPDATE ON telemetry_v12_day_manifests
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.chunk_day IS NOT OLD.chunk_day OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.parser_version IS NOT OLD.parser_version OR NEW.manifest_json IS NOT OLD.manifest_json OR NEW.expected_chunk_count IS NOT OLD.expected_chunk_count OR NEW.state IS NOT OLD.state OR NEW.created_at IS NOT OLD.created_at OR NEW.ready_at IS NOT OLD.ready_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.chunk_day,OLD.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.chunk_day IS NOT NULL AND OLD.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.chunk_day,NEW.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.chunk_day IS NOT NULL AND NEW.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_day_manifests_delete BEFORE DELETE ON telemetry_v12_day_manifests
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.chunk_day,OLD.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.chunk_day IS NOT NULL AND OLD.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_chunks_insert AFTER INSERT ON telemetry_v12_chunks
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.chunk_day,NEW.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.chunk_day IS NOT NULL AND NEW.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_chunks_update AFTER UPDATE ON telemetry_v12_chunks
WHEN NEW.id IS NOT OLD.id OR NEW.manifest_id IS NOT OLD.manifest_id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.stream IS NOT OLD.stream OR NEW.chunk_day IS NOT OLD.chunk_day OR NEW.chunk_seq IS NOT OLD.chunk_seq OR NEW.chunk_id IS NOT OLD.chunk_id OR NEW.chunk_digest IS NOT OLD.chunk_digest OR NEW.envelope_digest IS NOT OLD.envelope_digest OR NEW.parser_version IS NOT OLD.parser_version OR NEW.record_count IS NOT OLD.record_count OR NEW.r2_key IS NOT OLD.r2_key OR NEW.device_upload_authorization_id IS NOT OLD.device_upload_authorization_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.chunk_day,OLD.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.chunk_day IS NOT NULL AND OLD.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.chunk_day,NEW.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.chunk_day IS NOT NULL AND NEW.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.chunk_day IS NULL OR NEW.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_chunks_delete BEFORE DELETE ON telemetry_v12_chunks
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.chunk_day,OLD.chunk_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.chunk_day IS NOT NULL AND OLD.chunk_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.chunk_day IS NULL OR OLD.chunk_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;


CREATE TRIGGER storage_effective_selective_telemetry_v12_domains_update AFTER UPDATE ON telemetry_v12_domains
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.predecessor_token_hash IS NOT OLD.predecessor_token_hash OR NEW.previous_generation_id IS NOT OLD.previous_generation_id OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.legacy_fingerprint IS NOT OLD.legacy_fingerprint OR NEW.input_revision IS NOT OLD.input_revision OR NEW.from_day IS NOT OLD.from_day OR NEW.through_day IS NOT OLD.through_day OR NEW.days_json IS NOT OLD.days_json OR NEW.created_at IS NOT OLD.created_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.from_day,OLD.through_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.from_day IS NOT NULL AND OLD.through_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.from_day IS NULL OR OLD.through_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.from_day IS NULL OR OLD.through_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT NEW.participant_id,NEW.from_day,NEW.through_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND NEW.participant_id IS NOT NULL AND NEW.from_day IS NOT NULL AND NEW.through_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND (NEW.from_day IS NULL OR NEW.through_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.from_day IS NULL OR NEW.through_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_domains_delete BEFORE DELETE ON telemetry_v12_domains
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT OLD.participant_id,OLD.from_day,OLD.through_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND OLD.participant_id IS NOT NULL AND OLD.from_day IS NOT NULL AND OLD.through_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND (OLD.from_day IS NULL OR OLD.through_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.from_day IS NULL OR OLD.through_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_domain_days_insert AFTER INSERT ON telemetry_v12_domain_days
WHEN NOT EXISTS(SELECT 1 FROM telemetry_v12_domain_days prior
 JOIN telemetry_v12_domains old_generation ON old_generation.id=prior.generation_id
 JOIN telemetry_v12_domains next_generation ON next_generation.id=NEW.generation_id

 WHERE prior.generation_id!=NEW.generation_id AND prior.manifest_id=NEW.manifest_id
 AND prior.observed_day=NEW.observed_day AND old_generation.participant_id=next_generation.participant_id
 AND old_generation.device_id=next_generation.device_id)
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) WHERE (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id),NEW.observed_day,NEW.observed_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NOT NULL AND NEW.observed_day IS NOT NULL AND NEW.observed_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) AND (NEW.observed_day IS NULL OR NEW.observed_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.observed_day IS NULL OR NEW.observed_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_domain_days_update AFTER UPDATE ON telemetry_v12_domain_days
WHEN NEW.generation_id IS NOT OLD.generation_id OR NEW.observed_day IS NOT OLD.observed_day OR NEW.manifest_id IS NOT OLD.manifest_id OR NEW.manifest_digest IS NOT OLD.manifest_digest
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) WHERE (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id),OLD.observed_day,OLD.observed_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) IS NOT NULL AND OLD.observed_day IS NOT NULL AND OLD.observed_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (OLD.observed_day IS NULL OR OLD.observed_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.observed_day IS NULL OR OLD.observed_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) WHERE (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id),NEW.observed_day,NEW.observed_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NOT NULL AND NEW.observed_day IS NOT NULL AND NEW.observed_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) AND (NEW.observed_day IS NULL OR NEW.observed_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (NEW.observed_day IS NULL OR NEW.observed_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_domain_days_delete BEFORE DELETE ON telemetry_v12_domain_days
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) WHERE (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id),OLD.observed_day,OLD.observed_day,sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) IS NOT NULL AND OLD.observed_day IS NOT NULL AND OLD.observed_day IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (OLD.observed_day IS NULL OR OLD.observed_day IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (OLD.observed_day IS NULL OR OLD.observed_day IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_device_capabilities_insert AFTER INSERT ON telemetry_v12_device_capabilities
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_device_capabilities_update AFTER UPDATE ON telemetry_v12_device_capabilities
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version OR NEW.state IS NOT OLD.state OR NEW.consented_at IS NOT OLD.consented_at OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_device_capabilities_delete BEFORE DELETE ON telemetry_v12_device_capabilities
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_accountless_v12_device_authorizations_insert AFTER INSERT ON accountless_v12_device_authorizations
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_accountless_v12_device_authorizations_update AFTER UPDATE ON accountless_v12_device_authorizations
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_credential_id IS NOT OLD.device_credential_id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.policy_version IS NOT OLD.policy_version OR NEW.authorization_basis IS NOT OLD.authorization_basis OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version OR NEW.authorized_at IS NOT OLD.authorized_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.state IS NOT OLD.state OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_reason IS NOT OLD.revocation_reason
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_accountless_v12_device_authorizations_delete BEFORE DELETE ON accountless_v12_device_authorizations
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_accountless_upload_owners_insert AFTER INSERT ON accountless_upload_owners
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_accountless_upload_owners_update AFTER UPDATE ON accountless_upload_owners
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_credential_id IS NOT OLD.device_credential_id OR NEW.policy_version IS NOT OLD.policy_version OR NEW.authorization_basis IS NOT OLD.authorization_basis OR NEW.authorized_at IS NOT OLD.authorized_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.state IS NOT OLD.state OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_reason IS NOT OLD.revocation_reason
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_accountless_upload_owners_delete BEFORE DELETE ON accountless_upload_owners
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_accountless_v11_device_authorizations_insert AFTER INSERT ON accountless_v11_device_authorizations
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_accountless_v11_device_authorizations_update AFTER UPDATE ON accountless_v11_device_authorizations
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_credential_id IS NOT OLD.device_credential_id OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version OR NEW.authorized_at IS NOT OLD.authorized_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.state IS NOT OLD.state OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_reason IS NOT OLD.revocation_reason
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_accountless_v11_device_authorizations_delete BEFORE DELETE ON accountless_v11_device_authorizations
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_device_consents_insert AFTER INSERT ON telemetry_v11_device_consents
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_device_consents_update AFTER UPDATE ON telemetry_v11_device_consents
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version OR NEW.consented_at IS NOT OLD.consented_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=NEW.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT NEW.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v11_device_consents_delete BEFORE DELETE ON telemetry_v11_device_consents
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT OLD.participant_id WHERE OLD.participant_id IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=OLD.participant_id AND 1;
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT OLD.participant_id,'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND 1
 AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_selective_storage_source_state_insert AFTER INSERT ON storage_source_state
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_storage_source_state_update AFTER UPDATE ON storage_source_state
WHEN NEW.singleton IS NOT OLD.singleton OR NEW.source_id IS NOT OLD.source_id OR
 (NEW.authority_epoch IS NOT OLD.authority_epoch AND NOT EXISTS(SELECT 1 FROM storage_ingestion_changes c
   WHERE c.sequence=(SELECT max(sequence) FROM storage_ingestion_changes) AND c.kind='owner-active'
     AND c.public_authority_epoch=NEW.authority_epoch AND c.public_authority_epoch=OLD.authority_epoch+1
     AND (EXISTS(SELECT 1 FROM storage_v11_event_sources e WHERE e.event_digest=c.event_digest AND e.owner_digest=c.owner_digest)
 OR EXISTS(SELECT 1 FROM storage_v12_event_sources e WHERE e.event_digest=c.event_digest AND e.owner_digest=c.owner_digest))))
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 -- A terminal journal write is source-global authority but can have one exact
 -- selective owner. This effect remains durable for a surviving participant;
 -- native participant erasure removes it by FK cascade. Neither case infers
 -- an owner from a merely current epoch or an unbridged ledger.
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT owner.participant_id,'','',0,(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 FROM storage_ingestion_changes c
 JOIN storage_v11_owner_links link ON link.owner_digest=c.owner_digest
 JOIN storage_owner_revisions revision ON revision.owner_digest=link.owner_digest
 JOIN accountless_upload_owners owner ON owner.participant_id=link.participant_id
 JOIN accountless_enrollment_ledger ledger ON ledger.device_id=owner.enrollment_device_id
 JOIN device_credentials credential ON credential.id=owner.device_credential_id
 JOIN participants participant ON participant.id=owner.participant_id
 WHERE c.sequence=(SELECT max(sequence) FROM storage_ingestion_changes)
  AND NEW.singleton IS OLD.singleton AND NEW.source_id IS OLD.source_id
  AND c.kind IN('owner-withdrawn','owner-erased')
  AND c.public_authority_epoch=NEW.authority_epoch
  AND c.public_authority_epoch=OLD.authority_epoch+1
  AND c.revision=revision.revision AND c.authority_epoch=revision.authority_epoch
  AND c.object_digest IS link.object_digest AND c.content_digest IS link.manifest_digest
  AND ((c.kind='owner-withdrawn' AND link.state='withdrawn')
    OR (c.kind='owner-erased' AND link.state='erased'))
  AND revision.state=link.state
  AND participant.owner_kind='accountless' AND participant.state='active'
  AND ledger.state='active' AND owner.state='active'
  AND owner.revoked_at IS NULL AND owner.revocation_reason IS NULL
  AND owner.policy_version=ledger.policy_version AND owner.authorization_basis=ledger.authorization_basis
  AND owner.expires_at=ledger.expires_at
  AND credential.participant_id=owner.participant_id
  AND credential.accountless_enrollment_device_id=ledger.device_id
  AND credential.authority_kind='accountless' AND credential.state='active'
  AND credential.expires_at=ledger.expires_at
  AND NOT EXISTS(SELECT 1 FROM accountless_public_history_retention retained
    WHERE retained.enrollment_device_id=ledger.device_id)
  AND NOT EXISTS(SELECT 1 FROM accountless_v11_device_authorizations grant_row
    WHERE grant_row.enrollment_device_id=ledger.device_id
      AND (grant_row.participant_id IS NOT owner.participant_id
        OR grant_row.device_credential_id IS NOT owner.device_credential_id))
  AND NOT EXISTS(SELECT 1 FROM accountless_v12_device_authorizations grant_row
    WHERE grant_row.enrollment_device_id=ledger.device_id
      AND (grant_row.participant_id IS NOT owner.participant_id
        OR grant_row.device_credential_id IS NOT owner.device_credential_id))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 INSERT INTO storage_effective_selective_owners(participant_id)
 SELECT effect.participant_id FROM storage_effective_selective_effects effect
 WHERE effect.stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
  AND effect.source_day='' AND effect.through_day='' AND effect.stream=0
 ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id IN(SELECT effect.participant_id FROM storage_effective_selective_effects effect
   WHERE effect.stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
    AND effect.source_day='' AND effect.through_day='' AND effect.stream=0);
 -- This fresh exact effect proves a mapped terminal change independent of
 -- AFTER-link trigger order. A native participant delete subsequently removes
 -- the effect by cascade; a direct terminal link retains the affected-owner
 -- effect until its exact ACK.
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1
  AND (NEW.singleton IS NOT OLD.singleton OR NEW.source_id IS NOT OLD.source_id
   OR NOT EXISTS(SELECT 1 FROM storage_effective_selective_effects effect
    JOIN storage_ingestion_changes c ON c.sequence=(SELECT max(sequence) FROM storage_ingestion_changes)
    JOIN storage_v11_owner_links link ON link.owner_digest=c.owner_digest
    WHERE effect.stamp=storage_effective_selective_runtime.sequence
      AND effect.source_day='' AND effect.through_day='' AND effect.stream=0
      AND effect.participant_id=link.participant_id
      AND c.kind IN('owner-withdrawn','owner-erased')
      AND ((c.kind='owner-withdrawn' AND link.state='withdrawn')
        OR (c.kind='owner-erased' AND link.state='erased'))
      AND c.public_authority_epoch=NEW.authority_epoch
      AND c.public_authority_epoch=OLD.authority_epoch+1));
END;

CREATE TRIGGER storage_effective_selective_storage_source_state_delete BEFORE DELETE ON storage_source_state
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_typed_telemetry_schema_insert AFTER INSERT ON typed_telemetry_schema
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_typed_telemetry_schema_update AFTER UPDATE ON typed_telemetry_schema
WHEN NEW.id IS NOT OLD.id OR NEW.version IS NOT OLD.version
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_typed_telemetry_schema_delete BEFORE DELETE ON typed_telemetry_schema
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_telemetry_usage_correction_runtime_insert AFTER INSERT ON telemetry_usage_correction_runtime
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_telemetry_usage_correction_runtime_update AFTER UPDATE ON telemetry_usage_correction_runtime
WHEN NEW.id IS NOT OLD.id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.method_version IS NOT OLD.method_version OR NEW.state IS NOT OLD.state OR NEW.max_capture_rows IS NOT OLD.max_capture_rows OR NEW.max_history_page IS NOT OLD.max_history_page
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_telemetry_usage_correction_runtime_delete BEFORE DELETE ON telemetry_usage_correction_runtime
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_runtime_insert AFTER INSERT ON telemetry_v12_runtime
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_runtime_update AFTER UPDATE ON telemetry_v12_runtime
WHEN NEW.id IS NOT OLD.id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.envelope_schema_version IS NOT OLD.envelope_schema_version OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version OR NEW.state IS NOT OLD.state OR NEW.policy_revision IS NOT OLD.policy_revision OR NEW.max_day_chunks IS NOT OLD.max_day_chunks OR NEW.max_chunk_records IS NOT OLD.max_chunk_records OR NEW.max_day_bytes IS NOT OLD.max_day_bytes OR NEW.changed_at IS NOT OLD.changed_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_telemetry_v12_runtime_delete BEFORE DELETE ON telemetry_v12_runtime
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_ingestion_analytics_separation_insert AFTER INSERT ON ingestion_analytics_separation
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_ingestion_analytics_separation_update AFTER UPDATE ON ingestion_analytics_separation
WHEN NEW.id IS NOT OLD.id OR NEW.phase IS NOT OLD.phase OR NEW.policy_revision IS NOT OLD.policy_revision OR NEW.empty_source_check IS NOT OLD.empty_source_check
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_ingestion_analytics_separation_delete BEFORE DELETE ON ingestion_analytics_separation
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_collection_controls_insert AFTER INSERT ON collection_controls
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_collection_controls_update AFTER UPDATE ON collection_controls
WHEN NEW.singleton IS NOT OLD.singleton OR NEW.schema_version IS NOT OLD.schema_version OR NEW.enrollment_enabled IS NOT OLD.enrollment_enabled OR NEW.upload_registration_enabled IS NOT OLD.upload_registration_enabled OR NEW.processing_enabled IS NOT OLD.processing_enabled OR NEW.publication_enabled IS NOT OLD.publication_enabled OR NEW.control_state IS NOT OLD.control_state OR NEW.revision IS NOT OLD.revision OR NEW.reason_code IS NOT OLD.reason_code OR NEW.updated_at IS NOT OLD.updated_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_collection_controls_delete BEFORE DELETE ON collection_controls
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_accountless_enrollment_ledger_insert AFTER INSERT ON accountless_enrollment_ledger
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_accountless_enrollment_ledger_update AFTER UPDATE ON accountless_enrollment_ledger
WHEN NEW.device_id IS NOT OLD.device_id OR NEW.device_secret_hash IS NOT OLD.device_secret_hash OR NEW.installation_principal_id IS NOT OLD.installation_principal_id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.policy_version IS NOT OLD.policy_version OR NEW.authorization_basis IS NOT OLD.authorization_basis OR NEW.state IS NOT OLD.state OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_reason IS NOT OLD.revocation_reason OR NEW.renewal_generation IS NOT OLD.renewal_generation OR NEW.renewed_at IS NOT OLD.renewed_at
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 -- The bridge's BEFORE UPDATE terminal trigger has already withdrawn the
 -- exact owner link. Only a same-key revocation with one complete, non-retained
 -- accountless owner graph can be scoped; every other ledger mutation stays
 -- source-global. The scoped effect is durable until its exact ACK.
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT owner.participant_id,'','',0,(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 FROM accountless_upload_owners owner WHERE owner.enrollment_device_id=OLD.device_id
  AND OLD.device_id IS NEW.device_id AND OLD.state='active' AND NEW.state='revoked'
  AND NEW.device_secret_hash IS OLD.device_secret_hash
  AND NEW.installation_principal_id IS OLD.installation_principal_id
  AND NEW.schema_version IS OLD.schema_version AND NEW.policy_version IS OLD.policy_version
  AND NEW.authorization_basis IS OLD.authorization_basis AND NEW.issued_at IS OLD.issued_at
  AND NEW.expires_at IS OLD.expires_at AND NEW.renewal_generation IS OLD.renewal_generation
  AND NEW.renewed_at IS OLD.renewed_at
  AND NOT EXISTS(SELECT 1 FROM accountless_public_history_retention retention
    WHERE retention.enrollment_device_id=OLD.device_id)
  AND EXISTS(SELECT 1 FROM accountless_upload_owners owner
    JOIN participants participant ON participant.id=owner.participant_id
    JOIN device_credentials credential ON credential.id=owner.device_credential_id
    JOIN storage_v11_owner_links link ON link.participant_id=owner.participant_id
    JOIN storage_owner_revisions revision ON revision.owner_digest=link.owner_digest
    WHERE owner.enrollment_device_id=OLD.device_id AND owner.state='active'
      AND owner.revoked_at IS NULL AND owner.revocation_reason IS NULL
      AND owner.policy_version=OLD.policy_version
      AND owner.authorization_basis=OLD.authorization_basis AND owner.expires_at=OLD.expires_at
      AND participant.owner_kind='accountless' AND participant.state='active'
      AND credential.participant_id=owner.participant_id
      AND credential.accountless_enrollment_device_id=OLD.device_id
      AND credential.authority_kind='accountless' AND credential.state='active'
      AND credential.expires_at=OLD.expires_at
      AND link.state='withdrawn' AND revision.state='withdrawn'
      AND NOT EXISTS(SELECT 1 FROM accountless_v11_device_authorizations grant_row
        WHERE grant_row.enrollment_device_id=OLD.device_id
          AND (grant_row.participant_id IS NOT owner.participant_id
            OR grant_row.device_credential_id IS NOT owner.device_credential_id))
      AND NOT EXISTS(SELECT 1 FROM accountless_v12_device_authorizations grant_row
        WHERE grant_row.enrollment_device_id=OLD.device_id
          AND (grant_row.participant_id IS NOT owner.participant_id
            OR grant_row.device_credential_id IS NOT owner.device_credential_id)))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 INSERT INTO storage_effective_selective_owners(participant_id)
 SELECT effect.participant_id FROM storage_effective_selective_effects effect
 WHERE effect.stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
   AND effect.source_day='' AND effect.through_day='' AND effect.stream=0
   AND effect.participant_id=(SELECT owner.participant_id FROM accountless_upload_owners owner
     WHERE owner.enrollment_device_id=OLD.device_id)
 ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id IN(SELECT effect.participant_id FROM storage_effective_selective_effects effect
   WHERE effect.stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
     AND effect.source_day='' AND effect.through_day='' AND effect.stream=0
     AND effect.participant_id=(SELECT owner.participant_id FROM accountless_upload_owners owner
       WHERE owner.enrollment_device_id=OLD.device_id));
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1
 WHERE id=1 AND NOT (OLD.device_id IS NEW.device_id AND OLD.state='active' AND NEW.state='revoked'
  AND NEW.device_secret_hash IS OLD.device_secret_hash
  AND NEW.installation_principal_id IS OLD.installation_principal_id
  AND NEW.schema_version IS OLD.schema_version AND NEW.policy_version IS OLD.policy_version
  AND NEW.authorization_basis IS OLD.authorization_basis AND NEW.issued_at IS OLD.issued_at
  AND NEW.expires_at IS OLD.expires_at AND NEW.renewal_generation IS OLD.renewal_generation
  AND NEW.renewed_at IS OLD.renewed_at
  AND NOT EXISTS(SELECT 1 FROM accountless_public_history_retention retention
    WHERE retention.enrollment_device_id=OLD.device_id)
  AND EXISTS(SELECT 1 FROM accountless_upload_owners owner
    JOIN participants participant ON participant.id=owner.participant_id
    JOIN device_credentials credential ON credential.id=owner.device_credential_id
    JOIN storage_v11_owner_links link ON link.participant_id=owner.participant_id
    JOIN storage_owner_revisions revision ON revision.owner_digest=link.owner_digest
    WHERE owner.enrollment_device_id=OLD.device_id AND owner.state='active'
      AND owner.revoked_at IS NULL AND owner.revocation_reason IS NULL
      AND owner.policy_version=OLD.policy_version
      AND owner.authorization_basis=OLD.authorization_basis AND owner.expires_at=OLD.expires_at
      AND participant.owner_kind='accountless' AND participant.state='active'
      AND credential.participant_id=owner.participant_id
      AND credential.accountless_enrollment_device_id=OLD.device_id
      AND credential.authority_kind='accountless' AND credential.state='active'
      AND credential.expires_at=OLD.expires_at
      AND link.state='withdrawn' AND revision.state='withdrawn'
      AND NOT EXISTS(SELECT 1 FROM accountless_v11_device_authorizations grant_row
        WHERE grant_row.enrollment_device_id=OLD.device_id
          AND (grant_row.participant_id IS NOT owner.participant_id
            OR grant_row.device_credential_id IS NOT owner.device_credential_id))
      AND NOT EXISTS(SELECT 1 FROM accountless_v12_device_authorizations grant_row
        WHERE grant_row.enrollment_device_id=OLD.device_id
          AND (grant_row.participant_id IS NOT owner.participant_id
            OR grant_row.device_credential_id IS NOT owner.device_credential_id))));
END;

CREATE TRIGGER storage_effective_selective_accountless_enrollment_ledger_delete BEFORE DELETE ON accountless_enrollment_ledger
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_admission_state_insert AFTER INSERT ON typed_v1_admission_state
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_admission_state_update AFTER UPDATE ON typed_v1_admission_state
WHEN NEW.runtime_contract_version IS NOT OLD.runtime_contract_version OR NEW.source_namespace IS NOT OLD.source_namespace OR NEW.namespace_id IS NOT OLD.namespace_id
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_admission_state_delete BEFORE DELETE ON typed_v1_admission_state
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_admission_state_insert AFTER INSERT ON typed_v11_admission_state
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_admission_state_update AFTER UPDATE ON typed_v11_admission_state
WHEN NEW.runtime_contract_version IS NOT OLD.runtime_contract_version OR NEW.source_namespace IS NOT OLD.source_namespace OR NEW.namespace_id IS NOT OLD.namespace_id
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_admission_state_delete BEFORE DELETE ON typed_v11_admission_state
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_selective_correction_fact_insert AFTER INSERT ON telemetry_usage_correction_facts
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) WHERE (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id),(SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=NEW.history_id),(SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=NEW.history_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NOT NULL AND (SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NOT NULL AND (SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) AND ((SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NULL OR (SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NULL OR (SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_correction_fact_delete BEFORE DELETE ON telemetry_usage_correction_facts
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) WHERE (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id),(SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=OLD.history_id),(SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=OLD.history_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NOT NULL AND (SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NOT NULL AND (SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) AND ((SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NULL OR (SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NULL OR (SELECT date(event_time_ms/1000,'unixepoch') FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_v12_record_delete BEFORE DELETE ON telemetry_v12_records
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) WHERE (SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id),date(OLD.observed_at_ms/1000,'unixepoch'),date(OLD.observed_at_ms/1000,'unixepoch'),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND date(OLD.observed_at_ms/1000,'unixepoch') IS NOT NULL AND date(OLD.observed_at_ms/1000,'unixepoch') IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) AND (date(OLD.observed_at_ms/1000,'unixepoch') IS NULL OR date(OLD.observed_at_ms/1000,'unixepoch') IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (date(OLD.observed_at_ms/1000,'unixepoch') IS NULL OR date(OLD.observed_at_ms/1000,'unixepoch') IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v1_record_admissions_delete BEFORE DELETE ON typed_v1_record_admissions
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) WHERE (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),(SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id),(SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL AND (SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NOT NULL AND (SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND ((SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NULL OR (SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NULL OR (SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_v11_record_proofs_delete BEFORE DELETE ON typed_v11_record_proofs
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) WHERE (SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key),(SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id),(SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) IS NOT NULL AND (SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NOT NULL AND (SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) AND ((SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NULL OR (SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND ((SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NULL OR (SELECT date(observed_at_ms/1000,'unixepoch') FROM typed_telemetry_records WHERE id=OLD.typed_record_id) IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_typed_record_delete BEFORE DELETE ON typed_telemetry_records
BEGIN
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1 WHERE id=1;
 INSERT INTO storage_effective_selective_owners(participant_id) SELECT (SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) WHERE (SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) IS NOT NULL AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) AND (l.state="erased" OR o.state="erased")) ON CONFLICT DO UPDATE SET needs_work=1 WHERE needs_work=0;
 INSERT INTO storage_effective_selective_work(participant_id,from_day,through_day,stamp)
 SELECT (SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1),date(OLD.observed_at_ms/1000,'unixepoch'),date(OLD.observed_at_ms/1000,'unixepoch'),sequence FROM storage_effective_selective_runtime
 WHERE id=1 AND (SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) IS NOT NULL AND date(OLD.observed_at_ms/1000,'unixepoch') IS NOT NULL AND date(OLD.observed_at_ms/1000,'unixepoch') IS NOT NULL
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,from_day,through_day) DO UPDATE SET stamp=excluded.stamp,day_cursor='',family=0,row_cursor=0;
 UPDATE storage_effective_selective_owners SET broad_stamp=(SELECT sequence FROM storage_effective_selective_runtime WHERE id=1)
 WHERE participant_id=(SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) AND (date(OLD.observed_at_ms/1000,'unixepoch') IS NULL OR date(OLD.observed_at_ms/1000,'unixepoch') IS NULL);
 INSERT INTO storage_effective_selective_effects(participant_id,source_day,through_day,stream,stamp)
 SELECT (SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1),'','',0,sequence FROM storage_effective_selective_runtime WHERE id=1 AND (date(OLD.observed_at_ms/1000,'unixepoch') IS NULL OR date(OLD.observed_at_ms/1000,'unixepoch') IS NULL)
 AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) AND (l.state="erased" OR o.state="erased"))
 ON CONFLICT(participant_id,source_day,through_day,stream) DO UPDATE SET stamp=excluded.stamp;
 UPDATE storage_effective_selective_runtime SET sequence=sequence+1,policy_stamp=sequence+1 WHERE id=1 AND (SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) IS NULL;
END;

CREATE TRIGGER storage_effective_selective_erase_storage_owner_revisions AFTER UPDATE ON storage_owner_revisions WHEN NEW.state='erased'
BEGIN
 DELETE FROM storage_effective_selective_work WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest);
 DELETE FROM storage_effective_selective_variants WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest);
 DELETE FROM storage_effective_selective_reverse_work WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest);
 DELETE FROM storage_effective_selective_days WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest);
 DELETE FROM storage_effective_selective_ranges WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest);
 DELETE FROM storage_effective_selective_effects WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest);
 DELETE FROM storage_effective_selective_owners WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest);
 UPDATE storage_effective_selective_bootstrap SET owner_cursor='',complete=0 WHERE owner_cursor=NEW.owner_digest;
END;

CREATE TRIGGER storage_effective_selective_erase_storage_v11_owner_links AFTER UPDATE ON storage_v11_owner_links WHEN NEW.state='erased'
BEGIN
 DELETE FROM storage_effective_selective_work WHERE participant_id=NEW.participant_id;
 DELETE FROM storage_effective_selective_variants WHERE participant_id=NEW.participant_id;
 DELETE FROM storage_effective_selective_reverse_work WHERE participant_id=NEW.participant_id;
 DELETE FROM storage_effective_selective_days WHERE participant_id=NEW.participant_id;
 DELETE FROM storage_effective_selective_ranges WHERE participant_id=NEW.participant_id;
 DELETE FROM storage_effective_selective_effects WHERE participant_id=NEW.participant_id;
 DELETE FROM storage_effective_selective_owners WHERE participant_id=NEW.participant_id;
 UPDATE storage_effective_selective_bootstrap SET owner_cursor='',complete=0 WHERE owner_cursor=NEW.owner_digest;
END;

-- Indexes support bounded keyset acquisition, without compatibility decoding.
CREATE INDEX storage_effective_selective_typed_page ON typed_telemetry_records(owner_id,observed_day,id);
CREATE INDEX storage_effective_selective_v12_page ON telemetry_v12_records(observed_day,id);
CREATE INDEX storage_effective_selective_correction_page ON telemetry_usage_correction_history(participant_id,event_time_ms,id);
