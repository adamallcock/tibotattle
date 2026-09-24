-- Typed v1.2 records are normalized children of the legacy chunk/manifest
-- journal. Once a ready day enters any active domain generation, direct
-- deletion of its typed values must not silently shrink the published read
-- set. Participant erasure remains possible after the owner enters deleting.

CREATE FUNCTION telemetry_v12_typed_published_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE manifest_id_value text;
BEGIN
  IF TG_TABLE_NAME = 'telemetry_v12_typed_records' THEN
    SELECT record.manifest_id INTO manifest_id_value
      FROM telemetry_v12_typed_records record
     WHERE record.id = OLD.id;
  ELSE
    SELECT record.manifest_id INTO manifest_id_value
      FROM telemetry_v12_typed_records record
     WHERE record.id = OLD.record_id;
  END IF;

  IF manifest_id_value IS NOT NULL AND EXISTS (
    SELECT 1
      FROM telemetry_v12_day_manifests manifest
      JOIN telemetry_v12_domain_days domain_day ON domain_day.manifest_id = manifest.id
      JOIN telemetry_v12_domains generation ON generation.id = domain_day.generation_id
      JOIN participants participant ON participant.id = generation.participant_id
     WHERE manifest.id = manifest_id_value
       AND generation.participant_id = manifest.participant_id
       AND participant.state = 'active'
  ) THEN
    RAISE EXCEPTION 'telemetry_source_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER telemetry_v12_typed_record_delete_guard
BEFORE DELETE ON telemetry_v12_typed_records
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_typed_published_delete_guard();
CREATE TRIGGER telemetry_v12_typed_usage_delete_guard
BEFORE DELETE ON telemetry_v12_typed_usage
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_typed_published_delete_guard();
CREATE TRIGGER telemetry_v12_typed_quota_delete_guard
BEFORE DELETE ON telemetry_v12_typed_quota
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_typed_published_delete_guard();
CREATE TRIGGER telemetry_v12_typed_session_tool_delete_guard
BEFORE DELETE ON telemetry_v12_typed_session_tools
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_typed_published_delete_guard();
