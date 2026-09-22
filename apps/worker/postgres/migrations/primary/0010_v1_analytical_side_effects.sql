-- PostgreSQL primary migration 0010: operational v1 analytical side effects.
--
-- These tables and trigger functions are the PostgreSQL equivalents of the
-- v1 model-history, graph, prepared-source, and quota-fit source contracts.
-- They are installed in the same schema as the telemetry_v1_* journal so the
-- writer, readers, correction invalidation, and owner lifecycle observe one
-- transactional dataset.  The computation and publication workers consume
-- these bounded states separately.

CREATE TABLE input_versions (
  participant_id text PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 0)
);

CREATE TABLE community_model_history_dependencies (
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  day date NOT NULL,
  from_day date NOT NULL,
  dependency_revision bigint NOT NULL DEFAULT 0
    CHECK (dependency_revision >= 0 AND dependency_revision < 9007199254740991),
  input_fingerprint text
    CHECK (input_fingerprint IS NULL OR input_fingerprint ~ '^[0-9a-f]{64}$'),
  verified_input_revision bigint
    CHECK (verified_input_revision IS NULL OR
      (verified_input_revision >= 0 AND verified_input_revision < 9007199254740991)),
  PRIMARY KEY (participant_id, day),
  CHECK (from_day = day - 100)
);
CREATE INDEX community_model_history_dependencies_day
  ON community_model_history_dependencies(day, participant_id);

CREATE TABLE community_model_composition_days (
  day date PRIMARY KEY,
  payload_json text NOT NULL,
  computed_at timestamptz NOT NULL,
  history_method_version text
);


-- Operational v1 transactional projection effects. Computation workers
-- consume these states separately, just as on D1; this is not publication.
CREATE TABLE legacy_sources(participant_id text PRIMARY KEY REFERENCES participants);
CREATE TABLE v11_domain_heads(participant_id text PRIMARY KEY REFERENCES participants);
CREATE TABLE mutation_control (
  singleton_id integer PRIMARY KEY CHECK(singleton_id=1), mutation_epoch bigint NOT NULL DEFAULT 0,
  graph_append_epoch bigint NOT NULL DEFAULT -1, graph_invalidation_epoch bigint NOT NULL DEFAULT 0,
  graph_append_reason text, graph_last_change_reason text,
  graph_last_change_at timestamptz, graph_last_invalidated_at timestamptz
);
INSERT INTO mutation_control(singleton_id) VALUES(1);
CREATE TABLE graph_scope(singleton integer PRIMARY KEY CHECK(singleton=1),
  metadata jsonb NOT NULL, expected_epoch bigint NOT NULL, phase text NOT NULL CHECK(phase IN ('supersede','insert')));
CREATE TABLE publication_state(singleton integer PRIMARY KEY CHECK(singleton=1),
  publication_state text NOT NULL CHECK(publication_state IN ('ready','updating')),changed_at timestamptz NOT NULL);
INSERT INTO publication_state VALUES(1,'ready',clock_timestamp());
CREATE TABLE preview_cache(id text PRIMARY KEY,payload jsonb NOT NULL);
CREATE TABLE daily_rebuilds(day date PRIMARY KEY,requested_epoch bigint NOT NULL,requested_at timestamptz NOT NULL);
CREATE TABLE current_queue_state(singleton_id integer PRIMARY KEY CHECK(singleton_id=1),window_generation bigint NOT NULL);
INSERT INTO current_queue_state VALUES(1,1);
CREATE TABLE current_queue(participant_id text PRIMARY KEY REFERENCES participants ON DELETE CASCADE,
  dirty_generation bigint NOT NULL,window_generation bigint NOT NULL,pending boolean NOT NULL,last_served_sequence bigint NOT NULL);
CREATE TABLE refresh_lanes(lane text PRIMARY KEY CHECK(lane IN ('current','daily')),
  state text NOT NULL CHECK(state IN ('queued','complete')),completed_at timestamptz,restart_reason text);
CREATE TABLE prepared_source_days(participant_id text NOT NULL REFERENCES participants ON DELETE CASCADE,
  source_day date NOT NULL,phase text NOT NULL CHECK(phase IN ('quota','usage','complete','discarding')),
  progress_revision bigint NOT NULL CHECK(progress_revision BETWEEN 0 AND 9007199254740990),
  quota_count bigint NOT NULL CHECK(quota_count BETWEEN 0 AND 9007199254740990),
  usage_count bigint NOT NULL CHECK(usage_count BETWEEN 0 AND 9007199254740990),PRIMARY KEY(participant_id,source_day));
CREATE TABLE preparation_counters(singleton_id integer PRIMARY KEY CHECK(singleton_id=1),is_exact boolean NOT NULL,
  tracked_days bigint NOT NULL,complete_days bigint NOT NULL,building_days bigint NOT NULL,retiring_days bigint NOT NULL,
  checkpoint_steps bigint NOT NULL,quota_observations bigint NOT NULL,usage_events bigint NOT NULL,
  CHECK(complete_days+building_days+retiring_days=tracked_days),
  CHECK(least(tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events)>=0),
  CHECK(greatest(tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events)<=9007199254740991));
INSERT INTO preparation_counters VALUES(1,true,0,0,0,0,0,0,0);

CREATE FUNCTION begin_graph_scope(input jsonb) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE epoch bigint;
BEGIN
  -- Acquire the shared publication epoch before mutating source rows. This
  -- preserves D1's global serialization; throughput remains a qualification gate.
  SELECT mutation_epoch INTO STRICT epoch FROM mutation_control WHERE singleton_id=1 FOR UPDATE;
  IF EXISTS(SELECT 1 FROM legacy_sources WHERE participant_id=input->>'participantId')
     OR EXISTS(SELECT 1 FROM v11_domain_heads WHERE participant_id=input->>'participantId') THEN RETURN; END IF;
  INSERT INTO graph_scope VALUES(1,jsonb_set(input #- '{chunk,records}','{recordCount}',to_jsonb(jsonb_array_length(input->'chunk'->'records'))),epoch,
    CASE WHEN input->'supersedes'->>'id' IS NULL THEN 'insert' ELSE 'supersede' END);
END;
$$;

CREATE FUNCTION publication_mutated() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE preserves boolean;
BEGIN
  preserves := NEW.mutation_epoch=OLD.mutation_epoch+1 AND NEW.graph_append_epoch=NEW.mutation_epoch
    AND NEW.graph_append_epoch IS DISTINCT FROM OLD.graph_append_epoch;
  UPDATE publication_state SET publication_state='updating',changed_at=clock_timestamp() WHERE singleton=1;
  UPDATE mutation_control SET graph_last_change_at=clock_timestamp(),
    graph_last_change_reason=CASE WHEN preserves THEN coalesce(NEW.graph_append_reason,'accepted-append') ELSE 'authority-or-unrecognized-change' END,
    graph_invalidation_epoch=CASE WHEN preserves THEN graph_invalidation_epoch ELSE NEW.mutation_epoch END,
    graph_last_invalidated_at=CASE WHEN preserves THEN graph_last_invalidated_at ELSE clock_timestamp() END WHERE singleton_id=1;
  IF NOT preserves THEN DELETE FROM preview_cache; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_mutated AFTER UPDATE OF mutation_epoch ON mutation_control
FOR EACH ROW WHEN(OLD.mutation_epoch IS DISTINCT FROM NEW.mutation_epoch) EXECUTE FUNCTION publication_mutated();

CREATE FUNCTION analytical_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE epoch bigint; marker graph_scope%ROWTYPE; m jsonb; preserves boolean := false; correction boolean := false; social boolean;
  owner_id text;
BEGIN
  owner_id := CASE WHEN TG_OP='DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
  INSERT INTO input_versions VALUES(owner_id,1) ON CONFLICT(participant_id) DO UPDATE SET revision=input_versions.revision+1;
  IF TG_OP='UPDATE' AND OLD.participant_id<>NEW.participant_id THEN
    INSERT INTO input_versions VALUES(OLD.participant_id,1) ON CONFLICT(participant_id) DO UPDATE SET revision=input_versions.revision+1;
  END IF;
  SELECT EXISTS(SELECT 1 FROM participants WHERE owner_kind='social' AND
    (id=owner_id OR (TG_OP='UPDATE' AND id=OLD.participant_id))) INTO social;
  IF NOT social THEN RETURN NULL; END IF;
  SELECT mutation_epoch INTO STRICT epoch FROM mutation_control WHERE singleton_id=1 FOR UPDATE;
  SELECT * INTO marker FROM graph_scope WHERE singleton=1;
  m:=marker.metadata;
  IF TG_OP='INSERT' THEN
    correction := NEW.revision > 1 AND EXISTS(
      SELECT 1 FROM telemetry_v1_chunks predecessor
       WHERE predecessor.participant_id=NEW.participant_id
         AND predecessor.device_id=NEW.device_id
         AND predecessor.stream=NEW.stream
         AND predecessor.chunk_day=NEW.chunk_day
         AND predecessor.chunk_seq=NEW.chunk_seq
         AND predecessor.revision=NEW.revision-1
         AND predecessor.superseded_at IS NOT NULL);
    preserves := coalesce(marker.phase='insert' AND marker.expected_epoch=epoch
      AND m->>'chunkId'=NEW.id AND m->>'participantId'=NEW.participant_id AND m->>'deviceId'=NEW.device_id
      AND m->'chunk'->>'stream'=NEW.stream AND (m->'chunk'->>'chunkDay')::date=NEW.chunk_day
      AND (m->'chunk'->>'chunkSeq')::integer=NEW.chunk_seq AND (m->'chunk'->>'chunkRevision')::integer=NEW.revision
      AND m->'chunk'->>'chunkDigest'=NEW.chunk_digest AND m->'chunk'->>'parserVersion'=NEW.parser_version
      AND (m->>'recordCount')::integer=NEW.record_count AND NEW.record_count=NEW.accepted_record_count
      AND (m->>'createdAt')::timestamptz=NEW.created_at AND m->>'uploadAuthorizationId'=NEW.device_upload_authorization_id
      AND m->>'envelopeDigest'=NEW.envelope_digest,false);
    IF NOT preserves AND NOT correction THEN
      preserves := NEW.revision=1 AND EXISTS(SELECT 1 FROM participants WHERE id=owner_id AND state='active')
        AND NOT EXISTS(SELECT 1 FROM legacy_sources WHERE participant_id=owner_id)
        AND NOT EXISTS(SELECT 1 FROM v11_domain_heads WHERE participant_id=owner_id)
        AND NOT EXISTS(SELECT 1 FROM telemetry_v1_chunks WHERE participant_id=owner_id AND device_id=NEW.device_id AND stream=NEW.stream
          AND chunk_day=NEW.chunk_day AND chunk_seq=NEW.chunk_seq AND id<>NEW.id)
        AND NOT EXISTS(SELECT 1 FROM telemetry_v1_chunks WHERE participant_id=owner_id AND device_id<>NEW.device_id
          AND chunk_day=NEW.chunk_day AND superseded_at IS NULL AND accepted_record_count>0);
    END IF;
    preserves := preserves OR correction;
    UPDATE mutation_control SET mutation_epoch=epoch+1,graph_append_epoch=CASE WHEN preserves THEN epoch+1 ELSE -1 END,
      graph_append_reason=CASE WHEN correction OR m->'supersedes'->>'id' IS NOT NULL THEN 'accepted-correction' ELSE 'accepted-append' END WHERE singleton_id=1;
    DELETE FROM graph_scope WHERE metadata->>'chunkId'=NEW.id;
  ELSIF TG_OP='UPDATE' THEN
    correction := OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL;
    preserves := correction OR coalesce(marker.phase='supersede' AND marker.expected_epoch=epoch
      AND m->'supersedes'->>'id'=OLD.id AND m->>'participantId'=OLD.participant_id AND m->>'deviceId'=OLD.device_id
      AND m->'chunk'->>'stream'=OLD.stream AND (m->'chunk'->>'chunkDay')::date=OLD.chunk_day
      AND (m->'chunk'->>'chunkSeq')::integer=OLD.chunk_seq AND (m->'chunk'->>'chunkRevision')::integer=OLD.revision+1
      AND OLD.superseded_at IS NULL AND NEW.superseded_at=(m->>'createdAt')::timestamptz
      AND (to_jsonb(OLD)-'superseded_at'-'r2_key'-'envelope_digest')=(to_jsonb(NEW)-'superseded_at'-'r2_key'-'envelope_digest'),false);
    UPDATE mutation_control SET mutation_epoch=epoch+1,graph_append_epoch=CASE WHEN preserves THEN epoch+1 ELSE -1 END,
      graph_append_reason='accepted-correction' WHERE singleton_id=1;
    IF preserves THEN UPDATE graph_scope SET expected_epoch=epoch+1,phase='insert' WHERE singleton=1; END IF;
  ELSE
    UPDATE mutation_control SET mutation_epoch=epoch+1 WHERE singleton_id=1;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER aa_analytical_insert AFTER INSERT ON telemetry_v1_chunks FOR EACH ROW WHEN(NEW.superseded_at IS NULL) EXECUTE FUNCTION analytical_mutation();
CREATE TRIGGER aa_analytical_delete AFTER DELETE ON telemetry_v1_chunks FOR EACH ROW WHEN(OLD.superseded_at IS NULL) EXECUTE FUNCTION analytical_mutation();
CREATE TRIGGER aa_analytical_update AFTER UPDATE ON telemetry_v1_chunks FOR EACH ROW
WHEN((OLD.superseded_at IS NULL OR NEW.superseded_at IS NULL) AND
 (to_jsonb(OLD)-'r2_key'-'envelope_digest') IS DISTINCT FROM (to_jsonb(NEW)-'r2_key'-'envelope_digest')) EXECUTE FUNCTION analytical_mutation();

CREATE FUNCTION analysis_queued() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO current_queue SELECT p.id,1,s.window_generation,true,0 FROM participants p,current_queue_state s
    WHERE p.id=NEW.participant_id AND p.state='active' AND p.owner_kind='social' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=current_queue.dirty_generation+1,pending=true;
  UPDATE refresh_lanes SET state='queued',completed_at=NULL,restart_reason='input_changed'
    WHERE lane='current' AND state='complete' AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id AND owner_kind='social');
  RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_queued_insert AFTER INSERT ON input_versions FOR EACH ROW WHEN(NEW.revision>0) EXECUTE FUNCTION analysis_queued();
CREATE TRIGGER analysis_queued_update AFTER UPDATE OF revision ON input_versions FOR EACH ROW WHEN(OLD.revision IS DISTINCT FROM NEW.revision) EXECUTE FUNCTION analysis_queued();
CREATE FUNCTION participant_queue_removed() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN DELETE FROM current_queue WHERE participant_id=NEW.id; RETURN NEW; END;
$$;
CREATE TRIGGER participant_queue_removed AFTER UPDATE OF state ON participants FOR EACH ROW WHEN(NEW.state<>'active') EXECUTE FUNCTION participant_queue_removed();
CREATE FUNCTION daily_rebuild_queued() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id AND owner_kind='social') THEN RETURN NEW; END IF;
  INSERT INTO daily_rebuilds SELECT NEW.chunk_day,mutation_epoch,clock_timestamp() FROM mutation_control WHERE singleton_id=1
    ON CONFLICT(day) DO UPDATE SET requested_epoch=EXCLUDED.requested_epoch,requested_at=EXCLUDED.requested_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zz_daily_rebuild_queued AFTER INSERT ON telemetry_v1_chunks FOR EACH ROW EXECUTE FUNCTION daily_rebuild_queued();

CREATE FUNCTION prepared_source_discard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE prepared_source_days SET phase='discarding',progress_revision=progress_revision+1
    WHERE phase<>'discarding' AND ((participant_id=OLD.participant_id AND source_day=OLD.observed_day)
      OR (TG_OP='UPDATE' AND participant_id=NEW.participant_id AND source_day=NEW.observed_day));
  RETURN NULL;
END;
$$;
CREATE TRIGGER prepared_source_discard AFTER DELETE OR UPDATE ON telemetry_v1_records FOR EACH ROW EXECUTE FUNCTION prepared_source_discard();

CREATE FUNCTION preparation_progress_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE before_values bigint[]:=ARRAY[0,0,0,0,0,0,0]; after_values bigint[]:=ARRAY[0,0,0,0,0,0,0];
  current_values bigint[]; next_values bigint[]:=ARRAY[]::bigint[]; counter preparation_counters%ROWTYPE; i integer; social boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM participants WHERE owner_kind='social' AND
    (id=CASE WHEN TG_OP='DELETE' THEN OLD.participant_id ELSE NEW.participant_id END
      OR (TG_OP='UPDATE' AND id=OLD.participant_id))) INTO social;
  IF NOT social THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND ROW(OLD.phase,OLD.progress_revision,OLD.quota_count,OLD.usage_count) IS NOT DISTINCT FROM ROW(NEW.phase,NEW.progress_revision,NEW.quota_count,NEW.usage_count) THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' THEN before_values:=ARRAY[1,(OLD.phase='complete')::integer,(OLD.phase IN ('quota','usage'))::integer,
    (OLD.phase='discarding')::integer,OLD.progress_revision,OLD.quota_count,OLD.usage_count]; END IF;
  IF TG_OP<>'DELETE' THEN after_values:=ARRAY[1,(NEW.phase='complete')::integer,(NEW.phase IN ('quota','usage'))::integer,
    (NEW.phase='discarding')::integer,NEW.progress_revision,NEW.quota_count,NEW.usage_count]; END IF;
  SELECT * INTO counter FROM preparation_counters WHERE singleton_id=1 FOR UPDATE;
  IF NOT counter.is_exact THEN RETURN NULL; END IF;
  current_values:=ARRAY[counter.tracked_days,counter.complete_days,counter.building_days,counter.retiring_days,
    counter.checkpoint_steps,counter.quota_observations,counter.usage_events];
  FOR i IN 1..7 LOOP
    IF current_values[i]<before_values[i] OR current_values[i]-before_values[i]>9007199254740991-after_values[i] THEN
      UPDATE preparation_counters SET is_exact=false WHERE singleton_id=1; RETURN NULL;
    END IF;
    next_values[i]:=current_values[i]-before_values[i]+after_values[i];
  END LOOP;
  UPDATE preparation_counters SET tracked_days=next_values[1],complete_days=next_values[2],building_days=next_values[3],retiring_days=next_values[4],
    checkpoint_steps=next_values[5],quota_observations=next_values[6],usage_events=next_values[7] WHERE singleton_id=1;
  RETURN NULL;
END;
$$;
CREATE TRIGGER preparation_progress_changed AFTER INSERT OR UPDATE OR DELETE ON prepared_source_days FOR EACH ROW EXECUTE FUNCTION preparation_progress_changed();
CREATE FUNCTION participant_input_created() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN INSERT INTO input_versions VALUES(NEW.id,0); RETURN NEW; END;
$$;
CREATE TRIGGER participant_input_created AFTER INSERT ON participants FOR EACH ROW EXECUTE FUNCTION participant_input_created();
CREATE FUNCTION participant_withdrawal() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Withdraw publication authority at claim time, before external object
  -- deletion can fail or be retried. Final row deletion is a separate event.
  UPDATE mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER participant_withdrawal BEFORE UPDATE OF state ON participants FOR EACH ROW
WHEN(OLD.state='active' AND NEW.state='deleting' AND OLD.owner_kind='social') EXECUTE FUNCTION participant_withdrawal();
CREATE FUNCTION participant_input_state() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE input_versions SET revision=revision+1 WHERE participant_id=NEW.id;
  DELETE FROM community_model_history_dependencies WHERE participant_id=NEW.id;
  IF NEW.owner_kind='social' THEN
    DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER participant_input_state AFTER UPDATE OF state ON participants FOR EACH ROW
WHEN(OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION participant_input_state();
CREATE FUNCTION participant_projection_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.owner_kind='social' THEN
    -- Remove heads while their owner is still queryable by counter triggers.
    DELETE FROM prepared_source_days WHERE participant_id=OLD.id;
    DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL;
    DELETE FROM preview_cache;
    UPDATE mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1;
  END IF;
  DELETE FROM input_versions WHERE participant_id=OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER participant_projection_delete BEFORE DELETE ON participants FOR EACH ROW EXECUTE FUNCTION participant_projection_delete();

CREATE FUNCTION invalidate_model_history_v1_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1,
         input_fingerprint = NULL,
         verified_input_revision = NULL
   WHERE participant_id = NEW.participant_id
     AND day BETWEEN NEW.chunk_day AND NEW.chunk_day + 100;

  IF EXISTS (
    SELECT 1 FROM participants
     WHERE id = NEW.participant_id AND owner_kind = 'social'
  ) THEN
    DELETE FROM community_model_composition_days
     WHERE history_method_version IS NOT NULL
       AND day BETWEEN NEW.chunk_day AND NEW.chunk_day + 100;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_model_history_v1_insert
AFTER INSERT ON telemetry_v1_chunks FOR EACH ROW
WHEN (NEW.superseded_at IS NULL)
EXECUTE FUNCTION invalidate_model_history_v1_insert();

CREATE FUNCTION invalidate_model_history_v1_update() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1,
         input_fingerprint = NULL,
         verified_input_revision = NULL
   WHERE (participant_id = OLD.participant_id
          AND day BETWEEN OLD.chunk_day AND OLD.chunk_day + 100)
      OR (participant_id = NEW.participant_id
          AND day BETWEEN NEW.chunk_day AND NEW.chunk_day + 100);

  IF EXISTS (
    SELECT 1 FROM participants
     WHERE owner_kind = 'social'
       AND (id = OLD.participant_id OR id = NEW.participant_id)
  ) THEN
    DELETE FROM community_model_composition_days
     WHERE history_method_version IS NOT NULL
       AND (day BETWEEN OLD.chunk_day AND OLD.chunk_day + 100
            OR day BETWEEN NEW.chunk_day AND NEW.chunk_day + 100);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_model_history_v1_update
AFTER UPDATE ON telemetry_v1_chunks FOR EACH ROW
WHEN ((OLD.superseded_at IS NULL OR NEW.superseded_at IS NULL)
 AND (OLD.id IS DISTINCT FROM NEW.id
      OR OLD.participant_id IS DISTINCT FROM NEW.participant_id
      OR OLD.device_id IS DISTINCT FROM NEW.device_id
      OR OLD.stream IS DISTINCT FROM NEW.stream
      OR OLD.chunk_day IS DISTINCT FROM NEW.chunk_day
      OR OLD.chunk_seq IS DISTINCT FROM NEW.chunk_seq
      OR OLD.revision IS DISTINCT FROM NEW.revision
      OR OLD.chunk_digest IS DISTINCT FROM NEW.chunk_digest
      OR OLD.parser_version IS DISTINCT FROM NEW.parser_version
      OR OLD.record_count IS DISTINCT FROM NEW.record_count
      OR OLD.accepted_record_count IS DISTINCT FROM NEW.accepted_record_count
      OR OLD.device_upload_authorization_id IS DISTINCT FROM NEW.device_upload_authorization_id
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.superseded_at IS DISTINCT FROM NEW.superseded_at))
EXECUTE FUNCTION invalidate_model_history_v1_update();

CREATE FUNCTION invalidate_model_history_v1_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1,
         input_fingerprint = NULL,
         verified_input_revision = NULL
   WHERE participant_id = OLD.participant_id
     AND day BETWEEN OLD.chunk_day AND OLD.chunk_day + 100;

  IF EXISTS (
    SELECT 1 FROM participants
     WHERE id = OLD.participant_id AND owner_kind = 'social'
  ) THEN
    DELETE FROM community_model_composition_days
     WHERE history_method_version IS NOT NULL
       AND day BETWEEN OLD.chunk_day AND OLD.chunk_day + 100;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER community_model_history_v1_delete
AFTER DELETE ON telemetry_v1_chunks FOR EACH ROW
WHEN (OLD.superseded_at IS NULL)
EXECUTE FUNCTION invalidate_model_history_v1_delete();


-- PostgreSQL port of migration 0046's bounded quota-fit index. The canonical
-- source remains telemetry_v1_records; no quota rows are copied into this
-- projection until the resumable high-water backfill advances.

CREATE TABLE telemetry_v1_quota_fit_rows (
  record_id bigint PRIMARY KEY REFERENCES telemetry_v1_records(id) ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  resets_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL
);

CREATE INDEX telemetry_v1_quota_fit_rows_cursor
  ON telemetry_v1_quota_fit_rows(participant_id, resets_at, observed_at, record_id);

CREATE TABLE telemetry_v1_quota_fit_backfill (
  singleton_id integer PRIMARY KEY CHECK (singleton_id = 1),
  through_record_id bigint NOT NULL CHECK (through_record_id >= 0),
  last_record_id bigint NOT NULL DEFAULT 0 CHECK (last_record_id >= 0),
  is_complete integer NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
  CHECK (last_record_id <= through_record_id)
);

-- This index is the raw-page seek boundary; the LIMIT remains before
-- eligibility filtering.
CREATE INDEX records_participant_stream_observed
  ON telemetry_v1_records(participant_id, stream, observed_at, id);

CREATE FUNCTION telemetry_v1_quota_fit_is_eligible(
  record_row telemetry_v1_records
) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $$
  SELECT record_row.stream = 'quota'
    AND record_row.limit_id = 'codex'
    AND record_row.window_duration_minutes = 10080
    AND record_row.provider IS NOT NULL
    AND record_row.plan_type IS NOT NULL
    AND record_row.plan_variant IS NOT NULL
    AND record_row.resets_at IS NOT NULL
    AND record_row.slot IS NOT NULL
    AND record_row.used_percent IS NOT NULL
$$;

CREATE FUNCTION telemetry_v1_quota_fit_rows_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF telemetry_v1_quota_fit_is_eligible(NEW) THEN
    INSERT INTO telemetry_v1_quota_fit_rows(record_id, participant_id, resets_at, observed_at)
      VALUES (NEW.id, NEW.participant_id, NEW.resets_at, NEW.observed_at)
      ON CONFLICT(record_id) DO UPDATE SET participant_id=EXCLUDED.participant_id,
        resets_at=EXCLUDED.resets_at, observed_at=EXCLUDED.observed_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER telemetry_v1_quota_fit_rows_insert
AFTER INSERT ON telemetry_v1_records FOR EACH ROW
EXECUTE FUNCTION telemetry_v1_quota_fit_rows_insert();

CREATE FUNCTION telemetry_v1_quota_fit_rows_update() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  DELETE FROM telemetry_v1_quota_fit_rows
   WHERE record_id = OLD.id OR record_id = NEW.id;
  IF telemetry_v1_quota_fit_is_eligible(NEW) THEN
    INSERT INTO telemetry_v1_quota_fit_rows(record_id, participant_id, resets_at, observed_at)
      VALUES (NEW.id, NEW.participant_id, NEW.resets_at, NEW.observed_at)
      ON CONFLICT(record_id) DO UPDATE SET participant_id=EXCLUDED.participant_id,
        resets_at=EXCLUDED.resets_at, observed_at=EXCLUDED.observed_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER telemetry_v1_quota_fit_rows_update
AFTER UPDATE OF id, participant_id, stream, limit_id, window_duration_minutes,
  provider, plan_type, plan_variant, resets_at, slot, used_percent, observed_at
ON telemetry_v1_records FOR EACH ROW
EXECUTE FUNCTION telemetry_v1_quota_fit_rows_update();

CREATE FUNCTION telemetry_v1_quota_fit_rows_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  DELETE FROM telemetry_v1_quota_fit_rows WHERE record_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER telemetry_v1_quota_fit_rows_delete
AFTER DELETE ON telemetry_v1_records FOR EACH ROW
EXECUTE FUNCTION telemetry_v1_quota_fit_rows_delete();

-- This uses the source BIGINT high-water seek. Later inserts are maintained by
-- the trigger and never move the finite backfill boundary.
INSERT INTO telemetry_v1_quota_fit_backfill(singleton_id, through_record_id, last_record_id, is_complete)
SELECT 1, COALESCE(MAX(id), 0), 0, CASE WHEN MAX(id) IS NULL THEN 1 ELSE 0 END
FROM telemetry_v1_records;

-- 0008 originally installed the reconciliation trigger before this
-- analytical fragment.  Replace its probe with a row-count check: PL/pgSQL
-- EXECUTE ... INTO does not update FOUND, and a writer must hold the same
-- pending-object row lock cleanup uses before publishing its chunk.
CREATE OR REPLACE FUNCTION reject_reconciliation_deleting_chunk()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  object_key_value text;
  reconciliation_state_value text;
  selected_count integer;
BEGIN
  EXECUTE format(
    'SELECT object_key,reconciliation_state FROM %I.pending_objects
      WHERE contribution_id=$1 FOR UPDATE',
    TG_TABLE_SCHEMA
  ) INTO object_key_value,reconciliation_state_value USING NEW.id;
  GET DIAGNOSTICS selected_count = ROW_COUNT;
  IF selected_count <> 1
      OR object_key_value IS DISTINCT FROM NEW.r2_key
      OR reconciliation_state_value <> 'registered' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
