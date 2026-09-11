-- A staged day never displaces history. Only a complete, source-pinned domain
-- can become the analytical authority. No source rows are deleted by cutover.
CREATE TABLE telemetry_v11_domain_predecessors (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  previous_generation_id TEXT,
  legacy_fingerprint TEXT NOT NULL CHECK (length(legacy_fingerprint) = 64),
  input_revision INTEGER NOT NULL CHECK (input_revision >= 0),
  from_day TEXT NOT NULL CHECK (length(from_day) = 10),
  through_day TEXT NOT NULL CHECK (length(through_day) = 10 AND through_day >= from_day),
  winners_json TEXT NOT NULL CHECK (json_valid(winners_json) AND length(winners_json) <= 1250000),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;
CREATE INDEX telemetry_v11_predecessors_participant ON telemetry_v11_domain_predecessors(participant_id, device_id, expires_at);
CREATE INDEX telemetry_v11_predecessors_device ON telemetry_v11_domain_predecessors(device_id);

CREATE TABLE telemetry_v11_domains (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  predecessor_token_hash TEXT NOT NULL REFERENCES telemetry_v11_domain_predecessors(token_hash),
  previous_generation_id TEXT,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  legacy_fingerprint TEXT NOT NULL CHECK (length(legacy_fingerprint) = 64),
  input_revision INTEGER NOT NULL CHECK (input_revision >= 0),
  from_day TEXT NOT NULL,
  through_day TEXT NOT NULL CHECK (through_day >= from_day),
  days_json TEXT NOT NULL CHECK (json_valid(days_json) AND length(days_json) <= 1250000),
  created_at TEXT NOT NULL,
  UNIQUE(participant_id, device_id, manifest_digest)
) STRICT;
CREATE INDEX telemetry_v11_domains_participant ON telemetry_v11_domains(participant_id);
CREATE INDEX telemetry_v11_domains_export_cursor ON telemetry_v11_domains(participant_id, created_at, id);
CREATE INDEX telemetry_v11_domains_device ON telemetry_v11_domains(device_id);
CREATE INDEX telemetry_v11_domains_predecessor ON telemetry_v11_domains(predecessor_token_hash);

CREATE TABLE telemetry_v11_domain_days (
  generation_id TEXT NOT NULL REFERENCES telemetry_v11_domains(id) ON DELETE CASCADE,
  observed_day TEXT NOT NULL,
  manifest_id TEXT NOT NULL REFERENCES telemetry_v11_day_manifests(id) ON DELETE CASCADE,
  PRIMARY KEY(generation_id, observed_day),
  UNIQUE(generation_id, manifest_id)
) STRICT;
CREATE INDEX telemetry_v11_domain_days_manifest ON telemetry_v11_domain_days(manifest_id);

CREATE TABLE telemetry_v11_domain_heads (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL UNIQUE REFERENCES telemetry_v11_domains(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER telemetry_v11_domain_immutable BEFORE UPDATE ON telemetry_v11_domains
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_immutable'); END;
CREATE TRIGGER telemetry_v11_domain_days_immutable BEFORE UPDATE ON telemetry_v11_domain_days
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_immutable'); END;
CREATE TRIGGER telemetry_v11_predecessor_immutable
BEFORE UPDATE ON telemetry_v11_domain_predecessors
WHEN NEW.token_hash IS NOT OLD.token_hash OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_id IS NOT OLD.device_id OR NEW.previous_generation_id IS NOT OLD.previous_generation_id
  OR NEW.legacy_fingerprint IS NOT OLD.legacy_fingerprint OR NEW.input_revision IS NOT OLD.input_revision
  OR NEW.from_day IS NOT OLD.from_day OR NEW.through_day IS NOT OLD.through_day
  OR NEW.winners_json IS NOT OLD.winners_json OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_immutable'); END;

-- Device credentials and grant remain independently revocable while staging.
CREATE VIEW telemetry_v11_current_predecessors AS
SELECT x.* FROM telemetry_v11_domain_predecessors x
JOIN participants p ON p.id = x.participant_id AND p.state = 'active'
JOIN device_credentials c ON c.id = x.device_id AND c.participant_id = x.participant_id AND c.state = 'active'
JOIN telemetry_v11_device_consents grant_row ON grant_row.participant_id = x.participant_id AND grant_row.device_id = x.device_id
JOIN telemetry_transport_participant_floors floor_row ON floor_row.participant_id = x.participant_id AND floor_row.minimum_rank <= 11
JOIN telemetry_transport_formats format_row ON format_row.schema_version = 'telemetry-contribution-v1.1' AND format_row.lifecycle = 'accepted'
JOIN community_analytical_input_versions v ON v.participant_id = x.participant_id AND v.revision = x.input_revision
LEFT JOIN telemetry_v11_domain_heads h ON h.participant_id = x.participant_id
WHERE x.consumed_at IS NULL AND x.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  AND x.previous_generation_id IS h.generation_id;

CREATE TRIGGER telemetry_v11_domain_complete_before_insert
BEFORE INSERT ON telemetry_v11_domains
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v11_current_predecessors x
    WHERE x.token_hash = NEW.predecessor_token_hash AND x.participant_id = NEW.participant_id
      AND x.device_id = NEW.device_id AND x.previous_generation_id IS NEW.previous_generation_id
      AND x.legacy_fingerprint = NEW.legacy_fingerprint AND x.input_revision = NEW.input_revision
      AND x.from_day >= NEW.from_day AND x.through_day <= NEW.through_day
  ) THEN RAISE(ABORT, 'telemetry_domain_predecessor_changed') END);
  -- Journal-only bound before any record-level closure scan: at most 30,000
  -- chunks / 6,000,000 records, matching the legacy source-pin journal budget.
  SELECT (CASE WHEN (SELECT COALESCE(SUM(m.expected_chunk_count), 0)
    FROM json_each(NEW.days_json) e JOIN telemetry_v11_day_manifests m
      ON m.id = json_extract(e.value, '$.manifestId')) > 30000
    THEN RAISE(ABORT, 'telemetry_domain_range_too_large') END);
  SELECT (CASE WHEN json_array_length(NEW.days_json) NOT BETWEEN 1 AND 4096
    OR json_array_length(NEW.days_json) != CAST(julianday(NEW.through_day) - julianday(NEW.from_day) + 1 AS INTEGER)
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.days_json) e
      LEFT JOIN telemetry_v11_day_manifests m ON m.id = json_extract(e.value, '$.manifestId')
      WHERE json_extract(e.value, '$.day') IS NOT date(NEW.from_day, '+' || e.key || ' days')
        OR m.id IS NULL OR m.participant_id != NEW.participant_id OR m.device_id != NEW.device_id
        OR m.chunk_day != json_extract(e.value, '$.day') OR m.manifest_digest != json_extract(e.value, '$.manifestDigest')
        OR m.state != 'ready'
        OR m.expected_chunk_count != (SELECT count(*) FROM telemetry_v11_chunks c WHERE c.manifest_id = m.id)
        OR EXISTS (SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id = m.id
          AND c.record_count != (SELECT count(*) FROM telemetry_v11_records r WHERE r.chunk_id = c.id))
    ) THEN RAISE(ABORT, 'telemetry_domain_incomplete') END);
  SELECT (CASE WHEN EXISTS (
    SELECT r.stream, r.occurrence_id FROM json_each(NEW.days_json) e
    JOIN telemetry_v11_records r ON r.manifest_id = json_extract(e.value, '$.manifestId')
    GROUP BY r.stream, r.occurrence_id HAVING count(*) > 1
  ) THEN RAISE(ABORT, 'telemetry_domain_occurrence_conflict') END);
  -- Every legacy winning occurrence must survive with identical base semantics.
  -- A declared excluded count, equal row count, or same wire version is not proof.
  SELECT (CASE WHEN EXISTS (
    WITH candidate_days AS MATERIALIZED (
      SELECT json_extract(e.value, '$.day') AS day,
        json_extract(e.value, '$.manifestId') AS manifest_id FROM json_each(NEW.days_json) e
    ) SELECT 1 FROM telemetry_v1_records old_row
    JOIN telemetry_v11_domain_predecessors x ON x.token_hash = NEW.predecessor_token_hash
    LEFT JOIN candidate_days candidate ON candidate.day = old_row.observed_day
    WHERE old_row.participant_id = NEW.participant_id
      AND (old_row.participant_id, old_row.observed_day, old_row.device_id) IN (
        SELECT json_extract(w.value, '$[0]'), json_extract(w.value, '$[1]'), json_extract(w.value, '$[2]') FROM json_each(x.winners_json) w)
      AND (candidate.manifest_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM telemetry_v11_records new_row
        WHERE new_row.manifest_id = candidate.manifest_id
          AND new_row.stream = old_row.stream AND new_row.legacy_occurrence_id = old_row.occurrence_id
          AND new_row.legacy_record_json = old_row.record_json
      ))
  ) THEN RAISE(ABORT, 'telemetry_domain_compatibility_unproven') END);
  SELECT (CASE WHEN EXISTS (
    WITH candidate_days AS MATERIALIZED (
      SELECT json_extract(e.value, '$.day') AS day,
        json_extract(e.value, '$.manifestId') AS manifest_id FROM json_each(NEW.days_json) e
    ) SELECT 1 FROM telemetry_v11_domain_days previous_day
    JOIN telemetry_v11_records old_row ON old_row.manifest_id = previous_day.manifest_id
    LEFT JOIN candidate_days candidate ON candidate.day = previous_day.observed_day
    WHERE previous_day.generation_id = NEW.previous_generation_id AND (candidate.manifest_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM telemetry_v11_records new_row
      WHERE new_row.manifest_id = candidate.manifest_id
        AND new_row.stream = old_row.stream AND new_row.occurrence_id = old_row.occurrence_id
        AND json_remove(new_row.record_json, '$.accountPlanAttribution')
          = json_remove(old_row.record_json, '$.accountPlanAttribution')
    ))
  ) THEN RAISE(ABORT, 'telemetry_domain_compatibility_unproven') END);
  -- A domain head is participant-wide analytical authority, not a day-level
  -- overlay. Even disjoint v0.2 history would disappear at cutover without a
  -- reviewed semantic replacement proof. Preserve the old lane until then.
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM telemetry_contributions legacy
    WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
      AND legacy.transport_schema_version = 'telemetry-contribution-v0.2'
  ) THEN RAISE(ABORT, 'telemetry_domain_compatibility_unproven') END);
END;

CREATE TRIGGER telemetry_v11_domain_day_member BEFORE INSERT ON telemetry_v11_domain_days
WHEN NOT EXISTS (SELECT 1 FROM telemetry_v11_domains d, json_each(d.days_json) e
  WHERE d.id = NEW.generation_id AND json_extract(e.value, '$.day') = NEW.observed_day
    AND json_extract(e.value, '$.manifestId') = NEW.manifest_id)
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_incomplete'); END;

CREATE VIEW telemetry_v11_activatable_domains AS
SELECT d.* FROM telemetry_v11_domains d
JOIN telemetry_v11_current_predecessors x ON x.token_hash = d.predecessor_token_hash
WHERE (SELECT count(*) FROM telemetry_v11_domain_days day_row WHERE day_row.generation_id = d.id) = json_array_length(d.days_json);

CREATE TRIGGER telemetry_v11_head_insert_guard BEFORE INSERT ON telemetry_v11_domain_heads
WHEN NEW.revision != 1 OR NOT EXISTS (SELECT 1 FROM telemetry_v11_activatable_domains d
  WHERE d.id = NEW.generation_id AND d.participant_id = NEW.participant_id)
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_predecessor_changed'); END;
CREATE TRIGGER telemetry_v11_head_update_guard BEFORE UPDATE ON telemetry_v11_domain_heads
WHEN NEW.participant_id != OLD.participant_id OR NEW.revision != OLD.revision + 1
  OR NOT EXISTS (SELECT 1 FROM telemetry_v11_activatable_domains d
    WHERE d.id = NEW.generation_id AND d.participant_id = NEW.participant_id AND d.previous_generation_id = OLD.generation_id)
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_predecessor_changed'); END;

CREATE TRIGGER telemetry_v11_head_insert_publish AFTER INSERT ON telemetry_v11_domain_heads
BEGIN
  UPDATE telemetry_v11_domain_predecessors SET consumed_at = NEW.updated_at
    WHERE token_hash = (SELECT predecessor_token_hash FROM telemetry_v11_domains WHERE id = NEW.generation_id);
  UPDATE community_analytical_input_versions SET revision = revision + 1 WHERE participant_id = NEW.participant_id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  INSERT INTO community_daily_aggregate_rebuilds (day, requested_epoch, requested_at)
    SELECT observed_day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1), NEW.updated_at
    FROM telemetry_v11_domain_days WHERE generation_id = NEW.generation_id
    ON CONFLICT(day) DO UPDATE SET requested_epoch = excluded.requested_epoch, requested_at = excluded.requested_at;
END;
CREATE TRIGGER telemetry_v11_head_update_publish AFTER UPDATE ON telemetry_v11_domain_heads
BEGIN
  UPDATE telemetry_v11_domain_predecessors SET consumed_at = NEW.updated_at
    WHERE token_hash = (SELECT predecessor_token_hash FROM telemetry_v11_domains WHERE id = NEW.generation_id);
  UPDATE community_analytical_input_versions SET revision = revision + 1 WHERE participant_id = NEW.participant_id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  INSERT INTO community_daily_aggregate_rebuilds (day, requested_epoch, requested_at)
    SELECT observed_day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1), NEW.updated_at
    FROM telemetry_v11_domain_days WHERE generation_id = NEW.generation_id
    ON CONFLICT(day) DO UPDATE SET requested_epoch = excluded.requested_epoch, requested_at = excluded.requested_at;
END;

-- Owner deletion first withdraws the participant. Revocation/disconnect alone
-- deliberately does not erase accepted evidence or reset analytical authority.
CREATE TRIGGER telemetry_v11_active_domain_delete_guard BEFORE DELETE ON telemetry_v11_domains
WHEN EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h JOIN participants p ON p.id = h.participant_id
  WHERE h.generation_id = OLD.id AND p.state = 'active')
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_active'); END;
CREATE TRIGGER telemetry_v11_active_head_delete_guard BEFORE DELETE ON telemetry_v11_domain_heads
WHEN EXISTS (SELECT 1 FROM participants p WHERE p.id = OLD.participant_id AND p.state = 'active')
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_active'); END;
CREATE TRIGGER telemetry_v11_active_day_delete_guard BEFORE DELETE ON telemetry_v11_domain_days
WHEN EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h JOIN participants p ON p.id = h.participant_id
  WHERE h.generation_id = OLD.generation_id AND p.state = 'active')
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_active'); END;
CREATE TRIGGER telemetry_v11_active_record_delete_guard BEFORE DELETE ON telemetry_v11_records
WHEN EXISTS (SELECT 1 FROM telemetry_v11_domain_days day_row
  JOIN telemetry_v11_domain_heads h ON h.generation_id = day_row.generation_id
  JOIN participants p ON p.id = h.participant_id AND p.state = 'active'
  WHERE day_row.manifest_id = OLD.manifest_id)
BEGIN SELECT RAISE(ABORT, 'telemetry_domain_active'); END;

CREATE VIEW telemetry_v11_active_records AS
SELECT r.rowid AS id, r.chunk_id AS chunk_row_id, d.participant_id, d.device_id,
  r.stream, r.occurrence_id, r.observed_at, day_row.observed_day,
  json_extract(r.record_json, '$.provider') AS provider,
  json_extract(r.record_json, '$.modelId') AS model_id,
  json_extract(r.record_json, '$.sessionUuid') AS session_uuid,
  json_extract(r.record_json, '$.planType') AS plan_type,
  json_extract(r.record_json, '$.planVariant') AS plan_variant,
  json_extract(r.record_json, '$.limitId') AS limit_id,
  json_extract(r.record_json, '$.slot') AS slot,
  json_extract(r.record_json, '$.usedPercent') AS used_percent,
  json_extract(r.record_json, '$.windowDurationMinutes') AS window_duration_minutes,
  json_extract(r.record_json, '$.resetsAt') AS resets_at,
  json_extract(r.record_json, '$.components.inputUncachedTokens') AS input_uncached_tokens,
  json_extract(r.record_json, '$.components.inputCacheReadTokens') AS input_cache_read_tokens,
  json_extract(r.record_json, '$.components.inputCacheWriteTokens') AS input_cache_write_tokens,
  json_extract(r.record_json, '$.components.outputTextTokens') AS output_text_tokens,
  json_extract(r.record_json, '$.components.outputReasoningTokens') AS output_reasoning_tokens,
  json_extract(r.record_json, '$.components.outputCombinedTokens') AS output_combined_tokens,
  r.record_json, d.id AS generation_id
FROM telemetry_v11_domain_heads h
JOIN participants p ON p.id = h.participant_id AND p.state = 'active'
JOIN telemetry_v11_domains d ON d.id = h.generation_id
JOIN telemetry_v11_domain_days day_row ON day_row.generation_id = d.id
JOIN telemetry_v11_records r ON r.manifest_id = day_row.manifest_id;

CREATE VIEW telemetry_analytical_records AS
SELECT r.*, NULL AS generation_id FROM telemetry_v1_records r
WHERE NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h
  WHERE h.participant_id = r.participant_id)
UNION ALL SELECT * FROM telemetry_v11_active_records;

CREATE VIEW telemetry_analytical_chunks AS
SELECT c.id, c.participant_id, c.device_id, c.chunk_day, c.stream, c.revision,
  c.chunk_digest, c.parser_version, c.accepted_record_count, c.created_at
FROM telemetry_v1_chunks c WHERE c.superseded_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id = c.participant_id)
UNION ALL
SELECT c.id, d.participant_id, d.device_id, c.chunk_day, c.stream, 1 AS revision,
  c.chunk_digest, c.parser_version, c.record_count AS accepted_record_count, c.created_at
FROM telemetry_v11_domain_heads h JOIN telemetry_v11_domains d ON d.id = h.generation_id
JOIN telemetry_v11_domain_days day_row ON day_row.generation_id = d.id
JOIN telemetry_v11_chunks c ON c.manifest_id = day_row.manifest_id;

-- One pinned day/stream at a time supports a bounded, stable keyset seek. An
-- observed-time filter alone on the activated view otherwise rescans every
-- historical manifest and sorts the usage corpus again for each output page.
CREATE INDEX telemetry_v11_records_time_cursor
  ON telemetry_v11_records(manifest_id, stream, observed_at, occurrence_id);
