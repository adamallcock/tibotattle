/**
 * Owner-only activation of the accountless performance runtime on the
 * PostgreSQL origin (primary 0079_performance_telemetry.sql; owner decisions
 * 2026-10-10, items 1 and 2; orchestrator gate answer 23).
 *
 * The task is a subtype of the protected `run_maintenance` envelope, exactly
 * as the Worker's D1 activation (telemetry-runtime-activation.ts) is: the
 * admin action route (cloud-run/routes/admin-action.mjs) authenticates the
 * Access owner, checks the admin CSRF headers and bounds the body, then hands
 * `{body, identityKey}` to `maintenance.telemetryRuntimeActivation`. Nothing
 * here authenticates; nothing here is reachable from a participant route.
 *
 * Only the `performance` target exists on this origin. `usage_v12` is
 * refused as 400 BODY_INVALID: its active state arrived by transfer and is
 * never activated here.
 *
 * Everything runs in ONE plain top-level read-committed transaction
 * (withPostgresMutation), in this order:
 *
 *   1. replay: the audit row whose operation id is the idempotency key. A
 *      success row for the same intent returns its recorded result with
 *      `replayed: true`; a terminal row for another intent, another action
 *      or a failure is 409 ADMIN_ACTION_CONFLICT;
 *   2. the primary migration receipt (readSchemaReceipt, the one reader) must
 *      be current for this image's manifest, else 503
 *      TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE;
 *   3. the request's deployment must name this image: its sourceCommit equals
 *      DEPLOYMENT_SOURCE_COMMIT and its historySha256 equals the digest of
 *      the image's manifest (the migrate receipt's historySha256), else 409
 *      ADMIN_ACTION_CONFLICT;
 *   4. collection controls FOR SHARE, with uploadRegistration and processing
 *      enabled, else the controls' own 503 code;
 *   5. the runtime singleton FOR UPDATE: staged at policy_revision =
 *      expectedRevision, else 409 ADMIN_ACTION_CONFLICT (a concurrent
 *      request with the same key that won the lock is answered as a replay);
 *   6. the dictionary registry rows equal this image's
 *      PERFORMANCE_FIELD_DICTIONARIES pairing, else 503
 *      TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE;
 *   7. begin the run_maintenance audit row (content-free details);
 *   8. name it in tibotattle.telemetry_performance_activation (local to the
 *      transaction);
 *   9. move the runtime staged -> active at policy_revision + 1;
 *  10. finish the audit row with success.
 *
 * Every refusal before step 7 throws, so the transaction rolls back and no
 * audit row is left. 0079's runtime guard accepts the step 9 update only
 * while the step 7 row is 'started' and was inserted by this very
 * transaction at its top level, so the audit row and the activation commit
 * or vanish together. A commit whose outcome is unknown answers 503
 * TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE; resending the same request is
 * safe, because a committed activation then replays.
 *
 * A 'started' row for the same intent cannot be left by this task (it never
 * commits one), but one can exist (an interrupted earlier writer). If the
 * runtime is already active at expectedRevision + 1 it is finished with
 * success and the result is returned with `reconciled: true`; otherwise the
 * request is 503 TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED and nothing
 * changes.
 *
 * The 0079 guard is defence in depth only: the runtime role holds DML and
 * can set the setting, so owner-only activation rests on the Access
 * chokepoint plus CSRF in front of the admin route.
 *
 * Audit details hold only closed labels, the idempotency key, revisions, the
 * deployment commit and the manifest digest. The owner identity key is
 * stored only as postgres-admin-audit.ts's domain-separated digest.
 */
import { PERFORMANCE_FIELD_DICTIONARIES } from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  beginPostgresAdminOperationInTransaction,
  finishPostgresAdminOperationInTransaction,
} from "./postgres-admin-audit";
import {
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-client";
import { readPostgresCollectionControls } from "./postgres-collection-controls";
import { readSchemaReceipt, type PostgresSchemaReceiptMigration } from "./postgres-schema-receipt";

/** The one target this origin activates. */
export type PostgresTelemetryRuntimeActivationTarget = "performance";

export interface PostgresTelemetryRuntimeActivationDeployment {
  /** sha256 of the image's primary manifest, as the migrate receipt's historySha256. */
  readonly historySha256: string;
  /** The image's DEPLOYMENT_SOURCE_COMMIT (40 lowercase hex). */
  readonly sourceCommit: string;
}

export interface PostgresTelemetryRuntimeActivationRequest {
  readonly confirmation: "activate_telemetry_performance_runtime";
  readonly deployment: PostgresTelemetryRuntimeActivationDeployment;
  readonly expectedRevision: number;
  /** A lowercase v4 UUID; it is also the audit row's operation id. */
  readonly idempotencyKey: string;
  readonly target: PostgresTelemetryRuntimeActivationTarget;
}

export interface PostgresTelemetryRuntimeActivationResult {
  readonly task: "telemetry_runtime_activation";
  readonly operationId: string;
  readonly target: PostgresTelemetryRuntimeActivationTarget;
  readonly state: "active";
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly revision: number;
  /** True when this request performed no activation itself. */
  readonly replayed: boolean;
  /** True when the recorded activation finished an earlier writer's started audit row. */
  readonly reconciled: boolean;
}

export interface PostgresTelemetryRuntimeActivationOptions {
  readonly pool: PostgresPool;
  /** The primary schema (a lowercase identifier). */
  readonly schema: string;
  /**
   * The image's DEPLOYMENT_SOURCE_COMMIT. Null or anything but 40 lowercase
   * hex makes every activation 503 TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE
   * (a replay still answers).
   */
  readonly sourceCommit: string | null;
  /** The image's primary manifest (POSTGRES_RUNTIME_MIGRATIONS.primary). */
  readonly expectedMigrations: readonly PostgresSchemaReceiptMigration[];
  /** Epoch milliseconds; defaults to Date.now. */
  readonly clock?: () => number;
}

export type PostgresTelemetryRuntimeActivationTask = (input: {
  readonly body: unknown;
  readonly identityKey: string;
}) => Promise<PostgresTelemetryRuntimeActivationResult>;

const TASK = "telemetry_runtime_activation" as const;
const TARGET = "performance" as const;
const CONFIRMATION = "activate_telemetry_performance_runtime" as const;
const DETAILS_SCHEMA_VERSION = "postgres-telemetry-runtime-activation-v1" as const;
const ACTIVATION_SETTING = "tibotattle.telemetry_performance_activation";
const MAX_REVISION = 2_147_483_647;
const TRANSACTION_TIMEOUT_MILLISECONDS = 10_000;
const LOCK_TIMEOUT_MILLISECONDS = 5_000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const MIGRATION_NAME = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;

function bodyInvalid(): never {
  throw new ApiError(400, "BODY_INVALID");
}

function conflict(): never {
  throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
}

function unavailable(): never {
  throw new ApiError(503, "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE");
}

function reconcileRequired(): never {
  throw new ApiError(503, "TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED");
}

function configurationInvalid(field: string): never {
  throw new TypeError(`TELEMETRY_RUNTIME_ACTIVATION_CONFIGURATION_INVALID: ${field}`);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plainObject(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_REVISION;
}

/**
 * Parse the exact owner body
 * `{action: 'run_maintenance', telemetryRuntimeActivation: {confirmation,
 * deployment: {historySha256, sourceCommit}, expectedRevision,
 * idempotencyKey, target: 'performance'}}`. Anything else, including the
 * `usage_v12` target, is 400 BODY_INVALID.
 */
export function parsePostgresTelemetryRuntimeActivationRequest(
  body: unknown,
): PostgresTelemetryRuntimeActivationRequest {
  if (!exactKeys(body, ["action", "telemetryRuntimeActivation"]) || body.action !== "run_maintenance") {
    bodyInvalid();
  }
  const activation = body.telemetryRuntimeActivation;
  if (!exactKeys(activation, ["confirmation", "deployment", "expectedRevision", "idempotencyKey", "target"])) {
    bodyInvalid();
  }
  const { confirmation, deployment, expectedRevision, idempotencyKey, target } = activation;
  if (target !== TARGET
      || confirmation !== CONFIRMATION
      || !validRevision(expectedRevision)
      || typeof idempotencyKey !== "string"
      || !UUID_V4.test(idempotencyKey)
      || !exactKeys(deployment, ["historySha256", "sourceCommit"])
      || typeof deployment.historySha256 !== "string"
      || !SHA256.test(deployment.historySha256)
      || typeof deployment.sourceCommit !== "string"
      || !COMMIT.test(deployment.sourceCommit)) {
    bodyInvalid();
  }
  return Object.freeze({
    confirmation: CONFIRMATION,
    deployment: Object.freeze({
      historySha256: deployment.historySha256 as string,
      sourceCommit: deployment.sourceCommit as string,
    }),
    expectedRevision,
    idempotencyKey,
    target: TARGET,
  });
}

function validManifest(value: unknown): value is readonly PostgresSchemaReceiptMigration[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry: unknown, index) =>
    plainObject(entry)
    && entry.version === index + 1
    && typeof entry.name === "string" && MIGRATION_NAME.test(entry.name)
    && typeof entry.sha256 === "string" && SHA256.test(entry.sha256));
}

/** Sorted-key JSON: the migrate job's canonicalJson (postgres-production-migrations.mjs). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 over the canonical `[{version, name, sha256}]` list of a primary
 * manifest: byte-for-byte the production migrate receipt's
 * `migrations.historySha256` for a database migrated to that manifest.
 */
export async function postgresRuntimeMigrationHistorySha256(
  expectedMigrations: readonly PostgresSchemaReceiptMigration[],
): Promise<string> {
  if (!validManifest(expectedMigrations)) configurationInvalid("expectedMigrations");
  return sha256Hex(canonicalJson(expectedMigrations.map(({ version, name, sha256 }) => ({ version, name, sha256 }))));
}

interface IntentDetails {
  readonly schemaVersion: typeof DETAILS_SCHEMA_VERSION;
  readonly task: typeof TASK;
  readonly target: typeof TARGET;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly deployment: PostgresTelemetryRuntimeActivationDeployment;
}

interface AuditRow {
  readonly operation_id: unknown;
  readonly action: unknown;
  readonly outcome: unknown;
  readonly details_json: unknown;
}

interface RuntimeRow {
  readonly state: unknown;
  readonly policy_revision: unknown;
  readonly schema_version: unknown;
  readonly privacy_contract_version: unknown;
}

interface RegistryRow {
  readonly field_dictionary_version: unknown;
  readonly bucket_scheme_version: unknown;
  readonly ultrafast_labels: unknown;
}

function intentDetails(request: PostgresTelemetryRuntimeActivationRequest): IntentDetails {
  return {
    schemaVersion: DETAILS_SCHEMA_VERSION,
    task: TASK,
    target: TARGET,
    idempotencyKey: request.idempotencyKey,
    expectedRevision: request.expectedRevision,
    deployment: {
      historySha256: request.deployment.historySha256,
      sourceCommit: request.deployment.sourceCommit,
    },
  };
}

function parseDetails(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return plainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether recorded details describe the same intent: the same key, target
 * and expected revision. The deployment is a gate for performing an
 * activation, not part of its identity, so a replay after a redeploy still
 * returns the recorded result.
 */
function sameIntent(details: Record<string, unknown>, request: PostgresTelemetryRuntimeActivationRequest): boolean {
  return details.schemaVersion === DETAILS_SCHEMA_VERSION
    && details.task === TASK
    && details.target === TARGET
    && details.idempotencyKey === request.idempotencyKey
    && details.expectedRevision === request.expectedRevision;
}

function result(
  operationId: string,
  request: PostgresTelemetryRuntimeActivationRequest,
  flags: { readonly replayed: boolean; readonly reconciled: boolean },
): PostgresTelemetryRuntimeActivationResult {
  const toRevision = request.expectedRevision + 1;
  return Object.freeze({
    task: TASK,
    operationId,
    target: TARGET,
    state: "active",
    fromRevision: request.expectedRevision,
    toRevision,
    revision: toRevision,
    replayed: flags.replayed,
    reconciled: flags.reconciled,
  });
}

/** The recorded result of a success row for this intent, or a refusal. */
function recordedResult(
  row: AuditRow,
  request: PostgresTelemetryRuntimeActivationRequest,
): PostgresTelemetryRuntimeActivationResult {
  const details = parseDetails(row.details_json);
  if (details === null || !sameIntent(details, request)) conflict();
  if (details.state !== "active"
      || details.fromRevision !== request.expectedRevision
      || details.toRevision !== request.expectedRevision + 1) {
    reconcileRequired();
  }
  return result(request.idempotencyKey, request, { replayed: true, reconciled: details.reconciled === true });
}

interface Prepared {
  readonly schema: string;
  readonly tables: Readonly<Record<"audit" | "runtime" | "registry", string>>;
  readonly expectedMigrations: readonly PostgresSchemaReceiptMigration[];
  readonly historySha256: string;
  readonly sourceCommit: string | null;
  readonly registry: string;
  readonly clock: () => number;
}

function expectedRegistry(): string {
  return canonicalJson(Object.values(PERFORMANCE_FIELD_DICTIONARIES)
    .map((dictionary) => ({
      fieldDictionaryVersion: dictionary.fieldDictionaryVersion,
      bucketSchemeVersion: dictionary.bucketSchemeVersion,
      ultrafastLabels: dictionary.speedModes.includes("ultrafast"),
    }))
    .sort((left, right) => (left.fieldDictionaryVersion < right.fieldDictionaryVersion ? -1
      : left.fieldDictionaryVersion > right.fieldDictionaryVersion ? 1 : 0)));
}

async function readAuditRow(client: PostgresClient, prepared: Prepared, operationId: string): Promise<AuditRow | null> {
  const rows = (await client.query<AuditRow>(
    `SELECT operation_id, action, outcome, details_json FROM ${prepared.tables.audit} WHERE operation_id = $1`,
    [operationId],
  )).rows;
  if (rows.length > 1) unavailable();
  return rows[0] ?? null;
}

async function lockRuntime(client: PostgresClient, prepared: Prepared): Promise<RuntimeRow> {
  const rows = (await client.query<RuntimeRow>(
    `SELECT state, policy_revision, schema_version, privacy_contract_version
       FROM ${prepared.tables.runtime}
      WHERE id = 1
      FOR UPDATE`,
  )).rows;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) unavailable();
  return row;
}

function activeAt(runtime: RuntimeRow, revision: number): boolean {
  return runtime.state === "active" && runtime.policy_revision === revision;
}

async function assertSchemaCurrent(client: PostgresClient, prepared: Prepared): Promise<void> {
  const status = await readSchemaReceipt(client, {
    schema: prepared.schema,
    expected: prepared.expectedMigrations,
  });
  if (status !== "current") unavailable();
}

function assertDeployment(prepared: Prepared, request: PostgresTelemetryRuntimeActivationRequest): void {
  if (prepared.sourceCommit === null) unavailable();
  if (request.deployment.sourceCommit !== prepared.sourceCommit
      || request.deployment.historySha256 !== prepared.historySha256) {
    conflict();
  }
}

async function assertRegistry(client: PostgresClient, prepared: Prepared): Promise<void> {
  const rows = (await client.query<RegistryRow>(
    `SELECT field_dictionary_version, bucket_scheme_version, ultrafast_labels
       FROM ${prepared.tables.registry}
      ORDER BY field_dictionary_version COLLATE "C"`,
  )).rows;
  const actual = canonicalJson(rows.map((row) => ({
    fieldDictionaryVersion: row.field_dictionary_version,
    bucketSchemeVersion: row.bucket_scheme_version,
    ultrafastLabels: row.ultrafast_labels,
  })));
  if (actual !== prepared.registry) unavailable();
}

function nowEpoch(prepared: Prepared): number {
  let now: unknown;
  try {
    now = prepared.clock();
  } catch {
    unavailable();
  }
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) unavailable();
  return now;
}

/** Finish an earlier writer's started row when the runtime already shows its activation. */
async function reconcileStarted(
  client: PostgresClient,
  prepared: Prepared,
  request: PostgresTelemetryRuntimeActivationRequest,
  row: AuditRow,
): Promise<PostgresTelemetryRuntimeActivationResult> {
  const details = parseDetails(row.details_json);
  if (details === null || !sameIntent(details, request)) conflict();
  await assertSchemaCurrent(client, prepared);
  assertDeployment(prepared, request);
  const runtime = await lockRuntime(client, prepared);
  if (!activeAt(runtime, request.expectedRevision + 1)) reconcileRequired();
  await finishPostgresAdminOperationInTransaction(client, prepared.schema, {
    operationId: request.idempotencyKey,
    outcome: "success",
    details: {
      ...intentDetails(request),
      fromRevision: request.expectedRevision,
      toRevision: request.expectedRevision + 1,
      state: "active",
      reconciled: true,
    },
  });
  return result(request.idempotencyKey, request, { replayed: true, reconciled: true });
}

/** An existing audit row for the key: a replay, a reconcile, or a refusal. */
async function existingOperation(
  client: PostgresClient,
  prepared: Prepared,
  request: PostgresTelemetryRuntimeActivationRequest,
  row: AuditRow,
): Promise<PostgresTelemetryRuntimeActivationResult> {
  if (row.action !== "run_maintenance") conflict();
  if (row.outcome === "success") return recordedResult(row, request);
  if (row.outcome === "started") return reconcileStarted(client, prepared, request, row);
  return conflict();
}

async function activate(
  client: PostgresClient,
  prepared: Prepared,
  request: PostgresTelemetryRuntimeActivationRequest,
  identityKey: string,
): Promise<PostgresTelemetryRuntimeActivationResult> {
  // 1. Replay by idempotency key.
  const existing = await readAuditRow(client, prepared, request.idempotencyKey);
  if (existing !== null) return existingOperation(client, prepared, request, existing);
  // 2. The schema this image was built for.
  await assertSchemaCurrent(client, prepared);
  // 3. The request names this deployment.
  assertDeployment(prepared, request);
  // 4. Collection controls, stable until commit.
  const controls = await readPostgresCollectionControls(client, prepared.schema, { forShare: true });
  if (controls.uploadRegistration !== true) throw new ApiError(503, "UPLOAD_REGISTRATION_DISABLED");
  if (controls.processing !== true) throw new ApiError(503, "PROCESSING_DISABLED");
  // 5. The runtime singleton.
  const runtime = await lockRuntime(client, prepared);
  if (runtime.state !== "staged" || runtime.policy_revision !== request.expectedRevision) {
    // A concurrent request with the same key may have won the lock and
    // committed; read committed lets this statement see it.
    const raced = await readAuditRow(client, prepared, request.idempotencyKey);
    if (raced !== null) return existingOperation(client, prepared, request, raced);
    conflict();
  }
  if (runtime.schema_version !== "model-performance-daily-v1"
      || runtime.privacy_contract_version !== "privacy-safe-model-performance-v1") {
    unavailable();
  }
  // 6. The dictionary registry equals this image's pairing.
  await assertRegistry(client, prepared);
  // 7. Begin the audit row inside this transaction, at its top level.
  const now = nowEpoch(prepared);
  const intent = intentDetails(request);
  const operationId = await beginPostgresAdminOperationInTransaction(client, prepared.schema, {
    operationId: request.idempotencyKey,
    action: "run_maintenance",
    identityKey,
    details: intent,
    nowIso: new Date(now).toISOString(),
  });
  // 8. Name it for 0079's runtime guard, for this transaction only.
  await client.query("SELECT set_config($1, $2, true)", [ACTIVATION_SETTING, operationId]);
  // 9. staged -> active, one policy revision, a strictly later updated_at.
  const updated = await client.query<{ policy_revision: unknown }>(
    `UPDATE ${prepared.tables.runtime}
        SET state = 'active',
            policy_revision = policy_revision + 1,
            updated_at = GREATEST(updated_at + interval '1 millisecond', $2::timestamptz)
      WHERE id = 1 AND state = 'staged' AND policy_revision = $1
      RETURNING policy_revision`,
    [request.expectedRevision, new Date(now).toISOString()],
  );
  if (updated.rows.length !== 1 || updated.rows[0]?.policy_revision !== request.expectedRevision + 1) {
    unavailable();
  }
  // 10. Finish the audit row.
  await finishPostgresAdminOperationInTransaction(client, prepared.schema, {
    operationId,
    outcome: "success",
    details: {
      ...intent,
      fromRevision: request.expectedRevision,
      toRevision: request.expectedRevision + 1,
      state: "active",
      reconciled: false,
    },
  });
  return result(operationId, request, { replayed: false, reconciled: false });
}

/**
 * Build the owner activation task for one primary schema. Structural
 * configuration errors throw a TypeError at construction; every request
 * failure is a content-free ApiError.
 */
export function createPostgresTelemetryRuntimeActivationTask(
  options: PostgresTelemetryRuntimeActivationOptions,
): PostgresTelemetryRuntimeActivationTask {
  if (!plainObject(options)) configurationInvalid("options");
  const { pool, schema, sourceCommit, expectedMigrations } = options;
  const clock = options.clock ?? Date.now;
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    configurationInvalid("pool");
  }
  if (typeof schema !== "string" || !SCHEMA_IDENTIFIER.test(schema)
      || schema.startsWith("pg_") || schema === "information_schema") {
    configurationInvalid("schema");
  }
  if (!validManifest(expectedMigrations)) configurationInvalid("expectedMigrations");
  if (typeof clock !== "function") configurationInvalid("clock");
  const quoted = quotePostgresIdentifier(schema);
  const manifest = Object.freeze(expectedMigrations.map(({ version, name, sha256 }) =>
    Object.freeze({ version, name, sha256 })));
  const registry = expectedRegistry();
  const commit = typeof sourceCommit === "string" && COMMIT.test(sourceCommit) ? sourceCommit : null;
  let preparedPromise: Promise<Prepared> | null = null;
  const prepare = (): Promise<Prepared> => {
    preparedPromise ??= postgresRuntimeMigrationHistorySha256(manifest).then((historySha256) => Object.freeze({
      schema,
      tables: Object.freeze({
        audit: `${quoted}."admin_action_audit"`,
        runtime: `${quoted}."telemetry_performance_runtime"`,
        registry: `${quoted}."telemetry_performance_field_dictionaries"`,
      }),
      expectedMigrations: manifest,
      historySha256,
      sourceCommit: commit,
      registry,
      clock,
    }));
    return preparedPromise;
  };

  return async (input) => {
    const body: unknown = plainObject(input) ? input.body : undefined;
    const request = parsePostgresTelemetryRuntimeActivationRequest(body);
    const identityKey: unknown = plainObject(input) ? input.identityKey : undefined;
    if (typeof identityKey !== "string" || identityKey.length === 0) unavailable();
    let prepared: Prepared;
    try {
      prepared = await prepare();
    } catch {
      preparedPromise = null;
      return unavailable();
    }
    try {
      return await withPostgresMutation(pool, (client) => activate(client, prepared, request, identityKey), {
        operation: "telemetry_runtime_activation",
        isolationLevel: "read_committed",
        statementTimeoutMilliseconds: TRANSACTION_TIMEOUT_MILLISECONDS,
        lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
        preserveSafeError: (error) => (error instanceof ApiError ? error : null),
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return unavailable();
    }
  };
}
