/**
 * Synthetic, content-free fixtures for the accountless performance intake and
 * its community publication heads (primary 0079_performance_telemetry.sql).
 *
 * Shared, unchanged, by the PostgreSQL 17 specs of the performance build
 * (schema, policy, reports, activation, publication, admin, host and ops). The
 * helpers write through the live guards of the promoted primary chain, into
 * one schema named by the caller; every table name is schema-qualified, so no
 * helper depends on the session search_path.
 *
 * Every identifier is a fresh random UUID or a digest of a constant label;
 * every secret hash is random bytes. No path, prompt, response, session
 * content, account identifier or credential appears anywhere. Instants are
 * written at millisecond precision as ISO strings, so the triggers' equality
 * joins (grant expiry = owner expiry) compare exactly.
 *
 * Helpers that must be atomic (the runtime activation, a report with its
 * cohorts and buckets, a grant with its capability) take a pg Pool and run
 * their own transaction. The others take any queryable (Pool or Client).
 *
 * Test-only: this module lives outside the Cloud Run build context and must
 * never be imported by product code.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const DAY_MS = 86_400_000;

export const PERFORMANCE_MIGRATION_NAME = "0079_performance_telemetry.sql";

export const PERFORMANCE_DICTIONARY_2026_09_21 = "telemetry-performance-registry-2026-09-21.1";
export const PERFORMANCE_DICTIONARY_2026_09_29 = "telemetry-performance-registry-2026-09-29.1";
export const PERFORMANCE_DICTIONARY_2026_10_10 = "telemetry-performance-registry-2026-10-10.1";
export const PERFORMANCE_BUCKET_SCHEME_V1 = "performance-histogram-v1";
export const PERFORMANCE_BUCKET_SCHEME_V2 = "performance-histogram-v2";

/** The registry rows 0079 seeds: dictionary -> {scheme, ultrafast labels}. */
export const PERFORMANCE_DICTIONARY_REGISTRY = Object.freeze({
  [PERFORMANCE_DICTIONARY_2026_09_21]: Object.freeze({ bucketSchemeVersion: PERFORMANCE_BUCKET_SCHEME_V1, ultrafastLabels: false }),
  [PERFORMANCE_DICTIONARY_2026_09_29]: Object.freeze({ bucketSchemeVersion: PERFORMANCE_BUCKET_SCHEME_V1, ultrafastLabels: true }),
  [PERFORMANCE_DICTIONARY_2026_10_10]: Object.freeze({ bucketSchemeVersion: PERFORMANCE_BUCKET_SCHEME_V2, ultrafastLabels: true }),
});

export const PERFORMANCE_DICTIONARY_BASES = Object.freeze([
  "v12_parser_inference", "default_no_manifest", "client_declared",
]);
export const PERFORMANCE_GRANT_SCHEMA_V1 = "accountless-performance-owner-v1";
export const PERFORMANCE_GRANT_SCHEMA_V2 = "accountless-performance-owner-v2";
export const PERFORMANCE_INTAKE_ROUTE_IDS = Object.freeze([
  "accountless_telemetry_performance_authorization",
  "telemetry_performance_capabilities",
  "telemetry_performance_reports",
]);
export const PERFORMANCE_PUBLICATION_PERIODS = Object.freeze(["1", "7", "30", "all"]);
export const PERFORMANCE_PUBLICATION_SPEED_MODES = Object.freeze(["standard", "fast", "ultrafast"]);

const RECORD_SCHEMA_VERSION = "model-performance-daily-v1";
const PRIVACY_CONTRACT_VERSION = "privacy-safe-model-performance-v1";
const MEASUREMENT_VERSION = "model-performance-samples-v1";
const METHOD_VERSION = "performance-daily-histogram-v1";
const SCOPE = "model-performance-daily";
/** A provider/model pair of the reviewed model catalog (REVIEWED_MODEL_CATALOG; synthetic counts only). */
export const PERFORMANCE_FIXTURE_MODEL = Object.freeze({ provider: "openai_codex", modelId: "gpt-5.5" });

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

/** `"schema"."name"`, refusing anything but a lowercase identifier. */
export function performanceTable(schema, name) {
  if (typeof schema !== "string" || !SCHEMA_IDENTIFIER.test(schema)) fail("PERFORMANCE_FIXTURE_SCHEMA_INVALID");
  if (typeof name !== "string" || !SCHEMA_IDENTIFIER.test(name)) fail("PERFORMANCE_FIXTURE_TABLE_INVALID");
  return `"${schema}"."${name}"`;
}

/** An ISO instant at millisecond precision (24 characters). */
export function performanceInstant(epochMs) {
  if (!Number.isSafeInteger(epochMs)) fail("PERFORMANCE_FIXTURE_INSTANT_INVALID");
  return new Date(epochMs).toISOString();
}

/** The UTC day (YYYY-MM-DD) of an epoch. */
export function performanceUtcDay(epochMs) {
  return performanceInstant(epochMs).slice(0, 10);
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isPool(db) {
  return db !== null && typeof db === "object" && typeof db.totalCount === "number" && typeof db.connect === "function";
}

async function inTransaction(pool, run) {
  if (!isPool(pool)) fail("PERFORMANCE_FIXTURE_POOL_REQUIRED");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Seed one active accountless owner graph: enrollment ledger, accountless
 * participant, accountless device credential and upload owner, all with the
 * same millisecond expiry. The device id doubles as the enrollment device id,
 * as a shipped accountless installation enrolls.
 */
export async function seedPerformanceAccountlessOwner(db, {
  schema,
  issuedAtEpoch = Date.now() - 60_000,
  leaseMs = 30 * DAY_MS,
} = {}) {
  const t = (name) => performanceTable(schema, name);
  const deviceId = randomUUID();
  const participantId = `participant:${randomUUID()}`;
  const issuedAt = performanceInstant(issuedAtEpoch);
  const expiresAt = performanceInstant(issuedAtEpoch + leaseMs);
  await db.query(`INSERT INTO ${t("accountless_enrollment_ledger")} (
      device_id, device_secret_hash, installation_principal_id, schema_version,
      policy_version, authorization_basis, state, issued_at, expires_at, renewal_generation
    ) VALUES ($1, $2, $3, 'accountless-enrollment-v0.1', 'accountless-opt-out-v1',
      'accountless-policy-v1', 'active', $4::timestamptz, $5::timestamptz, 0)`,
  [deviceId, randomBytes(32), `accountless:${randomUUID()}`, issuedAt, expiresAt]);
  await db.query(`INSERT INTO ${t("participants")} (id, owner_kind, state, created_at)
    VALUES ($1, 'accountless', 'active', $2::timestamptz)`, [participantId, issuedAt]);
  await db.query(`INSERT INTO ${t("device_credentials")} (
      id, participant_id, authority_kind, paired_via_pairing_id, accountless_enrollment_device_id,
      secret_hash, state, issued_at, expires_at, last_used_at, credential_generation
    ) VALUES ($1, $2, 'accountless', NULL, $1, $3, 'active', $4::timestamptz, $5::timestamptz,
      $4::timestamptz, 1)`, [deviceId, participantId, randomBytes(32), issuedAt, expiresAt]);
  await db.query(`INSERT INTO ${t("accountless_upload_owners")} (
      enrollment_device_id, participant_id, device_credential_id, policy_version,
      authorization_basis, authorized_at, expires_at, state
    ) VALUES ($1, $2, $1, 'accountless-opt-out-v1', 'accountless-policy-v1',
      $3::timestamptz, $4::timestamptz, 'active')`, [deviceId, participantId, issuedAt, expiresAt]);
  return Object.freeze({ participantId, deviceId, enrollmentDeviceId: deviceId, issuedAt, expiresAt });
}

/**
 * Slide the owner graph's lease (ledger, device and upload owner) to a new
 * millisecond expiry, as an accountless renewal does. Returns the new owner.
 */
export async function slidePerformanceOwnerLease(db, { schema, owner, expiresAtEpoch, renewedAtEpoch = Date.now() }) {
  const t = (name) => performanceTable(schema, name);
  const expiresAt = performanceInstant(expiresAtEpoch);
  const renewedAt = performanceInstant(renewedAtEpoch);
  await db.query(`UPDATE ${t("accountless_enrollment_ledger")}
      SET expires_at = $2::timestamptz, renewed_at = $3::timestamptz, renewal_generation = renewal_generation + 1
    WHERE device_id = $1`, [owner.enrollmentDeviceId, expiresAt, renewedAt]);
  await db.query(`UPDATE ${t("device_credentials")} SET expires_at = $2::timestamptz WHERE id = $1`,
    [owner.deviceId, expiresAt]);
  await db.query(`UPDATE ${t("accountless_upload_owners")} SET expires_at = $2::timestamptz
    WHERE enrollment_device_id = $1`, [owner.enrollmentDeviceId, expiresAt]);
  return Object.freeze({ ...owner, expiresAt });
}

/**
 * Begin a 'started' run_maintenance audit row (content-free details) and
 * return its operation id. The audit lifecycle guard keeps it append-only.
 * The runtime guard accepts it only inside the transaction that inserted it,
 * at that transaction's top level (no savepoint): pass the activation's own
 * client, as activatePerformanceRuntime does. Called with a Pool, it commits
 * at once and models a 'started' row a crashed activation left behind.
 */
export async function beginPerformanceActivationAudit(db, { schema, nowEpoch = Date.now() }) {
  const operationId = randomUUID();
  await db.query(`INSERT INTO ${performanceTable(schema, "admin_action_audit")}
      (operation_id, action, actor_identity_digest, outcome, details_json, created_at)
    VALUES ($1, 'run_maintenance', $2, 'started', $3, $4::timestamptz)`,
  [operationId, sha256Hex("synthetic-performance-owner"), JSON.stringify({ operation: "telemetryRuntimeActivation" }),
    performanceInstant(nowEpoch)]);
  return operationId;
}

/**
 * Activate the runtime through the audit + GUC path, in one transaction:
 * begin the audit, name it in tibotattle.telemetry_performance_activation,
 * move staged -> active at policy revision + 1, finish the audit.
 */
export async function activatePerformanceRuntime(pool, { schema, nowEpoch = Date.now() } = {}) {
  return inTransaction(pool, async (client) => {
    const t = (name) => performanceTable(schema, name);
    const operationId = await beginPerformanceActivationAudit(client, { schema, nowEpoch });
    await client.query("SELECT set_config('tibotattle.telemetry_performance_activation', $1, true)", [operationId]);
    const updated = await client.query(`UPDATE ${t("telemetry_performance_runtime")}
        SET state = 'active', policy_revision = policy_revision + 1,
            updated_at = GREATEST(updated_at + interval '1 millisecond', $1::timestamptz)
      WHERE id = 1 RETURNING policy_revision`, [performanceInstant(nowEpoch)]);
    await client.query(`UPDATE ${t("admin_action_audit")} SET outcome = 'success' WHERE operation_id = $1`,
      [operationId]);
    return Object.freeze({ operationId, policyRevision: updated.rows[0].policy_revision });
  });
}

/** The grant schema version a dictionary basis implies. */
export function performanceGrantSchemaVersion(dictionaryBasis) {
  if (!PERFORMANCE_DICTIONARY_BASES.includes(dictionaryBasis)) fail("PERFORMANCE_FIXTURE_BASIS_INVALID");
  return dictionaryBasis === "client_declared" ? PERFORMANCE_GRANT_SCHEMA_V2 : PERFORMANCE_GRANT_SCHEMA_V1;
}

/** The next (revision, epoch) after the current authorization head, as the policy computes it. */
export async function nextPerformanceGrantTuple(db, { schema, owner }) {
  const head = await db.query(`SELECT capability_revision, authority_epoch, state
      FROM ${performanceTable(schema, "accountless_telemetry_performance_authorizations")}
     WHERE enrollment_device_id = $1
     ORDER BY capability_revision DESC, authority_epoch DESC LIMIT 1`, [owner.enrollmentDeviceId]);
  const row = head.rows[0];
  return Object.freeze({
    capabilityRevision: (row?.capability_revision ?? 0) + 1,
    authorityEpoch: (row?.authority_epoch ?? 0) + (row === undefined || row.state === "revoked" ? 1 : 0),
  });
}

/**
 * Insert one authorization row and its capability row for a dictionary and
 * basis, in one transaction, at the next tuple unless one is given. The
 * expiry is the owner's. Returns the tuple the device would read.
 */
export async function insertPerformanceGrant(pool, {
  schema,
  owner,
  fieldDictionaryVersion = PERFORMANCE_DICTIONARY_2026_09_29,
  dictionaryBasis = "v12_parser_inference",
  capabilityRevision,
  authorityEpoch,
  nowEpoch = Date.now(),
  withCapability = true,
}) {
  return inTransaction(pool, async (client) => {
    const t = (name) => performanceTable(schema, name);
    const next = capabilityRevision === undefined || authorityEpoch === undefined
      ? await nextPerformanceGrantTuple(client, { schema, owner }) : null;
    const tuple = Object.freeze({
      capabilityRevision: capabilityRevision ?? next.capabilityRevision,
      authorityEpoch: authorityEpoch ?? next.authorityEpoch,
    });
    const now = performanceInstant(nowEpoch);
    await client.query(`INSERT INTO ${t("accountless_telemetry_performance_authorizations")} (
        enrollment_device_id, participant_id, device_credential_id, schema_version, policy_version,
        authorization_basis, performance_schema_version, field_dictionary_version, dictionary_basis,
        privacy_contract_version, scope, capability_revision, authority_epoch, authorized_at, expires_at, state
      ) VALUES ($1, $2, $3, $4, 'accountless-telemetry-performance-policy-v1', 'accountless-performance-policy-v1',
        $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, 'active')`,
    [owner.enrollmentDeviceId, owner.participantId, owner.deviceId, performanceGrantSchemaVersion(dictionaryBasis),
      RECORD_SCHEMA_VERSION, fieldDictionaryVersion, dictionaryBasis, PRIVACY_CONTRACT_VERSION, SCOPE,
      tuple.capabilityRevision, tuple.authorityEpoch, now, owner.expiresAt]);
    if (withCapability) {
      await client.query(`INSERT INTO ${t("telemetry_performance_device_capabilities")} (
          participant_id, device_id, schema_version, field_dictionary_version, dictionary_basis,
          privacy_contract_version, scope, capability_revision, authority_epoch, issued_at, expires_at,
          state, consented_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, 'accepted', $10::timestamptz)`,
      [owner.participantId, owner.deviceId, RECORD_SCHEMA_VERSION, fieldDictionaryVersion, dictionaryBasis,
        PRIVACY_CONTRACT_VERSION, SCOPE, tuple.capabilityRevision, tuple.authorityEpoch, now, owner.expiresAt]);
    }
    return Object.freeze({
      ...tuple, fieldDictionaryVersion, dictionaryBasis,
      bucketSchemeVersion: PERFORMANCE_DICTIONARY_REGISTRY[fieldDictionaryVersion]?.bucketSchemeVersion ?? null,
      expiresAt: owner.expiresAt, issuedAt: now,
    });
  });
}

function ceilRational(numerator, denominator) {
  return Number((numerator + denominator - 1n) / denominator);
}

/** ceil(base * 1.15^k) for k = 1..count, as the contract derives its log edges. */
function logarithmicEdges(base, count) {
  return Array.from({ length: count }, (_, index) => {
    const k = BigInt(index + 1);
    return ceilRational(base * 115n ** k, 100n ** k);
  });
}

/**
 * The contract's upper-exclusive bucket edges, restated so the fixture can
 * place samples without a contract that knows every scheme (the v2 speed edges
 * reach the contract with SPD-G0). The schema spec asserts each list equals
 * the contract's export whenever the contract exports it.
 * - v1 speed (centi-tokens/second): 60 edges of 200; bucket 60 overflows.
 * - v2 speed: the v1 edges, 18 edges of 1,000 through 30,000, then
 *   ceil(30,000 * 1.15^k) for k = 1..17; bucket 95 overflows.
 * - ttft and turnDuration (ms): 1, 500, then ceil(500 * 1.15^k) for
 *   k = 1..55; bucket 0 is TTFT == 0 only, bucket 57 overflows.
 */
export const PERFORMANCE_FIXTURE_SPEED_EDGES_V1 = Object.freeze(
  Array.from({ length: 60 }, (_, index) => (index + 1) * 200),
);
export const PERFORMANCE_FIXTURE_SPEED_EDGES_V2 = Object.freeze([
  ...PERFORMANCE_FIXTURE_SPEED_EDGES_V1,
  ...Array.from({ length: 18 }, (_, index) => 12_000 + (index + 1) * 1_000),
  ...logarithmicEdges(30_000n, 17),
]);
export const PERFORMANCE_FIXTURE_DURATION_EDGES_MS = Object.freeze([1, 500, ...logarithmicEdges(500n, 55)]);

const SPEED_EDGES_BY_SCHEME = Object.freeze({
  [PERFORMANCE_BUCKET_SCHEME_V1]: PERFORMANCE_FIXTURE_SPEED_EDGES_V1,
  [PERFORMANCE_BUCKET_SCHEME_V2]: PERFORMANCE_FIXTURE_SPEED_EDGES_V2,
});

function speedEdges(scheme) {
  const edges = SPEED_EDGES_BY_SCHEME[scheme];
  if (edges === undefined) fail("PERFORMANCE_FIXTURE_SCHEME_INVALID");
  return edges;
}

/** The highest bucket index a metric has under a scheme (the overflow bucket). */
export function performanceFixtureMaxBucket(scheme, metric) {
  if (metric === "speed") return speedEdges(scheme).length;
  speedEdges(scheme);
  if (metric === "ttft" || metric === "turnDuration") return PERFORMANCE_FIXTURE_DURATION_EDGES_MS.length;
  return fail("PERFORMANCE_FIXTURE_METRIC_INVALID");
}

/** The contract bucket of one sample: speed in centi-tokens/second, ttft and turnDuration in ms. */
export function performanceFixtureBucket(scheme, metric, value) {
  const maximum = performanceFixtureMaxBucket(scheme, metric);
  if (!Number.isSafeInteger(value) || value < (metric === "turnDuration" ? 1 : 0)) {
    fail("PERFORMANCE_FIXTURE_SAMPLE_INVALID");
  }
  if (metric === "speed") {
    const index = speedEdges(scheme).findIndex((upper) => value < upper);
    return index < 0 ? maximum : index;
  }
  if (metric === "ttft" && value === 0) return 0;
  if (value < PERFORMANCE_FIXTURE_DURATION_EDGES_MS[1]) return 1;
  const index = PERFORMANCE_FIXTURE_DURATION_EDGES_MS.findIndex((upper, edgeIndex) => edgeIndex >= 2 && value < upper);
  return index < 0 ? maximum : index;
}

/**
 * A speed sample (centi-tokens/second) inside `bucket`: the bucket's lower
 * edge rounded up to a multiple of 10 (at least 10), so a 10 s duration per
 * turn carries a whole token count and the rate is exact.
 */
export function performanceFixtureSpeedForBucket(scheme, bucket) {
  const edges = speedEdges(scheme);
  if (!Number.isSafeInteger(bucket) || bucket < 0 || bucket > edges.length) fail("PERFORMANCE_FIXTURE_SPEED_BUCKET_INVALID");
  const lower = bucket === 0 ? 0 : edges[bucket - 1];
  const value = Math.ceil(Math.max(lower, 10) / 10) * 10;
  if (performanceFixtureBucket(scheme, "speed", value) !== bucket) fail("PERFORMANCE_FIXTURE_SPEED_BUCKET_INVALID");
  return value;
}

/**
 * A contract-shaped sparse histogram of integer samples under a scheme: the
 * buckets are derived from the samples and min/max are their extrema.
 */
export function syntheticPerformanceHistogram(scheme, metric, values) {
  if (!Array.isArray(values)) fail("PERFORMANCE_FIXTURE_SAMPLE_INVALID");
  const buckets = {};
  for (const value of values) {
    const key = String(performanceFixtureBucket(scheme, metric, value));
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.keys(buckets).sort((left, right) => Number(left) - Number(right))
    .map((key) => [key, buckets[key]]));
  return {
    schemaVersion: scheme,
    metric,
    sampleCount: values.length,
    buckets: sorted,
    min: values.length === 0 ? null : Math.min(...values),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

const SPEED_DURATION_MS_PER_TURN = 10_000;

/**
 * A plain, contract-shaped performance record (model-performance-daily-v1)
 * with synthetic counts, valid under `fieldDictionaryVersion` whenever its
 * labels are in that dictionary's vocabulary (2026-09-21.1 has no Ultrafast
 * labels; such records exist only to prove the database refuses them).
 * `speedBucket` places every speed sample in that bucket of the dictionary's
 * scheme and derives the speed extrema, tokens and duration to match;
 * `ttftMs` and `turnDurationMs` place the latency samples, whose buckets are
 * derived from the contract edges. Overrides replace any field verbatim.
 */
export function syntheticPerformanceRecord({
  day,
  fieldDictionaryVersion = PERFORMANCE_DICTIONARY_2026_09_29,
  speedMode = "standard",
  speedModeSource = "rollout_thread_settings",
  apiServiceTier = "standard",
  reasoningEffort = "medium",
  speedMethod = "receipt",
  speedBucket = 30,
  ttftMs = 900,
  turnDurationMs = 12_000,
  turns = 3,
  ...overrides
} = {}) {
  const scheme = PERFORMANCE_DICTIONARY_REGISTRY[fieldDictionaryVersion]?.bucketSchemeVersion;
  if (scheme === undefined) fail("PERFORMANCE_FIXTURE_DICTIONARY_INVALID");
  if (!Number.isSafeInteger(turns) || turns < 1) fail("PERFORMANCE_FIXTURE_TURNS_INVALID");
  const speedTurns = speedMethod === "unavailable" ? 0 : turns;
  const speed = speedTurns === 0 ? null : performanceFixtureSpeedForBucket(scheme, speedBucket);
  const repeat = (count, value) => Array.from({ length: count }, () => value);
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    day,
    provider: PERFORMANCE_FIXTURE_MODEL.provider,
    modelId: PERFORMANCE_FIXTURE_MODEL.modelId,
    reasoningEffort,
    speedMethod,
    speedMode,
    speedModeSource,
    apiServiceTier,
    measurementVersion: MEASUREMENT_VERSION,
    bucketSchemeVersion: scheme,
    turns,
    speedTurns,
    ttftTurns: turns,
    completionTurns: turns,
    timedResponses: speedTurns,
    // rate = tokens * 100,000 / ms centi-tokens/second, exactly `speed`.
    speedTokens: speedTurns === 0 ? 0 : (speed / 10) * speedTurns,
    speedDurationMs: SPEED_DURATION_MS_PER_TURN * speedTurns,
    speedHistogram: syntheticPerformanceHistogram(scheme, "speed", repeat(speedTurns, speed)),
    ttftHistogram: syntheticPerformanceHistogram(scheme, "ttft", repeat(turns, ttftMs)),
    completionHistogram: syntheticPerformanceHistogram(scheme, "turnDuration", repeat(turns, turnDurationMs)),
    ...overrides,
  };
}

const HISTOGRAM_METRICS = Object.freeze([
  ["speedHistogram", "speed"], ["ttftHistogram", "ttft"], ["completionHistogram", "turnDuration"],
]);

/**
 * Insert one current report for (owner, day) with its cohorts, sparse
 * buckets and an 'accepted' (or 'replaced') receipt, in one transaction,
 * from plain contract-shaped records. By default an existing current row for
 * the device-day is superseded first, as the report writer does. The
 * capability tuple and dictionary come from `grant` (insertPerformanceGrant).
 * The receipt repeats the report's participant, device, day and revision,
 * which its composite foreign key requires; an idempotent replay writes no
 * receipt, so 'idempotent' is never an outcome.
 */
export async function insertPerformanceReport(pool, {
  schema,
  owner,
  grant,
  reportDay,
  records = [],
  fieldDictionaryVersion = grant.fieldDictionaryVersion,
  bucketSchemeVersion = PERFORMANCE_DICTIONARY_REGISTRY[fieldDictionaryVersion]?.bucketSchemeVersion,
  sourceRevision = 1,
  sourceGeneration = "synthetic-generation-1",
  sourceDigest,
  reportRevision,
  parserVersion = "unified-rollout-typed-v20",
  methodVersion = METHOD_VERSION,
  nowEpoch = Date.now(),
  supersedeCurrent = true,
  withReceipt = true,
}) {
  return inTransaction(pool, async (client) => {
    const t = (name) => performanceTable(schema, name);
    const canonical = JSON.stringify({ reportDay, fieldDictionaryVersion, records });
    const reportId = randomUUID();
    const revision = reportRevision ?? sha256Hex(`synthetic-report:${reportId}:${canonical}`);
    const now = performanceInstant(nowEpoch);
    let outcome = "accepted";
    if (supersedeCurrent) {
      const superseded = await client.query(`UPDATE ${t("telemetry_performance_reports")}
          SET state = 'superseded', superseded_at = GREATEST(created_at, $4::timestamptz)
        WHERE participant_id = $1 AND device_id = $2 AND report_day = $3::date AND state = 'current'
          AND source_revision < $5
        RETURNING id`, [owner.participantId, owner.deviceId, reportDay, now, sourceRevision]);
      if (superseded.rowCount > 0) outcome = "replaced";
    }
    await client.query(`INSERT INTO ${t("telemetry_performance_reports")} (
        id, participant_id, device_id, report_day, report_revision, source_generation, source_digest,
        source_revision, method_version, parser_version, schema_version, field_dictionary_version,
        bucket_scheme_version, privacy_contract_version, measurement_version, record_count, canonical_bytes,
        capability_revision, authority_epoch, state, created_at
      ) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
        'current', $20::timestamptz)`,
    [reportId, owner.participantId, owner.deviceId, reportDay, revision, sourceGeneration,
      sourceDigest ?? sha256Hex(`synthetic-source:${sourceGeneration}:${sourceRevision}`), sourceRevision,
      methodVersion, parserVersion, RECORD_SCHEMA_VERSION, fieldDictionaryVersion, bucketSchemeVersion,
      PRIVACY_CONTRACT_VERSION, MEASUREMENT_VERSION, records.length, Buffer.byteLength(canonical),
      grant.capabilityRevision, grant.authorityEpoch, now]);
    for (const [cohortIndex, record] of records.entries()) {
      await client.query(`INSERT INTO ${t("telemetry_performance_cohorts")} (
          report_id, cohort_index, field_dictionary_version, bucket_scheme_version, provider, model_id,
          reasoning_effort, speed_method, speed_mode, speed_mode_source, api_service_tier, turns, speed_turns,
          ttft_turns, completion_turns, timed_responses, speed_tokens, speed_duration_ms, speed_min, speed_max,
          ttft_min, ttft_max, completion_min, completion_max
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24)`,
      [reportId, cohortIndex, fieldDictionaryVersion, record.bucketSchemeVersion ?? bucketSchemeVersion,
        record.provider, record.modelId, record.reasoningEffort, record.speedMethod, record.speedMode,
        record.speedModeSource, record.apiServiceTier, record.turns, record.speedTurns, record.ttftTurns,
        record.completionTurns, record.timedResponses, record.speedTokens, record.speedDurationMs,
        record.speedHistogram.min, record.speedHistogram.max, record.ttftHistogram.min, record.ttftHistogram.max,
        record.completionHistogram.min, record.completionHistogram.max]);
      for (const [field, metric] of HISTOGRAM_METRICS) {
        for (const [bucketIndex, bucketCount] of Object.entries(record[field].buckets)) {
          await client.query(`INSERT INTO ${t("telemetry_performance_buckets")}
              (report_id, cohort_index, bucket_scheme_version, metric, bucket_index, bucket_count)
            VALUES ($1, $2, $3, $4, $5, $6)`,
          [reportId, cohortIndex, record[field].schemaVersion ?? bucketSchemeVersion, metric,
            Number(bucketIndex), bucketCount]);
        }
      }
    }
    if (withReceipt) {
      await client.query(`INSERT INTO ${t("telemetry_performance_receipts")} (
          id, participant_id, device_id, report_id, report_day, report_revision, envelope_digest, outcome, created_at
        ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::timestamptz)`,
      [randomUUID(), owner.participantId, owner.deviceId, reportId, reportDay, revision,
        sha256Hex(`synthetic-envelope:${reportId}`), outcome, now]);
    }
    return Object.freeze({ reportId, reportRevision: revision, outcome, createdAt: now });
  });
}

/**
 * Seed one v1.2 day manifest (staged, no chunks) carrying `parserVersion`
 * for (owner, chunkDay), the evidence the v1 grant's dictionary inference
 * reads. Content-free: the manifest body is an empty object.
 */
export async function seedPerformanceV12DayManifest(db, {
  schema,
  owner,
  chunkDay,
  parserVersion,
  createdAtEpoch = Date.now(),
}) {
  const id = randomUUID();
  await db.query(`INSERT INTO ${performanceTable(schema, "telemetry_v12_day_manifests")} (
      id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json,
      expected_chunk_count, state, created_at
    ) VALUES ($1, $2, $3, $4::date, $5, $6, '{}', 0, 'staged', $7::timestamptz)`,
  [id, owner.participantId, owner.deviceId, chunkDay, sha256Hex(`synthetic-manifest:${id}`), parserVersion,
    performanceInstant(createdAtEpoch)]);
  return Object.freeze({ id });
}

/**
 * Register kernel-registry.json's entry `index` (default the first) in
 * analytics_v2_kernels, idempotently, and return its kernel id. The
 * publication heads reference a registered kernel.
 */
export async function ensurePerformanceFixtureKernel(db, { schema, index = 0 } = {}) {
  const registry = JSON.parse(await readFile(join(WORKER_ROOT, "src", "analytics-v2", "kernel-registry.json"), "utf8"));
  const kernel = registry.kernels.at(index);
  await db.query(`INSERT INTO ${performanceTable(schema, "analytics_v2_kernels")} (kernel_id, production_commit,
      vendor_manifest_sha256, compute_closure_sha256, price_registry_sha256, price_registry_version, method_version,
      registered_at) VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-10-02T00:00:00Z') ON CONFLICT DO NOTHING`,
  [kernel.kernelId, kernel.productionCommit, kernel.vendorManifestSha256, kernel.computeClosureSha256,
    kernel.priceRegistrySha256, kernel.priceRegistryVersion, kernel.methodVersion]);
  return kernel.kernelId;
}

/**
 * A valid, empty community-model-performance-v1 document for one slot: no
 * models, zero counts, a window ending on `end` (a completed UTC day).
 */
export function syntheticCommunityModelPerformancePayload({
  period = "7",
  speedMode = "standard",
  revision = 1,
  end = "2026-10-10",
  start,
  interval = period === "all" ? "week" : "day",
  generatedAt = "2026-10-11T03:00:00.000Z",
  ...overrides
} = {}) {
  const endEpoch = Date.parse(`${end}T00:00:00.000Z`);
  const windowStart = start ?? (period === "all" ? "2026-09-21" : performanceUtcDay(endEpoch - (Number(period) - 1) * DAY_MS));
  return {
    schemaVersion: "community-model-performance-v1",
    methodVersion: "performance-histogram-pool-type7-bounds-v1",
    population: "reported_samples",
    approximate: true,
    revision,
    generatedAt,
    period,
    interval,
    start: windowStart,
    end,
    speedMode,
    excludedUnknownTurns: 0,
    contributors: 0,
    devices: 0,
    reports: 0,
    models: [],
    ...overrides,
  };
}

/** sha256 over the payload's canonical JSON (sorted keys): a synthetic digest. */
export function syntheticPerformancePayloadSha256(payload) {
  const canonical = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  };
  return sha256Hex(canonical(payload));
}

/**
 * Insert one publication head for a given valid payload. Its period, speed
 * mode and revision default to the payload's; the kernel defaults to the
 * first registered fixture kernel (registered here if absent).
 */
export async function insertPerformancePublicationHead(db, {
  schema,
  payload,
  period = payload.period,
  speedMode = payload.speedMode,
  revision = payload.revision,
  releasedAtEpoch = Date.now(),
  payloadSha256 = syntheticPerformancePayloadSha256(payload),
  runId = randomUUID(),
  kernelId,
  manifestVersion = 1,
}) {
  const kernel = kernelId ?? await ensurePerformanceFixtureKernel(db, { schema });
  await db.query(`INSERT INTO ${performanceTable(schema, "analytics_v2_published_performance")}
      (period, speed_mode, revision, released_at, payload, payload_sha256, run_id, kernel_id, manifest_version)
    VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, $6, $7::uuid, $8, $9)`,
  [period, speedMode, revision, performanceInstant(releasedAtEpoch), JSON.stringify(payload), payloadSha256,
    runId, kernel, manifestVersion]);
  return Object.freeze({ period, speedMode, revision, payloadSha256, runId, kernelId: kernel });
}
