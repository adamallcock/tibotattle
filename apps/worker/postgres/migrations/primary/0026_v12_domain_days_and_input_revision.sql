-- Current-main v1.2 domain generations use a canonical ready-day list. The
-- older PostgreSQL v1.2 prototype stored a different winners representation.
-- Preserve those rows as legacy evidence rather than relabeling their bytes.

ALTER TABLE telemetry_v12_domain_predecessors
  ALTER COLUMN winners_json DROP NOT NULL;
ALTER TABLE telemetry_v12_domain_predecessors
  ADD COLUMN days_json text
    CHECK (days_json IS NULL OR (
      length(days_json) <= 1250000
      AND jsonb_typeof(days_json::jsonb) = 'array'
    ));
ALTER TABLE telemetry_v12_domain_predecessors
  ADD CONSTRAINT telemetry_v12_predecessor_single_representation
    CHECK ((winners_json IS NULL) <> (days_json IS NULL));

-- A participant may have only one generation for a manifest digest even when
-- multiple devices are authorized. The older uniqueness scope included device.
CREATE UNIQUE INDEX telemetry_v12_domains_participant_manifest
  ON telemetry_v12_domains(participant_id, manifest_digest);

-- A ready day referenced by a generation must not disappear independently of
-- that generation. Defer the check until transaction end so deleting an owner
-- can cascade through manifests and domains in either PostgreSQL FK order.
ALTER TABLE telemetry_v12_domain_days
  DROP CONSTRAINT telemetry_v12_domain_days_manifest_id_fkey;
ALTER TABLE telemetry_v12_domain_days
  ADD CONSTRAINT telemetry_v12_domain_days_manifest_id_fkey
  FOREIGN KEY (manifest_id) REFERENCES telemetry_v12_day_manifests(id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- Domain predecessor fingerprints include an owner input revision. Existing
-- PostgreSQL rows become a baseline revision. Later source adapters must map
-- each current D1 revision-producing transition before the request path opens.
CREATE TABLE community_analytical_input_versions (
  participant_id text PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO community_analytical_input_versions(participant_id, revision)
SELECT id, 0 FROM participants;

CREATE FUNCTION community_analytical_input_participant_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO community_analytical_input_versions(participant_id, revision)
  VALUES (NEW.id, 0);
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_analytical_input_participant_insert
AFTER INSERT ON participants FOR EACH ROW
EXECUTE FUNCTION community_analytical_input_participant_insert();

CREATE FUNCTION community_analytical_input_participant_state() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE community_analytical_input_versions
     SET revision = revision + 1 WHERE participant_id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_analytical_input_participant_state
AFTER UPDATE OF state ON participants FOR EACH ROW
WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION community_analytical_input_participant_state();
