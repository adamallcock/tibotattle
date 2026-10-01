-- Completed public aggregates are last-good output. Ordinary accepted uploads
-- and corrections queue replacement work and swap in atomically; they no longer
-- withdraw a completed publication through the global public epoch. Only a
-- delivered or source-proven containment terminal (owner-withdrawn/erased), a
-- policy or collection revision, or an incompatible method withholds one.
-- Both tables are digest-only: no identities, payloads or record content.

-- Highest containment epoch this analytics target has delivered or fenced.
CREATE TABLE analytics_community_terminal_watermarks (
 source_id TEXT PRIMARY KEY,
 terminal_public_authority_epoch INTEGER NOT NULL CHECK(terminal_public_authority_epoch>=0),
 terminal_sequence INTEGER NOT NULL CHECK(terminal_sequence>=0)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_terminal_watermark_monotonic BEFORE UPDATE ON analytics_community_terminal_watermarks
WHEN NEW.source_id IS NOT OLD.source_id
 OR NEW.terminal_public_authority_epoch<OLD.terminal_public_authority_epoch
 OR NEW.terminal_sequence<OLD.terminal_sequence
BEGIN SELECT RAISE(ABORT,'analytics_terminal_watermark_regression'); END;
CREATE TRIGGER analytics_terminal_watermark_retained BEFORE DELETE ON analytics_community_terminal_watermarks
BEGIN SELECT RAISE(ABORT,'analytics_terminal_watermark_retained'); END;
CREATE TRIGGER analytics_terminal_watermark_delivered AFTER INSERT ON analytics_applied_events
WHEN NEW.kind IN('owner-withdrawn','owner-erased')
BEGIN
 INSERT INTO analytics_community_terminal_watermarks(source_id,terminal_public_authority_epoch,terminal_sequence)
 VALUES(NEW.source_id,NEW.public_authority_epoch,NEW.sequence)
 ON CONFLICT(source_id) DO UPDATE SET
  terminal_public_authority_epoch=max(terminal_public_authority_epoch,excluded.terminal_public_authority_epoch),
  terminal_sequence=max(terminal_sequence,excluded.terminal_sequence);
END;
CREATE TRIGGER analytics_terminal_watermark_fenced AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
 INSERT INTO analytics_community_terminal_watermarks(source_id,terminal_public_authority_epoch,terminal_sequence)
 VALUES(NEW.source_id,NEW.public_authority_epoch,NEW.terminal_sequence)
 ON CONFLICT(source_id) DO UPDATE SET
  terminal_public_authority_epoch=max(terminal_public_authority_epoch,excluded.terminal_public_authority_epoch),
  terminal_sequence=max(terminal_sequence,excluded.terminal_sequence);
END;

-- Days whose completed daily publication may embed a since-terminated owner's
-- folded records. Rows are captured in the same transaction as the terminal
-- (ordered delivery or the prioritized erasure fence), before any cleanup can
-- remove the owner rows that prove that membership. An owner fold with no
-- records contributes nothing to a day's totals and is not containment; an
-- unreadable fold is treated as contained. Absence of a row for a day
-- therefore proves the day never folded that owner's records after this
-- migration.
CREATE TABLE analytics_community_daily_containment (
 source_id TEXT NOT NULL,
 day TEXT NOT NULL,
 owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
 terminal_public_authority_epoch INTEGER NOT NULL CHECK(terminal_public_authority_epoch>0),
 PRIMARY KEY(source_id,day,owner_digest)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_daily_containment_day
 ON analytics_community_daily_containment(source_id,day,terminal_public_authority_epoch DESC);
CREATE TRIGGER analytics_daily_containment_retained BEFORE DELETE ON analytics_community_daily_containment
BEGIN SELECT RAISE(ABORT,'analytics_daily_containment_retained'); END;
CREATE TRIGGER analytics_daily_containment_delivered AFTER UPDATE OF state ON analytics_owner_state
WHEN NEW.state IN('withdrawn','erased')
BEGIN
 INSERT INTO analytics_community_daily_containment(source_id,day,owner_digest,terminal_public_authority_epoch)
 SELECT c.source_id,c.day,c.owner_digest,COALESCE(
  (SELECT MAX(e.public_authority_epoch) FROM analytics_applied_events e
   WHERE e.source_id=NEW.source_id AND e.owner_digest=NEW.owner_digest AND e.kind IN('owner-withdrawn','owner-erased')),
  (SELECT s.authority_epoch+1 FROM analytics_source_cursors s WHERE s.source_id=NEW.source_id),1)
 FROM analytics_community_daily_owners c WHERE c.source_id=NEW.source_id AND c.owner_digest=NEW.owner_digest
  AND (CASE WHEN json_valid(c.values_json) THEN COALESCE(json_extract(c.values_json,'$.counts.usage'),1)
   +COALESCE(json_extract(c.values_json,'$.counts.quota'),1)+COALESCE(json_extract(c.values_json,'$.counts.session'),1) ELSE 1 END)>0
 ON CONFLICT(source_id,day,owner_digest) DO UPDATE SET
  terminal_public_authority_epoch=max(terminal_public_authority_epoch,excluded.terminal_public_authority_epoch);
END;
CREATE TRIGGER analytics_daily_containment_inserted AFTER INSERT ON analytics_owner_state
WHEN NEW.state IN('withdrawn','erased')
BEGIN
 INSERT INTO analytics_community_daily_containment(source_id,day,owner_digest,terminal_public_authority_epoch)
 SELECT c.source_id,c.day,c.owner_digest,COALESCE(
  (SELECT MAX(e.public_authority_epoch) FROM analytics_applied_events e
   WHERE e.source_id=NEW.source_id AND e.owner_digest=NEW.owner_digest AND e.kind IN('owner-withdrawn','owner-erased')),
  (SELECT s.authority_epoch+1 FROM analytics_source_cursors s WHERE s.source_id=NEW.source_id),1)
 FROM analytics_community_daily_owners c WHERE c.source_id=NEW.source_id AND c.owner_digest=NEW.owner_digest
  AND (CASE WHEN json_valid(c.values_json) THEN COALESCE(json_extract(c.values_json,'$.counts.usage'),1)
   +COALESCE(json_extract(c.values_json,'$.counts.quota'),1)+COALESCE(json_extract(c.values_json,'$.counts.session'),1) ELSE 1 END)>0
 ON CONFLICT(source_id,day,owner_digest) DO UPDATE SET
  terminal_public_authority_epoch=max(terminal_public_authority_epoch,excluded.terminal_public_authority_epoch);
END;
CREATE TRIGGER analytics_daily_containment_fenced AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
 INSERT INTO analytics_community_daily_containment(source_id,day,owner_digest,terminal_public_authority_epoch)
 SELECT c.source_id,c.day,c.owner_digest,NEW.public_authority_epoch
 FROM analytics_community_daily_owners c WHERE c.source_id=NEW.source_id AND c.owner_digest=NEW.owner_digest
  AND (CASE WHEN json_valid(c.values_json) THEN COALESCE(json_extract(c.values_json,'$.counts.usage'),1)
   +COALESCE(json_extract(c.values_json,'$.counts.quota'),1)+COALESCE(json_extract(c.values_json,'$.counts.session'),1) ELSE 1 END)>0
 ON CONFLICT(source_id,day,owner_digest) DO UPDATE SET
  terminal_public_authority_epoch=max(terminal_public_authority_epoch,excluded.terminal_public_authority_epoch);
END;

-- Backfill from retained journal receipts and fences. A publication pinned
-- below a terminal is kept only when every such terminated owner has a
-- retained fold row proving it contributed no records to that day; otherwise
-- the membership evidence is contaminated or already retired, the row is
-- withheld by the epoch fence today, and it is retired here so the per-day
-- rule can never resurrect it. Its head remains and rebuilds normally.
-- D1 forbids temporary tables, so the terminal set is a CTE in each statement.
WITH terminals AS (
 SELECT source_id,owner_digest,MAX(epoch) AS epoch,MAX(seq) AS seq FROM (
  SELECT source_id,owner_digest,public_authority_epoch AS epoch,sequence AS seq FROM analytics_applied_events
   WHERE kind IN('owner-withdrawn','owner-erased')
  UNION ALL
  SELECT source_id,owner_digest,public_authority_epoch,terminal_sequence FROM analytics_storage_erasure_fences
 ) GROUP BY source_id,owner_digest
)
INSERT INTO analytics_community_terminal_watermarks(source_id,terminal_public_authority_epoch,terminal_sequence)
SELECT source_id,MAX(epoch),MAX(seq) FROM terminals GROUP BY source_id;
WITH terminals AS (
 SELECT source_id,owner_digest,MAX(epoch) AS epoch,MAX(seq) AS seq FROM (
  SELECT source_id,owner_digest,public_authority_epoch AS epoch,sequence AS seq FROM analytics_applied_events
   WHERE kind IN('owner-withdrawn','owner-erased')
  UNION ALL
  SELECT source_id,owner_digest,public_authority_epoch,terminal_sequence FROM analytics_storage_erasure_fences
 ) GROUP BY source_id,owner_digest
)
INSERT INTO analytics_community_daily_containment(source_id,day,owner_digest,terminal_public_authority_epoch)
SELECT c.source_id,c.day,c.owner_digest,t.epoch FROM analytics_community_daily_owners c
 JOIN terminals t ON t.source_id=c.source_id AND t.owner_digest=c.owner_digest
 WHERE (CASE WHEN json_valid(c.values_json) THEN COALESCE(json_extract(c.values_json,'$.counts.usage'),1)
  +COALESCE(json_extract(c.values_json,'$.counts.quota'),1)+COALESCE(json_extract(c.values_json,'$.counts.session'),1) ELSE 1 END)>0;
WITH terminals AS (
 SELECT source_id,owner_digest,MAX(epoch) AS epoch,MAX(seq) AS seq FROM (
  SELECT source_id,owner_digest,public_authority_epoch AS epoch,sequence AS seq FROM analytics_applied_events
   WHERE kind IN('owner-withdrawn','owner-erased')
  UNION ALL
  SELECT source_id,owner_digest,public_authority_epoch,terminal_sequence FROM analytics_storage_erasure_fences
 ) GROUP BY source_id,owner_digest
)
DELETE FROM analytics_community_daily_publications WHERE (source_id,day,revision) IN(
 SELECT p.source_id,p.day,p.revision FROM analytics_community_daily_publications p
 JOIN terminals t ON t.source_id=p.source_id
 WHERE COALESCE(json_extract(p.authority_json,'$.publicAuthorityEpoch'),-1)<t.epoch
  AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_owners c
   WHERE c.source_id=p.source_id AND c.day=p.day AND c.owner_digest=t.owner_digest AND json_valid(c.values_json)
    AND COALESCE(json_extract(c.values_json,'$.counts.usage'),1)+COALESCE(json_extract(c.values_json,'$.counts.quota'),1)
     +COALESCE(json_extract(c.values_json,'$.counts.session'),1)=0));
