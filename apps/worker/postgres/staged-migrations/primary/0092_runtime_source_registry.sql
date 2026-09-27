-- Candidate primary DDL for the exact D1 runtime-source identity contract.
-- Registration binds one source ID to its raw namespace at contract version 1.
-- It does not grant ingestion or participant authority.
CREATE TABLE analytics_runtime_sources (
  source_id text NOT NULL,
  source_namespace text NOT NULL,
  contract_version integer NOT NULL,
  CONSTRAINT analytics_runtime_sources_pkey PRIMARY KEY (source_id),
  CONSTRAINT analytics_runtime_sources_source_id_check
    CHECK (char_length(source_id) BETWEEN 1 AND 200 AND source_id !~ '[[:cntrl:]]'),
  CONSTRAINT analytics_runtime_sources_source_namespace_check
    CHECK (char_length(source_namespace) BETWEEN 1 AND 200 AND source_namespace !~ '[[:cntrl:]]'),
  CONSTRAINT analytics_runtime_sources_contract_version_check
    CHECK (contract_version = 1)
);

CREATE FUNCTION reject_analytics_runtime_source_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'analytics_runtime_source_immutable';
  RETURN NULL;
END;
$function$;

CREATE TRIGGER analytics_runtime_source_immutable
  BEFORE UPDATE OR DELETE ON analytics_runtime_sources
  FOR EACH ROW
  EXECUTE FUNCTION reject_analytics_runtime_source_mutation();

CREATE TRIGGER analytics_runtime_source_truncate_refused
  BEFORE TRUNCATE ON analytics_runtime_sources
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_analytics_runtime_source_mutation();

-- These are the existing PostgreSQL relations with direct D1 equivalents
-- whose source_id is already constrained to analytics_runtime_sources.
-- Validate existing rows as part of DDL application; an unregistered legacy
-- source must be backed by its exact namespace/version before this can apply.
ALTER TABLE analytics_admin_metric_snapshots
  ADD CONSTRAINT analytics_admin_metric_snapshots_runtime_source_fk
  FOREIGN KEY (source_id) REFERENCES analytics_runtime_sources (source_id);

ALTER TABLE analytics_admin_metrics_history_cache
  ADD CONSTRAINT analytics_admin_metrics_history_cache_runtime_source_fk
  FOREIGN KEY (source_id) REFERENCES analytics_runtime_sources (source_id);
