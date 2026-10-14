-- Full isolated ingestion role, after typed-v1 admission. Ordinary authorized
-- append must not invalidate a completed historical graph. Classify only the
-- conservative baseline0059 append case: one elected device per owner/day,
-- no format crossover, no correction and no replaced occurrence. The typed
-- device/stream/occurrence unique index rejects same-device stealing atomically.
-- This runs after the <=200 records and their membership proofs are complete;
-- the request still exists in this same native D1 batch. Bootstrap has no
-- request and remains hard. No record scans or additional outbox rows.
DROP TRIGGER typed_v1_event_publish;
CREATE TRIGGER typed_v1_event_publish AFTER INSERT ON typed_v1_event_sources
BEGIN
 INSERT INTO storage_ingestion_changes(event_digest,owner_digest,revision,kind,object_digest,content_digest,
  authority_epoch,public_authority_epoch,recorded_ms)
 SELECT NEW.event_digest,NEW.owner_digest,COALESCE(prior.revision,0)+1,
  (CASE WHEN classification.append=1 THEN 'source-updated' ELSE 'owner-active' END),
  NEW.event_digest,(SELECT chunk_digest FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),
  COALESCE(prior.authority_epoch,0)+(CASE WHEN classification.append=1 THEN 0 ELSE 1 END),
  source.authority_epoch+(CASE WHEN classification.append=1 THEN 0 ELSE 1 END),
  CAST(strftime('%s','now') AS INTEGER)*1000
 FROM storage_source_state source LEFT JOIN storage_owner_revisions prior ON prior.owner_digest=NEW.owner_digest
 CROSS JOIN (SELECT (CASE WHEN EXISTS (
  SELECT 1 FROM telemetry_v1_chunks c
  JOIN participants p ON p.id=c.participant_id AND p.state='active' AND p.owner_kind='social'
  JOIN typed_v1_authority_requests request ON request.chunk_id=c.id AND request.participant_id=c.participant_id
   AND request.device_id=c.device_id AND request.authorization_id=c.device_upload_authorization_id
   AND request.envelope_digest=c.envelope_digest
  JOIN storage_v11_owner_links link ON link.participant_id=c.participant_id AND link.owner_digest=NEW.owner_digest AND link.state='active'
  JOIN storage_owner_revisions owner ON owner.owner_digest=link.owner_digest AND owner.state='active'
  WHERE c.id=NEW.chunk_id AND c.participant_id=NEW.participant_id AND c.revision=1 AND c.superseded_at IS NULL
   AND c.accepted_record_count=c.record_count AND c.record_count BETWEEN 1 AND 200
   AND NOT EXISTS(SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=c.participant_id)
   AND NOT EXISTS(SELECT 1 FROM telemetry_contributions WHERE participant_id=c.participant_id AND status='accepted')
   AND NOT EXISTS(SELECT 1 FROM telemetry_v1_chunks older WHERE older.participant_id=c.participant_id
    AND older.device_id=c.device_id AND older.stream=c.stream AND older.chunk_day=c.chunk_day
    AND older.chunk_seq=c.chunk_seq AND older.id<>c.id)
   AND NOT EXISTS(SELECT 1 FROM device_credentials d WHERE d.participant_id=c.participant_id AND d.id<>c.device_id
    AND EXISTS(SELECT 1 FROM telemetry_v1_chunks other_device INDEXED BY telemetry_v1_chunks_device_day
     WHERE other_device.participant_id=c.participant_id AND other_device.device_id=d.id
      AND other_device.chunk_day=c.chunk_day AND other_device.superseded_at IS NULL AND other_device.accepted_record_count>0))
 ) THEN 1 ELSE 0 END) append) classification WHERE source.singleton=1;
 UPDATE storage_v11_owner_links SET state='active',object_digest=NEW.event_digest,
  manifest_digest=(SELECT chunk_digest FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) WHERE participant_id=NEW.participant_id;
END;
