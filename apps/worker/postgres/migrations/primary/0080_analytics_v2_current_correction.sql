-- Explicit new-contribution correction; existing saved-input receipts retain
-- their v1 meaning. Neither old contribution values nor associations are updated.
ALTER TABLE analytics_v2_reprice_runs
  ADD COLUMN input_source text NOT NULL DEFAULT 'saved-snapshot',
  ADD COLUMN source_kernel_id smallint REFERENCES analytics_v2_kernels(kernel_id);

CREATE FUNCTION analytics_v2_current_correction_receipt_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
DECLARE item record; c jsonb; r jsonb; refused_total numeric := 0;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR NOT value ?& ARRAY['schema','status','inputSource','sourceKernelId','planSha256','counts','refusals','replayed']
    OR value - ARRAY['schema','status','inputSource','sourceKernelId','planSha256','counts','refusals','replayed'] <> '{}'::jsonb
    OR value->>'schema' IS DISTINCT FROM 'analytics-v2-current-correction-execution-v1'
    OR value->>'status' IS DISTINCT FROM 'complete' OR value->>'inputSource' IS DISTINCT FROM 'current-owner-day'
    OR value->'replayed' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(value->'sourceKernelId') IS DISTINCT FROM 'number'
    OR NOT COALESCE(value->>'sourceKernelId' ~ '^[0-9]+$',false)
    OR jsonb_typeof(value->'planSha256') IS DISTINCT FROM 'string'
    OR NOT COALESCE(value->>'planSha256' ~ '^[0-9a-f]{64}$',false) THEN RETURN false; END IF;
  IF (value->>'sourceKernelId')::numeric NOT BETWEEN 1 AND 32767 THEN RETURN false; END IF;
  c := value->'counts'; r := value->'refusals';
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
    OR NOT c ?& ARRAY['planned','changed','unchanged','refused','contributionVersions','currentSourceVersions','archiveSourceVersions']
    OR c - ARRAY['planned','changed','unchanged','refused','contributionVersions','currentSourceVersions','archiveSourceVersions'] <> '{}'::jsonb
    OR NOT r ?& ARRAY['owner_set_unavailable','member_link_unavailable','price_inputs_unavailable',
      'price_input_association_unproven','price_inputs_corrupt','contribution_invalid','reprice_membership_or_evidence_drift',
      'current_source_unavailable','current_source_binding_unproven','current_source_run_unproven',
      'current_source_non_spend_drift','current_source_values_unchanged']
    OR r - ARRAY['owner_set_unavailable','member_link_unavailable','price_inputs_unavailable',
      'price_input_association_unproven','price_inputs_corrupt','contribution_invalid','reprice_membership_or_evidence_drift',
      'current_source_unavailable','current_source_binding_unproven','current_source_run_unproven',
      'current_source_non_spend_drift','current_source_values_unchanged'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOR item IN SELECT key,val FROM jsonb_each(c) AS counts(key,val) LOOP
    IF jsonb_typeof(item.val) IS DISTINCT FROM 'number' OR item.val::text !~ '^[0-9]+$' THEN RETURN false; END IF;
    IF item.val::text::numeric > (CASE WHEN item.key LIKE '%Versions' THEN 1000 ELSE 32 END) THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT val FROM jsonb_each(r) AS refusals(key,val) LOOP
    IF jsonb_typeof(item.val) IS DISTINCT FROM 'number' OR item.val::text !~ '^[0-9]+$' THEN RETURN false; END IF;
    IF item.val::text::numeric > 32 THEN RETURN false; END IF;
    refused_total := refused_total + item.val::text::numeric;
  END LOOP;
  RETURN (c->>'changed')::numeric + (c->>'unchanged')::numeric + (c->>'refused')::numeric = (c->>'planned')::numeric
    AND (c->>'currentSourceVersions')::numeric + (c->>'archiveSourceVersions')::numeric = (c->>'contributionVersions')::numeric
    AND refused_total = (c->>'refused')::numeric;
END;
$$;
ALTER TABLE analytics_v2_reprice_runs DROP CONSTRAINT analytics_v2_reprice_runs_receipt_check;
ALTER TABLE analytics_v2_reprice_runs ADD CONSTRAINT analytics_v2_reprice_runs_receipt_check CHECK (COALESCE(
  (input_source = 'saved-snapshot' AND source_kernel_id IS NULL AND jsonb_typeof(receipt) = 'object'
    AND receipt->>'schema' = 'analytics-v2-reprice-execution-v1' AND receipt->>'status' = 'complete')
  OR (input_source = 'current-owner-day' AND source_kernel_id IS NOT NULL
    AND analytics_v2_current_correction_receipt_valid(receipt)
    AND receipt->>'sourceKernelId' = source_kernel_id::text AND receipt->>'planSha256' = plan_sha256),false));

-- Provenance is owner/version scoped and follows the existing exact-owner
-- archive deletion cascade. Legacy rows remain NULL; no history is relabelled.
CREATE FUNCTION analytics_v2_correction_provenance_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
DECLARE key text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR NOT value ?& ARRAY['inputSource','priorVersion','priorValuesSha256','sourceRunId','sourceKernelId',
      'sourceManifestVersion','sourceValuesSha256','sourceInputsSha256']
    OR value - ARRAY['inputSource','priorVersion','priorValuesSha256','sourceRunId','sourceKernelId',
      'sourceManifestVersion','sourceValuesSha256','sourceInputsSha256'] <> '{}'::jsonb
    OR value->>'inputSource' NOT IN ('archive','current-owner-day')
    OR jsonb_typeof(value->'inputSource') IS DISTINCT FROM 'string'
    OR jsonb_typeof(value->'sourceRunId') IS DISTINCT FROM 'string'
    OR NOT COALESCE(value->>'sourceRunId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
    THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['priorValuesSha256','sourceValuesSha256','sourceInputsSha256'] LOOP
    IF jsonb_typeof(value->key) IS DISTINCT FROM 'string' OR NOT COALESCE(value->>key ~ '^[0-9a-f]{64}$',false) THEN RETURN false; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['priorVersion','sourceKernelId','sourceManifestVersion'] LOOP
    IF jsonb_typeof(value->key) IS DISTINCT FROM 'number' OR NOT COALESCE(value->>key ~ '^[0-9]+$',false) THEN RETURN false; END IF;
    IF (value->>key)::numeric < 1 OR (value->>key)::numeric > (CASE WHEN key='sourceKernelId' THEN 32767 ELSE 2147483647 END) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
ALTER TABLE analytics_v2_contribution_price_inputs ADD COLUMN correction_provenance jsonb;
ALTER TABLE analytics_v2_contribution_price_inputs ADD CONSTRAINT analytics_v2_correction_provenance_check CHECK (
  correction_provenance IS NULL OR COALESCE(analytics_v2_correction_provenance_valid(correction_provenance)
    AND correction_provenance->>'priorVersion' = (version-1)::text
    AND correction_provenance->>'sourceInputsSha256' = source_inputs_sha256,false));
