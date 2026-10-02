/**
 * CR-7 (D-CRB): the production composition of the Cloud Run origin.
 *
 * composeOriginFamilies is the one family composition of every PostgreSQL
 * origin mode: HOST_MODE production and staging, the edge-test rehearsal and
 * the loopback fastpath-test (and the legacy health-and-v12-day-manifest
 * chain, which reuses its dispatchers). It builds the route families exactly
 * once, each with the root's request-context accessor (FC-3/FC-4, so every
 * error body carries the id the root logs: OD-CR-6 (i)), the storage gate's
 * probe as its health check, and the injected upload-ingress authority
 * (the shared lease and the 60 s / 15 s body policy of the Worker). It
 * returns the handler of every route the origin can serve, keyed by
 * WORKER_ROUTE_POLICY id, for the CR-6 registry to resolve.
 *
 * createPostgresProductionRuntime composes HOST_MODE production or staging
 * (OD-CR-8: the staging plane uses the same code path) from the CR-3
 * configuration only (readProductionConfiguration and
 * createProductionWorkerEnv): three IAM pools on the one primary instance
 * (data, admission, readiness), the origin-tier limiters with the plane's
 * cfg.rateLimits.originTier and PRODUCTION_ADMISSION_TIMEOUTS, the shared
 * PostgreSQL ingress budget, the EP-6 edge replay bindings, the GCS
 * quarantine store with CR-3's bucket birth proof (OD-2), the storage gate
 * (TTL 0, OD-ROLL / OD-CR-10), the families, the registry
 * (POSTGRES_PORTED_WORKER_ROUTE_IDS, with the route modules folded in), the
 * CR-6 handler and EP-6 in front of it.
 *
 * The admin host (OD-CR-3) is a composition-root decision:
 * PRODUCTION_ADMIN_HOST_POLICY stays 'refuse' (503 POSTGRES_ROUTE_NOT_PORTED
 * for every admin-host request) until the owner answers OWN-17 question 2.
 * With 'chokepoint' the runtime builds createPostgresAdminAccessChokepoint
 * once over the env, registers C-ADMIN's six routes (no analytics pool while
 * analytics_v2 lives in primary, migration 0059) and injects C-MAINT's
 * lifecycle pass as their run_maintenance task.
 *
 * Nothing here reads process.env except through CR-3, and nothing here
 * logs: the handler and EP-6 own the request and refusal lines.
 */

import { Connector } from "@google-cloud/cloud-sql-connector";
import { EDGE_ADMISSION_BINDINGS } from "../src/edge-admission-policy.ts";
import { canonicalRunAppOrigin } from "../src/edge-origin-contract.ts";
import { ApiError } from "../src/errors.ts";
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
import { createPostgresSourceIdentityConfig } from "../src/postgres-client.ts";
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
import { assertAccountScopedLocalPreview } from "../src/account-scoped-ingest.ts";
import { createPostgresDevicePairing } from "../src/postgres-device-pairing.ts";
import { claimPostgresDevicePairing } from "../src/postgres-device-pairing-claim.ts";
import { grantPostgresTelemetryV12Consent } from "../src/postgres-telemetry-v12-consent.ts";
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
  readPostgresDeviceSyncManifest,
  readPostgresDeviceSyncState,
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
import { decryptSyntheticEnvelope, publicEnvelopeKey, sha256Hex } from "../src/crypto.ts";
import { validateTelemetryV12StagedChunk } from "../src/telemetry-v12-repository.ts";
import {
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  validateTelemetryV12Envelope,
} from "@app-usagemonitor/telemetry-contract";
import { assertPostgresTelemetryTransportWriteAllowed } from "../src/postgres-telemetry-format-authority.ts";
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
import {
  acquireUploadIngressLease,
  assertUploadIngressConfiguration,
  releaseUploadIngressLease,
  startUploadIngressLeaseHeartbeat,
  uploadIngressBodyReadPolicy,
} from "../src/upload-ingress-admission.ts";
import { createPostgresUploadIngressBudget } from "../src/postgres-ingress-budget.ts";
import { createPostgresRateLimiter } from "../src/postgres-rate-limiter.ts";
import { createGcsQuarantineObjectStore } from "../src/gcs-quarantine-object-store.ts";
import { recordPostgresDiagnosticError } from "../src/postgres-host-diagnostics.ts";
import { POSTGRES_RUNTIME_MIGRATIONS } from "../src/postgres-runtime-schema.ts";
import { WORKER_ROUTE_POLICY } from "../src/route-registry.ts";
import {
  POSTGRES_ADMIN_HOST_ROUTE_IDS,
  POSTGRES_PORTED_WORKER_ROUTE_IDS,
} from "../src/backend-composition.ts";
import { createPostgresAdminAccessChokepoint } from "../src/postgres-admin-access.ts";
import { runPostgresLifecyclePass } from "../src/postgres-lifecycle-pass.ts";
import { createAnalyticsV2CommunityDailyRoute } from "../src/analytics-v2/community-daily-route.ts";
import { closeCloudSqlResources, createGoogleAccessTokenProvider, createIamPool } from "./cloud-sql.mjs";
import { createOriginIntakeComposition } from "./origin-intake-composition.mjs";
import { createAdminConsoleHandlers } from "./routes/admin-console.mjs";
import { createOriginRouteModuleRegistry, defineOriginRouteModule } from "./origin-route-modules.mjs";
import { logOriginBoundaryRefusal } from "./origin-node-request.mjs";
import { createEdgeAdmissionLimiters, EDGE_ADMISSION_REPLAY_BINDINGS } from "./postgres-edge-admission-limiters.mjs";
import { createEdgeOriginDispatch, edgeRequestContext } from "./postgres-edge-origin-dispatch.mjs";
import { requestIdFrom, createRequestContextStore } from "./postgres-request-context.mjs";
import { createProductionRequestHandler } from "./postgres-host-dispatch.mjs";
import { ADMIN_HOST_ROUTE_IDS, createProductionRouteRegistry } from "./postgres-production-registry.mjs";
import { createPostgresReadinessDispatch } from "./postgres-readiness-dispatch.mjs";
import { createPostgresHealthDispatch, healthCapabilityFlags, registryPorted } from "./postgres-health-dispatch.mjs";
import {
  EDGE_ORIGIN_MODE,
  EDGE_TIER_RATE_LIMIT_BINDINGS,
  PRODUCTION_ADMISSION_TIMEOUTS,
  PRODUCTION_POOL_APPLICATION_NAMES,
  createProductionWorkerEnv,
  readProductionConfiguration,
  revealProductionSecret,
} from "./postgres-production-configuration.mjs";
import {
  createPostgresStorageGate,
  createPostgresTestCommunityDailyDispatch,
  createPostgresTestDevicePairingClaimDispatch,
  createPostgresTestDevicePairingDispatch,
  createPostgresTestParticipantDevicesDispatch,
  createPostgresTestPersonalSessionDispatch,
  createPostgresTestTelemetryV12ConsentDispatch,
  createPostgresTestV12DayManifestDispatch,
} from "./postgres-test-dispatch.mjs";

/** HOST_MODE values and the CR-3 profile each composes (OD-CR-8: staging allowed). */
export const PRODUCTION_HOST_MODES = Object.freeze({
  production: "production",
  staging: "staging",
});

/**
 * OD-CR-3 for the production and staging admin host: 'refuse'. The owner
 * answered OWN-17 questions 1 and 2 in round 12 (open the admin host with
 * what is ported; sections without a GCP source say "unavailable"), and
 * the cutover checklist schedules that as ADMIN-R12, after D-CRB, together
 * with the overview's unavailable sections and the not_applicable ledger
 * DTO. Flipping this to 'chokepoint' is the one-line change that serves
 * C-ADMIN's six routes behind the Access chokepoint.
 */
export const PRODUCTION_ADMIN_HOST_POLICY = "refuse";

/** OD-CR-6 (iv): unported routes answer without retry-after. */
export const PRODUCTION_UNPORTED_RETRY_AFTER_SECONDS = null;

/** OD-ROLL / OD-CR-10: the storage gate never reuses a receipt read. */
export const PRODUCTION_STORAGE_GATE_TTL_MILLISECONDS = 0;

/** The C-MAINT maintenance cycle granularity (the Worker cron's minute). */
export const ORIGIN_MAINTENANCE_CYCLE_MILLISECONDS = 60_000;

/** The listen addresses the origin may bind. */
export const ORIGIN_LISTEN_HOSTS = Object.freeze({ loopback: "127.0.0.1", cloudRun: "0.0.0.0" });

const V12_ROUTE_IDS = Object.freeze([
  "envelope_key",
  "accountless_enrollment",
  "accountless_ownership",
  "accountless_telemetry_v12_authorization",
  "accountless_renewal",
  "device_disconnect",
  "device_credential_renew",
  "device_sync_state",
  "device_sync_capabilities",
  "device_sync_capabilities_v12",
  "device_sync_manifest",
  "telemetry_v12_day_manifests",
  "telemetry_v12_domain_predecessor",
  "telemetry_v12_domain_activate",
]);
const V11_ROUTE_IDS = Object.freeze([
  "telemetry_v11_consent",
  "telemetry_v11_day_manifests",
  "telemetry_v11_domain_predecessor",
  "telemetry_v11_domain_activate",
]);

export const ORIGIN_COMPOSITION_INVALID = "ORIGIN_COMPOSITION_INVALID";

function compositionError(code) {
  return Object.assign(new Error(code), { code });
}

function refuse(code) {
  throw compositionError(code);
}

/**
 * The upload-ingress authority the contributions preamble takes (d43c8f92
 * index.ts:3337-3447): the Worker's own functions over the env's
 * UPLOAD_INGRESS_BUDGET, which the origin binds to the shared PostgreSQL
 * budget.
 */
export function createUploadIngressAuthority() {
  return Object.freeze({
    assertConfiguration: (env) => assertUploadIngressConfiguration(env),
    bodyReadPolicy: (env) => uploadIngressBodyReadPolicy(env),
    acquireLease: (env) => acquireUploadIngressLease(env),
    startHeartbeat: (env, lease) => startUploadIngressLeaseHeartbeat(env, lease),
    releaseLease: (env, lease) => releaseUploadIngressLease(env, lease),
  });
}

/**
 * C-MAINT's lifecycle pass as the admin action's run_maintenance task
 * (C-ADMIN admin-action.mjs, audited by RUN_MAINTENANCE_AUDIT_FIELDS): the
 * pass for the request's whole-minute cycle, mapped to the Worker's result
 * keys. A pass that cannot take the maintenance lock or the migration fence
 * is MAINTENANCE_IN_PROGRESS, which the action answers 409
 * LIFECYCLE_STATE_CONFLICT. Erasure-era items are the constant not-applicable
 * values of owner decision OD-4; phases the pass does not run (identity
 * hand-off and sign-in purges) are absent, never reported as done.
 */
export function createLifecyclePassMaintenance({ pool, objectStore, primarySchema }) {
  return Object.freeze({
    async runMaintenance(nowEpoch) {
      const result = await runPostgresLifecyclePass({
        pool,
        objectStore,
        schema: { primarySchema },
        cycleEpoch: nowEpoch - (nowEpoch % ORIGIN_MAINTENANCE_CYCLE_MILLISECONDS),
        expectedPrimaryMigrations: POSTGRES_RUNTIME_MIGRATIONS.primary,
      });
      if (result.outcome === "skipped") return Object.freeze({ code: "MAINTENANCE_IN_PROGRESS" });
      return Object.freeze({
        code: result.outcome === "complete" ? "OK"
          : result.outcome === "partial" ? "MAINTENANCE_INCOMPLETE" : result.code,
        lifecycleComplete: result.lifecycleComplete,
        quarantineRetentionComplete: result.quarantineRetentionComplete,
        restoreReplayComplete: result.appendOnlyNotApplicable.restoreReplayComplete,
        quarantineReconciliationComplete: result.quarantineReconciliationComplete,
        expiredDeletionTombstonesPurged: 0,
        deletionTombstonePurgeComplete: result.appendOnlyNotApplicable.deletionTombstoneRetentionComplete,
        expiredPrimaryIdentityReenrollmentCooldownsPurged: 0,
        primaryIdentityReenrollmentCooldownPurgeComplete: true,
        expiredIdentityReenrollmentCooldownsPurged: 0,
        identityReenrollmentCooldownPurgeComplete: true,
        aggregateRebuildComplete: false,
        aggregateRebuildDelegated: true,
        publicationEnabled: null,
      });
    },
  });
}

function isPool(value) {
  return value !== null && typeof value === "object" && typeof value.connect === "function";
}

/**
 * The single family composition (wave-3 host brief B3). deps:
 * - dataPool, primarySchema, sourceIdentity {sourceId, sourceNamespace};
 * - admissionEnv: the frozen env every family reads (the eight limiter
 *   bindings, UPLOAD_INGRESS_BUDGET and the ingress and admission vars);
 * - storageGate: {assertCurrent, probe} (createPostgresStorageGate);
 * - dispatchOrigin and productionConfiguration (the CR-3 configuration in
 *   production and staging, else null);
 * - objectStore, envelopePublicJwk, envelopePrivateJwk;
 * - requestContext: the root's accessor (FC-4);
 * - uploadIngress: createUploadIngressAuthority();
 * - statusDispatchers: {health, ready}, the RD-3 and RD-2 families (or, in
 *   the legacy health-and-v12-day-manifest mode, the test health and ready
 *   null, which leaves /api/ready to the v1.2 dispatch's unsupported 503);
 * - routeModules: extra origin route modules (the analytics-v2
 *   community-daily module), mounted beside the intake's;
 * - routeModuleContext: (request) => frozen per-request module context;
 * - composeIntake: whether the legacy intake is composed;
 * - adminHandlers: null, or C-ADMIN's six handlers (Map by route id).
 *
 * Returns {handlers, routeModules, routeModuleContext, dispatchers}: handlers
 * maps every route id the composition serves to its built-in (the registry
 * folds the route modules over community_daily and
 * device_upload_authorization; createOriginRouteRegistry); dispatchers are
 * the families themselves (the loopback fallback is the v1.2 dispatch).
 */
export function composeOriginFamilies(deps) {
  if (deps === null || typeof deps !== "object") refuse(ORIGIN_COMPOSITION_INVALID);
  const {
    dataPool, primarySchema, sourceIdentity, admissionEnv, storageGate, dispatchOrigin,
    productionConfiguration = null, objectStore, envelopePublicJwk, envelopePrivateJwk, requestContext,
    uploadIngress, statusDispatchers, routeModules = [], routeModuleContext, composeIntake = true,
    adminHandlers = null,
  } = deps;
  if (!isPool(dataPool) || typeof primarySchema !== "string"
      || admissionEnv === null || typeof admissionEnv !== "object" || !Object.isFrozen(admissionEnv)
      || storageGate === null || typeof storageGate !== "object" || typeof storageGate.probe !== "function"
      || typeof requestContext !== "function" || typeof routeModuleContext !== "function"
      || statusDispatchers === null || typeof statusDispatchers !== "object"
      || typeof statusDispatchers.health !== "function"
      || (statusDispatchers.ready !== null && typeof statusDispatchers.ready !== "function")
      || !Array.isArray(routeModules)
      || (adminHandlers !== null && !(adminHandlers instanceof Map))) {
    refuse(ORIGIN_COMPOSITION_INVALID);
  }
  const schemaOptions = Object.freeze({ primarySchema });
  const shared = { requestContext, productionConfiguration, primaryPool: dataPool, schemaOptions };
  const healthDispatch = storageGate.probe;
  const communityDaily = createPostgresTestCommunityDailyDispatch({
    ...shared,
    sourceIdentity,
    readPostgresPublishedCommunityDaily,
    healthDispatch,
    privateOrigin: dispatchOrigin,
  });
  const participantDevices = createPostgresTestParticipantDevicesDispatch({
    ...shared,
    authenticatePostgresPersonalSession,
    assertPostgresPersonalSessionCsrf,
    listPostgresParticipantDevices,
    revokePostgresParticipantDevice,
    readBoundedRequestBody,
    maxRequestBytes: MAX_REQUEST_BYTES,
    healthDispatch,
    privateOrigin: dispatchOrigin,
  });
  const personalSession = createPostgresTestPersonalSessionDispatch({
    ...shared,
    authenticatePostgresPersonalSession: authenticatePostgresPersonalSessionForRead,
    assertPostgresPersonalSessionCsrf,
    revokePostgresPersonalSession,
    healthDispatch,
    clearSessionCookie: clearedSessionCookie(),
    privateOrigin: dispatchOrigin,
  });
  const devicePairing = createPostgresTestDevicePairingDispatch({
    ...shared,
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
  const devicePairingClaim = createPostgresTestDevicePairingClaimDispatch({
    ...shared,
    claimPostgresDevicePairing,
    healthDispatch,
    readBoundedRequestBody,
    maxRequestBytes: MAX_REQUEST_BYTES,
    privateOrigin: dispatchOrigin,
  });
  const telemetryV12Consent = createPostgresTestTelemetryV12ConsentDispatch({
    ...shared,
    authenticatePostgresPersonalSession: authenticatePostgresPersonalSessionForRead,
    assertPostgresPersonalSessionCsrf,
    grantPostgresTelemetryV12Consent,
    healthDispatch,
    readBoundedRequestBody,
    maxRequestBytes: MAX_REQUEST_BYTES,
    privateOrigin: dispatchOrigin,
  });
  const assertPostgresV12UploadAllowed = (pool, device, nowEpoch, { schema }) =>
    assertPostgresTelemetryTransportWriteAllowed(pool, device, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      { nowEpoch, schema });
  // Legacy intake beside the v1.2 routes (IN-2 and IN-3): the v1.1, v1.0 and
  // v0.1 envelopes with their upload-authorization formats, the
  // upload-authorization route module and the v1.1 routes, all behind the
  // same storage gate as the built-in routes.
  const intake = composeIntake ? createOriginIntakeComposition({
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
    primaryPool: dataPool,
    schemaOptions,
    admissionEnv,
    requestContext,
    assertAdmissionBindings,
    assertAttemptAllowed,
    assertUploadAuthorizationBindings,
    assertUploadAuthorizationAllowed,
    assertV12UploadAllowed: assertPostgresV12UploadAllowed,
    assertStorageCurrent: storageGate.assertCurrent,
    routePolicy: WORKER_ROUTE_POLICY,
    maxRequestBytes: MAX_REQUEST_BYTES,
    socialConsentVersion: TELEMETRY_CONSENT_VERSION,
    sourceNamespace: sourceIdentity.sourceNamespace,
    envelopePublicJwk,
    envelopePrivateJwk,
  }) : null;
  const v12Dispatch = createPostgresTestV12DayManifestDispatch({
    ...shared,
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
    storageGate,
    privateOrigin: dispatchOrigin,
    healthDispatch: statusDispatchers.health,
    admissionEnv,
    assertAdmissionBindings,
    assertAttemptAllowed,
    assertUploadAuthorizationBindings,
    assertUploadAuthorizationAllowed,
    assertUploadIngressRequestAllowed,
    uploadIngress,
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
    sourceNamespace: sourceIdentity.sourceNamespace,
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
  });
  // The intake answers every method of the v1.1 routes and a wrong method on
  // the shared legacy routes; it answers null for what the v1.2 dispatch
  // serves.
  const intakeThenV12 = async (request) => (intake === null ? null : await intake.dispatch(request))
    ?? v12Dispatch(request);
  const handlers = new Map();
  for (const id of V12_ROUTE_IDS) handlers.set(id, v12Dispatch);
  for (const id of V11_ROUTE_IDS) handlers.set(id, intakeThenV12);
  handlers.set("contributions", intakeThenV12);
  handlers.set("device_upload_authorization", intakeThenV12);
  handlers.set("session", personalSession);
  handlers.set("logout", personalSession);
  handlers.set("participant_devices", participantDevices);
  handlers.set("participant_device_revocation", participantDevices);
  handlers.set("device_pairing", devicePairing);
  handlers.set("device_pairing_claim", devicePairingClaim);
  handlers.set("telemetry_v12_consent", telemetryV12Consent);
  handlers.set("community_daily", communityDaily);
  handlers.set("health", statusDispatchers.health);
  // The legacy chain has no RD-2: its /api/ready is the v1.2 dispatch's
  // unsupported 503, as before.
  handlers.set("ready", statusDispatchers.ready ?? v12Dispatch);
  if (adminHandlers !== null) {
    for (const id of POSTGRES_ADMIN_HOST_ROUTE_IDS) {
      if (typeof adminHandlers.get(id) !== "function") refuse(ORIGIN_COMPOSITION_INVALID);
      handlers.set(id, adminHandlers.get(id));
    }
  }
  const moduleRegistry = createOriginRouteModuleRegistry({
    modules: [...(intake?.routeModules ?? []), ...routeModules],
    routePolicy: WORKER_ROUTE_POLICY,
  });
  return Object.freeze({
    handlers,
    routeModules: moduleRegistry,
    routeModuleContext,
    dispatchers: Object.freeze({
      communityDaily, participantDevices, personalSession, devicePairing, devicePairingClaim,
      telemetryV12Consent, v12Dispatch, intake,
    }),
  });
}

/**
 * The CR-6 registry over composed families: the handlers of exactly the
 * ported ids, with the route modules folded in.
 */
export function createOriginRouteRegistry(families, portedRouteIds) {
  const ported = new Set(portedRouteIds);
  return createProductionRouteRegistry({
    routePolicy: WORKER_ROUTE_POLICY,
    handlers: new Map([...families.handlers].filter(([id]) => ported.has(id))),
    portedRouteIds: [...portedRouteIds],
    routeModules: families.routeModules,
    routeModuleContext: families.routeModuleContext,
  });
}

/** The analytics-v2 community-daily route module (mandatory on the production plane). */
export function analyticsCommunityDailyModule({ factory, pool, primarySchema, admissionEnv, clock = null, originMode }) {
  if (typeof factory !== "function") refuse("ANALYTICS_V2_COMMUNITY_DAILY_ROUTE_UNAVAILABLE");
  const built = factory({
    pool,
    schema: primarySchema,
    ...(originMode === undefined ? {} : { originMode }),
    ...(clock === null ? {} : { clock }),
    // d43c8f92 index.ts handleCommunityDaily: the public-read limiter (the
    // edge's replayed outcome behind EP-6).
    assertPublicReadAllowed: (request) => assertPublicAggregateReadAllowed(
      admissionEnv.PUBLIC_READ_RATE_LIMIT, request, admissionEnv,
    ),
  });
  if (built === null || typeof built !== "object") refuse("ANALYTICS_V2_COMMUNITY_DAILY_ROUTE_INVALID");
  return defineOriginRouteModule({
    method: built.method,
    pathname: built.pathname,
    overridesBuiltIn: built.overridesBuiltIn,
    handler: built.handler,
  });
}

/**
 * The listen address (wave-3 critic host gap 9): 0.0.0.0 only for a Cloud
 * Run service CR-3 validated (a K_SERVICE name and a canonical run.app
 * HOST_ORIGIN) whose HOST asks for it; 127.0.0.1 otherwise. Any other HOST is
 * refused (HOST_INVALID).
 */
export function productionListenHost(processEnv, configuration) {
  const host = typeof processEnv?.HOST === "string" && processEnv.HOST !== "" ? processEnv.HOST : null;
  if (host !== null && host !== ORIGIN_LISTEN_HOSTS.loopback && host !== ORIGIN_LISTEN_HOSTS.cloudRun) {
    refuse("HOST_INVALID");
  }
  const cloudRunService = configuration?.deployment?.workload?.kind === "service"
    && typeof configuration.deployment.workload.name === "string"
    && processEnv?.K_SERVICE === configuration.deployment.workload.name
    && typeof configuration.origins?.host === "string"
    && canonicalRunAppOrigin(configuration.origins.host) === configuration.origins.host;
  if (host === ORIGIN_LISTEN_HOSTS.cloudRun) {
    if (!cloudRunService) refuse("HOST_INVALID");
    return ORIGIN_LISTEN_HOSTS.cloudRun;
  }
  return ORIGIN_LISTEN_HOSTS.loopback;
}

function listenPort(processEnv) {
  const raw = typeof processEnv?.PORT === "string" && processEnv.PORT !== "" ? processEnv.PORT : "8080";
  const port = /^[0-9]{1,5}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) refuse("PORT_INVALID");
  return port;
}

/** The edge-tier binding names agree across CR-3, EP-6's replay and the edge policy. */
function assertEdgeTierBindings() {
  const sorted = (names) => JSON.stringify([...names].sort());
  if (sorted(EDGE_TIER_RATE_LIMIT_BINDINGS) !== sorted(EDGE_ADMISSION_REPLAY_BINDINGS)
      || sorted(EDGE_TIER_RATE_LIMIT_BINDINGS) !== sorted(EDGE_ADMISSION_BINDINGS)) {
    refuse("EDGE_TIER_BINDINGS_DRIFT");
  }
}

/**
 * HOST_MODE production or staging. processEnv is the process environment;
 * hostMode one of PRODUCTION_HOST_MODES; adminHostPolicy the composition
 * root's OD-CR-3 answer (server.mjs passes PRODUCTION_ADMIN_HOST_POLICY).
 * dependencies (tests and the composition root only): createConnector,
 * createIamPool, createGoogleAccessTokenProvider,
 * createGcsQuarantineObjectStore, createAnalyticsV2CommunityDailyRoute
 * (required), clock (EP-6 and the status families), logger (the request
 * log sink). Returns {productionDispatch, hostOrigin, listenHost,
 * listenPort, pools, connector, configuration, registry}; on a startup
 * refusal it closes what it opened and rethrows the closed code.
 */
export async function createPostgresProductionRuntime({
  processEnv,
  hostMode,
  adminHostPolicy = PRODUCTION_ADMIN_HOST_POLICY,
  dependencies = {},
} = {}) {
  if (!Object.hasOwn(PRODUCTION_HOST_MODES, hostMode ?? "")) refuse("HOST_MODE_INVALID");
  if (adminHostPolicy !== "refuse" && adminHostPolicy !== "chokepoint") refuse("ADMIN_HOST_POLICY_INVALID");
  const configuration = readProductionConfiguration(processEnv, PRODUCTION_HOST_MODES[hostMode]);
  if (configuration.edge?.mode !== EDGE_ORIGIN_MODE) refuse("EDGE_ORIGIN_MODE_INVALID");
  assertEdgeTierBindings();
  const listenHost = productionListenHost(processEnv, configuration);
  const port = listenPort(processEnv);
  const namespace = configuration.vars.TELEMETRY_STORAGE_NAMESPACE;
  let sourceIdentity;
  try {
    sourceIdentity = createPostgresSourceIdentityConfig({ sourceNamespace: namespace });
  } catch {
    refuse("TELEMETRY_STORAGE_NAMESPACE_INVALID");
  }
  const createAnalyticsRoute = dependencies.createAnalyticsV2CommunityDailyRoute
    ?? createAnalyticsV2CommunityDailyRoute;
  const clock = dependencies.clock ?? Date.now;
  const { primary, iamUser, bucket, bucketHistoryProof } = configuration.resources;
  const primarySchema = primary.schema;
  const connector = typeof dependencies.createConnector === "function"
    ? dependencies.createConnector()
    : new Connector();
  const createPool = dependencies.createIamPool ?? createIamPool;
  const pools = [];
  try {
    const openPool = async (name) => {
      const pool = await createPool({
        connector,
        instanceConnectionName: primary.instanceConnectionName,
        database: primary.database,
        user: iamUser,
        max: configuration.poolSizes[name],
        applicationName: PRODUCTION_POOL_APPLICATION_NAMES[name],
      });
      pools.push(pool);
      return pool;
    };
    const dataPool = await openPool("data");
    const admissionPool = await openPool("admission");
    const readinessPool = await openPool("readiness");
    const keyHashSecret = revealProductionSecret(configuration.secrets.POSTGRES_RATE_LIMIT_SECRET);
    const originTier = {};
    for (const [name, limits] of Object.entries(configuration.rateLimits.originTier)) {
      originTier[limits.binding] = createPostgresRateLimiter(admissionPool, {
        primarySchema,
        name,
        limit: limits.limit,
        periodSeconds: limits.periodSeconds,
        keyHashSecret,
      }, { ...configuration.admissionTimeouts });
    }
    const budget = createPostgresUploadIngressBudget(admissionPool, { primarySchema });
    const edgeAdmission = createEdgeAdmissionLimiters();
    const env = createProductionWorkerEnv(configuration, {
      bindings: {
        ...edgeAdmission.bindings,
        ...originTier,
        UPLOAD_INGRESS_BUDGET: Object.freeze({ getByName: () => budget }),
      },
    });
    const accessToken = await (dependencies.createGoogleAccessTokenProvider ?? createGoogleAccessTokenProvider)();
    const objectStore = (dependencies.createGcsQuarantineObjectStore ?? createGcsQuarantineObjectStore)(
      bucket, accessToken, undefined, undefined, bucketHistoryProof,
    );
    const storageGate = createPostgresStorageGate({
      primaryPool: readinessPool,
      schemaOptions: { primarySchema },
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      positiveTtlMilliseconds: PRODUCTION_STORAGE_GATE_TTL_MILLISECONDS,
      clock,
    });
    const requestContextStore = createRequestContextStore();
    const requestContext = requestContextStore.accessor;
    const adminOpen = adminHostPolicy === "chokepoint";
    const portedRouteIds = [...POSTGRES_PORTED_WORKER_ROUTE_IDS, ...(adminOpen ? ADMIN_HOST_ROUTE_IDS : [])];
    const capabilityFlags = healthCapabilityFlags((id) => portedRouteIds.includes(id));
    const statusDispatchers = Object.freeze({
      health: createPostgresHealthDispatch({
        requestContext, env, readinessPool, primarySchema, objectStore, capabilityFlags, clock,
      }),
      ready: createPostgresReadinessDispatch({
        requestContext, env, readinessPool, primarySchema,
        sourceNamespace: sourceIdentity.sourceNamespace,
        expectedPrimaryMigrations: POSTGRES_RUNTIME_MIGRATIONS.primary,
        clock,
      }),
    });
    const adminHandlers = adminOpen
      ? createAdminConsoleHandlers({
        requestContext,
        env,
        // analytics_v2 lives in primary (0059): no separate analytics pool.
        pools: { primary: dataPool },
        schemaOptions: { primarySchema },
        maintenance: createLifecyclePassMaintenance({ pool: dataPool, objectStore, primarySchema }),
      })
      : null;
    const families = composeOriginFamilies({
      dataPool,
      primarySchema,
      sourceIdentity,
      admissionEnv: env,
      storageGate,
      dispatchOrigin: configuration.origins.public,
      productionConfiguration: configuration,
      objectStore,
      envelopePublicJwk: env.ENVELOPE_PUBLIC_JWK,
      envelopePrivateJwk: env.ENVELOPE_PRIVATE_JWK,
      requestContext,
      uploadIngress: createUploadIngressAuthority(),
      statusDispatchers,
      routeModules: [analyticsCommunityDailyModule({
        factory: createAnalyticsRoute, pool: dataPool, primarySchema, admissionEnv: env,
      })],
      routeModuleContext: (request) => Object.freeze({
        origin: configuration.origins.public,
        hostMode,
        requestId: requestIdFrom(requestContext, request),
      }),
      adminHandlers,
    });
    const registry = createOriginRouteRegistry(families, portedRouteIds);
    const registryFlags = healthCapabilityFlags(registryPorted(registry));
    if (JSON.stringify(registryFlags) !== JSON.stringify(capabilityFlags)) refuse("HEALTH_CAPABILITY_FLAGS_DRIFT");
    const handler = createProductionRequestHandler({
      registry,
      env,
      requestContextStore,
      requestContext: edgeRequestContext,
      storageGate,
      recordDiagnostic: (event) => recordPostgresDiagnosticError(dataPool, { primarySchema }, event),
      ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
      adminHostPolicy,
      ...(adminOpen ? { adminAccess: createPostgresAdminAccessChokepoint(env) } : {}),
      unportedRetryAfterSeconds: PRODUCTION_UNPORTED_RETRY_AFTER_SECONDS,
    });
    const productionDispatch = createEdgeOriginDispatch({
      invokerServiceAccount: configuration.edge.invokerServiceAccount,
      verifierServiceAccounts: configuration.edge.verifierServiceAccounts,
      audience: configuration.edge.audience,
      publicOrigin: configuration.origins.public,
      admission: edgeAdmission,
      inner: handler,
      clock,
      onRefusal: (diagnostic) => logOriginBoundaryRefusal(diagnostic),
    });
    return Object.freeze({
      productionDispatch,
      hostMode,
      hostOrigin: configuration.origins.host,
      listenHost,
      listenPort: port,
      pools: Object.freeze([...pools]),
      connector,
      configuration,
      registry,
    });
  } catch (error) {
    await closeCloudSqlResources({ pools, connector }).catch(() => undefined);
    if (typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)) {
      throw compositionError(error.code);
    }
    if (error instanceof ApiError) throw compositionError(error.code);
    throw compositionError("CLOUD_RUN_PRODUCTION_RUNTIME_FAILED");
  }
}
