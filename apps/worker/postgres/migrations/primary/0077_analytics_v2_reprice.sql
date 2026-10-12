-- K-REPRICE: completed bounded runs, immutable price equivalences, and the
-- former public head on each higher-revision publication. No price-input
-- codec/table duplication and no relaxation of the forward-only head trigger.
-- Immutable association/archive of the SAME existing codec representation.
-- No retroactive count-based association of historical versions is allowed.
CREATE TABLE analytics_v2_contribution_price_inputs (
  day date NOT NULL,
  owner_digest text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  values_sha256 char(64) NOT NULL CHECK (values_sha256 ~ '^[0-9a-f]{64}$'),
  projection_version text NOT NULL CHECK (projection_version = 'analytics-v2-price-input-v1'),
  codec text NOT NULL CHECK (codec = 'deflate-raw-canonical-json-v1'),
  inputs bytea NOT NULL CHECK (octet_length(inputs) > 0),
  inputs_sha256 char(64) NOT NULL CHECK (inputs_sha256 ~ '^[0-9a-f]{64}$'),
  source_inputs_sha256 char(64) NOT NULL CHECK (source_inputs_sha256 ~ '^[0-9a-f]{64}$'),
  input_events integer NOT NULL CHECK (input_events BETWEEN 0 AND 250000),
  run_id uuid NOT NULL,
  kernel_id smallint NOT NULL REFERENCES analytics_v2_kernels(kernel_id),
  PRIMARY KEY (day,owner_digest,version),
  FOREIGN KEY(day,owner_digest,version) REFERENCES analytics_v2_daily_contributions(day,owner_digest,version)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX analytics_v2_contribution_price_inputs_owner ON analytics_v2_contribution_price_inputs(owner_digest);
CREATE TRIGGER analytics_v2_contribution_price_inputs_append_only BEFORE UPDATE OR DELETE
ON analytics_v2_contribution_price_inputs FOR EACH ROW EXECUTE FUNCTION analytics_v2_owner_sets_append_only();
CREATE TRIGGER analytics_v2_contribution_price_inputs_no_truncate BEFORE TRUNCATE
ON analytics_v2_contribution_price_inputs FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_owner_sets_no_truncate();
CREATE TABLE analytics_v2_reprice_runs (
  run_id uuid PRIMARY KEY,
  plan_sha256 char(64) NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  kernel_id smallint NOT NULL REFERENCES analytics_v2_kernels(kernel_id),
  manifest_version integer NOT NULL CHECK (manifest_version >= 1),
  registry_sha256 char(64) NOT NULL CHECK (registry_sha256 ~ '^[0-9a-f]{64}$'),
  pricing_method_version text NOT NULL CHECK (length(pricing_method_version) BETWEEN 1 AND 64),
  bounds jsonb NOT NULL CHECK (jsonb_typeof(bounds) = 'object'),
  receipt jsonb NOT NULL CHECK (COALESCE(jsonb_typeof(receipt) = 'object'
    AND receipt ->> 'schema' = 'analytics-v2-reprice-execution-v1'
    AND receipt ->> 'status' = 'complete',false)),
  finished_at timestamptz NOT NULL
);
CREATE TABLE analytics_v2_price_equivalences (
  day date NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  exclusions_sha256 char(64) NOT NULL CHECK (exclusions_sha256 ~ '^[0-9a-f]{64}$'),
  kernel_id smallint NOT NULL REFERENCES analytics_v2_kernels(kernel_id),
  manifest_version integer NOT NULL CHECK (manifest_version >= 1),
  registry_sha256 char(64) NOT NULL CHECK (registry_sha256 ~ '^[0-9a-f]{64}$'),
  pricing_method_version text NOT NULL CHECK (length(pricing_method_version) BETWEEN 1 AND 64),
  run_id uuid NOT NULL REFERENCES analytics_v2_reprice_runs(run_id) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (day, revision, payload_sha256, kernel_id, manifest_version, source_sha256, exclusions_sha256)
);
CREATE TABLE analytics_v2_published_daily_log (
  day date NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  released_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  run_id uuid NOT NULL,
  -- 0069 deliberately retains unknown stamps on preexisting public heads.
  kernel_id smallint,
  manifest_version integer NOT NULL,
  PRIMARY KEY (day, revision)
);
CREATE FUNCTION analytics_v2_reprice_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'analytics_v2_reprice_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER analytics_v2_reprice_runs_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON analytics_v2_reprice_runs FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_reprice_immutable();
CREATE TRIGGER analytics_v2_price_equivalences_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON analytics_v2_price_equivalences FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_reprice_immutable();
CREATE TRIGGER analytics_v2_published_daily_log_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON analytics_v2_published_daily_log FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_reprice_immutable();
CREATE FUNCTION analytics_v2_log_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO analytics_v2_published_daily_log
    (day,revision,released_at,payload,payload_sha256,run_id,kernel_id,manifest_version)
    VALUES (OLD.day,OLD.revision,OLD.released_at,OLD.payload,OLD.payload_sha256,
      OLD.run_id,OLD.kernel_id,OLD.manifest_version);
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_log_publication AFTER UPDATE ON analytics_v2_published_daily
FOR EACH ROW EXECUTE FUNCTION analytics_v2_log_publication();
