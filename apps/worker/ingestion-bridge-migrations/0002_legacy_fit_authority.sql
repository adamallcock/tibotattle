-- OPTIONAL replacement-role bridge. Legacy v0.2 remains a fit source only:
-- these are input/authority revision receipts, never daily usage or price totals.
-- All original consent, occurrence uniqueness and dataset selection remain intact.
CREATE TABLE storage_legacy_event_sources (
 event_digest TEXT PRIMARY KEY CHECK(length(event_digest)=64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
 owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
 participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 input_revision INTEGER NOT NULL CHECK(input_revision>=0),
 change_kind TEXT NOT NULL CHECK(change_kind IN('owner-active','source-updated')),
 UNIQUE(participant_id,input_revision)
) STRICT;
CREATE INDEX storage_legacy_events_owner ON storage_legacy_event_sources(owner_digest,event_digest);
CREATE TABLE storage_legacy_revision_requests(participant_id TEXT PRIMARY KEY,append_only INTEGER NOT NULL DEFAULT 0 CHECK(append_only IN(0,1))) STRICT;
CREATE INDEX storage_legacy_contribution_dataset ON telemetry_contributions(participant_id,dataset_id,status);
CREATE TRIGGER storage_legacy_request_apply AFTER INSERT ON storage_legacy_revision_requests
BEGIN
 INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state)
 SELECT p.id,lower(hex(randomblob(32))),'active' FROM participants p
 WHERE p.id=NEW.participant_id AND p.state='active' AND p.owner_kind='social'
 AND EXISTS(SELECT 1 FROM community_public_source_owners eligible WHERE eligible.participant_id=p.id AND eligible.device_id IS NULL)
 AND EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
  AND c.transport_schema_version='telemetry-contribution-v0.2')
 ON CONFLICT(participant_id) DO NOTHING;
 INSERT INTO storage_legacy_event_sources(event_digest,owner_digest,participant_id,input_revision,change_kind)
 SELECT lower(hex(randomblob(32))),l.owner_digest,l.participant_id,COALESCE(v.revision,0),(CASE WHEN NEW.append_only=1 AND EXISTS(SELECT 1 FROM storage_owner_revisions o WHERE o.owner_digest=l.owner_digest AND o.state='active') THEN 'source-updated' ELSE 'owner-active' END)
 FROM storage_v11_owner_links l JOIN participants p ON p.id=l.participant_id AND p.state='active' AND p.owner_kind='social'
 LEFT JOIN community_analytical_input_versions v ON v.participant_id=l.participant_id
 WHERE l.participant_id=NEW.participant_id AND l.state='active'
 AND EXISTS(SELECT 1 FROM community_public_source_owners eligible WHERE eligible.participant_id=p.id AND eligible.device_id IS NULL)
 AND (EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
  AND c.transport_schema_version='telemetry-contribution-v0.2')
  OR EXISTS(SELECT 1 FROM storage_legacy_event_sources prior WHERE prior.participant_id=p.id))
 ON CONFLICT(participant_id,input_revision) DO NOTHING;
 DELETE FROM storage_legacy_revision_requests WHERE participant_id=NEW.participant_id;
END;
CREATE TRIGGER storage_legacy_event_publish AFTER INSERT ON storage_legacy_event_sources
BEGIN
 INSERT INTO storage_ingestion_changes(event_digest,owner_digest,revision,kind,object_digest,content_digest,
  authority_epoch,public_authority_epoch,recorded_ms)
 VALUES(NEW.event_digest,NEW.owner_digest,COALESCE((SELECT revision FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+1,
  NEW.change_kind,NEW.event_digest,NEW.event_digest,
  COALESCE((SELECT authority_epoch FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+(CASE WHEN NEW.change_kind='owner-active' THEN 1 ELSE 0 END),
  (SELECT authority_epoch FROM storage_source_state WHERE singleton=1)+(CASE WHEN NEW.change_kind='owner-active' THEN 1 ELSE 0 END),CAST(strftime('%s','now') AS INTEGER)*1000);
 UPDATE storage_v11_owner_links SET object_digest=NEW.event_digest,manifest_digest=NEW.event_digest
 WHERE participant_id=NEW.participant_id AND generation_id IS NULL;
END;
CREATE TRIGGER storage_legacy_event_immutable BEFORE UPDATE ON storage_legacy_event_sources
BEGIN SELECT RAISE(ABORT,'storage_legacy_event_immutable'); END;
CREATE TRIGGER storage_legacy_event_retained BEFORE DELETE ON storage_legacy_event_sources
WHEN NOT EXISTS(SELECT 1 FROM storage_owner_revisions WHERE owner_digest=OLD.owner_digest AND state='erased')
BEGIN SELECT RAISE(ABORT,'storage_legacy_terminal_required'); END;
-- Header journal receipts are constant per admission stage. The first records
-- and membership writes commit atomically with header INSERT. The separate
-- accounting UPDATE has its own receipt; neither claims a completed fit.
CREATE TRIGGER storage_legacy_header_insert AFTER INSERT ON telemetry_contributions
WHEN NEW.status='accepted' AND NEW.transport_schema_version='telemetry-contribution-v0.2'
BEGIN INSERT INTO storage_legacy_revision_requests(participant_id,append_only) VALUES(NEW.participant_id,(CASE WHEN NEW.transport_schema_version='telemetry-contribution-v0.2' AND NEW.dataset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM telemetry_contributions prior WHERE prior.participant_id=NEW.participant_id AND prior.dataset_id=NEW.dataset_id AND prior.status='accepted' AND prior.id<>NEW.id) THEN 1 ELSE 0 END)); END;
CREATE TRIGGER storage_legacy_header_update AFTER UPDATE ON telemetry_contributions
WHEN (OLD.transport_schema_version='telemetry-contribution-v0.2' OR NEW.transport_schema_version='telemetry-contribution-v0.2') AND (OLD.status = 'accepted' OR NEW.status = 'accepted') AND (
  OLD.id IS NOT NEW.id
  OR OLD.participant_id IS NOT NEW.participant_id
  OR OLD.plaintext_digest IS NOT NEW.plaintext_digest
  OR OLD.status IS NOT NEW.status
  OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.range_start IS NOT NEW.range_start
  OR OLD.range_end IS NOT NEW.range_end
  OR OLD.client_platform IS NOT NEW.client_platform
  OR OLD.provider_policy_epoch IS NOT NEW.provider_policy_epoch
  OR OLD.estimated_api_cost_usd IS NOT NEW.estimated_api_cost_usd
  OR OLD.priced_event_coverage_percent IS NOT NEW.priced_event_coverage_percent
  OR OLD.unknown_model_event_count IS NOT NEW.unknown_model_event_count
  OR OLD.unknown_billable_units IS NOT NEW.unknown_billable_units
  OR OLD.price_basis IS NOT NEW.price_basis
  OR OLD.declared_record_count IS NOT NEW.declared_record_count
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.upload_authorization_id IS NOT NEW.upload_authorization_id
  OR OLD.device_upload_authorization_id IS NOT NEW.device_upload_authorization_id
  OR OLD.server_cost_nanousd IS NOT NEW.server_cost_nanousd
  OR OLD.server_priced_event_count IS NOT NEW.server_priced_event_count
  OR OLD.server_partially_priced_event_count IS NOT NEW.server_partially_priced_event_count
  OR OLD.server_unpriced_event_count IS NOT NEW.server_unpriced_event_count
  OR OLD.server_pricing_method_version IS NOT NEW.server_pricing_method_version
  OR OLD.server_price_registry_version IS NOT NEW.server_price_registry_version
  OR OLD.server_price_registry_sha256 IS NOT NEW.server_price_registry_sha256
  OR OLD.transport_schema_version IS NOT NEW.transport_schema_version
  OR OLD.dataset_id IS NOT NEW.dataset_id
  OR OLD.dataset_part_index IS NOT NEW.dataset_part_index
  OR OLD.dataset_part_count IS NOT NEW.dataset_part_count
  OR OLD.dataset_completeness IS NOT NEW.dataset_completeness
  OR OLD.dataset_range_start IS NOT NEW.dataset_range_start
  OR OLD.dataset_range_end IS NOT NEW.dataset_range_end
  OR OLD.accepted_record_count IS NOT NEW.accepted_record_count
  OR OLD.server_price_basis IS NOT NEW.server_price_basis
  OR OLD.server_price_epoch_basis IS NOT NEW.server_price_epoch_basis
  OR OLD.server_price_event_time_start IS NOT NEW.server_price_event_time_start
  OR OLD.server_price_event_time_end IS NOT NEW.server_price_event_time_end
)
BEGIN
 INSERT INTO storage_legacy_revision_requests(participant_id,append_only) VALUES(OLD.participant_id,(CASE WHEN OLD.status='accepted' AND NEW.status='accepted' AND OLD.transport_schema_version='telemetry-contribution-v0.2' AND NEW.transport_schema_version='telemetry-contribution-v0.2' AND OLD.id IS NEW.id AND OLD.participant_id IS NEW.participant_id AND OLD.plaintext_digest IS NEW.plaintext_digest AND OLD.status IS NEW.status AND OLD.schema_version IS NEW.schema_version AND OLD.range_start IS NEW.range_start AND OLD.range_end IS NEW.range_end AND OLD.client_platform IS NEW.client_platform AND OLD.provider_policy_epoch IS NEW.provider_policy_epoch AND OLD.declared_record_count IS NEW.declared_record_count AND OLD.created_at IS NEW.created_at AND OLD.upload_authorization_id IS NEW.upload_authorization_id AND OLD.device_upload_authorization_id IS NEW.device_upload_authorization_id AND OLD.transport_schema_version IS NEW.transport_schema_version AND OLD.dataset_id IS NEW.dataset_id AND OLD.dataset_part_index IS NEW.dataset_part_index AND OLD.dataset_part_count IS NEW.dataset_part_count AND OLD.dataset_completeness IS NEW.dataset_completeness AND OLD.dataset_range_start IS NEW.dataset_range_start AND OLD.dataset_range_end IS NEW.dataset_range_end THEN 1 ELSE 0 END));
 INSERT INTO storage_legacy_revision_requests(participant_id) SELECT NEW.participant_id WHERE NEW.participant_id IS NOT OLD.participant_id;
END;
CREATE TRIGGER storage_legacy_header_delete AFTER DELETE ON telemetry_contributions
WHEN OLD.status='accepted' AND OLD.transport_schema_version='telemetry-contribution-v0.2'
BEGIN INSERT INTO storage_legacy_revision_requests(participant_id) VALUES(OLD.participant_id); END;
-- Raw rows only advance exact input metadata; they do not multiply outbox
-- receipts. Repair/delete is a hard public graph fence. Ordinary INSERT is an
-- append: source-pinned future graph work sees the new input revision.
CREATE TRIGGER storage_legacy_telemetry_records_insert AFTER INSERT ON telemetry_records
BEGIN
 INSERT INTO community_analytical_input_versions(participant_id,revision)
 SELECT p.id,1 FROM participants p WHERE p.id=NEW.participant_id AND p.state='active' AND p.owner_kind='social'
 AND (EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
  AND c.transport_schema_version='telemetry-contribution-v0.2')
  OR EXISTS(SELECT 1 FROM storage_legacy_event_sources s WHERE s.participant_id=p.id))
 ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER storage_legacy_telemetry_records_update AFTER UPDATE ON telemetry_records
BEGIN
 INSERT INTO community_analytical_input_versions(participant_id,revision)
 SELECT p.id,1 FROM participants p WHERE p.id=OLD.participant_id AND p.state='active' AND p.owner_kind='social'
 AND (EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
  AND c.transport_schema_version='telemetry-contribution-v0.2')
  OR EXISTS(SELECT 1 FROM storage_legacy_event_sources s WHERE s.participant_id=p.id))
 ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
 INSERT INTO community_analytical_input_versions(participant_id,revision)
 SELECT p.id,1 FROM participants p WHERE p.id=NEW.participant_id AND NEW.participant_id IS NOT OLD.participant_id AND p.state='active' AND p.owner_kind='social'
 AND (EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
  AND c.transport_schema_version='telemetry-contribution-v0.2')
  OR EXISTS(SELECT 1 FROM storage_legacy_event_sources s WHERE s.participant_id=p.id))
 ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
 UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1 AND EXISTS(
  SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social');
END;
CREATE TRIGGER storage_legacy_telemetry_records_delete AFTER DELETE ON telemetry_records
BEGIN
 INSERT INTO community_analytical_input_versions(participant_id,revision)
 SELECT p.id,1 FROM participants p WHERE p.id=OLD.participant_id AND p.state='active' AND p.owner_kind='social'
 AND (EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
  AND c.transport_schema_version='telemetry-contribution-v0.2')
  OR EXISTS(SELECT 1 FROM storage_legacy_event_sources s WHERE s.participant_id=p.id))
 ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
 UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1 AND EXISTS(
  SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id) AND p.owner_kind='social');
END;
CREATE TRIGGER storage_legacy_telemetry_contribution_occurrences_insert AFTER INSERT ON telemetry_contribution_occurrences
BEGIN
 INSERT INTO community_analytical_input_versions(participant_id,revision)
 SELECT p.id,1 FROM participants p WHERE p.id=NEW.participant_id AND p.state='active' AND p.owner_kind='social'
 AND (EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
  AND c.transport_schema_version='telemetry-contribution-v0.2')
  OR EXISTS(SELECT 1 FROM storage_legacy_event_sources s WHERE s.participant_id=p.id))
 ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
 UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1 AND EXISTS(
 SELECT 1 FROM telemetry_records r WHERE r.participant_id=NEW.participant_id AND r.record_kind=NEW.record_kind AND r.occurrence_id=NEW.occurrence_id AND r.origin_contribution_id<>NEW.contribution_id);
END;
CREATE TRIGGER storage_legacy_telemetry_contribution_occurrences_update AFTER UPDATE ON telemetry_contribution_occurrences
BEGIN
 INSERT INTO community_analytical_input_versions(participant_id,revision)
 SELECT p.id,1 FROM participants p WHERE p.id=OLD.participant_id AND p.state='active' AND p.owner_kind='social'
 AND (EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
  AND c.transport_schema_version='telemetry-contribution-v0.2')
  OR EXISTS(SELECT 1 FROM storage_legacy_event_sources s WHERE s.participant_id=p.id))
 ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
 INSERT INTO community_analytical_input_versions(participant_id,revision)
 SELECT p.id,1 FROM participants p WHERE p.id=NEW.participant_id AND NEW.participant_id IS NOT OLD.participant_id AND p.state='active' AND p.owner_kind='social'
 AND (EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
  AND c.transport_schema_version='telemetry-contribution-v0.2')
  OR EXISTS(SELECT 1 FROM storage_legacy_event_sources s WHERE s.participant_id=p.id))
 ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
 UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1 AND EXISTS(
  SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social');
END;
CREATE TRIGGER storage_legacy_telemetry_contribution_occurrences_delete AFTER DELETE ON telemetry_contribution_occurrences
BEGIN
 INSERT INTO community_analytical_input_versions(participant_id,revision)
 SELECT p.id,1 FROM participants p WHERE p.id=OLD.participant_id AND p.state='active' AND p.owner_kind='social'
 AND (EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
  AND c.transport_schema_version='telemetry-contribution-v0.2')
  OR EXISTS(SELECT 1 FROM storage_legacy_event_sources s WHERE s.participant_id=p.id))
 ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
 UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1 AND EXISTS(
  SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id) AND p.owner_kind='social');
END;

-- Recognized append metadata preserves historical publication while exact input
-- revisions still invalidate future work. Unknown changes keep the hard fence.
DROP TRIGGER community_analytical_input_legacy_insert;
CREATE TRIGGER community_analytical_input_legacy_insert
AFTER INSERT ON telemetry_contributions
FOR EACH ROW WHEN NEW.status = 'accepted'
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1, graph_append_reason='accepted-append', graph_append_epoch=(CASE WHEN NEW.transport_schema_version='telemetry-contribution-v0.2' AND NEW.dataset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM telemetry_contributions prior WHERE prior.participant_id=NEW.participant_id AND prior.dataset_id=NEW.dataset_id AND prior.status='accepted' AND prior.id<>NEW.id) THEN mutation_epoch+1 ELSE graph_append_epoch END)
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM participants p
      WHERE p.id = NEW.participant_id AND p.owner_kind = 'social'
   );
END;

-- Recognized append metadata preserves historical publication while exact input
-- revisions still invalidate future work. Unknown changes keep the hard fence.
DROP TRIGGER community_analytical_input_legacy_update;
CREATE TRIGGER community_analytical_input_legacy_update
AFTER UPDATE ON telemetry_contributions FOR EACH ROW WHEN (OLD.status = 'accepted' OR NEW.status = 'accepted') AND (
  OLD.id IS NOT NEW.id
  OR OLD.participant_id IS NOT NEW.participant_id
  OR OLD.plaintext_digest IS NOT NEW.plaintext_digest
  OR OLD.status IS NOT NEW.status
  OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.range_start IS NOT NEW.range_start
  OR OLD.range_end IS NOT NEW.range_end
  OR OLD.client_platform IS NOT NEW.client_platform
  OR OLD.provider_policy_epoch IS NOT NEW.provider_policy_epoch
  OR OLD.estimated_api_cost_usd IS NOT NEW.estimated_api_cost_usd
  OR OLD.priced_event_coverage_percent IS NOT NEW.priced_event_coverage_percent
  OR OLD.unknown_model_event_count IS NOT NEW.unknown_model_event_count
  OR OLD.unknown_billable_units IS NOT NEW.unknown_billable_units
  OR OLD.price_basis IS NOT NEW.price_basis
  OR OLD.declared_record_count IS NOT NEW.declared_record_count
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.upload_authorization_id IS NOT NEW.upload_authorization_id
  OR OLD.device_upload_authorization_id IS NOT NEW.device_upload_authorization_id
  OR OLD.server_cost_nanousd IS NOT NEW.server_cost_nanousd
  OR OLD.server_priced_event_count IS NOT NEW.server_priced_event_count
  OR OLD.server_partially_priced_event_count IS NOT NEW.server_partially_priced_event_count
  OR OLD.server_unpriced_event_count IS NOT NEW.server_unpriced_event_count
  OR OLD.server_pricing_method_version IS NOT NEW.server_pricing_method_version
  OR OLD.server_price_registry_version IS NOT NEW.server_price_registry_version
  OR OLD.server_price_registry_sha256 IS NOT NEW.server_price_registry_sha256
  OR OLD.transport_schema_version IS NOT NEW.transport_schema_version
  OR OLD.dataset_id IS NOT NEW.dataset_id
  OR OLD.dataset_part_index IS NOT NEW.dataset_part_index
  OR OLD.dataset_part_count IS NOT NEW.dataset_part_count
  OR OLD.dataset_completeness IS NOT NEW.dataset_completeness
  OR OLD.dataset_range_start IS NOT NEW.dataset_range_start
  OR OLD.dataset_range_end IS NOT NEW.dataset_range_end
  OR OLD.accepted_record_count IS NOT NEW.accepted_record_count
  OR OLD.server_price_basis IS NOT NEW.server_price_basis
  OR OLD.server_price_epoch_basis IS NOT NEW.server_price_epoch_basis
  OR OLD.server_price_event_time_start IS NOT NEW.server_price_event_time_start
  OR OLD.server_price_event_time_end IS NOT NEW.server_price_event_time_end
)
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id,revision)
    SELECT id,1 FROM participants WHERE id=OLD.participant_id OR id=NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1,graph_append_reason='accepted-append',graph_append_epoch=(CASE WHEN OLD.status='accepted' AND NEW.status='accepted' AND OLD.transport_schema_version='telemetry-contribution-v0.2' AND NEW.transport_schema_version='telemetry-contribution-v0.2' AND OLD.id IS NEW.id AND OLD.participant_id IS NEW.participant_id AND OLD.plaintext_digest IS NEW.plaintext_digest AND OLD.status IS NEW.status AND OLD.schema_version IS NEW.schema_version AND OLD.range_start IS NEW.range_start AND OLD.range_end IS NEW.range_end AND OLD.client_platform IS NEW.client_platform AND OLD.provider_policy_epoch IS NEW.provider_policy_epoch AND OLD.declared_record_count IS NEW.declared_record_count AND OLD.created_at IS NEW.created_at AND OLD.upload_authorization_id IS NEW.upload_authorization_id AND OLD.device_upload_authorization_id IS NEW.device_upload_authorization_id AND OLD.transport_schema_version IS NEW.transport_schema_version AND OLD.dataset_id IS NEW.dataset_id AND OLD.dataset_part_index IS NEW.dataset_part_index AND OLD.dataset_part_count IS NEW.dataset_part_count AND OLD.dataset_completeness IS NEW.dataset_completeness AND OLD.dataset_range_start IS NEW.dataset_range_start AND OLD.dataset_range_end IS NEW.dataset_range_end THEN mutation_epoch+1 ELSE graph_append_epoch END) WHERE singleton_id=1 AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social');
END;
