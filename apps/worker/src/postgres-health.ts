/**
 * RD-3 /api/health for the Cloud Run origin: the pure half (CR-6/CR-7 phase A).
 *
 * buildPostgresHealthBody reproduces the d43c8f92 Worker health body
 * (src/index.ts handleRequest, route 'health') in exact key order, with the
 * public collection state, public analytics availability and contracts
 * logic unchanged, minus checks.deletionLedger and
 * capabilities.deletionSafeRestoreReplay (append-only decision record).
 * postgresDeploymentSourceCommit is a verbatim port of the Worker's
 * configuredDeploymentSourceCommit.
 *
 * Nothing here reads storage. The readers (collection controls, the
 * retention row, SELECT 1 and the object-store probe) and
 * postgres-health-dispatch.mjs are phase B: the dispatcher needs LEAD-SIMP's
 * primary-only reader and the OD-2 outcome for objectStore.head (critic
 * build order step 2). The phase-B dispatcher runs, in Worker order:
 * configuredEnrollmentMode(env), the admission preflight, the readers and
 * probes, postgresDeploymentSourceCommit(env), then this builder.
 */
import { configuredAccountScopedIngestMode } from "./account-scoped-ingest";
import type { CollectionControls } from "./collection-controls";
import { ApiError } from "./errors";
import type { PostgresRetentionState } from "./postgres-lifecycle-state";
import { publicAnalyticsEnabled } from "./public-analytics-gate";
import {
  POSTGRES_HEALTH_CAPABILITY_FLAG_KEYS,
  POSTGRES_HEALTH_COLLECTION_STATES,
  POSTGRES_HEALTH_ENROLLMENT_MODES,
  POSTGRES_HEALTH_LIFECYCLE_STATES,
  POSTGRES_HEALTH_SOURCE_COMMIT_PATTERN,
  type PostgresHealthBody,
  type PostgresHealthCapabilityFlags,
  type PostgresHealthEnrollmentMode,
} from "./postgres-health-contract";

export {
  POSTGRES_HEALTH_CAPABILITY_FLAG_KEYS,
  POSTGRES_HEALTH_OMITTED_WORKER_KEYS,
  validatePostgresHealthBody,
  type PostgresHealthBody,
  type PostgresHealthCapabilityFlags,
} from "./postgres-health-contract";

/** The collection-control fields health reads (readPostgresCollectionControlsFromPool). */
export type PostgresHealthControls = Pick<
  CollectionControls,
  "state" | "enrollment" | "uploadRegistration" | "processing" | "publication"
>;

/** The retention fields health reads (readPostgresRetentionState). */
export type PostgresHealthRetention = Pick<
  PostgresRetentionState,
  "state" | "quarantineRetentionComplete" | "restoreReplayComplete"
>;

export interface PostgresHealthInput {
  /** The frozen Worker-shaped env (CR-3 createProductionWorkerEnv). */
  readonly env: Env;
  /** configuredEnrollmentMode(env), read first as the Worker does. */
  readonly enrollmentMode: PostgresHealthEnrollmentMode;
  readonly controls: PostgresHealthControls;
  readonly retention: PostgresHealthRetention;
  /** postgresDeploymentSourceCommit(env); null omits deployment, as the Worker does. */
  readonly sourceCommit: string | null;
  /** OD-CR-5, required: there are no default capability flags. */
  readonly capabilityFlags: PostgresHealthCapabilityFlags;
}

function invalid(code: string): never {
  throw Object.assign(new TypeError(code), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function includes(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

function validControls(value: unknown): value is PostgresHealthControls {
  return isRecord(value)
    && includes(POSTGRES_HEALTH_COLLECTION_STATES, value.state)
    && typeof value.enrollment === "boolean"
    && typeof value.uploadRegistration === "boolean"
    && typeof value.processing === "boolean"
    && typeof value.publication === "boolean";
}

function validRetention(value: unknown): value is PostgresHealthRetention {
  return isRecord(value)
    && includes(POSTGRES_HEALTH_LIFECYCLE_STATES, value.state)
    && typeof value.quarantineRetentionComplete === "boolean"
    && typeof value.restoreReplayComplete === "boolean";
}

function capabilityFlags(value: unknown): PostgresHealthCapabilityFlags {
  if (!isRecord(value)) invalid("POSTGRES_HEALTH_CAPABILITY_FLAGS_UNDECIDED");
  const keys = Object.keys(value);
  if (keys.length !== POSTGRES_HEALTH_CAPABILITY_FLAG_KEYS.length
      || POSTGRES_HEALTH_CAPABILITY_FLAG_KEYS.some((key) =>
        !Object.hasOwn(value, key) || typeof value[key] !== "boolean")) {
    invalid("POSTGRES_HEALTH_CAPABILITY_FLAGS_UNDECIDED");
  }
  return {
    participantExport: value.participantExport as boolean,
    coordinatedSignInAdmission: value.coordinatedSignInAdmission as boolean,
  };
}

/**
 * Verbatim port of the Worker's configuredDeploymentSourceCommit: absent is
 * null (the body then has no deployment block); anything but 7-64 lowercase
 * hex is 503 DEPLOYMENT_SOURCE_COMMIT_INVALID. The production configuration
 * (CR-3) always supplies 40 hex.
 */
export function postgresDeploymentSourceCommit(env: Env): string | null {
  const configured: unknown = Reflect.get(env, "DEPLOYMENT_SOURCE_COMMIT");
  if (configured === undefined) return null;
  if (typeof configured !== "string"
      || !POSTGRES_HEALTH_SOURCE_COMMIT_PATTERN.test(configured)) {
    throw new ApiError(503, "DEPLOYMENT_SOURCE_COMMIT_INVALID");
  }
  return configured;
}

/**
 * The Worker's health body for the given readings, minus the two keys the
 * append-only decision removes. A malformed input is a TypeError with a
 * closed code (POSTGRES_HEALTH_INPUT_INVALID, or
 * POSTGRES_HEALTH_CAPABILITY_FLAGS_UNDECIDED for missing OD-CR-5 flags); an
 * invalid ACCOUNT_SCOPED_INGEST_MODE is the Worker's 503
 * ACCOUNT_SCOPED_CONFIGURATION_INVALID, raised at the same point.
 */
export function buildPostgresHealthBody(input: PostgresHealthInput): PostgresHealthBody {
  if (!isRecord(input) || !isRecord(input.env)) invalid("POSTGRES_HEALTH_INPUT_INVALID");
  const flags = capabilityFlags(input.capabilityFlags);
  const { env, enrollmentMode, controls, retention, sourceCommit } = input;
  if (!includes(POSTGRES_HEALTH_ENROLLMENT_MODES, enrollmentMode)
      || !validControls(controls)
      || !validRetention(retention)
      || (sourceCommit !== null
        && (typeof sourceCommit !== "string" || !POSTGRES_HEALTH_SOURCE_COMMIT_PATTERN.test(sourceCommit)))) {
    invalid("POSTGRES_HEALTH_INPUT_INVALID");
  }
  const publicAnalyticsConfigured = publicAnalyticsEnabled(env);
  const publicAnalyticsAvailable = publicAnalyticsConfigured && controls.publication;
  const publicCollectionState = !publicAnalyticsConfigured && controls.state === "operational"
    ? "degraded"
    : controls.state;
  return {
    status: "ok",
    mode: "synthetic-and-private-telemetry",
    enrollmentMode,
    ...(sourceCommit === null ? {} : { deployment: { sourceCommit } }),
    collectionControls: {
      state: publicCollectionState,
      enrollment: controls.enrollment && enrollmentMode !== "disabled",
      uploadRegistration: controls.uploadRegistration,
      processing: controls.processing,
      publication: publicAnalyticsAvailable,
    },
    checks: {
      database: "ok",
      encryptedObjectStore: "reachable",
      lifecycle: retention.state,
      quarantineRetentionComplete: retention.quarantineRetentionComplete,
      restoreReplayComplete: retention.restoreReplayComplete,
    },
    contracts: {
      acceptedContribution: "telemetry-contribution-v0.1",
      accountScopedContribution: {
        schemaVersion: "telemetry-contribution-v0.2",
        status: configuredAccountScopedIngestMode(env) === "local_preview"
          ? "local_preview_loopback_only"
          : "implementation_disabled",
        externalParticipantsAuthorized: false,
      },
      incrementalContribution: {
        schemaVersion: "telemetry-contribution-v1.0",
        status: "implementation_ready",
        externalParticipantsAuthorized:
          Reflect.get(env, "INCREMENTAL_EXTERNAL_PARTICIPANTS") === "authorized",
      },
    },
    capabilities: {
      encryptedUpload: controls.processing,
      serverValidation: true,
      idempotentDeduplication: true,
      communityDaily: publicAnalyticsAvailable,
      participantExport: flags.participantExport,
      participantDeletion: false,
      boundedQuarantineRetention: true,
      ongoingDeviceUploadRegistration: controls.uploadRegistration,
      coordinatedSignInAdmission: flags.coordinatedSignInAdmission,
    },
  };
}
