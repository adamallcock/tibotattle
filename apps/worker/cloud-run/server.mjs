#!/usr/bin/env node

import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createPostgresWorkerBackend } from "../src/backend-composition.ts";
import {
  handleRequest,
  isPostgresWorkerRequestPathSupported,
} from "../src/index.ts";
import { runPostgresScheduledMaintenance } from "../src/postgres-maintenance.ts";
import {
  assertAdmissionBindings,
  assertAttemptAllowed,
  assertUploadAuthorizationAllowed,
  assertUploadAuthorizationBindings,
} from "../src/admission.ts";
import { MAX_REQUEST_BYTES } from "../src/constants.ts";
import { readBoundedRequestBody } from "../src/bounded-body.ts";
import { createGcsQuarantineObjectStore } from "../src/gcs-quarantine-object-store.ts";
import { createGcsErasureBucketHistoryProof } from "../src/gcs-erasure-object-store.ts";
import { createFilesystemAssets } from "./assets.mjs";
import { assertPostgresScheduledMaintenanceEnabled } from "./postgres-maintenance-gate.mjs";
import { createPostgresUploadIngressBudget } from "../src/postgres-ingress-budget.ts";
import { createPostgresRateLimiter } from "../src/postgres-rate-limiter.ts";
import {
  ACCOUNTLESS_ENROLLMENT_MAX_REQUEST_BYTES,
  parseAccountlessEnrollmentJson,
} from "../src/accountless-enrollment.ts";
import {
  ACCOUNTLESS_UPLOAD_OWNER_MAX_REQUEST_BYTES,
  parseAccountlessOwnershipJson,
} from "../src/accountless-ownership.ts";
import { parseTelemetryV12AccountlessAuthorizationJson } from "../src/telemetry-transport-policy.ts";
import {
  authenticatePostgresAccountlessOwnerForV12Grant,
  createPostgresAccountlessUploadOwner,
  enrollPostgresAccountlessDevice,
  grantPostgresTelemetryV12AccountlessAuthorization,
} from "../src/postgres-accountless-enrollment.ts";
import {
  readPostgresDeviceSyncState,
  readPostgresDeviceSyncV12Capabilities,
} from "../src/postgres-device-sync.ts";
import { readPostgresV12DayCandidates } from "../src/postgres-v12-manifest-candidates.ts";
import {
  abandonPostgresDeviceUploadAuthorization,
  authenticatePostgresDevice,
  claimPostgresDeviceUploadAuthorization,
} from "../src/postgres-typed-v12-transport.ts";
import {
  persistPostgresTypedV12StagedChunk,
  registerPostgresTypedV12DayManifest,
} from "../src/postgres-typed-v12-admission.ts";
import { createPostgresDeviceUploadAuthorization } from "../src/postgres-upload-authorization.ts";
import { createPostgresTypedV12Domain } from "../src/postgres-typed-v12-domain.ts";
import { readPostgresTelemetryV12EffectivePage } from "../src/postgres-typed-v12-effective-reader.ts";
import {
  decryptSyntheticEnvelope,
  publicEnvelopeKey,
  sha256Hex,
} from "../src/crypto.ts";
import { validateTelemetryV12StagedChunk } from "../src/telemetry-v12-repository.ts";
import { validateTelemetryV12Envelope } from "@app-usagemonitor/telemetry-contract";
import { assertPostgresTelemetryTransportWriteAllowed } from "../src/postgres-telemetry-format-authority.ts";
import { TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION } from "@app-usagemonitor/telemetry-contract";
import { hasPostgresDeletionTombstone } from "../src/postgres-ledger-authority.ts";
import { setTimingSafeEqualImplementation } from "../src/crypto.ts";
import { createIamPool, createGoogleAccessTokenProvider, closeCloudSqlResources, normalizeIamUser } from "./cloud-sql.mjs";
import {
  bootstrapOwnerFixture,
  parseOwnerFixture,
  refreshOwnerSessionFixture,
} from "./owner-bootstrap.mjs";
import { installNodeTimingSafeEqual } from "./node-crypto-adapter.mjs";
import {
  CLOUD_RUN_IAM_TEST_TARGET,
  createPostgresTestV12DayManifestDispatch,
  createPostgresTestHealthDispatch,
  dispatchCloudRunHostRequest,
  isPrivatePostgresTestHost,
} from "./postgres-test-dispatch.mjs";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { POSTGRES_RUNTIME_MIGRATIONS } from "../src/postgres-runtime-schema.ts";
import {
  buildRequestUrl,
  createRequestOriginAllowlist,
  requestOriginForHost,
  sanitizeHeaders,
} from "./request-boundary.mjs";

installNodeTimingSafeEqual(setTimingSafeEqualImplementation);

const RATE_LIMIT_BINDINGS = Object.freeze([
  ["ENROLLMENT_RATE_LIMIT", "ENROLLMENT", 20, 60],
  ["RECOVERY_RATE_LIMIT", "RECOVERY", 20, 60],
  ["CLIENT_ATTEMPT_RATE_LIMIT", "CLIENT_ATTEMPT", 1_000, 60],
  ["PUBLIC_READ_RATE_LIMIT", "PUBLIC_READ", 1_000, 60],
  ["UPLOAD_AUTHORIZATION_RATE_LIMIT", "UPLOAD_AUTHORIZATION", 1_000, 60],
  ["UPLOAD_PRINCIPAL_RATE_LIMIT", "UPLOAD_PRINCIPAL", 1_000, 60],
  ["UPLOAD_INGRESS_REQUEST_RATE_LIMIT", "UPLOAD_INGRESS_REQUEST", 1_000, 60],
  ["UPLOAD_INGRESS_CLIENT_RATE_LIMIT", "UPLOAD_INGRESS_CLIENT", 1_000, 60],
]);
const RATE_LIMIT_INTEGER = /^\d+$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

function configurationError(code) { throw Object.assign(new Error(code), { code }); }
function optional(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}
function required(name) {
  const value = optional(name);
  if (value === undefined) configurationError(`${name}_MISSING`);
  return value;
}
function integer(name, fallback, minimum, maximum) {
  const value = optional(name, String(fallback));
  if (!RATE_LIMIT_INTEGER.test(value)) configurationError(`${name}_INVALID`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    configurationError(`${name}_INVALID`);
  }
  return parsed;
}
function sourceDigest() {
  const value = optional("SOURCE_CONTENT_DIGEST");
  if (value === undefined || !DIGEST_PATTERN.test(value)) configurationError("SOURCE_CONTENT_DIGEST_INVALID");
  return value;
}
function gcsHistoryProof() {
  const raw = required("GCS_ERASURE_BUCKET_HISTORY_PROOF");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    configurationError("GCS_ERASURE_BUCKET_HISTORY_PROOF_INVALID");
  }
  const proof = value !== null && typeof value === "object" && !Array.isArray(value)
    && value.proof !== undefined ? value.proof : value;
  try {
    return createGcsErasureBucketHistoryProof(proof);
  } catch {
    configurationError("GCS_ERASURE_BUCKET_HISTORY_PROOF_INVALID");
  }
}
function parseOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { configurationError(`${name}_INVALID`); }
  if (url.protocol !== "http:" && url.protocol !== "https:" || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
    configurationError(`${name}_INVALID`);
  }
  return url.origin;
}
function configuredHostOrigin() {
  return parseOrigin(required("HOST_ORIGIN"), "HOST_ORIGIN");
}
function configuredPublicOrigin() {
  const value = optional("PUBLIC_ORIGIN");
  return value === undefined ? undefined : parseOrigin(value, "PUBLIC_ORIGIN");
}
function configuredRequestOrigins(hostOrigin, publicOrigin) {
  const rawAdminOrigin = optional("ADMIN_HOST_ORIGIN");
  const adminHostOrigin = rawAdminOrigin === undefined
    ? undefined
    : parseOrigin(rawAdminOrigin, "ADMIN_HOST_ORIGIN");
  return createRequestOriginAllowlist({
    publicHostOrigin: hostOrigin,
    canonicalPublicOrigin: publicOrigin,
    adminHostOrigin,
  });
}
function postgresTestHttpMode() {
  const mode = optional("POSTGRES_TEST_HTTP_MODE");
  if (mode === undefined) return null;
  if (!new Set(["health-only", "health-and-v12-day-manifest", "cloud-run-iam"]).has(mode)) {
    configurationError("POSTGRES_TEST_HTTP_MODE_INVALID");
  }
  return mode;
}
function privatePostgresTestHostConfiguration(mode) {
  if (mode === "cloud-run-iam") {
    const listenHost = optional("HOST");
    const configuredPort = optional("PORT");
    const hostOrigin = optional("HOST_ORIGIN");
    const service = optional("K_SERVICE");
    if (!isPrivatePostgresTestHost({
      mode,
      project: CLOUD_RUN_IAM_TEST_TARGET.project,
      region: CLOUD_RUN_IAM_TEST_TARGET.region,
      service,
      listenHost,
      hostOrigin,
      port: configuredPort === String(CLOUD_RUN_IAM_TEST_TARGET.port)
        ? CLOUD_RUN_IAM_TEST_TARGET.port : null,
    }) || optional("PUBLIC_ORIGIN") !== undefined
        || optional("ADMIN_HOST_ORIGIN") !== undefined) {
      configurationError("POSTGRES_TEST_CLOUD_RUN_IAM_CONFIGURATION_INVALID");
    }
    return Object.freeze({
      listenHost,
      port: CLOUD_RUN_IAM_TEST_TARGET.port,
      hostOrigin,
      mode,
      requestOriginAllowlist: createRequestOriginAllowlist({ publicHostOrigin: hostOrigin }),
    });
  }
  const listenHost = optional("HOST", "127.0.0.1");
  const port = integer("PORT", 8080, 1, 65_535);
  const hostOrigin = configuredHostOrigin();
  if (!isPrivatePostgresTestHost({ listenHost, hostOrigin, port })
      || optional("PUBLIC_ORIGIN") !== undefined
      || optional("ADMIN_HOST_ORIGIN") !== undefined) {
    configurationError("POSTGRES_TEST_PRIVATE_HOST_CONFIGURATION_INVALID");
  }
  return Object.freeze({
    listenHost,
    port,
    hostOrigin,
    mode,
    requestOriginAllowlist: createRequestOriginAllowlist({ publicHostOrigin: hostOrigin }),
  });
}
function throwingD1(name) {
  return new Proxy(Object.create(null), {
    get() { throw new Error(`${name}_D1_DISABLED`); },
    has() { return false; },
  });
}
export {
  buildRequestUrl,
  createRequestOriginAllowlist,
  requestOriginForHost,
  sanitizeHeaders,
} from "./request-boundary.mjs";

function databaseConfig() {
  const primary = {
    role: "primary",
    schema: optional("PRIMARY_SCHEMA", "tibotattle"),
    database: required("PRIMARY_DATABASE"),
    instanceConnectionName: required("PRIMARY_INSTANCE_CONNECTION_NAME"),
    max: 3,
  };
  const ledger = {
    role: "ledger",
    schema: optional("LEDGER_SCHEMA", "tibotattle_ledger"),
    database: required("LEDGER_DATABASE"),
    instanceConnectionName: required("LEDGER_INSTANCE_CONNECTION_NAME"),
    max: 2,
  };
  return { primary, ledger };
}

export function validateCloudRunIamTestResources({ database, iamUser, bucket, historyProof }) {
  const target = CLOUD_RUN_IAM_TEST_TARGET;
  const matchesDatabaseTarget = (actual, expected) => actual?.database === expected.database
    && actual?.schema === expected.schema
    && actual?.instanceConnectionName === expected.instanceConnectionName;
  if (!matchesDatabaseTarget(database?.primary, target.postgres.primary)) {
    configurationError("POSTGRES_TEST_CLOUD_RUN_IAM_PRIMARY_TARGET_INVALID");
  }
  if (!matchesDatabaseTarget(database?.ledger, target.postgres.ledger)) {
    configurationError("POSTGRES_TEST_CLOUD_RUN_IAM_LEDGER_TARGET_INVALID");
  }
  if (iamUser !== target.postgres.iamUser) {
    configurationError("POSTGRES_TEST_CLOUD_RUN_IAM_USER_INVALID");
  }
  if (bucket !== target.gcsBucket) {
    configurationError("POSTGRES_TEST_CLOUD_RUN_IAM_BUCKET_INVALID");
  }
  if (historyProof?.bucket !== target.gcsBucket) {
    configurationError("POSTGRES_TEST_CLOUD_RUN_IAM_BUCKET_HISTORY_PROOF_INVALID");
  }
  return Object.freeze({ bucket: target.gcsBucket, historyProof });
}

function rateLimitBinding(pool, schemaOptions, keyHashSecret, [binding, name, defaultLimit, defaultPeriod]) {
  return createPostgresRateLimiter(pool, {
    primarySchema: schemaOptions.primarySchema,
    ledgerSchema: schemaOptions.ledgerSchema,
    name,
    limit: integer(`HOST_RATE_LIMIT_${binding}_LIMIT`, defaultLimit, 1, 10_000),
    periodSeconds: integer(`HOST_RATE_LIMIT_${binding}_PERIOD_SECONDS`, defaultPeriod, 1, 86_400),
    keyHashSecret,
  });
}

function configurationEnv({
  backend,
  objectStore,
  ingressBudget,
  primaryPool,
  schemaOptions,
  hostOrigin,
  publicOrigin,
  assets,
  rateLimitSecret,
  digest,
}) {
  const environment = optional("ENVIRONMENT", "synthetic-development");
  const enrollmentMode = optional("ENROLLMENT_MODE", environment === "synthetic-development" ? "local_open" : "disabled");
  const identitySecret = optional("IDENTITY_LINK_SECRET");
  const identityVersion = optional("IDENTITY_LINK_SECRET_VERSION");
  if (identitySecret !== undefined && identityVersion === undefined) configurationError("IDENTITY_LINK_SECRET_VERSION_MISSING");
  const envelopePublic = required("ENVELOPE_PUBLIC_JWK");
  const envelopePrivate = required("ENVELOPE_PRIVATE_JWK");
  const env = {
    ENVIRONMENT: environment,
    ENROLLMENT_MODE: enrollmentMode,
    ACCOUNTLESS_ENROLLMENT_MODE: optional("ACCOUNTLESS_ENROLLMENT_MODE", "disabled"),
    ACCOUNTLESS_OWNERSHIP_MODE: optional("ACCOUNTLESS_OWNERSHIP_MODE", "disabled"),
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    TELEMETRY_STORAGE_MODE: optional("TELEMETRY_STORAGE_MODE", "json"),
    TELEMETRY_STORAGE_NAMESPACE: optional("TELEMETRY_STORAGE_NAMESPACE", ""),
    UPLOAD_INGRESS_QUEUE_MODE: "disabled",
    UPLOAD_INGRESS_MAX_CONCURRENT: optional("UPLOAD_INGRESS_MAX_CONCURRENT", "8"),
    UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: optional("UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE", "120"),
    UPLOAD_INGRESS_BURST: optional("UPLOAD_INGRESS_BURST", "16"),
    UPLOAD_INGRESS_LEASE_SECONDS: optional("UPLOAD_INGRESS_LEASE_SECONDS", "90"),
    UPLOAD_INGRESS_BODY_TOTAL_SECONDS: optional("UPLOAD_INGRESS_BODY_TOTAL_SECONDS", "60"),
    UPLOAD_INGRESS_BODY_IDLE_SECONDS: optional("UPLOAD_INGRESS_BODY_IDLE_SECONDS", "15"),
    SIGN_IN_START_MAX_PER_MINUTE: optional("SIGN_IN_START_MAX_PER_MINUTE", "5"),
    PUBLIC_ANALYTICS_MODE: optional("PUBLIC_ANALYTICS_MODE", "enabled"),
    ALLOWANCE_RECONSTRUCTION_MODE: optional("ALLOWANCE_RECONSTRUCTION_MODE", "resumable"),
    INCREMENTAL_EXTERNAL_PARTICIPANTS: optional("INCREMENTAL_EXTERNAL_PARTICIPANTS", "authorized"),
    PUBLIC_ORIGIN: publicOrigin,
    ENVELOPE_PUBLIC_JWK: envelopePublic,
    ENVELOPE_PRIVATE_JWK: envelopePrivate,
    IDENTITY_LINK_SECRET: identitySecret,
    IDENTITY_LINK_SECRET_VERSION: identityVersion,
    ADMIN_IDENTITY_LINK_KEY: optional("ADMIN_IDENTITY_LINK_KEY"),
    GOOGLE_OIDC_CLIENT_ID: optional("GOOGLE_OIDC_CLIENT_ID"),
    GOOGLE_OIDC_CLIENT_SECRET: optional("GOOGLE_OIDC_CLIENT_SECRET"),
    APPLE_SERVICES_ID: optional("APPLE_SERVICES_ID"),
    APPLE_KEY_ID: optional("APPLE_KEY_ID"),
    APPLE_TEAM_ID: optional("APPLE_TEAM_ID"),
    APPLE_PRIVATE_KEY: optional("APPLE_PRIVATE_KEY"),
    ACCESS_TEAM_DOMAIN: optional("ACCESS_TEAM_DOMAIN"),
    ACCESS_AUD: optional("ACCESS_AUD"),
    ACCESS_ADMIN_EMAIL: optional("ACCESS_ADMIN_EMAIL"),
    DISTRIBUTION_ANALYTICS_ZONE_ID: optional("DISTRIBUTION_ANALYTICS_ZONE_ID"),
    SOURCE_CONTENT_DIGEST: digest,
    POSTGRES_WORKER_BACKEND: backend,
    POSTGRES_OBJECT_STORE: objectStore,
    UPLOAD_INGRESS_BUDGET: Object.freeze({ getByName: () => ingressBudget }),
    USAGE_MONITOR_DB: throwingD1("USAGE_MONITOR_DB"),
    DELETION_LEDGER: throwingD1("DELETION_LEDGER"),
    QUARANTINE: undefined,
    SPARKLE_RELEASES: undefined,
    ASSETS: assets,
  };
  for (const definition of RATE_LIMIT_BINDINGS) {
    env[definition[0]] = rateLimitBinding(primaryPool, schemaOptions, rateLimitSecret, definition);
  }
  return Object.freeze(env);
}

export async function createRuntime({ databaseOnly = false, dependencies = {} } = {}) {
  const postgresTestMode = databaseOnly ? null : postgresTestHttpMode();
  const postgresTestHttpEnabled = postgresTestMode !== null;
  if (!databaseOnly && !postgresTestHttpEnabled && !isPostgresWorkerRequestPathSupported()) {
    configurationError("POSTGRES_WORKER_REQUEST_PATH_UNSUPPORTED");
  }
  const privateHost = postgresTestHttpEnabled
    ? privatePostgresTestHostConfiguration(postgresTestMode) : null;
  const hostOrigin = databaseOnly ? null : privateHost?.hostOrigin ?? configuredHostOrigin();
  const publicOrigin = databaseOnly || postgresTestHttpEnabled
    ? undefined : configuredPublicOrigin();
  const requestOriginAllowlist = databaseOnly
    ? null
    : privateHost?.requestOriginAllowlist ?? configuredRequestOrigins(hostOrigin, publicOrigin);
  const digest = databaseOnly || postgresTestHttpEnabled ? undefined : sourceDigest();
  const database = databaseConfig();
  const iamUser = normalizeIamUser(required("POSTGRES_IAM_USER"), "POSTGRES_IAM_USER");
  const cloudRunIamResources = postgresTestMode === "cloud-run-iam"
    ? validateCloudRunIamTestResources({
      database,
      iamUser,
      bucket: required("GCS_BUCKET_NAME"),
      historyProof: gcsHistoryProof(),
    })
    : null;
  const connector = typeof dependencies.createConnector === "function"
    ? dependencies.createConnector()
    : new Connector();
  const createPool = dependencies.createIamPool ?? createIamPool;
  const pools = [];
  try {
    const primaryPool = await createPool({ connector, ...database.primary, user: iamUser });
    pools.push(primaryPool);
    const ledgerPool = await createPool({ connector, ...database.ledger, user: iamUser });
    pools.push(ledgerPool);
    const schemaOptions = {
      primarySchema: database.primary.schema,
      ledgerSchema: database.ledger.schema,
    };
    const backend = createPostgresWorkerBackend({
      primaryPool,
      ledgerPool,
      schemaOptions,
      sourceId: optional("POSTGRES_SOURCE_ID"),
      sourceNamespace: optional("POSTGRES_SOURCE_NAMESPACE"),
    });
    if (databaseOnly) {
      return {
        pools,
        connector,
        backend,
        primaryPool,
        ledgerPool,
        schemaOptions,
        hostOrigin,
        requestOriginAllowlist,
      };
    }
    if (postgresTestMode === "health-only") {
      return {
        pools,
        connector,
        backend,
        primaryPool,
        ledgerPool,
        schemaOptions,
        hostOrigin,
        requestOriginAllowlist,
        listenHost: privateHost.listenHost,
        listenPort: privateHost.port,
        postgresTestHostMode: privateHost.mode,
        postgresTestHealthDispatch: createPostgresTestHealthDispatch({
          primaryPool,
          ledgerPool,
          schemaOptions,
          expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
          privateOrigin: hostOrigin,
        }),
      };
    }
    if (postgresTestMode === "health-and-v12-day-manifest"
        || postgresTestMode === "cloud-run-iam") {
      const rateLimitSecret = required("POSTGRES_RATE_LIMIT_SECRET");
      if (new TextEncoder().encode(rateLimitSecret).byteLength < 32) {
        configurationError("POSTGRES_RATE_LIMIT_SECRET_INVALID");
      }
      const envelopePublicJwk = required("ENVELOPE_PUBLIC_JWK");
      const envelopePrivateJwk = required("ENVELOPE_PRIVATE_JWK");
      const bucket = cloudRunIamResources?.bucket ?? required("GCS_BUCKET_NAME");
      const accessToken = await (dependencies.createGoogleAccessTokenProvider
        ?? createGoogleAccessTokenProvider)();
      const objectStore = (dependencies.createGcsQuarantineObjectStore
        ?? createGcsQuarantineObjectStore)(
        bucket,
        accessToken,
        undefined,
        undefined,
        cloudRunIamResources?.historyProof ?? gcsHistoryProof(),
      );
      const admissionEnv = {
        ENVIRONMENT: optional("ENVIRONMENT", "synthetic-development"),
        IDENTITY_LINK_SECRET: optional("IDENTITY_LINK_SECRET"),
        ACCOUNTLESS_ENROLLMENT_MODE: optional("ACCOUNTLESS_ENROLLMENT_MODE", "disabled"),
        ACCOUNTLESS_OWNERSHIP_MODE: optional("ACCOUNTLESS_OWNERSHIP_MODE", "disabled"),
      };
      for (const definition of RATE_LIMIT_BINDINGS) {
        admissionEnv[definition[0]] = rateLimitBinding(
          primaryPool, schemaOptions, rateLimitSecret, definition,
        );
      }
      const healthDispatch = createPostgresTestHealthDispatch({
        primaryPool,
        ledgerPool,
        schemaOptions,
        expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
        privateOrigin: hostOrigin,
      });
      return {
        pools,
        connector,
        backend,
        primaryPool,
        ledgerPool,
        schemaOptions,
        hostOrigin,
        requestOriginAllowlist,
        listenHost: privateHost.listenHost,
        listenPort: privateHost.port,
        postgresTestHostMode: privateHost.mode,
        postgresTestDispatch: createPostgresTestV12DayManifestDispatch({
          primaryPool,
          ledgerPool,
          schemaOptions,
          accountlessAuthority: Object.freeze({
            authenticateV12Grant: authenticatePostgresAccountlessOwnerForV12Grant,
            enroll: enrollPostgresAccountlessDevice,
            createOwner: createPostgresAccountlessUploadOwner,
            grantV12: grantPostgresTelemetryV12AccountlessAuthorization,
            parseEnrollmentJson: parseAccountlessEnrollmentJson,
            parseOwnershipJson: parseAccountlessOwnershipJson,
            parseV12AuthorizationJson: parseTelemetryV12AccountlessAuthorizationJson,
            maxEnrollmentBytes: ACCOUNTLESS_ENROLLMENT_MAX_REQUEST_BYTES,
            maxOwnershipBytes: ACCOUNTLESS_UPLOAD_OWNER_MAX_REQUEST_BYTES,
          }),
          expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
          privateOrigin: hostOrigin,
          healthDispatch,
          admissionEnv: Object.freeze(admissionEnv),
          assertAdmissionBindings,
          assertAttemptAllowed,
          assertUploadAuthorizationBindings,
          assertUploadAuthorizationAllowed,
          assertPostgresV12UploadAllowed: (pool, device, nowEpoch, { schema }) =>
            assertPostgresTelemetryTransportWriteAllowed(
              pool,
              device,
              TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
              { nowEpoch, schema },
            ),
          createPostgresDeviceUploadAuthorization,
          authenticatePostgresDevice,
          hasPostgresDeletionTombstone,
          readPostgresDeviceSyncState,
          readPostgresDeviceSyncV12Capabilities,
          readPostgresV12DayCandidates,
          publicEnvelopeKey,
          sourceNamespace: backend.sourceIdentity.sourceNamespace,
          createPostgresTypedV12Domain,
          readPostgresTelemetryV12EffectivePage,
          registerPostgresTypedV12DayManifest,
          claimPostgresDeviceUploadAuthorization,
          abandonPostgresDeviceUploadAuthorization,
          persistPostgresTypedV12StagedChunk,
          decryptSyntheticEnvelope,
          validateTelemetryV12Envelope,
          validateTelemetryV12StagedChunk,
          sha256Hex,
          objectStore,
          envelopePublicJwk,
          envelopePrivateJwk,
          readBoundedRequestBody,
          maxRequestBytes: MAX_REQUEST_BYTES,
        }),
      };
    }
    const ingressBudget = createPostgresUploadIngressBudget(primaryPool, schemaOptions);
    const rateLimitSecret = required("POSTGRES_RATE_LIMIT_SECRET");
    if (new TextEncoder().encode(rateLimitSecret).byteLength < 32) configurationError("POSTGRES_RATE_LIMIT_SECRET_INVALID");
    const bucket = required("GCS_BUCKET_NAME");
    const accessToken = await (dependencies.createGoogleAccessTokenProvider
      ?? createGoogleAccessTokenProvider)();
    const objectStore = (dependencies.createGcsQuarantineObjectStore
      ?? createGcsQuarantineObjectStore)(
      bucket,
      accessToken,
      undefined,
      undefined,
      gcsHistoryProof(),
    );
    const assets = await createFilesystemAssets(
      optional("ASSET_ROOT", "/app/apps/worker/cloud-run/assets"),
    );
    const env = configurationEnv({
      backend,
      objectStore,
      ingressBudget,
      primaryPool,
      schemaOptions,
      hostOrigin,
      publicOrigin,
      assets,
      rateLimitSecret,
      digest,
    });
    return {
      env,
      pools,
      connector,
      backend,
      primaryPool,
      ledgerPool,
      schemaOptions,
      objectStore,
      hostOrigin,
      requestOriginAllowlist,
    };
  } catch (error) {
    await closeCloudSqlResources({ pools, connector }).catch(() => undefined);
    if (error?.code) throw error;
    throw new Error("CLOUD_RUN_RUNTIME_CONFIGURATION_FAILED");
  }
}

/** Compose only the resources required by the fail-closed scheduled job. */
export async function createScheduledMaintenanceRuntime({ dependencies = {} } = {}) {
  const database = databaseConfig();
  const iamUser = normalizeIamUser(required("POSTGRES_IAM_USER"), "POSTGRES_IAM_USER");
  const bucket = required("GCS_BUCKET_NAME");
  const historyProof = gcsHistoryProof();
  if (historyProof.bucket !== bucket) {
    configurationError("GCS_ERASURE_BUCKET_HISTORY_PROOF_INVALID");
  }
  const connector = typeof dependencies.createConnector === "function"
    ? dependencies.createConnector()
    : new Connector();
  const createPool = dependencies.createIamPool ?? createIamPool;
  const pools = [];
  try {
    const primaryPool = await createPool({ connector, ...database.primary, user: iamUser });
    pools.push(primaryPool);
    const ledgerPool = await createPool({ connector, ...database.ledger, user: iamUser });
    pools.push(ledgerPool);
    const accessToken = await (dependencies.createGoogleAccessTokenProvider
      ?? createGoogleAccessTokenProvider)();
    const objectStore = (dependencies.createGcsQuarantineObjectStore
      ?? createGcsQuarantineObjectStore)(bucket, accessToken, undefined, undefined, historyProof);
    return {
      pools,
      connector,
      primaryPool,
      ledgerPool,
      objectStore,
      schemaOptions: {
        primarySchema: database.primary.schema,
        ledgerSchema: database.ledger.schema,
      },
    };
  } catch (error) {
    await closeCloudSqlResources({ pools, connector }).catch(() => undefined);
    if (error?.code) throw error;
    throw new Error("CLOUD_RUN_SCHEDULED_MAINTENANCE_CONFIGURATION_FAILED");
  }
}

async function requestFromNode(req, requestOriginAllowlist, response) {
  const host = req.headers.host;
  const allowedOrigin = requestOriginForHost(host, requestOriginAllowlist);
  const url = buildRequestUrl(req.url ?? "/", allowedOrigin.host, allowedOrigin.origin);
  const headers = sanitizeHeaders(req.headers, {
    preserveAccessAssertion: allowedOrigin.kind === "admin",
  });
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  req.once("close", () => {
    if (!req.complete) controller.abort();
  });
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  const options = { method: req.method ?? "GET", headers };
  if (options.method !== "GET" && options.method !== "HEAD") {
    options.body = Readable.toWeb(req);
    options.duplex = "half";
  }
  options.signal = controller.signal;
  return new Request(url, options);
}

async function writeResponse(res, response) {
  const headers = {};
  for (const [name, value] of response.headers) headers[name] = value;
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [];
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (response.body === null) { res.end(); return; }
  await pipeline(Readable.fromWeb(response.body), res);
}

async function serve(runtime) {
  const server = http.createServer(async (req, res) => {
    try {
      const request = await requestFromNode(req, runtime.requestOriginAllowlist, res);
      const response = await dispatchCloudRunHostRequest(request, runtime, handleRequest);
      await writeResponse(res, response);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = Number.isSafeInteger(error?.status) ? error.status : 500;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "HOST_REQUEST_UNAVAILABLE" }));
    }
  });
  const port = runtime.listenPort ?? integer("PORT", 8080, 1, 65_535);
  const host = runtime.listenHost ?? optional("HOST", "127.0.0.1");
  if (host !== "127.0.0.1" && host !== "0.0.0.0") configurationError("HOST_INVALID");
  const postgresTestDispatch = runtime.postgresTestHealthDispatch || runtime.postgresTestDispatch;
  const cloudRunIamMode = runtime.postgresTestHostMode === "cloud-run-iam";
  if (cloudRunIamMode
      && (host !== CLOUD_RUN_IAM_TEST_TARGET.listenHost
        || port !== CLOUD_RUN_IAM_TEST_TARGET.port)) {
    configurationError("POSTGRES_TEST_CLOUD_RUN_IAM_CONFIGURATION_INVALID");
  }
  if (postgresTestDispatch && host !== "127.0.0.1" && !cloudRunIamMode) {
    configurationError("POSTGRES_TEST_PRIVATE_HOST_REQUIRED");
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await closeCloudSqlResources(runtime).catch(() => undefined);
    throw Object.assign(new Error("HOST_LISTEN_FAILED"), { code: "HOST_LISTEN_FAILED", cause: error });
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        finish();
      }, 8_500);
      server.close(finish);
    });
    await closeCloudSqlResources(runtime);
  };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
  return close;
}

async function main() {
  const postgresTestMode = postgresTestHttpMode();
  if (postgresTestMode
      && ["--refresh-owner-session", "--bootstrap-owner", "--scheduled"].some((flag) => process.argv.includes(flag))) {
    configurationError("POSTGRES_TEST_HTTP_COMMAND_UNSUPPORTED");
  }
  if (process.argv.includes("--refresh-owner-session")) {
    const runtime = await createRuntime({ databaseOnly: true });
    try {
      const fixture = parseOwnerFixture(
        required("ADMIN_OWNER_FIXTURE_JSON"),
        { requireStandardSessionTtl: true },
      );
      const previousFixture = parseOwnerFixture(
        required("ADMIN_OWNER_PREVIOUS_FIXTURE_JSON"),
        { allowExpired: true },
      );
      const result = await refreshOwnerSessionFixture({
        backend: runtime.backend,
        fixture,
        previousFixture,
      });
      console.log(JSON.stringify(result));
    } finally {
      await closeCloudSqlResources(runtime);
    }
    return;
  }
  if (process.argv.includes("--bootstrap-owner")) {
    const runtime = await createRuntime({ databaseOnly: true });
    try {
      const fixture = parseOwnerFixture(required("ADMIN_OWNER_FIXTURE_JSON"));
      const result = await bootstrapOwnerFixture({ backend: runtime.backend, fixture });
      console.log(JSON.stringify(result));
    } finally {
      await closeCloudSqlResources(runtime);
    }
    return;
  }
  if (process.argv.includes("--scheduled")) {
    try { assertPostgresScheduledMaintenanceEnabled(process.env); }
    catch { configurationError("POSTGRES_SCHEDULED_MAINTENANCE_DISABLED"); }
    const runtime = await createScheduledMaintenanceRuntime();
    try {
      const result = await runPostgresScheduledMaintenance({
        primaryPool: runtime.primaryPool,
        ledgerPool: runtime.ledgerPool,
        objectStore: runtime.objectStore,
        schema: runtime.schemaOptions,
        nowEpoch: Date.now(),
      });
      const status = result.outcome === "partial" ? "incomplete" : result.outcome;
      console.log(JSON.stringify({ ...result, status, mode: "scheduled" }));
      if (result.outcome !== "skipped") process.exitCode = 1;
    } finally {
      await closeCloudSqlResources(runtime);
    }
    return;
  }
  const runtime = await createRuntime();
  await serve(runtime);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({ status: "error", code: typeof error?.code === "string" ? error.code : "CLOUD_RUN_HOST_FAILED" }));
    process.exitCode = 1;
  }
}
