#!/usr/bin/env node

import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  createPostgresWorkerBackend,
  isPostgresWorkerRequestPathSupported,
  POSTGRES_PORTED_WORKER_ROUTE_IDS,
} from "../src/backend-composition.ts";
import { runPostgresScheduledMaintenance } from "../src/postgres-maintenance.ts";
import { assertPublicAggregateReadAllowed } from "../src/admission.ts";
import { createGcsQuarantineObjectStore } from "../src/gcs-quarantine-object-store.ts";
import { assertPostgresScheduledMaintenanceEnabled } from "./postgres-maintenance-gate.mjs";
import { createPostgresUploadIngressBudget } from "../src/postgres-ingress-budget.ts";
import { createPostgresRateLimiter } from "../src/postgres-rate-limiter.ts";
import { recordPostgresDiagnosticError } from "../src/postgres-host-diagnostics.ts";
import { setTimingSafeEqualImplementation } from "../src/crypto.ts";
import { createIamPool, createGoogleAccessTokenProvider, closeCloudSqlResources, normalizeIamUser } from "./cloud-sql.mjs";
import {
  bootstrapOwnerFixture,
  parseOwnerFixture,
  refreshOwnerSessionFixture,
} from "./owner-bootstrap.mjs";
import { installNodeTimingSafeEqual } from "./node-crypto-adapter.mjs";
import {
  createPostgresStorageGate,
  createPostgresTestHealthDispatch,
  dispatchCloudRunHostRequest,
  isPrivatePostgresTestHost,
} from "./postgres-test-dispatch.mjs";
import { originIntakeServedInMode } from "./origin-intake-composition.mjs";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { POSTGRES_RUNTIME_MIGRATIONS } from "../src/postgres-runtime-schema.ts";
import {
  analyticsV2TestClock,
  FASTPATH_TEST_MODE,
  fastpathTestDatabaseConfig,
  fastpathTestRouteModules,
} from "./origin-fastpath-mode.mjs";
import { createAnalyticsV2CommunityDailyRoute } from "../src/analytics-v2/community-daily-route.ts";
import { createEdgeAdmissionLimiters } from "./postgres-edge-admission-limiters.mjs";
import { edgeRequestContext } from "./postgres-edge-origin-dispatch.mjs";
import {
  EDGE_TEST_PUBLIC_ORIGIN,
  composeEdgeTestOrigin,
  edgeTestAdmissionEnv,
  isEdgeTestCloudListen,
  readEdgeTestOriginConfiguration,
} from "./origin-edge-test-mode.mjs";
import {
  OriginBoundaryRefusal,
  isEdgeOriginBoundaryRefusal,
  lingerAfterEarlyAnswer,
  logOriginBoundaryRefusal,
  originRequestFromNode,
  writeOriginBoundaryRefusal,
} from "./origin-node-request.mjs";
import { createRequestContextStore, requestIdFrom } from "./postgres-request-context.mjs";
import { createPrivateTestRequestHandler, createProductionRequestHandler } from "./postgres-host-dispatch.mjs";
import {
  PRODUCTION_ADMIN_HOST_POLICY,
  PRODUCTION_HOST_MODES,
  PRODUCTION_UNPORTED_RETRY_AFTER_SECONDS,
  composeOriginFamilies,
  createOriginRouteRegistry,
  createPostgresProductionRuntime,
  createUploadIngressAuthority,
} from "./postgres-production-host.mjs";
import { createPostgresHealthDispatch, healthCapabilityFlags } from "./postgres-health-dispatch.mjs";
import { createPostgresReadinessDispatch } from "./postgres-readiness-dispatch.mjs";
import {
  QUARANTINE_BUCKET_HISTORY_PROOF_SETTING,
  parseQuarantineBucketHistoryProof,
} from "./postgres-production-configuration.mjs";
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
/**
 * HOST_MODE (CR-7, D-CRB): unset or empty for the test and command modes;
 * 'production' or 'staging' (OD-CR-8) composes the production host from the
 * CR-3 profile of the same name. Anything else is HOST_MODE_INVALID, and a
 * non-empty POSTGRES_TEST_HTTP_MODE beside it is HOST_MODE_CONFLICT (an empty
 * one reaches CR-3, which refuses it as POSTGRES_TEST_HTTP_MODE_FORBIDDEN).
 */
function hostMode(env = process.env) {
  const value = env.HOST_MODE;
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !Object.hasOwn(PRODUCTION_HOST_MODES, value)) {
    configurationError("HOST_MODE_INVALID");
  }
  if (typeof env.POSTGRES_TEST_HTTP_MODE === "string" && env.POSTGRES_TEST_HTTP_MODE !== "") {
    configurationError("HOST_MODE_CONFLICT");
  }
  return value;
}
/**
 * Owner decision OD-2 (2026-10-02): the quarantine bucket's birth proof,
 * GCS_QUARANTINE_BUCKET_HISTORY_PROOF, as the OPS-2 bucket-birth receipt's
 * proof record for exactly `bucket`, parsed by CR-3's one grammar
 * (parseQuarantineBucketHistoryProof; the production profiles read the same
 * parse as resources.bucketHistoryProof). The retired
 * GCS_ERASURE_BUCKET_HISTORY_PROOF is refused even when empty, so a stale
 * deployment fails closed instead of starting without the proof it expected.
 */
function quarantineBucketHistoryProof(bucket) {
  if (Object.hasOwn(process.env, "GCS_ERASURE_BUCKET_HISTORY_PROOF")) {
    configurationError("GCS_ERASURE_BUCKET_HISTORY_PROOF_RETIRED");
  }
  return parseQuarantineBucketHistoryProof(required(QUARANTINE_BUCKET_HISTORY_PROOF_SETTING), bucket);
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

export async function createRuntime({ databaseOnly = false, dependencies = {} } = {}) {
  // HOST_MODE first: production and staging are configured by CR-3 alone,
  // whose own codes refuse a test mode, a LEDGER_ setting or a test seam.
  const mode = hostMode();
  if (mode !== null) {
    if (databaseOnly) configurationError("HOST_MODE_COMMAND_UNSUPPORTED");
    return createPostgresProductionRuntime({
      processEnv: process.env,
      hostMode: mode,
      adminHostPolicy: PRODUCTION_ADMIN_HOST_POLICY,
      dependencies,
    });
  }
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
    // health-and-v12-day-manifest and fastpath-test (with or without
    // EDGE_ORIGIN_MODE=edge-test): the one family composition
    // (postgres-production-host.mjs composeOriginFamilies) the production
    // host uses.
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
    // (EP-6) and every family's origin is the public origin EP-6 rebuilds on.
    const edgeAdmission = edgeTestOrigin === null ? null : createEdgeAdmissionLimiters();
    const dispatchOrigin = edgeTestOrigin === null ? hostOrigin : EDGE_TEST_PUBLIC_ORIGIN;
    const ingressBudget = createPostgresUploadIngressBudget(primaryPool, schemaOptions);
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
      ACCOUNT_SCOPED_INGEST_MODE: "disabled",
      PUBLIC_ANALYTICS_MODE: optional("PUBLIC_ANALYTICS_MODE", "enabled"),
      // The Worker's upload-ingress policy (the shared lease and the 60 s /
      // 15 s body read) over the PostgreSQL budget, as production composes it.
      UPLOAD_INGRESS_QUEUE_MODE: "disabled",
      UPLOAD_INGRESS_MAX_CONCURRENT: optional("UPLOAD_INGRESS_MAX_CONCURRENT", "8"),
      UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: optional("UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE", "120"),
      UPLOAD_INGRESS_BURST: optional("UPLOAD_INGRESS_BURST", "16"),
      UPLOAD_INGRESS_LEASE_SECONDS: optional("UPLOAD_INGRESS_LEASE_SECONDS", "90"),
      UPLOAD_INGRESS_BODY_TOTAL_SECONDS: optional("UPLOAD_INGRESS_BODY_TOTAL_SECONDS", "60"),
      UPLOAD_INGRESS_BODY_IDLE_SECONDS: optional("UPLOAD_INGRESS_BODY_IDLE_SECONDS", "15"),
      UPLOAD_INGRESS_BUDGET: Object.freeze({ getByName: () => ingressBudget }),
      // RD-3's deployment.sourceCommit; absent unless the deploy sets it.
      ...Object.fromEntries([["DEPLOYMENT_SOURCE_COMMIT", optional("DEPLOYMENT_SOURCE_COMMIT")]]
        .filter(([, value]) => value !== undefined)),
      ...(edgeTestOrigin === null ? {} : { PUBLIC_ORIGIN: EDGE_TEST_PUBLIC_ORIGIN }),
    };
    for (const definition of RATE_LIMIT_BINDINGS) {
      originAdmissionEnv[definition[0]] = rateLimitBinding(
        primaryPool, schemaOptions, rateLimitSecret, definition,
      );
    }
    const admissionEnv = edgeAdmission === null
      ? Object.freeze(originAdmissionEnv)
      : edgeTestAdmissionEnv(originAdmissionEnv, edgeAdmission);
    // The test modes reuse a positive receipt for no time at all, so a test
    // sees drift (or a newer schema) on the very next request.
    const storageGate = createPostgresStorageGate({
      primaryPool,
      schemaOptions,
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      positiveTtlMilliseconds: 0,
    });
    const requestContextStore = createRequestContextStore();
    const requestContext = requestContextStore.accessor;
    const hostModeLabel = privateHost.mode;
    const legacyChain = postgresTestMode === "health-and-v12-day-manifest";
    const sourceIdentity = backend.sourceIdentity;
    const statusDispatchers = legacyChain
      ? Object.freeze({
        health: createPostgresTestHealthDispatch({
          primaryPool,
          schemaOptions,
          expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
          privateOrigin: dispatchOrigin,
        }),
        ready: null,
      })
      : Object.freeze({
        health: createPostgresHealthDispatch({
          requestContext,
          env: admissionEnv,
          readinessPool: primaryPool,
          primarySchema: schemaOptions.primarySchema,
          objectStore,
          capabilityFlags: healthCapabilityFlags((id) => POSTGRES_PORTED_WORKER_ROUTE_IDS.includes(id)),
        }),
        ready: createPostgresReadinessDispatch({
          requestContext,
          env: admissionEnv,
          readinessPool: primaryPool,
          primarySchema: schemaOptions.primarySchema,
          sourceNamespace: sourceIdentity.sourceNamespace,
          expectedPrimaryMigrations: POSTGRES_RUNTIME_MIGRATIONS.primary,
        }),
      });
    const families = composeOriginFamilies({
      dataPool: primaryPool,
      primarySchema: schemaOptions.primarySchema,
      sourceIdentity,
      admissionEnv,
      storageGate,
      dispatchOrigin,
      productionConfiguration: null,
      objectStore,
      envelopePublicJwk,
      envelopePrivateJwk,
      requestContext,
      uploadIngress: createUploadIngressAuthority(),
      statusDispatchers,
      composeIntake: originIntakeServedInMode(postgresTestMode),
      // Only a fastpath-test origin adds the analytics-v2 module.
      routeModules: postgresTestMode === FASTPATH_TEST_MODE
        ? fastpathTestRouteModules({
          env: process.env,
          primaryPool,
          primarySchema: database.primary.schema,
          createAnalyticsV2CommunityDailyRoute: dependencies.createAnalyticsV2CommunityDailyRoute ?? null,
          clock: dependencies.analyticsV2Clock ?? null,
          // d43c8f92 index.ts:3979 handleCommunityDaily: the public-read
          // limiter (PostgreSQL, or the edge's replayed outcome).
          assertPublicReadAllowed: (request) => assertPublicAggregateReadAllowed(
            admissionEnv.PUBLIC_READ_RATE_LIMIT, request, admissionEnv,
          ),
        })
        : [],
      routeModuleContext: (request) => Object.freeze({
        origin: dispatchOrigin,
        hostMode: hostModeLabel,
        requestId: requestIdFrom(requestContext, request),
      }),
    });
    const base = {
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
    };
    // Every test mode serves exactly the production route list, through the
    // one registry (the route modules folded in).
    const registry = createOriginRouteRegistry(families, POSTGRES_PORTED_WORKER_ROUTE_IDS);
    if (edgeTestOrigin === null) {
      return {
        ...base,
        registry,
        postgresTestDispatch: createPrivateTestRequestHandler({
          registry,
          dispatchOrigin: hostOrigin,
          fallback: families.dispatchers.v12Dispatch,
        }),
      };
    }
    // edge-test: the production request handler behind EP-6, byte for byte
    // the production pipeline (E12 proves it end to end).
    const handler = createProductionRequestHandler({
      registry,
      env: admissionEnv,
      requestContextStore,
      requestContext: edgeRequestContext,
      storageGate,
      recordDiagnostic: (event) => recordPostgresDiagnosticError(primaryPool, schemaOptions, event),
      adminHostPolicy: PRODUCTION_ADMIN_HOST_POLICY,
      unportedRetryAfterSeconds: PRODUCTION_UNPORTED_RETRY_AFTER_SECONDS,
    });
    return {
      ...base,
      registry,
      edgeTestOrigin,
      edgeTestRequestFromNode: (req, res) => originRequestFromNode(req, res, { hostOrigin }),
      postgresTestDispatch: composeEdgeTestOrigin({
        configuration: edgeTestOrigin,
        admission: edgeAdmission,
        inner: handler,
      }),
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

/** The production host's Node request timeouts (CR-7). */
export const PRODUCTION_SERVER_TIMEOUTS = Object.freeze({
  requestTimeoutMilliseconds: 300_000,
  headersTimeoutMilliseconds: 60_000,
});

/**
 * One request through the EP-6 boundary (HOST_MODE production or staging,
 * and edge-test): the Node request keeps its raw headers for EP-6
 * (originRequestFromNode); a refusal here, and EP-6's unmarked 421, end the
 * socket without reading the body, each logging its one content-free reason
 * line; any other answer lingers for an unread body, then is written.
 */
async function serveBehindBoundary(req, res, runtime, requestFromNode) {
  let request;
  try {
    request = requestFromNode(req, res);
  } catch (error) {
    if (!(error instanceof OriginBoundaryRefusal)) throw error;
    logOriginBoundaryRefusal(error);
    writeOriginBoundaryRefusal(res);
    return;
  }
  const response = await dispatchCloudRunHostRequest(request, runtime);
  if (isEdgeOriginBoundaryRefusal(response)) {
    await response.body?.cancel().catch(() => undefined);
    writeOriginBoundaryRefusal(res);
    return;
  }
  lingerAfterEarlyAnswer(req);
  await writeResponse(res, response);
}

/**
 * Listen for one runtime on its validated listen pair and return its close
 * function. Exported for local rehearsals that compose a runtime with
 * injected local pools; the entry point calls it from main().
 *
 * - The production host (runtime.productionDispatch) listens where its
 *   composition decided (productionListenHost: 0.0.0.0 only for a Cloud Run
 *   service CR-3 validated, else 127.0.0.1) and accepts its HOST_ORIGIN's
 *   host or a Cloud Run revision tag of it.
 * - Every test runtime listens on 127.0.0.1, except the pinned edge-test
 *   Cloud Run pair.
 */
export async function serve(runtime) {
  const production = typeof runtime.productionDispatch === "function";
  const edgeTest = typeof runtime.edgeTestRequestFromNode === "function";
  const server = http.createServer(async (req, res) => {
    try {
      if (production) {
        await serveBehindBoundary(req, res, runtime, (nodeRequest, nodeResponse) =>
          originRequestFromNode(nodeRequest, nodeResponse, { hostOrigin: runtime.hostOrigin, acceptRevisionTags: true }));
        return;
      }
      if (edgeTest) {
        await serveBehindBoundary(req, res, runtime, runtime.edgeTestRequestFromNode);
        return;
      }
      const request = await requestFromNode(
        req,
        runtime.requestOriginAllowlist,
        res,
        runtime.publicOrigin,
      );
      await writeResponse(res, await dispatchCloudRunHostRequest(request, runtime));
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
  if (production) {
    server.requestTimeout = PRODUCTION_SERVER_TIMEOUTS.requestTimeoutMilliseconds;
    server.headersTimeout = PRODUCTION_SERVER_TIMEOUTS.headersTimeoutMilliseconds;
  }
  const port = runtime.listenPort;
  const host = runtime.listenHost;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) configurationError("PORT_INVALID");
  if (host !== "127.0.0.1" && host !== "0.0.0.0") configurationError("HOST_INVALID");
  if (!production && host !== "127.0.0.1"
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
  // HOST_MODE composes only the request-serving origin: the maintenance Job
  // is its own workload (dist/postgres-maintenance-job.mjs, CR-3 profile
  // maintenance-job, no HOST_MODE), and the owner fixture commands belong to
  // the test estate.
  if (hostMode() !== null) {
    if (process.argv.includes("--scheduled")) configurationError("POSTGRES_SCHEDULED_HOST_MODE_FORBIDDEN");
    if (["--refresh-owner-session", "--bootstrap-owner"].some((flag) => process.argv.includes(flag))) {
      configurationError("HOST_MODE_COMMAND_UNSUPPORTED");
    }
  }
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
