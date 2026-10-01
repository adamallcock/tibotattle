import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * D1 cannot drop NOT NULL from the social-only participant columns. Migration
 * 0058 therefore snapshots the complete participant/device descendant graph,
 * rebuilds both roots, then restores the graph while foreign keys are
 * deferred. This is intentionally a dense fixture: each participant-owned
 * table captured by the migration has a real structural row, including the
 * v1 and v1.1 journals, consumed receipts, domain head and public cache rows.
 */

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const SNAPSHOT_TABLES = [
  "participants",
  "attribution_enrollments",
  "community_aggregate_exclusions",
  "community_allowance_fit_cache",
  "community_analytical_input_versions",
  "community_model_composition_cache",
  "contributions",
  "device_credential_rotations",
  "device_credentials",
  "device_pairing_events",
  "device_pairings",
  "device_upload_authorizations",
  "enrollment_grants",
  "participant_community_eligibility",
  "recovery_retry_receipts",
  "telemetry_contribution_admission_windows",
  "telemetry_contribution_occurrences",
  "telemetry_contributions",
  "telemetry_records",
  "telemetry_transport_floor_rollbacks",
  "telemetry_transport_participant_floors",
  "telemetry_v11_chunks",
  "telemetry_v11_day_manifests",
  "telemetry_v11_device_consents",
  "telemetry_v11_domain_days",
  "telemetry_v11_domain_heads",
  "telemetry_v11_domain_predecessors",
  "telemetry_v11_domains",
  "telemetry_v11_records",
  "telemetry_v1_chunk_admission_windows",
  "telemetry_v1_chunks",
  "telemetry_v1_device_consents",
  "telemetry_v1_records",
  "upload_authorizations",
  "web_sessions",
  // Canonical production 0046–0056 descendants that are removed by the
  // participant-root cascade during 0058 and must be restored verbatim.
  "community_analysis_work",
  "community_analysis_work_parts",
  "community_analysis_work_stage",
  "community_current_analysis_queue",
  "community_graph_update_scope",
  "community_model_history_dependencies",
  "community_model_history_results",
  "community_model_history_work",
  "community_model_history_work_parts",
  "community_model_history_work_stage",
  "community_prepared_fit_rows",
  "community_prepared_plan_rows",
  "community_prepared_source_days",
  "community_prepared_usage_bins",
  "community_prepared_usage_rows",
  "community_publication_members",
  "telemetry_v1_quota_fit_rows",
  // These two canonical control rows do not cascade, so they prove that the
  // rebuild neither replays nor recalculates unrelated production state.
  "community_preparation_progress_counters",
  "community_publication_generation",
] as const;

const expectedCounts = Object.freeze({
  participants: 1,
  attribution_enrollments: 1,
  community_aggregate_exclusions: 1,
  community_allowance_fit_cache: 1,
  community_analytical_input_versions: 1,
  community_model_composition_cache: 1,
  contributions: 1,
  device_credential_rotations: 1,
  device_credentials: 1,
  device_pairing_events: 1,
  device_pairings: 1,
  device_upload_authorizations: 3,
  enrollment_grants: 1,
  participant_community_eligibility: 1,
  recovery_retry_receipts: 1,
  telemetry_contribution_admission_windows: 1,
  telemetry_contribution_occurrences: 1,
  telemetry_contributions: 1,
  telemetry_records: 1,
  telemetry_transport_floor_rollbacks: 1,
  telemetry_transport_participant_floors: 1,
  telemetry_v11_chunks: 1,
  telemetry_v11_day_manifests: 1,
  telemetry_v11_device_consents: 1,
  telemetry_v11_domain_days: 1,
  telemetry_v11_domain_heads: 1,
  telemetry_v11_domain_predecessors: 1,
  telemetry_v11_domains: 1,
  telemetry_v11_records: 1,
  telemetry_v1_chunk_admission_windows: 1,
  telemetry_v1_chunks: 1,
  telemetry_v1_device_consents: 1,
  telemetry_v1_records: 1,
  upload_authorizations: 1,
  web_sessions: 1,
  community_analysis_work: 1,
  community_analysis_work_parts: 1,
  community_analysis_work_stage: 1,
  community_current_analysis_queue: 1,
  community_graph_update_scope: 1,
  community_model_history_dependencies: 1,
  community_model_history_results: 1,
  community_model_history_work: 1,
  community_model_history_work_parts: 1,
  community_model_history_work_stage: 1,
  community_prepared_fit_rows: 1,
  community_prepared_plan_rows: 1,
  community_prepared_source_days: 1,
  community_prepared_usage_bins: 1,
  community_prepared_usage_rows: 1,
  community_publication_members: 1,
  telemetry_v1_quota_fit_rows: 1,
  community_preparation_progress_counters: 1,
  community_publication_generation: 1,
});

const SCALE_PARTICIPANT_COUNT = 10_000;
const SCALE_INSERT_BATCH_SIZE = 100;

// Every source index, trigger, and view is compared byte-for-byte below.
// These are the only deliberate schema-definition changes: the social-only
// device guard is replaced by the authority-shaped guard, the new accountless
// authority objects are added, v1.1/floor admission learns the direct
// accountless chain while retaining its social lane, and public publication
// mutations are explicitly constrained to social participants.
const EXPECTED_SCHEMA_DIFFERENCE = Object.freeze({
  added: [
    "index:accountless_upload_owners_active",
    "index:accountless_v11_device_authorizations_active",
    "trigger:accountless_device_credential_nonrenewable",
    "trigger:accountless_device_upload_authorization_admission",
    "trigger:accountless_device_upload_claim_admission",
    "trigger:accountless_participant_requires_ledger_revocation",
    "trigger:accountless_upload_owner_admission",
    "trigger:accountless_upload_owner_immutable",
    "trigger:accountless_v11_authorization_admission",
    "trigger:accountless_v11_authorization_immutable",
    "trigger:contributions_require_social_owner",
    "trigger:device_credentials_authority_shape_update",
    "trigger:device_credentials_require_valid_authority",
    "trigger:device_pairings_require_social_owner",
    "trigger:participant_community_eligibility_requires_social_owner",
    "trigger:participants_owner_shape_insert",
    "trigger:participants_owner_shape_update",
    "trigger:telemetry_contributions_require_social_owner",
    "trigger:telemetry_v11_predecessor_authority",
    "trigger:telemetry_v1_chunks_require_social_owner",
    "trigger:telemetry_v1_consent_requires_social_owner",
    "trigger:upload_authorizations_require_social_owner",
    "trigger:web_sessions_require_social_owner",
  ],
  changed: [
    "trigger:community_aggregate_exclusion_changed",
    "trigger:community_aggregate_exclusion_inserted",
    "trigger:community_analytical_input_legacy_delete",
    "trigger:community_analytical_input_legacy_insert",
    "trigger:community_analytical_input_legacy_update",
    "trigger:community_analytical_input_v1_delete",
    "trigger:community_analytical_input_v1_insert",
    "trigger:community_analytical_input_v1_update",
    "trigger:community_current_analysis_fit_delete",
    "trigger:community_current_analysis_fit_insert",
    "trigger:community_current_analysis_fit_update",
    "trigger:community_current_analysis_model_delete",
    "trigger:community_current_analysis_model_insert",
    "trigger:community_current_analysis_model_update",
    "trigger:community_current_analysis_revision_insert",
    "trigger:community_current_analysis_revision_update",
    "trigger:community_daily_aggregate_participant_withdrawal",
    "trigger:community_model_composition_day_withdrawal",
    "trigger:community_model_history_legacy_delete",
    "trigger:community_model_history_legacy_insert",
    "trigger:community_model_history_legacy_update",
    "trigger:community_model_history_participant_delete",
    "trigger:community_model_history_participant_state",
    "trigger:community_model_history_successor_delete",
    "trigger:community_model_history_successor_insert",
    "trigger:community_model_history_successor_update",
    "trigger:community_model_history_v1_delete",
    "trigger:community_model_history_v1_insert",
    "trigger:community_model_history_v1_update",
    "trigger:community_preparation_progress_delete",
    "trigger:community_preparation_progress_insert",
    "trigger:community_preparation_progress_update",
    "trigger:community_publication_fit_delete",
    "trigger:community_publication_fit_insert",
    "trigger:community_publication_fit_update",
    "trigger:community_publication_model_delete",
    "trigger:community_publication_model_insert",
    "trigger:community_publication_model_update",
    "trigger:community_refresh_fit_delete",
    "trigger:community_refresh_fit_insert",
    "trigger:community_refresh_fit_update",
    "trigger:community_refresh_model_delete",
    "trigger:community_refresh_model_insert",
    "trigger:community_refresh_model_update",
    "trigger:community_snapshot_contribution_deleting",
    "trigger:community_snapshot_contribution_direct_delete",
    "trigger:community_snapshot_participant_withdrawal",
    "trigger:telemetry_transport_floor_created",
    "trigger:telemetry_transport_rollback_owner_only",
    "trigger:telemetry_v11_chunk_admission",
    "trigger:telemetry_v11_consent_admission",
    "trigger:telemetry_v11_head_insert_publish",
    "trigger:telemetry_v11_head_update_publish",
    "trigger:telemetry_v11_manifest_admission",
    "trigger:telemetry_v1_chunks_enqueue_daily_rebuild",
    "view:telemetry_v11_current_predecessors",
  ],
  removed: ["trigger:device_credentials_require_active_pairing"],
});

function bindings(): TestBindings {
  return env as TestBindings;
}

function db(): D1Database {
  return bindings().USAGE_MONITOR_DB;
}

// This spec qualifies the historical rebuild, independently of later policy migrations.
function migrationsThrough0059(): D1Migration[] {
  return bindings().TEST_MIGRATIONS.filter(migration => migration.name < '0060');
}

function migrationsBefore0058(): D1Migration[] {
  const migrations = bindings().TEST_MIGRATIONS;
  const index = migrations.findIndex((migration) => migration.name.startsWith("0058"));
  expect(index).toBeGreaterThan(0);
  return migrations.slice(0, index);
}

function hash(fill: string): string {
  return fill.repeat(64);
}

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

interface SourceTableShape {
  readonly table: typeof SNAPSHOT_TABLES[number];
  readonly columns: readonly string[];
}

interface SchemaObject {
  readonly type: "table" | "index" | "trigger" | "view";
  readonly name: string;
  readonly table: string;
  readonly sql: string;
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function stableValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return `blob:${hex(new Uint8Array(value))}`;
  if (ArrayBuffer.isView(value)) {
    return `blob:${hex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}`;
  }
  return value;
}

async function sourceTableShapes(): Promise<readonly SourceTableShape[]> {
  return Promise.all(SNAPSHOT_TABLES.map(async (table) => {
    const columns = await db().prepare(`PRAGMA table_info(${quoted(table)})`).all<{
      cid: number;
      name: string;
    }>();
    return Object.freeze({
      table,
      columns: columns.results
        .sort((left, right) => left.cid - right.cid)
        .map((column) => column.name),
    });
  }));
}

async function sourceRows(shapes: readonly SourceTableShape[]): Promise<Record<string, unknown>> {
  const tables = await Promise.all(shapes.map(async ({ table, columns }) => {
    const projection = columns.map(quoted).join(", ");
    const rows = await db().prepare(
      `SELECT ${projection} FROM ${quoted(table)} ORDER BY ${projection}`,
    ).all<Record<string, unknown>>();
    return [table, rows.results.map((row) => Object.fromEntries(
      columns.map((column) => [column, stableValue(row[column])]),
    ))] as const;
  }));
  return Object.fromEntries(tables);
}

async function sourceSchemaObjects(): Promise<readonly SchemaObject[]> {
  const objects = await db().prepare(`
    SELECT type, name, tbl_name AS table_name, sql
      FROM sqlite_master
     WHERE type IN ('index', 'trigger', 'view')
       AND name NOT LIKE 'sqlite_autoindex%'
       AND sql IS NOT NULL
     ORDER BY type, name
  `).all<{
    type: SchemaObject["type"];
    name: string;
    table_name: string;
    sql: string;
  }>();
  return objects.results.map((object) => Object.freeze({
    type: object.type,
    name: object.name,
    table: object.table_name,
    sql: object.sql,
  }));
}

async function completeSchemaObjects(): Promise<readonly SchemaObject[]> {
  const objects = await db().prepare(`
    SELECT type, name, tbl_name AS table_name, sql
      FROM sqlite_master
     WHERE type IN ('table', 'index', 'trigger', 'view')
       AND name NOT LIKE 'sqlite_%'
       AND name != 'd1_migrations'
       AND sql IS NOT NULL
     ORDER BY type, name
  `).all<{
    type: SchemaObject["type"];
    name: string;
    table_name: string;
    sql: string;
  }>();
  return objects.results.map((object) => Object.freeze({
    type: object.type,
    name: object.name,
    table: object.table_name,
    sql: object.sql,
  }));
}

function schemaDifference(
  before: readonly SchemaObject[],
  after: readonly SchemaObject[],
): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const key = (object: SchemaObject): string => `${object.type}:${object.name}`;
  const prior = new Map(before.map((object) => [key(object), object]));
  const next = new Map(after.map((object) => [key(object), object]));
  return {
    added: [...next.keys()].filter((entry) => !prior.has(entry)).sort(),
    removed: [...prior.keys()].filter((entry) => !next.has(entry)).sort(),
    changed: [...prior.keys()].filter((entry) => {
      const oldObject = prior.get(entry);
      const newObject = next.get(entry);
      return oldObject !== undefined && newObject !== undefined
        && (oldObject.table !== newObject.table || oldObject.sql !== newObject.sql);
    }).sort(),
  };
}

function schemaByKey(objects: readonly SchemaObject[]): ReadonlyMap<string, SchemaObject> {
  return new Map(objects.map((object) => [`${object.type}:${object.name}`, object]));
}

async function sourceGraphCounts(): Promise<Record<string, number>> {
  const rows = await Promise.all(SNAPSHOT_TABLES.map(async (table) => {
    const count = await db().prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .first<{ count: number }>();
    return [table, count?.count ?? -1] as const;
  }));
  return Object.fromEntries(rows);
}

async function sourceGraphDigest(shapes: readonly SourceTableShape[]): Promise<string> {
  const rows = await sourceRows(shapes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(rows)),
  );
  return hex(new Uint8Array(digest));
}

async function seedSocialParticipantScale(count: number): Promise<void> {
  const now = "2026-09-01T12:00:00.000Z";
  for (let offset = 0; offset < count; offset += SCALE_INSERT_BATCH_SIZE) {
    const statements = [];
    const limit = Math.min(offset + SCALE_INSERT_BATCH_SIZE, count);
    for (let index = offset; index < limit; index += 1) {
      const participantId = `participant:scale:${index.toString().padStart(5, "0")}`;
      statements.push(db().prepare(`INSERT INTO participants (
        id, access_token_id, access_token_hash, recovery_token_id,
        recovery_token_hash, state, consent_version, consented_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 'privacy-safe-telemetry-v0.1', ?, ?)`)
        .bind(
          participantId,
          `access:scale:${index}`,
          bytes(index % 256),
          `recovery:scale:${index}`,
          bytes((index + 1) % 256),
          now,
          now,
        ));
    }
    await db().batch(statements);
  }
}

async function removeSourceTriggers(): Promise<void> {
  const triggers = await db().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).all<{ name: string }>();
  await db().batch(triggers.results.map(({ name }) => db().prepare(
    `DROP TRIGGER "${name.replaceAll('"', '""')}"`,
  )));
}

async function seedCompleteSocialGraph(): Promise<{
  participantId: string;
  deviceId: string;
  manifestId: string;
  domainId: string;
}> {
  const participantId = `participant:${crypto.randomUUID()}`;
  const sessionId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const pairingId = crypto.randomUUID();
  const grantId = `grant:${crypto.randomUUID()}`;
  const sessionUploadId = crypto.randomUUID();
  const telemetryUploadId = crypto.randomUUID();
  const v1UploadId = crypto.randomUUID();
  const v11UploadId = crypto.randomUUID();
  const contributionId = `contribution:${crypto.randomUUID()}`;
  const telemetryContributionId = `telemetry:${crypto.randomUUID()}`;
  const v1ChunkId = `v1chunk:${crypto.randomUUID()}`;
  const manifestId = crypto.randomUUID();
  const v11ChunkId = `chunk:${crypto.randomUUID()}`;
  const predecessorHash = hash("d");
  const domainId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const now = "2026-09-01T12:00:00.000Z";
  const future = "2027-09-01T12:00:00.000Z";
  const day = "2026-09-01";
  const manifestDigest = hash("a");
  const v11ChunkDigest = hash("b");
  const v11EnvelopeDigest = hash("c");
  const manifestJson = JSON.stringify({
    chunks: [{
      chunkId: `usage:${day}:0`,
      chunkDigest: v11ChunkDigest,
      recordCount: 1,
    }],
  });
  const daysJson = JSON.stringify([{
    day,
    manifestId,
    manifestDigest,
  }]);

  await db().batch([
    db().prepare(`INSERT INTO participants (
      id, access_token_id, access_token_hash, recovery_token_id,
      recovery_token_hash, state, consent_version, consented_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'active', 'privacy-safe-telemetry-v0.1', ?, ?)`)
      .bind(participantId, crypto.randomUUID(), bytes(1), crypto.randomUUID(), bytes(2), now, now),
    db().prepare(`INSERT INTO web_sessions (
      id, participant_id, secret_hash, csrf_hash, scope, state,
      issued_at, expires_at, last_used_at
    ) VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?)`)
      .bind(sessionId, participantId, bytes(3), bytes(4), now, future, now),
    db().prepare(`INSERT INTO device_pairings (
      id, participant_id, issued_by_session_id, secret_hash, consent_version,
      state, issued_at, expires_at, consumed_at, claimed_device_id,
      transport_consent_version
    ) VALUES (?, ?, ?, ?, 'ongoing-privacy-safe-telemetry-v1.0',
      'consumed', ?, ?, ?, ?, 'ongoing-privacy-safe-telemetry-v1.0')`)
      .bind(pairingId, participantId, sessionId, bytes(5), now, future, now, deviceId),
    db().prepare(`INSERT INTO device_credentials (
      id, participant_id, paired_via_pairing_id, secret_hash, state,
      issued_at, expires_at, last_used_at, social_verified_at,
      credential_generation
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 2)`)
      .bind(deviceId, participantId, pairingId, bytes(6), now, future, now, now),
    db().prepare(
      "INSERT INTO attribution_enrollments (participant_id, namespace, created_at) VALUES (?, ?, ?)",
    ).bind(participantId, hash("a"), now),
    db().prepare(`INSERT INTO community_aggregate_exclusions (
      exclusion_id, participant_id, scope, reason_code, state, effective_at,
      created_at, created_by_digest
    ) VALUES (?, ?, 'community_weekly', 'manual_review', 'active', ?, ?, ?)`)
      .bind(`exclude:${crypto.randomUUID()}`, participantId, now, now, hash("e")),
    db().prepare(`INSERT INTO community_allowance_fit_cache (
      participant_id, cache_key, fits_json, computed_at, model_observations_json,
      input_fingerprint, source_method_version
    ) VALUES (?, 'cache:full-graph', '[]', ?, '[]', ?, 'full-graph-v1')`)
      .bind(participantId, now, hash("f")),
    db().prepare(
      "INSERT INTO community_analytical_input_versions (participant_id, revision) VALUES (?, 5)",
    ).bind(participantId),
    db().prepare(`INSERT INTO community_model_composition_cache (
      participant_id, cache_key, composition_json, computed_at, input_fingerprint,
      source_method_version
    ) VALUES (?, 'composition:full-graph', '{}', ?, ?, 'full-graph-v1')`)
      .bind(participantId, now, hash("0")),
    db().prepare(`INSERT INTO enrollment_grants (
      id, secret_hash, state, issued_at, expires_at, redeemed_at,
      redeemed_participant_id
    ) VALUES (?, ?, 'redeemed', ?, ?, ?, ?)`)
      .bind(grantId, bytes(7), now, future, now, participantId),
    db().prepare(`INSERT INTO participant_community_eligibility (
      id, participant_id, grant_id, created_at
    ) VALUES (?, ?, ?, ?)`)
      .bind(`eligibility:${crypto.randomUUID()}`, participantId, grantId, now),
    db().prepare(`INSERT INTO device_credential_rotations (
      id, device_id, participant_id, prior_secret_hash, replacement_secret_hash,
      attempt_id, generation, rotated_at, retire_at, recovery_proof_hash
    ) VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, ?)`)
      .bind(crypto.randomUUID(), deviceId, participantId, bytes(8), bytes(9),
        crypto.randomUUID(), now, future, bytes(10)),
    db().prepare(`INSERT INTO device_pairing_events (
      id, pairing_id, participant_id, kind, occurred_at
    ) VALUES (?, ?, ?, 'claimed', ?)`)
      .bind(crypto.randomUUID(), pairingId, participantId, now),
    db().prepare(`INSERT INTO recovery_retry_receipts (
      old_recovery_token_id, old_recovery_token_hash, recovery_attempt_hash,
      participant_id, derivation_nonce, replacement_recovery_token_id,
      replacement_session_id, issued_at, expires_at, replay_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .bind(`old-recovery:${crypto.randomUUID()}`, bytes(11), bytes(12), participantId,
        "r".repeat(43), `replacement-recovery:${crypto.randomUUID()}`,
        sessionId, now, future),
    db().prepare(`INSERT INTO upload_authorizations (
      id, participant_id, issued_by_session_id, secret_hash, envelope_digest,
      body_bytes, content_type, state, issued_at, expires_at, consumed_at,
      consumed_contribution_id
    ) VALUES (?, ?, ?, ?, ?, 128, 'application/json', 'consumed', ?, ?, ?, ?)`)
      .bind(sessionUploadId, participantId, sessionId, bytes(13), hash("1"), now, future, now, contributionId),
    db().prepare(`INSERT INTO device_upload_authorizations (
      id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
      body_bytes, content_type, state, issued_at, expires_at, consumed_at,
      consumed_contribution_id
    ) VALUES (?, ?, ?, ?, ?, 128, 'application/json', 'consumed', ?, ?, ?, ?)`)
      .bind(telemetryUploadId, participantId, deviceId, bytes(14), hash("2"), now, future, now, telemetryContributionId),
    db().prepare(`INSERT INTO device_upload_authorizations (
      id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
      body_bytes, content_type, state, issued_at, expires_at, consumed_at,
      consumed_contribution_id
    ) VALUES (?, ?, ?, ?, ?, 128, 'application/json', 'consumed', ?, ?, ?, ?)`)
      .bind(v1UploadId, participantId, deviceId, bytes(15), hash("3"), now, future, now, v1ChunkId),
    db().prepare(`INSERT INTO device_upload_authorizations (
      id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
      body_bytes, content_type, state, issued_at, expires_at, consumed_at,
      consumed_contribution_id
    ) VALUES (?, ?, ?, ?, ?, 128, 'application/json', 'consumed', ?, ?, ?, ?)`)
      .bind(v11UploadId, participantId, deviceId, bytes(16), hash("4"), now, future, now, v11ChunkId),
    db().prepare(`INSERT INTO contributions (
      id, participant_id, envelope_digest, r2_key, envelope_schema_version,
      key_id, status, fixture_id, range_start, range_end, quota_window_minutes,
      quota_used_percent_before, quota_used_percent_after, quota_display_precision,
      model_id, subscription_speed, api_tier_assumption, input_uncached_tokens,
      input_cached_tokens, output_text_tokens, output_reasoning_tokens,
      web_search_calls, unknown_tool_units, estimated_api_cost_usd,
      priced_event_coverage_percent, unknown_billable_units, price_basis,
      created_at, upload_authorization_id
    ) VALUES (?, ?, ?, 'synthetic/full-graph', 'telemetry-envelope-v0.1',
      'key:full-graph', 'accepted_synthetic', 'full-graph', ?, ?, 60, 10, 20,
      1, 'gpt-5.6-sol', 'standard', 'default', 100, 0, 50, 25, 0, 0,
      '0.01', 100, 0, 'current', ?, ?)`)
      .bind(contributionId, participantId, hash("5"), now, now, now, sessionUploadId),
    db().prepare(`INSERT INTO telemetry_contributions (
      id, participant_id, plaintext_digest, envelope_digest, r2_key, status,
      schema_version, range_start, range_end, client_platform,
      provider_policy_epoch, priced_event_coverage_percent,
      unknown_model_event_count, unknown_billable_units, price_basis,
      declared_record_count, created_at, device_upload_authorization_id,
      transport_schema_version
    ) VALUES (?, ?, ?, ?, 'telemetry/full-graph', 'accepted',
      'telemetry-contribution-v0.1', ?, ?, 'macos', 'full-graph', 100, 0, 0,
      'unavailable', 1, ?, ?, 'telemetry-contribution-v0.1')`)
      .bind(telemetryContributionId, participantId, hash("6"), hash("7"), now, now, now, telemetryUploadId),
    db().prepare(`INSERT INTO telemetry_records (
      id, origin_contribution_id, participant_id, record_kind, occurrence_id,
      observed_at, provider, model_id, record_json
    ) VALUES (41, ?, ?, 'usage', 'legacy-record:full-graph', ?,
      'openai_codex', 'gpt-5.6-sol', '{}')`)
      .bind(telemetryContributionId, participantId, now),
    db().prepare(`INSERT INTO telemetry_contribution_occurrences (
      contribution_id, participant_id, record_kind, occurrence_id, dataset_id,
      account_track_id, policy_epoch
    ) VALUES (?, ?, 'usage', 'legacy-record:full-graph', NULL, 'unattributed', NULL)`)
      .bind(telemetryContributionId, participantId),
    db().prepare(`INSERT INTO telemetry_contribution_admission_windows (
      participant_id, window_started_at, accepted_count, last_accepted_at
    ) VALUES (?, ?, 1, ?)`)
      .bind(participantId, now, now),
    db().prepare(`INSERT INTO telemetry_transport_participant_floors (
      participant_id, minimum_rank, revision, changed_at
    ) VALUES (?, 11, 2, ?)`)
      .bind(participantId, now),
    db().prepare(`INSERT INTO telemetry_v1_device_consents (
      participant_id, device_id, telemetry_schema_version, field_dictionary_version,
      privacy_contract_version, consented_at
    ) VALUES (?, ?, 'telemetry-contribution-v1.0', 'full-graph-v1',
      'ongoing-privacy-safe-telemetry-v1.0', ?)`)
      .bind(participantId, deviceId, now),
    db().prepare(`INSERT INTO telemetry_v1_chunks (
      id, participant_id, device_id, stream, chunk_day, chunk_seq, revision,
      chunk_digest, envelope_digest, parser_version, record_count,
      accepted_record_count, r2_key, device_upload_authorization_id, created_at
    ) VALUES (?, ?, ?, 'usage', ?, 0, 1, ?, ?, 'full-graph-v1', 1, 1,
      'v1/full-graph', ?, ?)`)
      .bind(v1ChunkId, participantId, deviceId, day, hash("8"), hash("9"), v1UploadId, now),
    db().prepare(`INSERT INTO telemetry_v1_records (
      id, chunk_row_id, participant_id, device_id, stream, occurrence_id,
      observed_at, observed_day, provider, model_id, input_uncached_tokens,
      output_text_tokens, output_reasoning_tokens, record_json
    ) VALUES (88, ?, ?, ?, 'usage', 'v1-record:full-graph', ?, ?,
      'openai_codex', 'gpt-5.6-sol', 100, 50, 25, '{}')`)
      .bind(v1ChunkId, participantId, deviceId, now, day),
    db().prepare(`INSERT INTO telemetry_v1_chunk_admission_windows (
      participant_id, device_id, window_day, accepted_count, last_accepted_at
    ) VALUES (?, ?, ?, 1, ?)`)
      .bind(participantId, deviceId, day, now),
    db().prepare(`INSERT INTO telemetry_v11_device_consents (
      participant_id, device_id, telemetry_schema_version, field_dictionary_version,
      privacy_contract_version, consented_at
    ) VALUES (?, ?, 'telemetry-contribution-v1.1',
      'telemetry-v1.1-registry-2026-08-31.1',
      'ongoing-privacy-safe-telemetry-v1.1', ?)`)
      .bind(participantId, deviceId, now),
    db().prepare(`INSERT INTO telemetry_v11_day_manifests (
      id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
      manifest_json, expected_chunk_count, state, created_at, ready_at
    ) VALUES (?, ?, ?, ?, ?, 'full-graph-v11', ?, 1, 'ready', ?, ?)`)
      .bind(manifestId, participantId, deviceId, day, manifestDigest, manifestJson, now, now),
    db().prepare(`INSERT INTO telemetry_v11_chunks (
      id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq,
      chunk_id, chunk_digest, envelope_digest, parser_version, record_count,
      r2_key, device_upload_authorization_id, created_at
    ) VALUES (?, ?, ?, ?, 'usage', ?, 0, ?, ?, ?, 'full-graph-v11', 1,
      'v11/full-graph', ?, ?)`)
      .bind(v11ChunkId, manifestId, participantId, deviceId, day,
        `usage:${day}:0`, v11ChunkDigest, v11EnvelopeDigest, v11UploadId, now),
    db().prepare(`INSERT INTO telemetry_v11_records (
      chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json,
      legacy_occurrence_id, legacy_record_json
    ) VALUES (?, ?, 'usage', 'v11-record:full-graph', ?, '{}', NULL, NULL)`)
      .bind(v11ChunkId, manifestId, now),
    db().prepare(`INSERT INTO telemetry_v11_domain_predecessors (
      token_hash, participant_id, device_id, previous_generation_id,
      legacy_fingerprint, input_revision, from_day, through_day, winners_json,
      created_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, NULL, ?, 5, ?, ?, '[]', ?, ?, ?)`)
      .bind(predecessorHash, participantId, deviceId, hash("e"), day, day, now, future, now),
    db().prepare(`INSERT INTO telemetry_v11_domains (
      id, participant_id, device_id, predecessor_token_hash,
      previous_generation_id, manifest_digest, legacy_fingerprint,
      input_revision, from_day, through_day, days_json, created_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, 5, ?, ?, ?, ?)`)
      .bind(domainId, participantId, deviceId, predecessorHash, hash("f"), hash("e"),
        day, day, daysJson, now),
    db().prepare(`INSERT INTO telemetry_v11_domain_days (
      generation_id, observed_day, manifest_id
    ) VALUES (?, ?, ?)`)
      .bind(domainId, day, manifestId),
    db().prepare(`INSERT INTO telemetry_v11_domain_heads (
      participant_id, generation_id, revision, updated_at
    ) VALUES (?, ?, 1, ?)`)
      .bind(participantId, domainId, now),
    db().prepare(`INSERT INTO admin_action_audit (
      operation_id, action, actor_identity_digest, outcome, details_json, created_at
    ) VALUES (?, 'run_maintenance', ?, 'started', '{}', ?)`)
      .bind(operationId, hash("f"), now),
    db().prepare(`INSERT INTO telemetry_transport_floor_rollbacks (
      operation_id, participant_id, participant_digest, expected_revision,
      from_rank, to_rank, created_at
    ) VALUES (?, ?, ?, 1, 11, 10, ?)`)
      .bind(operationId, participantId, hash("0"), now),
  ]);
  return { participantId, deviceId, manifestId, domainId };
}

/** Seed every canonical 0046–0056 descendant whose rows a participant-root
 * rebuild can erase. Source triggers are intentionally absent in this
 * migration-rehearsal fixture, so these rows prove 0058's explicit snapshots,
 * not normal scheduler side effects. */
async function seedCanonicalPrefixRows(fixture: {
  participantId: string;
  deviceId: string;
}): Promise<void> {
  const now = "2026-09-01T12:00:00.000Z";
  const day = "2026-09-01";
  const fingerprint = hash("a");
  const generation = "11111111-1111-1111-1111-111111111111";
  const checkpoint = (table: "community_analysis_work" | "community_model_history_work") => [
    db().prepare(`INSERT INTO ${table} (
      participant_id,run_id,input_revision,input_fingerprint,source_kind,
      source_method_version,fixed_now,observed_at_cutoff,resets_at_cutoff,
      window_minutes,max_quota_rows,phase,progress_revision,control_json,
      manifest_json,state_sha256,reader_policy
    ) VALUES (?, 'canonical-run', 1, ?, 'v1', 'canonical-method', ?, ?, ?,
      10080, 60000, 'plan', 3, '{}', '[]', ?, 'prepared-source-days-1')`)
      .bind(fixture.participantId, fingerprint, now, now, now, fingerprint),
    db().prepare(`INSERT INTO ${table}_parts
      (participant_id,run_id,component,payload_json,payload_sha256,payload_bytes)
      VALUES (?, 'canonical-run', 'plan-anchors', '[]', ?, 2)`)
      .bind(fixture.participantId, fingerprint),
    db().prepare(`INSERT INTO ${table}_stage
      (participant_id,run_id,stage_id,base_progress_revision,stage_revision,
       mode,target_phase,target_control_json,target_manifest_json,
       write_manifest_json,target_state_sha256,replay_json,write_offset,
       verified_offset,gc_component,gc_sha256,discard_input_revision,state_sha256)
      VALUES (?, 'canonical-run', 'canonical-stage', 0, 0, 'writing', 'plan',
       '{}', '[]', '[]', ?, '{}', 0, 0, '', '', NULL, ?)`)
      .bind(fixture.participantId, fingerprint, fingerprint),
  ];
  await db().batch([
    ...checkpoint("community_analysis_work"),
    ...checkpoint("community_model_history_work"),
    db().prepare(`INSERT INTO community_current_analysis_queue
      (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
      VALUES (?, 1, 0, 1, 0)`).bind(fixture.participantId),
    db().prepare(`INSERT INTO community_graph_update_scope
      (singleton,participant_id,device_id,stream,chunk_day,chunk_seq,old_chunk_id,
       new_chunk_id,new_revision,chunk_digest,parser_version,record_count,
       authorization_id,envelope_digest,created_at,expected_epoch,phase)
      VALUES (1, ?, ?, 'quota', ?, 0, NULL, 'canonical-new-chunk', 1, ?,
        'canonical-parser', 1, 'canonical-authority', ?, ?, 1, 'insert')`)
      .bind(fixture.participantId, fixture.deviceId, day, fingerprint, fingerprint, now),
    db().prepare(`INSERT INTO community_model_history_dependencies
      (participant_id,day,from_day,dependency_revision,input_fingerprint,verified_input_revision)
      VALUES (?, ?, '2026-05-24', 1, ?, 1)`)
      .bind(fixture.participantId, day, fingerprint),
    db().prepare(`INSERT INTO community_model_history_results
      (participant_id,day,input_revision,input_fingerprint,method_version,result_json,computed_at,dependency_revision)
      VALUES (?, ?, 1, ?, 'canonical-method', '{}', ?, 1)`)
      .bind(fixture.participantId, day, fingerprint, now),
    db().prepare(`INSERT INTO community_prepared_source_days
      (participant_id,source_day,generation,source_fingerprint,method_version,
       device_id,phase,progress_revision,cursor_time,cursor_id,quota_count,
       usage_count,plan_count,fit_count,fragment_count,control_json,control_sha256)
      VALUES (?, ?, ?, ?, 'canonical-method', ?, 'complete', 1, ?, 1, 1, 1,
       1, 1, 1, '{}', ?)`)
      .bind(fixture.participantId, day, fingerprint, fingerprint, fixture.deviceId, now, fingerprint),
    db().prepare(`INSERT INTO community_prepared_fit_rows
      (participant_id,source_day,generation,id,observed_at,device_id,provider,
       limit_id,plan_type,plan_variant,occurrence_id,slot,used_percent,
       window_duration_minutes,resets_at)
      VALUES (?, ?, ?, 1, ?, ?, 'openai_codex', 'codex', 'pro', 'default',
       'canonical-quota', 'primary', 10, 10080, ?)`)
      .bind(fixture.participantId, day, fingerprint, now, fixture.deviceId, now),
    db().prepare(`INSERT INTO community_prepared_plan_rows
      (participant_id,source_day,generation,id,observed_at,device_id,provider,
       limit_id,plan_type,plan_variant)
      VALUES (?, ?, ?, 1, ?, ?, 'openai_codex', 'codex', 'pro', 'default')`)
      .bind(fixture.participantId, day, fingerprint, now, fixture.deviceId),
    db().prepare(`INSERT INTO community_prepared_usage_bins
      (participant_id,source_day,generation,id,observed_at,payload_json,payload_sha256)
      VALUES (?, ?, ?, 1, ?, '[]', ?)`)
      .bind(fixture.participantId, day, fingerprint, now, fingerprint),
    db().prepare(`INSERT INTO community_prepared_usage_rows
      (participant_id,source_day,generation,id,observed_at,occurrence_id,provider,
       session_uuid,cost_nanousd,pricing_status,model_id)
      VALUES (?, ?, ?, 1, ?, 'canonical-usage', 'openai_codex', NULL, 1,
       'fully_priced', 'gpt-5.6-sol')`)
      .bind(fixture.participantId, day, fingerprint, now),
    db().prepare(`INSERT INTO community_publication_generation
      (singleton,generation,utc_day,from_day,method_version,source_epoch,
       hard_epoch,cache_revision,membership_watermark,capture_cursor,load_cursor,
       phase,published,member_count,prepared_count,payload_bytes,progress_revision,created_at)
      VALUES (1, ?, ?, '2026-05-24', 'canonical-method', 1, 1, 1, 1, 0, 0,
       'capturing', 0, 1, 0, 0, 0, ?)`)
      .bind(generation, day, now),
    db().prepare(`INSERT INTO community_publication_members
      (generation,member_id,participant_id,minimum_revision,source,
       composition_supported,selected_revision,fit_fingerprint,
       composition_fingerprint,fits_json,composition_json,payload_bytes)
      VALUES (?, 1, ?, 1, 'v1', 1, NULL, NULL, NULL, NULL, NULL, 0)`)
      .bind(generation, fixture.participantId),
    db().prepare(`INSERT INTO telemetry_v1_quota_fit_rows
      (record_id,participant_id,resets_at,observed_at)
      VALUES (88, ?, '2026-09-08T12:00:00.000Z', ?)`)
      .bind(fixture.participantId, now),
  ]);
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    bindings().DELETION_LEDGER,
    bindings().TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("migration 0058 accountless owner rebuild", () => {
  it("uses one canonical active lineage and gives fresh installs the production-0056 final schema", async () => {
    const activeNames = bindings().TEST_MIGRATIONS.map((migration) => migration.name);
    expect(activeNames).toContain("0046_v1_quota_fit_projection.sql");
    expect(activeNames).toContain("0057_accountless_enrollment_ledger.sql");
    expect(activeNames).toContain("0058_accountless_upload_ownership.sql");
    expect(activeNames).toContain("0059_accountless_upload_renewal.sql");
    expect(activeNames).not.toContain("0046_accountless_enrollment_ledger.sql");
    expect(activeNames).not.toContain("0047_accountless_upload_ownership.sql");
    expect(activeNames).not.toContain("0048_accountless_upload_renewal.sql");

    await applyD1Migrations(db(), migrationsThrough0059());
    const freshSchema = await completeSchemaObjects();
    await reset();
    await applyD1Migrations(db(), migrationsBefore0058());
    await applyD1Migrations(db(), migrationsThrough0059());
    expect(await completeSchemaObjects()).toEqual(freshSchema);
    expect((await db().prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("preserves every preexisting social participant/device descendant and rebuilds its source graph", async () => {
    await applyD1Migrations(db(), migrationsBefore0058());
    const preMigrationObjects = await sourceSchemaObjects();
    // The old source guards are tested elsewhere. Removing them here lets one
    // fixture exercise every historical child table simultaneously; 0058 must
    // recreate the complete source graph after restoring these typed rows.
    await removeSourceTriggers();
    const fixture = await seedCompleteSocialGraph();
    await seedCanonicalPrefixRows(fixture);
    const preMigrationShapes = await sourceTableShapes();
    const preMigrationRows = await sourceRows(preMigrationShapes);
    expect(await sourceGraphCounts()).toEqual(expectedCounts);

    await applyD1Migrations(db(), migrationsThrough0059());
    expect(await sourceGraphCounts()).toEqual(expectedCounts);
    expect(await sourceRows(preMigrationShapes)).toEqual(preMigrationRows);
    const foreignKeys = await db().prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeys.results).toEqual([]);

    const restoredRoot = await db().prepare(`
      SELECT p.owner_kind, p.access_token_id IS NOT NULL AS has_access_token,
             p.recovery_token_id IS NOT NULL AS has_recovery_token,
             p.consent_version, d.authority_kind, d.paired_via_pairing_id,
             d.accountless_enrollment_device_id, d.social_verified_at,
             floors.minimum_rank
        FROM participants p
        JOIN device_credentials d ON d.participant_id = p.id
        JOIN telemetry_transport_participant_floors floors ON floors.participant_id = p.id
       WHERE p.id = ? AND d.id = ?
    `).bind(fixture.participantId, fixture.deviceId).first<{
      owner_kind: string;
      has_access_token: number;
      has_recovery_token: number;
      consent_version: string | null;
      authority_kind: string;
      paired_via_pairing_id: string | null;
      accountless_enrollment_device_id: string | null;
      social_verified_at: string | null;
      minimum_rank: number;
    }>();
    expect(restoredRoot).toMatchObject({
      owner_kind: "social",
      has_access_token: 1,
      has_recovery_token: 1,
      consent_version: "privacy-safe-telemetry-v0.1",
      authority_kind: "social",
      accountless_enrollment_device_id: null,
      minimum_rank: 11,
    });
    expect(restoredRoot?.paired_via_pairing_id).toEqual(expect.any(String));
    expect(restoredRoot?.social_verified_at).toEqual(expect.any(String));

    expect((await db().prepare(`
      SELECT COUNT(*) AS count FROM telemetry_v11_active_records
       WHERE participant_id = ? AND generation_id = ?
    `).bind(fixture.participantId, fixture.domainId).first<{ count: number }>())?.count).toBe(1);
    expect((await db().prepare(`
      SELECT COUNT(*) AS count FROM telemetry_analytical_records
       WHERE participant_id = ?
    `).bind(fixture.participantId).first<{ count: number }>())?.count).toBe(1);

    const savedTables = await db().prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE '%_0058_save'
    `).all<{ name: string }>();
    expect(savedTables.results).toEqual([]);
    const sourceObjects = await db().prepare(`
      SELECT type, name FROM sqlite_master
       WHERE (type = 'trigger' AND name IN (
         'participants_owner_shape_insert',
         'device_credentials_require_valid_authority',
         'telemetry_v11_manifest_admission',
         'accountless_device_upload_authorization_admission'
       )) OR (type = 'view' AND name IN (
         'telemetry_analytical_records', 'telemetry_v11_active_records',
         'telemetry_v11_current_predecessors'
       ))
       ORDER BY type, name
    `).all<{ type: string; name: string }>();
    expect(sourceObjects.results).toEqual([
      { type: "trigger", name: "accountless_device_upload_authorization_admission" },
      { type: "trigger", name: "device_credentials_require_valid_authority" },
      { type: "trigger", name: "participants_owner_shape_insert" },
      { type: "trigger", name: "telemetry_v11_manifest_admission" },
      { type: "view", name: "telemetry_analytical_records" },
      { type: "view", name: "telemetry_v11_active_records" },
      { type: "view", name: "telemetry_v11_current_predecessors" },
    ]);
    const postMigrationObjects = await sourceSchemaObjects();
    expect(schemaDifference(preMigrationObjects, postMigrationObjects))
      .toEqual(EXPECTED_SCHEMA_DIFFERENCE);
    const schema = schemaByKey(postMigrationObjects);
    expect(schema.get("trigger:device_credentials_require_valid_authority")?.sql)
      .toContain("accountless_enrollment_ledger");
    expect(schema.get("trigger:device_credentials_require_valid_authority")?.sql)
      .toContain("authority_kind = 'accountless'");
    expect(schema.get("trigger:telemetry_transport_floor_created")?.sql)
      .toContain("CASE WHEN NEW.owner_kind = 'accountless' THEN 11 ELSE 1 END");
    expect(schema.get("trigger:telemetry_transport_rollback_owner_only")?.sql)
      .toContain("p.owner_kind = 'social'");
    expect(schema.get("trigger:telemetry_v11_consent_admission")?.sql)
      .toContain("p.owner_kind = 'social'");
    for (const name of [
      "trigger:community_daily_aggregate_participant_withdrawal",
      "trigger:community_snapshot_participant_withdrawal",
      "trigger:telemetry_v11_head_insert_publish",
    ]) {
      expect(schema.get(name)?.sql).toContain("owner_kind = 'social'");
    }
    // 0058 restores the canonical 0046–0056 state after rebuilding the two
    // root tables. These public scheduler/publication triggers intentionally
    // gain a social-owner gate: accountless analytical evidence remains
    // private until a separate public-eligibility decision exists.
    for (const name of [
      "trigger:community_analytical_input_v1_insert",
      "trigger:community_current_analysis_revision_insert",
      "trigger:community_current_analysis_fit_insert",
      "trigger:community_publication_fit_insert",
      "trigger:community_refresh_fit_insert",
      "trigger:community_preparation_progress_insert",
    ]) {
      expect(schema.get(name)?.sql).toContain("owner_kind='social'");
    }
    for (const name of [
      "trigger:telemetry_v11_chunk_admission",
      "trigger:telemetry_v11_manifest_admission",
      "view:telemetry_v11_current_predecessors",
    ]) {
      expect(schema.get(name)?.sql).toContain("accountless_v11_device_authorizations");
      expect(schema.get(name)?.sql).toContain("p.owner_kind = 'social'");
      expect(schema.get(name)?.sql).toContain("p.owner_kind = 'accountless'");
    }
  });

  it("rehearses production 0056 to 0058 with a 10,000-participant social graph", { timeout: 120_000 }, async () => {
    const startedAt = Date.now();
    let result = "failed";
    try {
      await applyD1Migrations(db(), migrationsBefore0058());
      // The scale fixture intentionally uses the same complete descendant
      // shape as the focused preservation test, while keeping only one
      // representative linked device/session/upload/chunk graph. The other
      // rows exercise the participant-root rebuild at migration scale.
      await removeSourceTriggers();
      await seedSocialParticipantScale(SCALE_PARTICIPANT_COUNT);
      const fixture = await seedCompleteSocialGraph();
      await seedCanonicalPrefixRows(fixture);
      const preMigrationShapes = await sourceTableShapes();
      const expectedScaleCounts = {
        ...expectedCounts,
        participants: SCALE_PARTICIPANT_COUNT + 1,
      };
      const preMigrationCounts = await sourceGraphCounts();
      expect(preMigrationCounts).toEqual(expectedScaleCounts);
      const preMigrationDigest = await sourceGraphDigest(preMigrationShapes);

      await applyD1Migrations(db(), migrationsThrough0059());

      expect(await sourceGraphCounts()).toEqual(preMigrationCounts);
      expect(await sourceGraphDigest(preMigrationShapes)).toBe(preMigrationDigest);
      expect((await db().prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

      const representativeCounts = await db().prepare(`
        SELECT
          (SELECT COUNT(*) FROM web_sessions WHERE participant_id = p.id) AS web_sessions,
          (SELECT COUNT(*) FROM device_credentials WHERE participant_id = p.id) AS device_credentials,
          (SELECT COUNT(*) FROM upload_authorizations WHERE participant_id = p.id) AS upload_authorizations,
          (SELECT COUNT(*) FROM device_upload_authorizations WHERE participant_id = p.id) AS device_upload_authorizations,
          (SELECT COUNT(*) FROM telemetry_v1_chunks WHERE participant_id = p.id) AS telemetry_v1_chunks,
          (SELECT COUNT(*) FROM telemetry_v11_chunks WHERE participant_id = p.id) AS telemetry_v11_chunks
          FROM participants p
         WHERE p.id = ?
      `).bind(fixture.participantId).first<{
        web_sessions: number;
        device_credentials: number;
        upload_authorizations: number;
        device_upload_authorizations: number;
        telemetry_v1_chunks: number;
        telemetry_v11_chunks: number;
      }>();
      expect(representativeCounts).toEqual({
        web_sessions: 1,
        device_credentials: 1,
        upload_authorizations: 1,
        device_upload_authorizations: 3,
        telemetry_v1_chunks: 1,
        telemetry_v11_chunks: 1,
      });

      const savedTables = await db().prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE '%_0058_save'
      `).all<{ name: string }>();
      expect(savedTables.results).toEqual([]);

      const restoredRoot = await db().prepare(`
        SELECT p.owner_kind, d.authority_kind, d.paired_via_pairing_id,
               d.accountless_enrollment_device_id
          FROM participants p
          JOIN device_credentials d ON d.participant_id = p.id
         WHERE p.id = ? AND d.id = ?
      `).bind(fixture.participantId, fixture.deviceId).first<{
        owner_kind: string;
        authority_kind: string;
        paired_via_pairing_id: string | null;
        accountless_enrollment_device_id: string | null;
      }>();
      expect(restoredRoot).toMatchObject({
        owner_kind: "social",
        authority_kind: "social",
        accountless_enrollment_device_id: null,
      });
      expect(restoredRoot?.paired_via_pairing_id).toEqual(expect.any(String));
      result = "pass";
    } finally {
      console.info(
        `[migration-0058-scale] result=${result} participants=${SCALE_PARTICIPANT_COUNT + 1} elapsed_ms=${Date.now() - startedAt}`,
      );
    }
  });
});
