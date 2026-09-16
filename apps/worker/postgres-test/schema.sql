-- Qualification schema only. Not a deployment migration or a full D1 port.
-- All writes use insert_contribution; direct table writes are test fixture setup.
-- Projection dirty requests are atomic evidence, not materialized-view parity.
CREATE SCHEMA tibotattle_v1_test;
REVOKE ALL ON SCHEMA tibotattle_v1_test FROM PUBLIC;
SET search_path = tibotattle_v1_test, pg_catalog;
CREATE TABLE participants (
  id text PRIMARY KEY, state text NOT NULL CHECK (state IN ('active','deleting')),
  owner_kind text NOT NULL CHECK(owner_kind IN ('social','accountless')),
  transport_floor integer NOT NULL DEFAULT 10 CHECK(transport_floor IN (10,20))
);
CREATE TABLE devices (
  id text PRIMARY KEY, participant_id text NOT NULL REFERENCES participants,
  state text NOT NULL CHECK(state IN ('active','revoked')),
  issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE consents (
  participant_id text NOT NULL REFERENCES participants,
  device_id text NOT NULL REFERENCES devices,
  schema_version text NOT NULL, dictionary_version text NOT NULL, privacy_version text NOT NULL,
  PRIMARY KEY(participant_id,device_id)
);
CREATE TABLE authorizations (
  id text PRIMARY KEY, participant_id text NOT NULL REFERENCES participants,
  device_id text NOT NULL REFERENCES devices, envelope_digest text NOT NULL,
  state text NOT NULL CHECK(state IN ('consuming','consumed','revoked')),
  lease_expires_at timestamptz, expires_at timestamptz NOT NULL,
  consumed_contribution_id text, consumed_at timestamptz
);
CREATE TABLE chunks (
  id text PRIMARY KEY, participant_id text NOT NULL REFERENCES participants,
  device_id text NOT NULL REFERENCES devices, stream text NOT NULL CHECK(stream IN ('usage','quota','session')),
  chunk_day date NOT NULL, chunk_seq integer NOT NULL CHECK(chunk_seq >= 0), revision integer NOT NULL CHECK(revision > 0),
  chunk_digest text NOT NULL, envelope_digest text NOT NULL,
  parser_version text NOT NULL, record_count integer NOT NULL CHECK(record_count BETWEEN 1 AND 200),
  object_key text NOT NULL UNIQUE, authorization_id text NOT NULL UNIQUE REFERENCES authorizations,
  created_at timestamptz NOT NULL, superseded_at timestamptz,
  UNIQUE(participant_id,envelope_digest),
  UNIQUE(participant_id,device_id,stream,chunk_day,chunk_seq,revision)
);
CREATE UNIQUE INDEX chunks_current ON chunks(participant_id,device_id,stream,chunk_day,chunk_seq)
  WHERE superseded_at IS NULL;
CREATE TABLE records (
  chunk_id text NOT NULL REFERENCES chunks,
  participant_id text NOT NULL REFERENCES participants, device_id text NOT NULL REFERENCES devices,
  stream text NOT NULL, occurrence_id text NOT NULL, observed_at timestamptz NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(participant_id,device_id,stream,occurrence_id)
);
CREATE INDEX records_chunk ON records(chunk_id);
CREATE TABLE admission_windows (
  participant_id text NOT NULL REFERENCES participants, device_id text NOT NULL REFERENCES devices,
  window_day date NOT NULL, accepted_count integer NOT NULL CHECK(accepted_count >= 0),
  PRIMARY KEY(participant_id,device_id,window_day)
);
CREATE TABLE input_versions (participant_id text PRIMARY KEY REFERENCES participants, revision bigint NOT NULL);
CREATE TABLE projection_requests (
  participant_id text NOT NULL REFERENCES participants, chunk_day date NOT NULL,
  projection text NOT NULL CHECK(projection IN ('daily_aggregate','current_analysis','model_history','prepared_source','quota_fit','public_graph')),
  revision bigint NOT NULL, PRIMARY KEY(participant_id,chunk_day,projection)
);
-- Separate durable object journal: insert does not delete this row on success or failure.
CREATE TABLE pending_objects (contribution_id text PRIMARY KEY, object_key text NOT NULL UNIQUE);

CREATE FUNCTION insert_contribution(input jsonb) RETURNS TABLE(accepted_records integer)
LANGUAGE plpgsql SET search_path = tibotattle_v1_test, pg_catalog AS $$
DECLARE
  p participants%ROWTYPE; d devices%ROWTYPE; a authorizations%ROWTYPE;
  current_chunk chunks%ROWTYPE;
  chunk jsonb := input->'chunk';
  records_input jsonb := chunk->'records';
  pid text := input->>'participantId'; did text := input->>'deviceId';
  cid text := input->>'chunkId'; aid text := input->>'uploadAuthorizationId';
  old_id text := input->'supersedes'->>'id';
  stream_name text := chunk->>'stream'; day_value date := (chunk->>'chunkDay')::date;
  sequence_value integer := (chunk->>'chunkSeq')::integer;
  revision_value integer := (chunk->>'chunkRevision')::integer;
  created timestamptz := (input->>'createdAt')::timestamptz;
  n integer := jsonb_array_length(records_input);
  accepted integer; maximum integer; changed integer; next_version bigint;
BEGIN
  IF n IS NULL OR n NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION USING ERRCODE='P1005', MESSAGE='invalid chunk'; END IF;
  -- A real row lock serializes all writers for this participant, including
  -- first admission where no window/current-chunk row exists yet.
  SELECT * INTO p FROM participants WHERE id=pid FOR UPDATE;
  IF NOT FOUND OR p.state <> 'active' THEN RAISE EXCEPTION USING ERRCODE='P1001', MESSAGE='participant unavailable'; END IF;
  IF p.owner_kind <> 'social' OR p.transport_floor > 10 THEN RAISE EXCEPTION USING ERRCODE='P1007', MESSAGE='transport blocked'; END IF;
  SELECT * INTO d FROM devices WHERE id=did AND participant_id=pid FOR UPDATE;
  IF NOT FOUND OR d.state <> 'active' OR d.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P1002', MESSAGE='upload unavailable'; END IF;
  PERFORM 1 FROM consents WHERE participant_id=pid AND device_id=did
    AND schema_version='telemetry-contribution-v1.0'
    AND dictionary_version='telemetry-v1.0-registry-2026-08-07.1'
    AND privacy_version='ongoing-privacy-safe-telemetry-v1.0'
    AND schema_version=chunk->'consent'->>'telemetrySchemaVersion'
    AND dictionary_version=chunk->'consent'->>'fieldDictionaryVersion'
    AND privacy_version=chunk->'consent'->>'privacyContractVersion' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P1006', MESSAGE='consent unavailable'; END IF;
  SELECT * INTO a FROM authorizations WHERE id=aid AND participant_id=pid AND device_id=did FOR UPDATE;
  IF NOT FOUND OR a.state <> 'consuming' OR a.envelope_digest <> input->>'envelopeDigest'
    OR a.lease_expires_at IS NULL OR a.lease_expires_at <= clock_timestamp() OR a.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P1002', MESSAGE='upload unavailable'; END IF;
  SELECT * INTO current_chunk FROM chunks WHERE participant_id=pid AND device_id=did
    AND stream=stream_name AND chunk_day=day_value AND chunk_seq=sequence_value AND superseded_at IS NULL FOR UPDATE;
  IF old_id IS NULL THEN
    IF current_chunk.id IS NOT NULL OR revision_value <> 1 OR EXISTS(
      SELECT 1 FROM chunks WHERE participant_id=pid AND device_id=did AND stream=stream_name
      AND chunk_day=day_value AND chunk_seq=sequence_value) THEN
      RAISE EXCEPTION USING ERRCODE='P1005', MESSAGE='revision conflict'; END IF;
  ELSE
    IF current_chunk.id IS DISTINCT FROM old_id OR revision_value IS DISTINCT FROM current_chunk.revision+1 THEN
      RAISE EXCEPTION USING ERRCODE='P1005', MESSAGE='revision conflict'; END IF;
  END IF;
  maximum := CASE WHEN d.issued_at > created - interval '7 days' THEN 20000 ELSE 2000 END;
  SELECT accepted_count INTO accepted FROM admission_windows
    WHERE participant_id=pid AND device_id=did AND window_day=(created AT TIME ZONE 'UTC')::date;
  IF COALESCE(accepted,0) >= maximum THEN RAISE EXCEPTION USING ERRCODE='P1003', MESSAGE='admission exhausted'; END IF;
  IF old_id IS NOT NULL THEN
    UPDATE chunks SET superseded_at=created WHERE id=old_id AND superseded_at IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION USING ERRCODE='P1005', MESSAGE='revision conflict'; END IF;
    DELETE FROM records WHERE chunk_id=old_id;
  END IF;
  BEGIN
    INSERT INTO chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,
      envelope_digest,parser_version,record_count,object_key,authorization_id,created_at)
    VALUES(cid,pid,did,stream_name,day_value,sequence_value,revision_value,chunk->>'chunkDigest',
      input->>'envelopeDigest',chunk->>'parserVersion',n,input->>'objectKey',aid,created);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION USING ERRCODE='P1005', MESSAGE='revision conflict'; END;
  BEGIN
    INSERT INTO records(chunk_id,participant_id,device_id,stream,occurrence_id,observed_at,payload)
      SELECT cid,pid,did,stream_name,
        CASE stream_name WHEN 'usage' THEN r->>'eventId' WHEN 'quota' THEN r->>'observationId' ELSE r->>'sessionUuid' END,
        (CASE stream_name WHEN 'usage' THEN r->>'eventTime' WHEN 'quota' THEN r->>'observedTime' ELSE r->>'firstEventTime' END)::timestamptz,r
      FROM jsonb_array_elements(records_input) AS r;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION USING ERRCODE='P1004', MESSAGE='record owned'; END;
  UPDATE authorizations SET state='consumed',consumed_contribution_id=cid,consumed_at=created,lease_expires_at=NULL WHERE id=aid;
  INSERT INTO admission_windows VALUES(pid,did,(created AT TIME ZONE 'UTC')::date,1)
    ON CONFLICT(participant_id,device_id,window_day) DO UPDATE SET accepted_count=admission_windows.accepted_count+1;
  INSERT INTO input_versions VALUES(pid,CASE WHEN old_id IS NULL THEN 1 ELSE 2 END)
    ON CONFLICT(participant_id) DO UPDATE SET revision=input_versions.revision+EXCLUDED.revision
    RETURNING revision INTO next_version;
  INSERT INTO projection_requests SELECT pid,day_value,name,next_version FROM unnest(ARRAY[
    'daily_aggregate','current_analysis','model_history','prepared_source','quota_fit','public_graph']) AS name
    ON CONFLICT(participant_id,chunk_day,projection) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN QUERY SELECT n;
END;
$$;
REVOKE ALL ON FUNCTION insert_contribution(jsonb) FROM PUBLIC;
RESET search_path;
