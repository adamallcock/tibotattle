/**
 * RD-3: the closed GET /api/health DTO the Cloud Run origin answers (CR-6/CR-7
 * phase A, pure half).
 *
 * The behavioural reference is the d43c8f92 Worker health branch of
 * handleRequest (src/index.ts), minus the two keys the accepted append-only
 * decision removes on Google Cloud
 * (docs/decisions/2026-09-26-append-only-contributions.md, "Health on Google
 * Cloud"): checks.deletionLedger, because there is no online deletion
 * ledger, and capabilities.deletionSafeRestoreReplay, because there is no
 * restore replay. participantDeletion stays false and
 * checks.restoreReplayComplete stays.
 *
 * Import-free so plain Node scripts (scripts/gcp-origin-verifier-smoke.mjs)
 * can validate a live body without a bundler.
 */

/** Worker health keys the GCP origin omits (append-only decision record). */
export const POSTGRES_HEALTH_OMITTED_WORKER_KEYS = Object.freeze([
  "checks.deletionLedger",
  "capabilities.deletionSafeRestoreReplay",
] as const);

/**
 * OD-CR-5 (open owner decision): the two capability flags for features the
 * origin does not serve yet. The Worker reports both as constant true; the
 * owner chooses between keeping those constants and deriving them from the
 * route registry. The builder takes both as required booleans, no default.
 */
export const POSTGRES_HEALTH_CAPABILITY_FLAG_KEYS = Object.freeze([
  "participantExport",
  "coordinatedSignInAdmission",
] as const);

export const POSTGRES_HEALTH_BODY_KEYS = Object.freeze([
  "status",
  "mode",
  "enrollmentMode",
  "deployment",
  "collectionControls",
  "checks",
  "contracts",
  "capabilities",
] as const);

export const POSTGRES_HEALTH_DEPLOYMENT_KEYS = Object.freeze(["sourceCommit"] as const);

export const POSTGRES_HEALTH_COLLECTION_CONTROL_KEYS = Object.freeze([
  "state",
  "enrollment",
  "uploadRegistration",
  "processing",
  "publication",
] as const);

export const POSTGRES_HEALTH_CHECK_KEYS = Object.freeze([
  "database",
  "encryptedObjectStore",
  "lifecycle",
  "quarantineRetentionComplete",
  "restoreReplayComplete",
] as const);

export const POSTGRES_HEALTH_CONTRACT_KEYS = Object.freeze([
  "acceptedContribution",
  "accountScopedContribution",
  "incrementalContribution",
] as const);

export const POSTGRES_HEALTH_ACCOUNT_SCOPED_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "externalParticipantsAuthorized",
] as const);

export const POSTGRES_HEALTH_INCREMENTAL_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "externalParticipantsAuthorized",
] as const);

export const POSTGRES_HEALTH_CAPABILITY_KEYS = Object.freeze([
  "encryptedUpload",
  "serverValidation",
  "idempotentDeduplication",
  "communityDaily",
  "participantExport",
  "participantDeletion",
  "boundedQuarantineRetention",
  "ongoingDeviceUploadRegistration",
  "coordinatedSignInAdmission",
] as const);

/** The Worker's ENROLLMENT_MODES (src/constants.ts). */
export const POSTGRES_HEALTH_ENROLLMENT_MODES = Object.freeze([
  "local_open",
  "open",
  "invite_only",
  "disabled",
] as const);

export const POSTGRES_HEALTH_COLLECTION_STATES = Object.freeze([
  "operational",
  "degraded",
  "contained",
] as const);

export const POSTGRES_HEALTH_LIFECYCLE_STATES = Object.freeze([
  "never_run",
  "running",
  "completed",
  "failed",
] as const);

/** The Worker's DEPLOYMENT_SOURCE_COMMIT_PATTERN (src/index.ts). */
export const POSTGRES_HEALTH_SOURCE_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/u;

export type PostgresHealthEnrollmentMode = (typeof POSTGRES_HEALTH_ENROLLMENT_MODES)[number];
export type PostgresHealthCollectionState = (typeof POSTGRES_HEALTH_COLLECTION_STATES)[number];
export type PostgresHealthLifecycleState = (typeof POSTGRES_HEALTH_LIFECYCLE_STATES)[number];

export interface PostgresHealthCapabilityFlags {
  readonly participantExport: boolean;
  readonly coordinatedSignInAdmission: boolean;
}

export interface PostgresHealthBody {
  readonly status: "ok";
  readonly mode: "synthetic-and-private-telemetry";
  readonly enrollmentMode: PostgresHealthEnrollmentMode;
  readonly deployment?: Readonly<{ sourceCommit: string }>;
  readonly collectionControls: Readonly<{
    state: PostgresHealthCollectionState;
    enrollment: boolean;
    uploadRegistration: boolean;
    processing: boolean;
    publication: boolean;
  }>;
  readonly checks: Readonly<{
    database: "ok";
    encryptedObjectStore: "reachable";
    lifecycle: PostgresHealthLifecycleState;
    quarantineRetentionComplete: boolean;
    restoreReplayComplete: boolean;
  }>;
  readonly contracts: Readonly<{
    acceptedContribution: "telemetry-contribution-v0.1";
    accountScopedContribution: Readonly<{
      schemaVersion: "telemetry-contribution-v0.2";
      status: "local_preview_loopback_only" | "implementation_disabled";
      externalParticipantsAuthorized: false;
    }>;
    incrementalContribution: Readonly<{
      schemaVersion: "telemetry-contribution-v1.0";
      status: "implementation_ready";
      externalParticipantsAuthorized: boolean;
    }>;
  }>;
  readonly capabilities: Readonly<{
    encryptedUpload: boolean;
    serverValidation: true;
    idempotentDeduplication: true;
    communityDaily: boolean;
    participantExport: boolean;
    participantDeletion: false;
    boundedQuarantineRetention: true;
    ongoingDeviceUploadRegistration: boolean;
    coordinatedSignInAdmission: boolean;
  }>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function section(
  violations: string[],
  parent: Record<string, unknown>,
  name: string,
  keys: readonly string[],
): Record<string, unknown> | null {
  const value = parent[name];
  if (!isPlainRecord(value)) {
    violations.push(name);
    return null;
  }
  if (!exactKeys(value, keys)) violations.push(`${name}:keys`);
  return value;
}

function booleans(
  violations: string[],
  path: string,
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (typeof value[key] !== "boolean") violations.push(`${path}.${key}`);
  }
}

/**
 * Validate a health body against the closed GCP contract: exact keys in
 * Worker order (so the two omitted Worker keys, and any internal name, are
 * refused), the Worker's constants, a present deployment.sourceCommit (the
 * production configuration always supplies one) and the Worker's
 * derivations between collection controls and capabilities. Returns the
 * violated paths, each a schema name and never a value; empty means valid.
 */
export function validatePostgresHealthBody(value: unknown): readonly string[] {
  const violations: string[] = [];
  if (!isPlainRecord(value)) return Object.freeze(["body"]);
  if (!exactKeys(value, POSTGRES_HEALTH_BODY_KEYS)) violations.push("body:keys");
  if (value.status !== "ok") violations.push("status");
  if (value.mode !== "synthetic-and-private-telemetry") violations.push("mode");
  if (!oneOf(value.enrollmentMode, POSTGRES_HEALTH_ENROLLMENT_MODES)) violations.push("enrollmentMode");
  const deployment = section(violations, value, "deployment", POSTGRES_HEALTH_DEPLOYMENT_KEYS);
  if (deployment !== null
      && (typeof deployment.sourceCommit !== "string"
        || !POSTGRES_HEALTH_SOURCE_COMMIT_PATTERN.test(deployment.sourceCommit))) {
    violations.push("deployment.sourceCommit");
  }
  const controls = section(violations, value, "collectionControls", POSTGRES_HEALTH_COLLECTION_CONTROL_KEYS);
  if (controls !== null) {
    if (!oneOf(controls.state, POSTGRES_HEALTH_COLLECTION_STATES)) violations.push("collectionControls.state");
    booleans(violations, "collectionControls", controls,
      ["enrollment", "uploadRegistration", "processing", "publication"]);
    if (controls.enrollment === true && value.enrollmentMode === "disabled") {
      violations.push("collectionControls.enrollment:inconsistent");
    }
  }
  const checks = section(violations, value, "checks", POSTGRES_HEALTH_CHECK_KEYS);
  if (checks !== null) {
    if (checks.database !== "ok") violations.push("checks.database");
    if (checks.encryptedObjectStore !== "reachable") violations.push("checks.encryptedObjectStore");
    if (!oneOf(checks.lifecycle, POSTGRES_HEALTH_LIFECYCLE_STATES)) violations.push("checks.lifecycle");
    booleans(violations, "checks", checks, ["quarantineRetentionComplete", "restoreReplayComplete"]);
  }
  const contracts = section(violations, value, "contracts", POSTGRES_HEALTH_CONTRACT_KEYS);
  if (contracts !== null) {
    if (contracts.acceptedContribution !== "telemetry-contribution-v0.1") {
      violations.push("contracts.acceptedContribution");
    }
    const accountScoped = section(violations, contracts, "accountScopedContribution",
      POSTGRES_HEALTH_ACCOUNT_SCOPED_KEYS);
    if (accountScoped !== null
        && (accountScoped.schemaVersion !== "telemetry-contribution-v0.2"
          || !oneOf(accountScoped.status, ["local_preview_loopback_only", "implementation_disabled"])
          || accountScoped.externalParticipantsAuthorized !== false)) {
      violations.push("contracts.accountScopedContribution");
    }
    const incremental = section(violations, contracts, "incrementalContribution",
      POSTGRES_HEALTH_INCREMENTAL_KEYS);
    if (incremental !== null
        && (incremental.schemaVersion !== "telemetry-contribution-v1.0"
          || incremental.status !== "implementation_ready"
          || typeof incremental.externalParticipantsAuthorized !== "boolean")) {
      violations.push("contracts.incrementalContribution");
    }
  }
  const capabilities = section(violations, value, "capabilities", POSTGRES_HEALTH_CAPABILITY_KEYS);
  if (capabilities !== null) {
    booleans(violations, "capabilities", capabilities, [
      "encryptedUpload",
      "communityDaily",
      "participantExport",
      "ongoingDeviceUploadRegistration",
      "coordinatedSignInAdmission",
    ]);
    if (capabilities.serverValidation !== true) violations.push("capabilities.serverValidation");
    if (capabilities.idempotentDeduplication !== true) violations.push("capabilities.idempotentDeduplication");
    if (capabilities.participantDeletion !== false) violations.push("capabilities.participantDeletion");
    if (capabilities.boundedQuarantineRetention !== true) {
      violations.push("capabilities.boundedQuarantineRetention");
    }
    if (controls !== null) {
      if (capabilities.encryptedUpload !== controls.processing) {
        violations.push("capabilities.encryptedUpload:inconsistent");
      }
      if (capabilities.communityDaily !== controls.publication) {
        violations.push("capabilities.communityDaily:inconsistent");
      }
      if (capabilities.ongoingDeviceUploadRegistration !== controls.uploadRegistration) {
        violations.push("capabilities.ongoingDeviceUploadRegistration:inconsistent");
      }
    }
  }
  return Object.freeze([...new Set(violations)]);
}
