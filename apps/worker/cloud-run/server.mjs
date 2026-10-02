#!/usr/bin/env node

import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createPostgresWorkerBackend } from "../src/backend-composition.ts";
import { readPostgresPublishedCommunityDaily } from "../src/postgres-community-daily.ts";
import {
  assertPostgresPersonalSessionCsrf,
  authenticatePostgresPersonalSession,
  listPostgresParticipantDevices,
  revokePostgresParticipantDevice,
} from "../src/postgres-personal-devices.ts";
import {
  authenticatePostgresPersonalSessionForRead,
  revokePostgresPersonalSession,
} from "../src/postgres-personal-session.ts";
import { clearedSessionCookie } from "../src/session.ts";
import {
  handleRequest,
  isPostgresWorkerRequestPathSupported,
} from "../src/index.ts";
import { runPostgresScheduledMaintenance } from "../src/postgres-maintenance.ts";
import { assertAccountScopedLocalPreview } from "../src/account-scoped-ingest.ts";
import { createPostgresDevicePairing } from "../src/postgres-device-pairing.ts";
import { claimPostgresDevicePairing } from "../src/postgres-device-pairing-claim.ts";
import { grantPostgresTelemetryV12Consent } from "../src/postgres-telemetry-v12-consent.ts";
import {
  assertAdmissionBindings,
  assertAttemptAllowed,
  assertPublicAggregateReadAllowed,
  assertUploadAuthorizationAllowed,
  assertUploadAuthorizationBindings,
  assertUploadIngressRequestAllowed,
} from "../src/admission.ts";
import { MAX_REQUEST_BYTES, TELEMETRY_CONSENT_VERSION } from "../src/constants.ts";
import { readBoundedRequestBody } from "../src/bounded-body.ts";
import {
  createGcsQuarantineObjectStore,
  GCS_QUARANTINE_BUCKET_HISTORY_PROOF_SETTING,
  parseGcsQuarantineBucketHistoryProof,
} from "../src/gcs-quarantine-object-store.ts";
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
  ACCOUNTLESS_RENEWAL_MAX_REQUEST_BYTES,
  parseAccountlessRenewalJson,
} from "../src/accountless-renewal.ts";
import {
  authenticatePostgresAccountlessOwnerForV12Grant,
  createPostgresAccountlessUploadOwner,
  enrollPostgresAccountlessDevice,
  grantPostgresTelemetryV12AccountlessAuthorization,
} from "../src/postgres-accountless-enrollment.ts";
import { renewPostgresAccountlessUploadOwner } from "../src/postgres-accountless-renewal.ts";
import {
  POSTGRES_DEVICE_CREDENTIAL_RENEWAL_MAX_REQUEST_BYTES,
  parsePostgresDeviceCredentialRenewalJson,
  renewPostgresDeviceCredential,
} from "../src/postgres-device-credential-renewal.ts";
import {
  readPostgresDeviceSyncCapabilities,
  readPostgresDeviceSyncV12Capabilities,
} from "../src/postgres-device-sync.ts";
import {
  readPostgresDeviceSyncState,
  readPostgresDeviceSyncManifest,
} from "../src/postgres-device-sync-reads.ts";
import { disconnectPostgresAuthenticatedDevice } from "../src/postgres-device-disconnect.ts";
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
// Legacy intake adapters (IN-2 v1.1, IN-3 v1.0/v0.1), composed by
// ./origin-intake-composition.mjs beside the v1.2 routes.
import * as postgresTelemetryV11Live from "../src/postgres-telemetry-v11-live-admission.ts";
import * as postgresDeviceBearerAuth from "../src/postgres-device-bearer-auth.ts";
import * as postgresTypedV12Transport from "../src/postgres-typed-v12-transport.ts";
import * as postgresPersonalDevices from "../src/postgres-personal-devices.ts";
import * as postgresCollectionControls from "../src/postgres-collection-controls.ts";
import * as workerCrypto from "../src/crypto.ts";
import * as boundedBody from "../src/bounded-body.ts";
import * as postgresLegacyContributionAdmission from "../src/postgres-legacy-contribution-admission.ts";
import * as postgresTransportWriteAuthority from "../src/postgres-transport-write-authority.ts";
import * as postgresUploadAuthorization from "../src/postgres-upload-authorization.ts";
import { setTimingSafeEqualImplementation } from "../src/crypto.ts";
import { createIamPool, createGoogleAccessTokenProvider, closeCloudSqlResources, normalizeIamUser } from "./cloud-sql.mjs";
import {
  bootstrapOwnerFixture,
  parseOwnerFixture,
  refreshOwnerSessionFixture,
} from "./owner-bootstrap.mjs";
import { installNodeTimingSafeEqual } from "./node-crypto-adapter.mjs";
import {
  createPostgresTestCommunityDailyDispatch,
  createPostgresTestDevicePairingDispatch,
  createPostgresTestDevicePairingClaimDispatch,
  createPostgresTestParticipantDevicesDispatch,
  createPostgresTestPersonalSessionDispatch,
  createPostgresTestTelemetryV12ConsentDispatch,
  createPostgresTestV12DayManifestDispatch,
  createPostgresTestHealthDispatch,
  createPostgresTestStorageReceiptCheck,
  dispatchCloudRunHostRequest,
  isPrivatePostgresTestHost,
} from "./postgres-test-dispatch.mjs";
import { createOriginIntakeComposition, originIntakeServedInMode } from "./origin-intake-composition.mjs";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { POSTGRES_RUNTIME_MIGRATIONS } from "../src/postgres-runtime-schema.ts";
import { WORKER_ROUTE_POLICY } from "../src/route-registry.ts";
import {
  createOriginRouteModuleRegistry,
  ORIGIN_OVERRIDABLE_BUILT_INS,
} from "./origin-route-modules.mjs";
import {
  analyticsV2TestClock,
  FASTPATH_TEST_MODE,
  fastpathTestDatabaseConfig,
  fastpathTestRouteModules,
} from "./origin-fastpath-mode.mjs";
import { createAnalyticsV2CommunityDailyRoute } from "../src/analytics-v2/community-daily-route.ts";
import { createEdgeAdmissionLimiters } from "./postgres-edge-admission-limiters.mjs";
import {
  EDGE_TEST_PUBLIC_ORIGIN,
  EdgeTestBoundaryRefusal,
  composeEdgeTestOrigin,
  edgeTestAdmissionEnv,
  edgeTestRequestFromNode,
  isEdgeOriginBoundaryRefusal,
  isEdgeTestCloudListen,
  lingerAfterEarlyEdgeTestAnswer,
  logEdgeTestBoundaryRefusal,
  readEdgeTestOriginConfiguration,
  writeEdgeTestBoundaryRefusal,
} from "./origin-edge-test-mode.mjs";
import {
  buildPublicGoogleRequestUrl,
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
/**
 * Owner decision OD-2 (2026-10-02): the quarantine bucket's birth proof,
 * GCS_QUARANTINE_BUCKET_HISTORY_PROOF, as the OPS-2 bucket-birth receipt's
 * proof record for exactly `bucket`. The retired
 * GCS_ERASURE_BUCKET_HISTORY_PROOF is refused even when empty, so a stale
 * deployment fails closed instead of starting without the proof it expected.
 */
function quarantineBucketHistoryProof(bucket) {
  if (Object.hasOwn(process.env, "GCS_ERASURE_BUCKET_HISTORY_PROOF")) {
    configurationError("GCS_ERASURE_BUCKET_HISTORY_PROOF_RETIRED");
  }
  const raw = required(GCS_QUARANTINE_BUCKET_HISTORY_PROOF_SETTING);
  try {
    return parseGcsQuarantineBucketHistoryProof(raw, bucket);
  } catch {
    configurationError("GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID");
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
  // The cloud-run-iam mode (the A2 deployed test host) is retired (owner
  // decision OD-6, 2026-10-02) and is refused like any unknown mode.
  if (!new Set([
    "health-only", "health-and-v12-day-manifest", FASTPATH_TEST_MODE,
  ]).has(mode)) {
    configurationError("POSTGRES_TEST_HTTP_MODE_INVALID");
  }
  return mode;
}
function privatePostgresTestHostConfiguration(mode, edgeTestOrigin = null) {
  if (edgeTestOrigin !== null) {
    // EDGE_ORIGIN_MODE=edge-test (origin-edge-test-mode.mjs) validated the
    // listen pair: loopback exactly as below, or the pinned Cloud Run pair.
    const { host, port, hostOrigin } = edgeTestOrigin.listen;
    return Object.freeze({
      listenHost: host,
      port,
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
  buildPublicGoogleRequestUrl,
  buildRequestUrl,
  createRequestOriginAllowlist,
  requestOriginForHost,
  sanitizeHeaders,
} from "./request-boundary.mjs";

/**
 * The deletion ledger is retired (decisions D2, D4 and D6 of 2026-09-26):
 * the test hosts and the scheduled job use one database and refuse any
 * LEDGER_ setting, so a stale deployment fails closed instead of being
 * served without the second pool it expected. (The production profiles of
 * postgres-production-configuration.mjs refuse the same settings with
 * their own codes.)
 */
function assertNoLedgerConfiguration(env = process.env) {
  if (Object.keys(env).some((name) => name.startsWith("LEDGER_"))) {
    configurationError("POSTGRES_LEDGER_CONFIGURATION_RETIRED");
  }
}

function databaseConfig() {
  assertNoLedgerConfiguration();
  const primary = {
    role: "primary",
    schema: optional("PRIMARY_SCHEMA", "tibotattle"),
    database: required("PRIMARY_DATABASE"),
    instanceConnectionName: required("PRIMARY_INSTANCE_CONNECTION_NAME"),
    max: 3,
  };
  return { primary };
}

function rateLimitBinding(pool, schemaOptions, keyHashSecret, [binding, name, defaultLimit, defaultPeriod]) {
  return createPostgresRateLimiter(pool, {
    primarySchema: schemaOptions.primarySchema,
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
  assertNoLedgerConfiguration();
  const postgresTestMode = databaseOnly ? null : postgresTestHttpMode();
  const postgresTestHttpEnabled = postgresTestMode !== null;
  if (!databaseOnly && !postgresTestHttpEnabled && !isPostgresWorkerRequestPathSupported()) {
    configurationError("POSTGRES_WORKER_REQUEST_PATH_UNSUPPORTED");
  }
  // EDGE_ORIGIN_MODE alone never enables a request path: it is read after the
  // refusal above and is refused outside fastpath-test.
  const edgeTestOrigin = databaseOnly
    ? null : readEdgeTestOriginConfiguration(process.env, { postgresTestMode });
  const privateHost = postgresTestHttpEnabled
    ? privatePostgresTestHostConfiguration(postgresTestMode, edgeTestOrigin) : null;
  const hostOrigin = databaseOnly ? null : privateHost?.hostOrigin ?? configuredHostOrigin();
  const publicOrigin = databaseOnly ? undefined : postgresTestHttpEnabled
    ? privateHost?.publicOrigin : configuredPublicOrigin();
  const requestOriginAllowlist = databaseOnly
    ? null
    : privateHost?.requestOriginAllowlist ?? configuredRequestOrigins(hostOrigin, publicOrigin);
  const digest = databaseOnly || postgresTestHttpEnabled ? undefined : sourceDigest();
  // fastpath-test serves a rehearsal schema only; refuse any other schema
  // before a connector or pool exists.
  const database = postgresTestMode === FASTPATH_TEST_MODE
    ? fastpathTestDatabaseConfig(process.env)
    : databaseConfig();
  const iamUser = normalizeIamUser(required("POSTGRES_IAM_USER"), "POSTGRES_IAM_USER");
  // Every composition that builds the quarantine store reads its bucket and
  // the bucket's birth proof (OD-2) before a connector or pool exists.
  const quarantineBucket = databaseOnly || postgresTestMode === "health-only"
    ? null : required("GCS_BUCKET_NAME");
  const quarantineHistoryProof = quarantineBucket === null
    ? null : quarantineBucketHistoryProof(quarantineBucket);
  const connector = typeof dependencies.createConnector === "function"
    ? dependencies.createConnector()
    : new Connector();
  const createPool = dependencies.createIamPool ?? createIamPool;
  const pools = [];
  try {
    const primaryPool = await createPool({ connector, ...database.primary, user: iamUser });
    pools.push(primaryPool);
    const schemaOptions = {
      primarySchema: database.primary.schema,
    };
    const backend = createPostgresWorkerBackend({
      primaryPool,
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
        schemaOptions,
        hostOrigin,
        requestOriginAllowlist,
        listenHost: privateHost.listenHost,
        listenPort: privateHost.port,
        postgresTestHostMode: privateHost.mode,
        postgresTestHealthDispatch: createPostgresTestHealthDispatch({
          primaryPool,
          schemaOptions,
          expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
          privateOrigin: hostOrigin,
        }),
      };
    }
    if (postgresTestMode === "health-and-v12-day-manifest"
        || postgresTestMode === FASTPATH_TEST_MODE) {
      const rateLimitSecret = required("POSTGRES_RATE_LIMIT_SECRET");
      if (new TextEncoder().encode(rateLimitSecret).byteLength < 32) {
        configurationError("POSTGRES_RATE_LIMIT_SECRET_INVALID");
      }
      const envelopePublicJwk = required("ENVELOPE_PUBLIC_JWK");
      const envelopePrivateJwk = required("ENVELOPE_PRIVATE_JWK");
      const accessToken = await (dependencies.createGoogleAccessTokenProvider
        ?? createGoogleAccessTokenProvider)();
      const objectStore = (dependencies.createGcsQuarantineObjectStore
        ?? createGcsQuarantineObjectStore)(
        quarantineBucket, accessToken, undefined, undefined, quarantineHistoryProof,
      );
      // In edge-test the six edge-tier bindings replay the edge's outcome
      // (EP-6) and every privateOrigin is the public origin EP-6 rebuilds on.
      const edgeAdmission = edgeTestOrigin === null ? null : createEdgeAdmissionLimiters();
      const dispatchOrigin = edgeTestOrigin === null ? hostOrigin : EDGE_TEST_PUBLIC_ORIGIN;
      const originAdmissionEnv = {
        ENVIRONMENT: optional("ENVIRONMENT", "synthetic-development"),
        ENROLLMENT_MODE: optional("ENROLLMENT_MODE", "disabled"),
        IDENTITY_LINK_SECRET: optional("IDENTITY_LINK_SECRET"),
        IDENTITY_LINK_SECRET_VERSION: optional("IDENTITY_LINK_SECRET_VERSION"),
        GOOGLE_OIDC_CLIENT_ID: optional("GOOGLE_OIDC_CLIENT_ID"),
        GOOGLE_OIDC_CLIENT_SECRET: optional("GOOGLE_OIDC_CLIENT_SECRET"),
        SIGN_IN_START_MAX_PER_MINUTE: optional("SIGN_IN_START_MAX_PER_MINUTE", "120"),
        ACCOUNTLESS_ENROLLMENT_MODE: optional("ACCOUNTLESS_ENROLLMENT_MODE", "disabled"),
        ACCOUNTLESS_OWNERSHIP_MODE: optional("ACCOUNTLESS_OWNERSHIP_MODE", "disabled"),
      };
      for (const definition of RATE_LIMIT_BINDINGS) {
        originAdmissionEnv[definition[0]] = rateLimitBinding(
          primaryPool, schemaOptions, rateLimitSecret, definition,
        );
      }
      const admissionEnv = edgeAdmission === null
        ? originAdmissionEnv
        : edgeTestAdmissionEnv(originAdmissionEnv, edgeAdmission);
      const healthDispatch = createPostgresTestHealthDispatch({
        primaryPool,
        schemaOptions,
        expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
        privateOrigin: dispatchOrigin,
      });
      const communityDailyDispatch = createPostgresTestCommunityDailyDispatch({
        primaryPool,
        schemaOptions,
        sourceIdentity: backend.sourceIdentity,
        readPostgresPublishedCommunityDaily,
        healthDispatch,
        privateOrigin: dispatchOrigin,
      });
      const participantDevicesDispatch = createPostgresTestParticipantDevicesDispatch({
        primaryPool,
        schemaOptions,
        authenticatePostgresPersonalSession,
        assertPostgresPersonalSessionCsrf,
        listPostgresParticipantDevices,
        revokePostgresParticipantDevice,
        readBoundedRequestBody,
        maxRequestBytes: MAX_REQUEST_BYTES,
        healthDispatch,
        privateOrigin: dispatchOrigin,
      });
      const personalSessionDispatch = createPostgresTestPersonalSessionDispatch({
        primaryPool,
        schemaOptions,
        authenticatePostgresPersonalSession: authenticatePostgresPersonalSessionForRead,
        assertPostgresPersonalSessionCsrf,
        revokePostgresPersonalSession,
        healthDispatch,
        clearSessionCookie: clearedSessionCookie(),
        privateOrigin: dispatchOrigin,
      });
      const devicePairingDispatch = createPostgresTestDevicePairingDispatch({
        primaryPool,
        schemaOptions,
        authenticatePostgresPersonalSession: authenticatePostgresPersonalSessionForRead,
        assertPostgresPersonalSessionCsrf,
        assertAccountScopedLocalPreview,
        createPostgresDevicePairing,
        healthDispatch,
        readBoundedRequestBody,
        maxRequestBytes: MAX_REQUEST_BYTES,
        admissionEnv,
        privateOrigin: dispatchOrigin,
      });
      const devicePairingClaimDispatch = createPostgresTestDevicePairingClaimDispatch({
        primaryPool,
        schemaOptions,
        claimPostgresDevicePairing,
        healthDispatch,
        readBoundedRequestBody,
        maxRequestBytes: MAX_REQUEST_BYTES,
        privateOrigin: dispatchOrigin,
      });
      const telemetryV12ConsentDispatch = createPostgresTestTelemetryV12ConsentDispatch({
        primaryPool,
        schemaOptions,
        authenticatePostgresPersonalSession: authenticatePostgresPersonalSessionForRead,
        assertPostgresPersonalSessionCsrf,
        grantPostgresTelemetryV12Consent,
        healthDispatch,
        readBoundedRequestBody,
        maxRequestBytes: MAX_REQUEST_BYTES,
        privateOrigin: dispatchOrigin,
      });
      Object.freeze(admissionEnv);
      const assertPostgresV12UploadAllowed = (pool, device, nowEpoch, { schema }) =>
        assertPostgresTelemetryTransportWriteAllowed(
          pool,
          device,
          TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
          { nowEpoch, schema },
        );
      // Legacy intake beside the v1.2 routes (IN-2 and IN-3 hand-offs): the
      // v1.1, v1.0 and v0.1 envelopes with their upload-authorization
      // formats, the upload-authorization route module and the v1.1 routes,
      // all gated on the same migration receipts as the built-in routes.
      // Only the modes whose clients reach those routes compose it
      // (ORIGIN_INTAKE_HOST_MODES).
      const intake = originIntakeServedInMode(postgresTestMode) ? createOriginIntakeComposition({
        adapters: {
          live: postgresTelemetryV11Live,
          bearer: postgresDeviceBearerAuth,
          transport: postgresTypedV12Transport,
          personalDevices: postgresPersonalDevices,
          controls: postgresCollectionControls,
          crypto: workerCrypto,
          boundedBody,
          legacyAdmission: postgresLegacyContributionAdmission,
          transportWriteAuthority: postgresTransportWriteAuthority,
          uploadAuthorization: postgresUploadAuthorization,
        },
        primaryPool,
        schemaOptions,
        admissionEnv,
        assertAdmissionBindings,
        assertAttemptAllowed,
        assertUploadAuthorizationBindings,
        assertUploadAuthorizationAllowed,
        assertV12UploadAllowed: assertPostgresV12UploadAllowed,
        assertStorageCurrent: createPostgresTestStorageReceiptCheck({
          primaryPool,
          schemaOptions,
          expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
        }),
        routePolicy: WORKER_ROUTE_POLICY,
        maxRequestBytes: MAX_REQUEST_BYTES,
        socialConsentVersion: TELEMETRY_CONSENT_VERSION,
        sourceNamespace: backend.sourceIdentity.sourceNamespace,
        envelopePublicJwk,
        envelopePrivateJwk,
      }) : null;
      // Route modules may replace only the overridable built-ins. A mode
      // that composes the intake mounts its upload-authorization module; only
      // a fastpath-test origin adds the analytics-v2 module.
      const routeModules = createOriginRouteModuleRegistry({
        modules: [
          ...(intake?.routeModules ?? []),
          ...(postgresTestMode === FASTPATH_TEST_MODE
            ? fastpathTestRouteModules({
              env: process.env,
              primaryPool,
              primarySchema: database.primary.schema,
              createAnalyticsV2CommunityDailyRoute:
                dependencies.createAnalyticsV2CommunityDailyRoute ?? null,
              clock: dependencies.analyticsV2Clock ?? null,
              // d43c8f92 index.ts:3979 handleCommunityDaily: the public-read
              // limiter (PostgreSQL, or the edge's replayed outcome).
              assertPublicReadAllowed: (request) => assertPublicAggregateReadAllowed(
                admissionEnv.PUBLIC_READ_RATE_LIMIT, request, admissionEnv,
              ),
            })
            : []),
        ],
        routePolicy: WORKER_ROUTE_POLICY,
      });
      const routeModuleContext = Object.freeze({ origin: dispatchOrigin, hostMode: privateHost.mode });
      const edgeTestDispatch = (inner) => (edgeTestOrigin === null ? inner : composeEdgeTestOrigin({
        configuration: edgeTestOrigin,
        admission: edgeAdmission,
        inner,
      }));
      return {
        pools,
        connector,
        backend,
        primaryPool,
        schemaOptions,
        hostOrigin,
        publicOrigin,
        requestOriginAllowlist,
        listenHost: privateHost.listenHost,
        listenPort: privateHost.port,
        postgresTestHostMode: privateHost.mode,
        ...(edgeTestOrigin === null ? {} : {
          edgeTestOrigin,
          edgeTestRequestFromNode: (req, res) => edgeTestRequestFromNode(req, res, { hostOrigin }),
        }),
        postgresTestDispatch: edgeTestDispatch(((v12Dispatch) => async (request) => {
          let pathname;
          let origin;
          try { ({ pathname, origin } = new URL(request.url)); } catch { /* V12 dispatch returns a safe 503. */ }
          // Non-overridable paths never reach a module. On an overridable
          // path a module registered for the exact method and private origin
          // answers first; otherwise the built-in below serves it unchanged.
          if (origin === dispatchOrigin && ORIGIN_OVERRIDABLE_BUILT_INS.includes(pathname)) {
            const routeModule = routeModules.resolve(request.method, pathname);
            if (routeModule !== null) return routeModule.handler(request, routeModuleContext);
          }
          // The intake answers every method of the v1.1 routes, and a wrong
          // method on the shared legacy routes, on the private origin (the
          // Worker's 405); it answers null for what the routes below serve.
          if (intake !== null && origin === dispatchOrigin && intake.pathnames.includes(pathname)) {
            const response = await intake.dispatch(request);
            if (response !== null) return response;
          }
          if (pathname === "/api/v1/community/daily") return communityDailyDispatch(request);
          if (pathname === "/api/v1/me/devices"
              || pathname === "/api/v1/me/devices/revoke") {
            return participantDevicesDispatch(request);
          }
          if (pathname === "/api/v1/session" || pathname === "/api/v1/logout") {
            return personalSessionDispatch(request);
          }
          if (pathname === "/api/v1/me/device-pairings") {
            return devicePairingDispatch(request);
          }
          if (pathname === "/api/v1/device-pairings/claim") {
            return devicePairingClaimDispatch(request);
          }
          if (pathname === "/api/v1/me/device-telemetry-v12-consents") {
            return telemetryV12ConsentDispatch(request);
          }
          return v12Dispatch(request);
        })(createPostgresTestV12DayManifestDispatch({
          primaryPool,
          schemaOptions,
          accountlessAuthority: Object.freeze({
            authenticateV12Grant: authenticatePostgresAccountlessOwnerForV12Grant,
            enroll: enrollPostgresAccountlessDevice,
            createOwner: createPostgresAccountlessUploadOwner,
            grantV12: grantPostgresTelemetryV12AccountlessAuthorization,
            renew: renewPostgresAccountlessUploadOwner,
            parseEnrollmentJson: parseAccountlessEnrollmentJson,
            parseOwnershipJson: parseAccountlessOwnershipJson,
            parseV12AuthorizationJson: parseTelemetryV12AccountlessAuthorizationJson,
            parseRenewalJson: parseAccountlessRenewalJson,
            maxEnrollmentBytes: ACCOUNTLESS_ENROLLMENT_MAX_REQUEST_BYTES,
            maxOwnershipBytes: ACCOUNTLESS_UPLOAD_OWNER_MAX_REQUEST_BYTES,
            maxRenewalBytes: ACCOUNTLESS_RENEWAL_MAX_REQUEST_BYTES,
          }),
          deviceCredentialRenewalAuthority: Object.freeze({
            renew: renewPostgresDeviceCredential,
            parseRequest: parsePostgresDeviceCredentialRenewalJson,
            maxRequestBytes: POSTGRES_DEVICE_CREDENTIAL_RENEWAL_MAX_REQUEST_BYTES,
          }),
          expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
          privateOrigin: dispatchOrigin,
          healthDispatch,
          admissionEnv,
          assertAdmissionBindings,
          assertAttemptAllowed,
          assertUploadAuthorizationBindings,
          assertUploadAuthorizationAllowed,
          assertUploadIngressRequestAllowed,
          assertPostgresV12UploadAllowed,
          createPostgresDeviceUploadAuthorization,
          authenticatePostgresDevice,
          disconnectPostgresAuthenticatedDevice,
          readPostgresDeviceSyncState,
          readPostgresDeviceSyncManifest,
          readPostgresDeviceSyncCapabilities,
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
          contributionEnvelopes: intake?.contributionEnvelopes,
          uploadAuthorizationFormats: intake?.uploadAuthorizationFormats,
          recordPostgresDeviceUploadReceipt: intake?.recordPostgresDeviceUploadReceipt,
        }))),
      };
    }
    const ingressBudget = createPostgresUploadIngressBudget(primaryPool, schemaOptions);
    const rateLimitSecret = required("POSTGRES_RATE_LIMIT_SECRET");
    if (new TextEncoder().encode(rateLimitSecret).byteLength < 32) configurationError("POSTGRES_RATE_LIMIT_SECRET_INVALID");
    const accessToken = await (dependencies.createGoogleAccessTokenProvider
      ?? createGoogleAccessTokenProvider)();
    const objectStore = (dependencies.createGcsQuarantineObjectStore
      ?? createGcsQuarantineObjectStore)(
      quarantineBucket, accessToken, undefined, undefined, quarantineHistoryProof,
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

/**
 * Compose only the resources required by the fail-closed scheduled job: one
 * primary pool and the quarantine object store. There is no ledger pool, and
 * any LEDGER_ setting is refused (databaseConfig). The store reads the
 * quarantine bucket's birth proof (OD-2), which must name this bucket. The
 * maintenance report's shape is fixed by owner decision OD-4
 * (src/postgres-maintenance.ts POSTGRES_MAINTENANCE_NOT_APPLICABLE).
 */
export async function createScheduledMaintenanceRuntime({ dependencies = {} } = {}) {
  const database = databaseConfig();
  const iamUser = normalizeIamUser(required("POSTGRES_IAM_USER"), "POSTGRES_IAM_USER");
  const bucket = required("GCS_BUCKET_NAME");
  const historyProof = quarantineBucketHistoryProof(bucket);
  const connector = typeof dependencies.createConnector === "function"
    ? dependencies.createConnector()
    : new Connector();
  const createPool = dependencies.createIamPool ?? createIamPool;
  const pools = [];
  try {
    const primaryPool = await createPool({ connector, ...database.primary, user: iamUser });
    pools.push(primaryPool);
    const accessToken = await (dependencies.createGoogleAccessTokenProvider
      ?? createGoogleAccessTokenProvider)();
    const objectStore = (dependencies.createGcsQuarantineObjectStore
      ?? createGcsQuarantineObjectStore)(bucket, accessToken, undefined, undefined, historyProof);
    return {
      pools,
      connector,
      primaryPool,
      objectStore,
      schemaOptions: {
        primarySchema: database.primary.schema,
      },
    };
  } catch (error) {
    await closeCloudSqlResources({ pools, connector }).catch(() => undefined);
    if (error?.code) throw error;
    throw new Error("CLOUD_RUN_SCHEDULED_MAINTENANCE_CONFIGURATION_FAILED");
  }
}

async function requestFromNode(req, requestOriginAllowlist, response, publicOrigin) {
  const host = req.headers.host;
  const allowedOrigin = requestOriginForHost(host, requestOriginAllowlist);
  const backendUrl = buildRequestUrl(req.url ?? "/", allowedOrigin.host, allowedOrigin.origin);
  const callbackQuery = req.headers["x-tibotattle-google-callback-query"];
  if (callbackQuery !== undefined && (Array.isArray(callbackQuery)
      || allowedOrigin.kind !== "public"
      || publicOrigin === undefined
      || backendUrl.pathname !== "/api/v1/identity/google/callback")) {
    throw Object.assign(new Error("OAUTH_CALLBACK_QUERY_INVALID"), { status: 400 });
  }
  const publicUrl = allowedOrigin.kind === "public"
    ? buildPublicGoogleRequestUrl(
      req.url ?? "/",
      allowedOrigin.host,
      allowedOrigin.origin,
      publicOrigin,
      callbackQuery,
    )
    : null;
  if (publicUrl !== null && req.headers.origin !== undefined
      && req.headers.origin !== publicOrigin) {
    throw Object.assign(new Error("REQUEST_ORIGIN_INVALID"), { status: 403 });
  }
  const url = publicUrl ?? backendUrl;
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

/**
 * Listen for one runtime on HOST:PORT (or the runtime's listen pair) and
 * return its close function. Exported for local rehearsals that compose a
 * runtime with injected local pools; the entry point calls it from main().
 */
export async function serve(runtime) {
  const edgeTest = typeof runtime.edgeTestRequestFromNode === "function";
  const server = http.createServer(async (req, res) => {
    try {
      let request;
      if (edgeTest) {
        // edge-test keeps the raw headers for EP-6; a refusal here, and EP-6's
        // unmarked 421 below, end the socket without reading the body. Each
        // logs its one content-free reason line: this one here, EP-6's inside
        // the composition (composeEdgeTestOrigin).
        try {
          request = runtime.edgeTestRequestFromNode(req, res);
        } catch (error) {
          if (!(error instanceof EdgeTestBoundaryRefusal)) throw error;
          logEdgeTestBoundaryRefusal(error);
          writeEdgeTestBoundaryRefusal(res);
          return;
        }
      } else {
        request = await requestFromNode(
          req,
          runtime.requestOriginAllowlist,
          res,
          runtime.publicOrigin,
        );
      }
      const response = await dispatchCloudRunHostRequest(request, runtime, handleRequest);
      if (edgeTest && isEdgeOriginBoundaryRefusal(response)) {
        await response.body?.cancel().catch(() => undefined);
        writeEdgeTestBoundaryRefusal(res);
        return;
      }
      if (edgeTest) lingerAfterEarlyEdgeTestAnswer(req);
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
  if (postgresTestDispatch && host !== "127.0.0.1"
      && !isEdgeTestCloudListen(runtime.edgeTestOrigin, host, port, process.env)) {
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

/**
 * The origin composition root's injected dependencies: the analytics-v2
 * community-daily route factory, which createRuntime mounts only in
 * fastpath-test mode with ANALYTICS_V2_ENABLED=1, and its optional test clock
 * (ANALYTICS_V2_TEST_NOW_MS, fastpath-test only). createRuntime itself keeps
 * no default factory, so a caller that injects none cannot mount the module.
 */
export function originCompositionDependencies(env = process.env) {
  const mode = env?.POSTGRES_TEST_HTTP_MODE === "" ? undefined : env?.POSTGRES_TEST_HTTP_MODE;
  const clock = analyticsV2TestClock(env, mode);
  return Object.freeze({
    createAnalyticsV2CommunityDailyRoute,
    ...(clock === null ? {} : { analyticsV2Clock: clock }),
  });
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
    assertNoLedgerConfiguration();
    const runtime = await createScheduledMaintenanceRuntime();
    try {
      const result = await runPostgresScheduledMaintenance({
        primaryPool: runtime.primaryPool,
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
  const runtime = await createRuntime({ dependencies: originCompositionDependencies(process.env) });
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
