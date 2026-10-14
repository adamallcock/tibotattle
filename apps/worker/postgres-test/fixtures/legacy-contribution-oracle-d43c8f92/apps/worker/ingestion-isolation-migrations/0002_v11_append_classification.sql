-- Optional isolated ingestion role only. Classify before either AFTER head
-- trigger runs; original predecessor/domain/admission guards remain unchanged.
-- Reused manifests/chunks require no record scan. At most200 unmatched OLD
-- analytical rows are compared via the immutable full canonical digest. Larger
-- repacks remain hard changes rather than weakening proof or scanning history.
CREATE TABLE storage_v11_append_transitions (
 generation_id TEXT PRIMARY KEY REFERENCES telemetry_v11_domains(id) ON DELETE CASCADE,
 previous_generation_id TEXT NOT NULL, participant_id TEXT NOT NULL,
 head_revision INTEGER NOT NULL CHECK(head_revision>1),
 is_append INTEGER NOT NULL CHECK(is_append IN(0,1)),
 compared_records INTEGER NOT NULL CHECK(compared_records BETWEEN 0 AND 201)
) STRICT;
CREATE TRIGGER storage_v11_append_transition_immutable BEFORE UPDATE ON storage_v11_append_transitions
BEGIN SELECT RAISE(ABORT,'storage_v11_transition_immutable'); END;
CREATE TRIGGER storage_v11_append_transition_retained BEFORE DELETE ON storage_v11_append_transitions
WHEN EXISTS(SELECT 1 FROM telemetry_v11_domains WHERE id=OLD.generation_id)
BEGIN SELECT RAISE(ABORT,'storage_v11_transition_retained'); END;
CREATE TRIGGER storage_v11_classify_head BEFORE UPDATE ON telemetry_v11_domain_heads
BEGIN
 INSERT INTO storage_v11_append_transitions
 (generation_id,previous_generation_id,participant_id,head_revision,is_append,compared_records)
 -- Do not alias a table OLD: SQLite would shadow the trigger predecessor.
 WITH days AS MATERIALIZED (
  SELECT prior_day.observed_day,prior_day.manifest_id old_manifest,next.manifest_id new_manifest
  FROM telemetry_v11_domain_days prior_day LEFT JOIN telemetry_v11_domain_days next
   ON next.generation_id=NEW.generation_id AND next.observed_day=prior_day.observed_day
  WHERE prior_day.generation_id=OLD.generation_id
 ),unmatched AS MATERIALIZED (
  SELECT c.id,c.manifest_id,c.stream,c.record_count,days.new_manifest
  FROM days JOIN telemetry_v11_chunks c ON c.manifest_id=days.old_manifest
  WHERE days.old_manifest IS NOT days.new_manifest AND c.stream IN('usage','quota')
   AND NOT EXISTS(SELECT 1 FROM telemetry_v11_chunks n WHERE n.manifest_id=days.new_manifest
    AND n.chunk_id=c.chunk_id AND n.stream=c.stream AND n.chunk_digest=c.chunk_digest
    AND n.record_count=c.record_count AND n.parser_version=c.parser_version)
  LIMIT 201
 ),counted AS MATERIALIZED (SELECT min(201,COALESCE(sum(record_count),0)) n FROM unmatched)
 SELECT NEW.generation_id,OLD.generation_id,NEW.participant_id,NEW.revision,
 CASE WHEN NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest
  WHERE l.participant_id=OLD.participant_id AND l.generation_id=OLD.generation_id AND l.head_revision=OLD.revision
   AND l.state='active' AND o.state='active')
  OR NOT EXISTS(SELECT 1 FROM typed_v11_admission_state WHERE id=1 AND runtime_contract_version=1)
  OR NOT EXISTS(SELECT 1 FROM telemetry_v11_domains n JOIN telemetry_v11_domains o ON o.id=OLD.generation_id
   WHERE n.id=NEW.generation_id AND n.previous_generation_id=o.id AND n.participant_id=o.participant_id
    AND n.participant_id=NEW.participant_id AND n.device_id=o.device_id)
  OR EXISTS(SELECT 1 FROM days LEFT JOIN telemetry_v11_day_manifests o ON o.id=days.old_manifest
   LEFT JOIN telemetry_v11_day_manifests n ON n.id=days.new_manifest
   WHERE n.id IS NULL OR n.state!='ready' OR o.state!='ready' OR n.participant_id IS NOT o.participant_id
    OR n.device_id IS NOT o.device_id OR n.chunk_day IS NOT o.chunk_day OR n.parser_version IS NOT o.parser_version
    OR json_extract(n.manifest_json,'$.consent') IS NOT json_extract(o.manifest_json,'$.consent')
    OR json_extract(n.manifest_json,'$.excluded') IS NOT json_extract(o.manifest_json,'$.excluded'))
  THEN 0
 WHEN counted.n>200 THEN 0
 WHEN EXISTS(SELECT 1 FROM unmatched c
  JOIN typed_v11_record_admissions old ON old.chunk_id=c.id
  JOIN typed_telemetry_records r ON r.id=old.typed_record_id
  WHERE NOT EXISTS(SELECT 1 FROM typed_v11_record_admissions next
   JOIN typed_telemetry_records nr ON nr.id=next.typed_record_id
   WHERE next.manifest_id=c.new_manifest AND next.stream=old.stream AND next.occurrence_id=old.occurrence_id
    AND nr.canonical_digest=r.canonical_digest AND nr.namespace_id=r.namespace_id AND nr.format=11 AND r.format=11))
  THEN 0 ELSE 1 END,counted.n FROM counted;
END;

DROP TRIGGER telemetry_v11_head_update_publish;
CREATE TRIGGER telemetry_v11_head_update_publish AFTER UPDATE ON telemetry_v11_domain_heads
BEGIN
 UPDATE telemetry_v11_domain_predecessors SET consumed_at=NEW.updated_at
  WHERE token_hash=(SELECT predecessor_token_hash FROM telemetry_v11_domains WHERE id=NEW.generation_id);
 UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=NEW.participant_id;
 UPDATE community_snapshot_mutation_control SET
  graph_append_epoch=CASE WHEN EXISTS(SELECT 1 FROM storage_v11_append_transitions t
   WHERE t.generation_id=NEW.generation_id AND t.previous_generation_id=OLD.generation_id
    AND t.participant_id=NEW.participant_id AND t.head_revision=NEW.revision AND t.is_append=1)
   THEN mutation_epoch+1 ELSE graph_append_epoch END,
  graph_append_reason=CASE WHEN EXISTS(SELECT 1 FROM storage_v11_append_transitions t
   WHERE t.generation_id=NEW.generation_id AND t.previous_generation_id=OLD.generation_id
    AND t.participant_id=NEW.participant_id AND t.head_revision=NEW.revision AND t.is_append=1)
   THEN 'accepted-v11-append' ELSE graph_append_reason END,
  mutation_epoch=mutation_epoch+1
 WHERE singleton_id=1 AND EXISTS(SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=NEW.participant_id);
END;

DROP TRIGGER storage_v11_event_publish;
CREATE TRIGGER storage_v11_event_publish AFTER INSERT ON storage_v11_event_sources
BEGIN
 INSERT INTO storage_ingestion_changes(event_digest,owner_digest,revision,kind,object_digest,content_digest,
  authority_epoch,public_authority_epoch,recorded_ms)
 SELECT NEW.event_digest,NEW.owner_digest,COALESCE(o.revision,0)+1,
  CASE WHEN classification.append=1 THEN 'source-updated' ELSE 'owner-active' END,NEW.event_digest,NEW.manifest_digest,
  COALESCE(o.authority_epoch,0)+CASE WHEN classification.append=1 THEN 0 ELSE 1 END,
  source.authority_epoch+CASE WHEN classification.append=1 THEN 0 ELSE 1 END,NEW.recorded_ms
 FROM storage_source_state source LEFT JOIN storage_owner_revisions o ON o.owner_digest=NEW.owner_digest
 CROSS JOIN (SELECT CASE WHEN EXISTS(SELECT 1 FROM storage_v11_append_transitions t
  JOIN storage_v11_owner_links l ON l.participant_id=t.participant_id AND l.owner_digest=NEW.owner_digest AND l.state='active'
  JOIN storage_owner_revisions prior ON prior.owner_digest=l.owner_digest AND prior.state='active'
  WHERE t.generation_id=NEW.generation_id AND t.participant_id=NEW.participant_id
   AND t.head_revision=NEW.head_revision AND t.is_append=1
   AND l.generation_id=t.previous_generation_id AND l.head_revision+1=t.head_revision)
  THEN 1 ELSE 0 END append) classification WHERE source.singleton=1;
END;
