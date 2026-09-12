-- Read-only shape compatibility over every retained source-version row. This is
-- NOT an active-domain/public-eligibility view; authority is a separate owner.
-- Original source row IDs remain namespace + format scoped, never target rowids.
-- No JSON is stored or manufactured here: SQLite REAL-to-JSON formatting differs
-- from ECMAScript canonical JSON. The bounded compatibility reader reconstructs
-- and verifies those bytes with the maintained codec.
--
-- Civil-date arithmetic uses only integers, including negative timestamps and
-- extended ISO years. ID tags below are exactly layout version 1's reversible
-- codec tags; unfamiliar admitted identifiers use tag 0's original ASCII bytes.
CREATE VIEW typed_telemetry_compatibility_records AS
WITH
fields AS NOT MATERIALIZED (
SELECT r.id AS storage_row_id, r.namespace_id, r.owner_id, r.format AS format_code, r.stream AS stream_code,
  r.source_row_id, r.occurrence_id AS occurrence_blob, r.observed_at_ms, r.observed_day AS observed_day_number,
  r.canonical_digest, n.original_id AS namespace_blob, o.original_id AS owner_blob, d.original_id AS device_blob,
  c.original_id AS chunk_blob, c.chunk_day AS chunk_day_number, m.original_id AS manifest_blob,
  provider.value AS provider, u.record_id AS usage_record_id, q.record_id AS quota_record_id,
  sid.value AS session_blob, model.value AS model_id, speed.value AS speed_mode,
  tier.value AS api_service_tier, surface.value AS surface, billing.value AS billing_surface,
  effort.value AS reasoning_effort, scope.value AS agent_scope, outcome.value AS outcome,
  u.total_input_context_tokens, u.input_uncached_tokens, u.input_cache_read_tokens, u.input_cache_write_tokens,
  u.output_text_tokens, u.output_reasoning_tokens, u.output_combined_tokens,
  plan.value AS plan_type, variant.value AS plan_variant, lim.value AS limit_id, slot.value AS slot,
  q.used_percent, q.window_duration_minutes, q.resets_at_ms,
  a.id AS attribution_id, a.account_basis AS account_basis_code, a.account_track AS account_track_blob,
  a.plan_basis AS plan_basis_code, a.plan_era AS plan_era_blob, ap.value AS attribution_plan_type
FROM typed_telemetry_records r
JOIN typed_telemetry_namespaces n ON n.id = r.namespace_id
JOIN typed_telemetry_owners o ON o.id = r.owner_id
JOIN typed_telemetry_devices d ON d.id = r.device_id
JOIN typed_telemetry_chunks c ON c.id = r.chunk_id
LEFT JOIN typed_telemetry_manifests m ON m.id = r.manifest_id
JOIN typed_telemetry_dictionary provider ON provider.id = r.provider_id
LEFT JOIN typed_telemetry_usage u ON u.record_id = r.id
LEFT JOIN typed_telemetry_identifiers sid ON sid.id = u.session_id
LEFT JOIN typed_telemetry_dictionary model ON model.id = u.model_id
LEFT JOIN typed_telemetry_dictionary speed ON speed.id = u.speed_mode_id
LEFT JOIN typed_telemetry_dictionary tier ON tier.id = u.api_service_tier_id
LEFT JOIN typed_telemetry_dictionary surface ON surface.id = u.surface_id
LEFT JOIN typed_telemetry_dictionary billing ON billing.id = u.billing_surface_id
LEFT JOIN typed_telemetry_dictionary effort ON effort.id = u.reasoning_effort_id
LEFT JOIN typed_telemetry_dictionary scope ON scope.id = u.agent_scope_id
LEFT JOIN typed_telemetry_dictionary outcome ON outcome.id = u.outcome_id
LEFT JOIN typed_telemetry_quota q ON q.record_id = r.id
LEFT JOIN typed_telemetry_quota_dimensions qd ON qd.id = q.dimensions_id
LEFT JOIN typed_telemetry_dictionary plan ON plan.id = qd.plan_type_id
LEFT JOIN typed_telemetry_dictionary variant ON variant.id = qd.plan_variant_id
LEFT JOIN typed_telemetry_dictionary lim ON lim.id = q.limit_id
LEFT JOIN typed_telemetry_dictionary slot ON slot.id = q.slot_id
LEFT JOIN typed_telemetry_attributions a ON a.id = coalesce(u.attribution_id, qd.attribution_id)
LEFT JOIN typed_telemetry_dictionary ap ON ap.id = a.plan_type_id
),
days AS NOT MATERIALIZED (
  SELECT *, observed_at_ms / 86400000 - (observed_at_ms % 86400000 < 0) + 719468 AS ot_z,
    resets_at_ms / 86400000 - (resets_at_ms % 86400000 < 0) + 719468 AS rt_z
  FROM fields
),
eras AS NOT MATERIALIZED (
  SELECT *, (ot_z - CASE WHEN ot_z < 0 THEN 146096 ELSE 0 END) / 146097 AS ot_era,
    (rt_z - CASE WHEN rt_z < 0 THEN 146096 ELSE 0 END) / 146097 AS rt_era FROM days
),
era_days AS NOT MATERIALIZED (
  SELECT *, ot_z - ot_era * 146097 AS ot_doe, rt_z - rt_era * 146097 AS rt_doe FROM eras
),
years AS NOT MATERIALIZED (
  SELECT *, (ot_doe - ot_doe / 1460 + ot_doe / 36524 - ot_doe / 146096) / 365 AS ot_yoe,
    (rt_doe - rt_doe / 1460 + rt_doe / 36524 - rt_doe / 146096) / 365 AS rt_yoe FROM era_days
),
year_days AS NOT MATERIALIZED (
  SELECT *, ot_doe - (365 * ot_yoe + ot_yoe / 4 - ot_yoe / 100) AS ot_doy,
    rt_doe - (365 * rt_yoe + rt_yoe / 4 - rt_yoe / 100) AS rt_doy FROM years
),
months AS NOT MATERIALIZED (
  SELECT *, (5 * ot_doy + 2) / 153 AS ot_mp, (5 * rt_doy + 2) / 153 AS rt_mp FROM year_days
),
civil AS NOT MATERIALIZED (
  SELECT *, ot_yoe + ot_era * 400 + (ot_mp >= 10) AS ot_year,
    rt_yoe + rt_era * 400 + (rt_mp >= 10) AS rt_year FROM months
)
SELECT
  storage_row_id,
  namespace_id,
  owner_id,
  format_code,
  stream_code,
  CASE
    WHEN hex(substr(namespace_blob, 1, 1)) = '00' THEN CAST(substr(namespace_blob, 2) AS TEXT)
    WHEN (hex(substr(namespace_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(namespace_blob) = 17)
      OR (hex(substr(namespace_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(namespace_blob) = 33)
    THEN (CASE hex(substr(namespace_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(namespace_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(namespace_blob, 2, 4))) || '-' || lower(hex(substr(namespace_blob, 6, 2))) || '-' || lower(hex(substr(namespace_blob, 8, 2))) || '-' || lower(hex(substr(namespace_blob, 10, 2))) || '-' || lower(hex(substr(namespace_blob, 12, 6))) ELSE lower(hex(substr(namespace_blob, 2))) END
    END AS source_namespace,
  CASE format_code WHEN 10 THEN 'v1' WHEN 11 THEN 'v11' END AS format,
  source_row_id,
  source_row_id AS id,
  CASE
    WHEN hex(substr(owner_blob, 1, 1)) = '00' THEN CAST(substr(owner_blob, 2) AS TEXT)
    WHEN (hex(substr(owner_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(owner_blob) = 17)
      OR (hex(substr(owner_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(owner_blob) = 33)
    THEN (CASE hex(substr(owner_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(owner_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(owner_blob, 2, 4))) || '-' || lower(hex(substr(owner_blob, 6, 2))) || '-' || lower(hex(substr(owner_blob, 8, 2))) || '-' || lower(hex(substr(owner_blob, 10, 2))) || '-' || lower(hex(substr(owner_blob, 12, 6))) ELSE lower(hex(substr(owner_blob, 2))) END
    END AS participant_id,
  CASE
    WHEN hex(substr(device_blob, 1, 1)) = '00' THEN CAST(substr(device_blob, 2) AS TEXT)
    WHEN (hex(substr(device_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(device_blob) = 17)
      OR (hex(substr(device_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(device_blob) = 33)
    THEN (CASE hex(substr(device_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(device_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(device_blob, 2, 4))) || '-' || lower(hex(substr(device_blob, 6, 2))) || '-' || lower(hex(substr(device_blob, 8, 2))) || '-' || lower(hex(substr(device_blob, 10, 2))) || '-' || lower(hex(substr(device_blob, 12, 6))) ELSE lower(hex(substr(device_blob, 2))) END
    END AS device_id,
  CASE
    WHEN hex(substr(chunk_blob, 1, 1)) = '00' THEN CAST(substr(chunk_blob, 2) AS TEXT)
    WHEN (hex(substr(chunk_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(chunk_blob) = 17)
      OR (hex(substr(chunk_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(chunk_blob) = 33)
    THEN (CASE hex(substr(chunk_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(chunk_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(chunk_blob, 2, 4))) || '-' || lower(hex(substr(chunk_blob, 6, 2))) || '-' || lower(hex(substr(chunk_blob, 8, 2))) || '-' || lower(hex(substr(chunk_blob, 10, 2))) || '-' || lower(hex(substr(chunk_blob, 12, 6))) ELSE lower(hex(substr(chunk_blob, 2))) END
    END AS chunk_row_id,
  CASE
    WHEN hex(substr(manifest_blob, 1, 1)) = '00' THEN CAST(substr(manifest_blob, 2) AS TEXT)
    WHEN (hex(substr(manifest_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(manifest_blob) = 17)
      OR (hex(substr(manifest_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(manifest_blob) = 33)
    THEN (CASE hex(substr(manifest_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(manifest_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(manifest_blob, 2, 4))) || '-' || lower(hex(substr(manifest_blob, 6, 2))) || '-' || lower(hex(substr(manifest_blob, 8, 2))) || '-' || lower(hex(substr(manifest_blob, 10, 2))) || '-' || lower(hex(substr(manifest_blob, 12, 6))) ELSE lower(hex(substr(manifest_blob, 2))) END
    END AS manifest_id,
  CASE stream_code WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' WHEN 3 THEN 'session' END AS stream,
  (CASE stream_code WHEN 1 THEN 'usage-event-' WHEN 2 THEN 'quota-observation-' WHEN 3 THEN 'session-dimension-' END) || CASE format_code WHEN 10 THEN 'v1.0' WHEN 11 THEN 'v1.1' END AS schema_version,
  CASE
    WHEN hex(substr(occurrence_blob, 1, 1)) = '00' THEN CAST(substr(occurrence_blob, 2) AS TEXT)
    WHEN (hex(substr(occurrence_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(occurrence_blob) = 17)
      OR (hex(substr(occurrence_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(occurrence_blob) = 33)
    THEN (CASE hex(substr(occurrence_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(occurrence_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(occurrence_blob, 2, 4))) || '-' || lower(hex(substr(occurrence_blob, 6, 2))) || '-' || lower(hex(substr(occurrence_blob, 8, 2))) || '-' || lower(hex(substr(occurrence_blob, 10, 2))) || '-' || lower(hex(substr(occurrence_blob, 12, 6))) ELSE lower(hex(substr(occurrence_blob, 2))) END
    END AS occurrence_id,
  observed_at_ms,
  CASE WHEN observed_at_ms IS NULL THEN NULL ELSE (CASE WHEN ot_year BETWEEN 0 AND 9999 THEN printf('%04d', ot_year) ELSE printf('%+07d', ot_year) END) || printf('-%02d-%02dT%02d:%02d:%02d.%03dZ', ot_mp + CASE WHEN ot_mp < 10 THEN 3 ELSE -9 END, ot_doy - (153 * ot_mp + 2) / 5 + 1, ((observed_at_ms % 86400000 + 86400000) % 86400000) / 3600000, ((observed_at_ms % 3600000 + 3600000) % 3600000) / 60000, ((observed_at_ms % 60000 + 60000) % 60000) / 1000, (observed_at_ms % 1000 + 1000) % 1000) END AS observed_at,
  date(observed_day_number * 86400, 'unixepoch') AS observed_day,
  date(chunk_day_number * 86400, 'unixepoch') AS chunk_day,
  provider,
  model_id,
  CASE WHEN stream_code = 3 THEN CASE
    WHEN hex(substr(occurrence_blob, 1, 1)) = '00' THEN CAST(substr(occurrence_blob, 2) AS TEXT)
    WHEN (hex(substr(occurrence_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(occurrence_blob) = 17)
      OR (hex(substr(occurrence_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(occurrence_blob) = 33)
    THEN (CASE hex(substr(occurrence_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(occurrence_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(occurrence_blob, 2, 4))) || '-' || lower(hex(substr(occurrence_blob, 6, 2))) || '-' || lower(hex(substr(occurrence_blob, 8, 2))) || '-' || lower(hex(substr(occurrence_blob, 10, 2))) || '-' || lower(hex(substr(occurrence_blob, 12, 6))) ELSE lower(hex(substr(occurrence_blob, 2))) END
    END ELSE CASE
    WHEN hex(substr(session_blob, 1, 1)) = '00' THEN CAST(substr(session_blob, 2) AS TEXT)
    WHEN (hex(substr(session_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(session_blob) = 17)
      OR (hex(substr(session_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(session_blob) = 33)
    THEN (CASE hex(substr(session_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(session_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(session_blob, 2, 4))) || '-' || lower(hex(substr(session_blob, 6, 2))) || '-' || lower(hex(substr(session_blob, 8, 2))) || '-' || lower(hex(substr(session_blob, 10, 2))) || '-' || lower(hex(substr(session_blob, 12, 6))) ELSE lower(hex(substr(session_blob, 2))) END
    END END AS session_uuid,
  speed_mode,
  api_service_tier,
  surface,
  billing_surface,
  reasoning_effort,
  agent_scope,
  outcome,
  total_input_context_tokens,
  input_uncached_tokens,
  input_cache_read_tokens,
  input_cache_write_tokens,
  output_text_tokens,
  output_reasoning_tokens,
  output_combined_tokens,
  plan_type,
  plan_variant,
  limit_id,
  slot,
  used_percent,
  window_duration_minutes,
  resets_at_ms,
  CASE WHEN resets_at_ms IS NULL THEN NULL ELSE (CASE WHEN rt_year BETWEEN 0 AND 9999 THEN printf('%04d', rt_year) ELSE printf('%+07d', rt_year) END) || printf('-%02d-%02dT%02d:%02d:%02d.%03dZ', rt_mp + CASE WHEN rt_mp < 10 THEN 3 ELSE -9 END, rt_doy - (153 * rt_mp + 2) / 5 + 1, ((resets_at_ms % 86400000 + 86400000) % 86400000) / 3600000, ((resets_at_ms % 3600000 + 3600000) % 3600000) / 60000, ((resets_at_ms % 60000 + 60000) % 60000) / 1000, (resets_at_ms % 1000 + 1000) % 1000) END AS resets_at,
  attribution_id,
  CASE account_basis_code WHEN 0 THEN 'unavailable' WHEN 1 THEN 'same_source' WHEN 2 THEN 'provisional_marker' END AS account_basis,
  CASE
    WHEN hex(substr(account_track_blob, 1, 1)) = '00' THEN CAST(substr(account_track_blob, 2) AS TEXT)
    WHEN (hex(substr(account_track_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(account_track_blob) = 17)
      OR (hex(substr(account_track_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(account_track_blob) = 33)
    THEN (CASE hex(substr(account_track_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(account_track_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(account_track_blob, 2, 4))) || '-' || lower(hex(substr(account_track_blob, 6, 2))) || '-' || lower(hex(substr(account_track_blob, 8, 2))) || '-' || lower(hex(substr(account_track_blob, 10, 2))) || '-' || lower(hex(substr(account_track_blob, 12, 6))) ELSE lower(hex(substr(account_track_blob, 2))) END
    END AS account_track_id,
  CASE plan_basis_code WHEN 0 THEN 'unavailable' WHEN 1 THEN 'same_source_occurrence' WHEN 2 THEN 'provisional_marker' WHEN 3 THEN 'conflicted' END AS plan_basis,
  attribution_plan_type,
  CASE
    WHEN hex(substr(plan_era_blob, 1, 1)) = '00' THEN CAST(substr(plan_era_blob, 2) AS TEXT)
    WHEN (hex(substr(plan_era_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(plan_era_blob) = 17)
      OR (hex(substr(plan_era_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(plan_era_blob) = 33)
    THEN (CASE hex(substr(plan_era_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(plan_era_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(plan_era_blob, 2, 4))) || '-' || lower(hex(substr(plan_era_blob, 6, 2))) || '-' || lower(hex(substr(plan_era_blob, 8, 2))) || '-' || lower(hex(substr(plan_era_blob, 10, 2))) || '-' || lower(hex(substr(plan_era_blob, 12, 6))) ELSE lower(hex(substr(plan_era_blob, 2))) END
    END AS plan_era_id,
  usage_record_id,
  quota_record_id,
  lower(hex(canonical_digest)) AS canonical_sha256,
  namespace_blob AS _namespace_blob,
  owner_blob AS _owner_blob,
  device_blob AS _device_blob,
  chunk_blob AS _chunk_blob,
  manifest_blob AS _manifest_blob,
  occurrence_blob AS _occurrence_blob,
  session_blob AS _session_blob,
  account_track_blob AS _account_track_blob,
  plan_era_blob AS _plan_era_blob
FROM civil;

-- Dynamic session keys stay typed child rows, with deterministic binary order.
CREATE VIEW typed_telemetry_compatibility_session_tools AS
SELECT r.id AS storage_row_id, r.namespace_id, r.owner_id, r.format AS format_code,
  r.source_row_id, d.value AS tool_class, t.count
FROM typed_telemetry_records r
JOIN typed_telemetry_session_tools t ON t.record_id = r.id
JOIN typed_telemetry_dictionary d ON d.id = t.tool_class_id
WHERE r.stream = 3;
