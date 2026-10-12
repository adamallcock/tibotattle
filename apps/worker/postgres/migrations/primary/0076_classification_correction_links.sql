-- PG-only additive classification provenance. Applying this fragment does not
-- deploy the writer or change any D1 contract. A link is visible to readers only
-- with its atomically accepted domain/event-source lineage; raw records stay.
CREATE TABLE telemetry_classification_correction_links (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  method_version text NOT NULL CHECK (method_version = 'classification-correction-v1'),
  kind text NOT NULL CHECK (kind IN ('usage-model','usage-provider','usage-model-provider','session-provider')),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id),
  owner_digest bytea NOT NULL CHECK (octet_length(owner_digest)=32),
  owner_revision bigint NOT NULL CHECK (owner_revision > 0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  stream text NOT NULL CHECK (stream IN ('usage','session')),
  occurrence_id bytea NOT NULL CHECK (octet_length(occurrence_id) BETWEEN 2 AND 257),
  observed_at_ms bigint NOT NULL CHECK (observed_at_ms BETWEEN -8640000000000000 AND 8640000000000000),
  before_format smallint NOT NULL CHECK (before_format IN (10,11,12)),
  after_format smallint NOT NULL CHECK (after_format IN (11,12) AND after_format >= before_format),
  before_record_id bigint NOT NULL CHECK (before_record_id > 0),
  after_record_id bigint NOT NULL CHECK (after_record_id > 0),
  before_namespace text NOT NULL CHECK (length(before_namespace) BETWEEN 1 AND 256),
  after_namespace text NOT NULL CHECK (length(after_namespace) BETWEEN 1 AND 256),
  before_chunk_id text NOT NULL CHECK (length(before_chunk_id) BETWEEN 1 AND 256),
  after_chunk_id text NOT NULL CHECK (length(after_chunk_id) BETWEEN 1 AND 256),
  before_manifest_id text CHECK (before_manifest_id IS NULL OR length(before_manifest_id) BETWEEN 1 AND 256),
  after_manifest_id text NOT NULL CHECK (length(after_manifest_id) BETWEEN 1 AND 256),
  before_chunk_digest text NOT NULL CHECK (before_chunk_digest ~ '^[0-9a-f]{64}$'),
  after_chunk_digest text NOT NULL CHECK (after_chunk_digest ~ '^[0-9a-f]{64}$'),
  before_manifest_digest text CHECK (before_manifest_digest IS NULL OR before_manifest_digest ~ '^[0-9a-f]{64}$'),
  after_manifest_digest text NOT NULL CHECK (after_manifest_digest ~ '^[0-9a-f]{64}$'),
  before_digest bytea NOT NULL CHECK (octet_length(before_digest)=32),
  after_digest bytea NOT NULL CHECK (octet_length(after_digest)=32),
  invariant_digest bytea NOT NULL CHECK (octet_length(invariant_digest)=32),
  link_digest bytea NOT NULL UNIQUE CHECK (octet_length(link_digest)=32),
  before_record_json text NOT NULL CHECK (octet_length(before_record_json) BETWEEN 1 AND 16384),
  after_record_json text NOT NULL CHECK (octet_length(after_record_json) BETWEEN 1 AND 16384),
  predecessor_token_hash text NOT NULL CHECK (predecessor_token_hash ~ '^[0-9a-f]{64}$'),
  previous_generation_id text,
  input_revision bigint NOT NULL CHECK (input_revision >= 0),
  generation_id text NOT NULL,
  activation_manifest_digest text NOT NULL CHECK (activation_manifest_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  CHECK ((stream='session') = (kind='session-provider')),
  UNIQUE (participant_id,device_id,stream,occurrence_id,before_format,before_namespace,before_digest)
);
CREATE INDEX telemetry_classification_correction_generation
  ON telemetry_classification_correction_links(participant_id,generation_id);
CREATE FUNCTION telemetry_classification_correction_retained()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Only the existing explicit owner purge/cascade can remove provenance.
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM participants WHERE id=OLD.participant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'telemetry_classification_correction_retained' USING ERRCODE='P1005';
END;
$$;
CREATE TRIGGER telemetry_classification_correction_immutable
  BEFORE UPDATE OR DELETE ON telemetry_classification_correction_links
  FOR EACH ROW EXECUTE FUNCTION telemetry_classification_correction_retained();
