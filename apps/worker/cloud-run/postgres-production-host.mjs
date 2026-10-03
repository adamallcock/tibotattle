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
 * (TTL 0, OD-ROLL / OD-CR-10, on the data pool so the readiness pool stays
 * RD-2's and RD-3's alone), the families, the registry
 * (POSTGRES_PORTED_WORKER_ROUTE_IDS, with the route modules folded in), the
 * CR-6 handler and EP-6 in front of it.
 *
 * The admin host (OD-CR-3) is a composition-root decision. The owner
 * answered OWN-17 in round 12 (2026-10-02): open it with what is ported, and
 * show "unavailable" for every section with no GCP source (ADMIN-R12).
 * PRODUCTION_ADMIN_HOST_POLICY is therefore 'chokepoint': the runtime builds
 * createPostgresAdminAccessChokepoint once over the env, registers C-ADMIN's
 * six routes (no analytics pool while analytics_v2 lives in primary,
 * migration 0059) and injects C-MAINT's lifecycle pass as their
 * run_maintenance task. No overview source is injected: the synthetic
 * contribution counts, historical publication and deletion-ledger blocks
 * answer their explicit unavailable state ('admin-overview-v0.6'), and the
 * database health reports the removed ledger not_applicable
 * ('admin-database-health-v0.2'). 'refuse' (503 POSTGRES_ROUTE_NOT_PORTED for
 * every admin-host request) stays available to a caller that passes it.
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
import {
  ADMIN_HOST_ROUTE_IDS,
  assertIdentityLinkConsumersRetired,
  createProductionRouteRegistry,
} from "./postgres-production-registry.mjs";
import { createPostgresReadinessDispatch } from "./postgres-readiness-dispatch.mjs";
import { createPostgresHealthDispatch, healthCapabilityFlags, registryPorted } from "./postgres-health-dispatch.mjs";
import {
  EDGE_ORIGIN_MODE,
  EDGE_TIER_RATE_LIMIT_BINDINGS,
  PRODUCTION_ADMISSION_TIMEOUTS,
  PRODUCTION_POOL_APPLICATION_NAMES,
  createProductionWorkerEnv,
  isRotatedIdentityLinkVersion,
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
 * OD-CR-3 for the production and staging admin host: 'chokepoint'. The owner
 * answered OWN-17 questions 1 to 3 in round 12 (open the admin host with
 * what is ported; sections without a GCP source say "unavailable"; the
 * removed deletion ledger is not_applicable with a closed-DTO version bump),
 * built as ADMIN-R12: C-ADMIN's six routes are served behind the Access
 * chokepoint. Without ACCESS_AUD (round 11's staging roll) the chokepoint
 * answers every admin-host request 503 ADMIN_NOT_CONFIGURED, as the Worker
 * does.
 */
export const PRODUCTION_ADMIN_HOST_POLICY = "chokepoint";

/**
 * The edge-test rehearsal origin (server.mjs, EDGE_ORIGIN_MODE=edge-test)
 * composes no admin family and no Access configuration, so its admin host
 * stays refused (503 POSTGRES_ROUTE_NOT_PORTED) after round 12.
 */
export const EDGE_TEST_ADMIN_HOST_POLICY = "refuse";

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
 * Defence in depth for round 16's identity-link rotation: under a rotated
 * label (production-v2), the host refuses to compose
 * (IDENTITY_LINK_ROTATION_CONSUMER_PORTED) if its ported set would serve a
 * route that consumes the identity-link pin, link keys or cooldown digests
 * (IDENTITY_LINK_CONSUMER_ROUTE_IDS). Returns whether the label is rotated.
 */
export function assertIdentityLinkRotationComposable(identityLinkSecretVersion, portedRouteIds) {
  if (!isRotatedIdentityLinkVersion(identityLinkSecretVersion)) return false;
  try {
    assertIdentityLinkConsumersRetired(portedRouteIds);
  } catch {
    refuse("IDENTITY_LINK_ROTATION_CONSUMER_PORTED");
  }
  return true;
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

const PASS_STORAGE_UNAVAILABLE = Object.freeze({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
const PASS_STATE_CONFLICT = Object.freeze({ status: 503, code: "LIFECYCLE_STATE_CONFLICT" });
const PASS_INTERNAL_ERROR = Object.freeze({ status: 500, code: "INTERNAL_ERROR" });

/**
 * The admin action's error for each refused or failed lifecycle pass code
 * (POSTGRES_LIFECYCLE_PASS_CODES.refused and .failure). A pass that cannot
 * complete is an error of run_maintenance, never a result: d43c8f92
 * runScheduledMaintenance throws, so handleAdminAction writes a 'failure'
 * audit with the error's code and answers the error (index.ts:3806-3851).
 * Each code takes the Worker's answer for the same condition: a schema,
 * receipt or row the pass cannot trust is 503 BACKEND_STORAGE_UNAVAILABLE
 * (the storage gate's refusal and the Worker's for a missing retention row);
 * a lease, cycle, pin or CHECK conflict on the lifecycle rows is 503
 * LIFECYCLE_STATE_CONFLICT (the Worker's answer for a lost maintenance or
 * reconciliation lease); a driver or object-store failure is 500
 * INTERNAL_ERROR (a D1 or R2 failure inside the Worker's pass is a raw
 * error). A code outside this table is also 500 INTERNAL_ERROR.
 */
export const LIFECYCLE_PASS_ADMIN_ERRORS = Object.freeze({
  POSTGRES_VERSION_UNSUPPORTED: PASS_STORAGE_UNAVAILABLE,
  POSTGRES_SCHEMA_RECEIPT_MISMATCH: PASS_STORAGE_UNAVAILABLE,
  LIFECYCLE_STATE_MISSING: PASS_STORAGE_UNAVAILABLE,
  LIFECYCLE_STATE_SHAPE_INVALID: PASS_STORAGE_UNAVAILABLE,
  LIFECYCLE_QUARANTINE_RETENTION_UNPORTED: PASS_STORAGE_UNAVAILABLE,
  LIFECYCLE_RESTORE_PIN_CONFLICT: PASS_STATE_CONFLICT,
  LIFECYCLE_LEASE_CONFLICT: PASS_STATE_CONFLICT,
  LIFECYCLE_CYCLE_REGRESSED: PASS_STATE_CONFLICT,
  LIFECYCLE_STATE_CHECK_CONFLICT: PASS_STATE_CONFLICT,
  POSTGRES_MAINTENANCE_UNAVAILABLE: PASS_INTERNAL_ERROR,
  QUARANTINE_OBJECT_STORAGE_UNAVAILABLE: PASS_INTERNAL_ERROR,
});

/**
 * C-MAINT's lifecycle pass as the admin action's run_maintenance task
 * (C-ADMIN admin-action.mjs, audited by RUN_MAINTENANCE_AUDIT_FIELDS): the
 * pass for the request's whole-minute cycle, mapped to the Worker's result
 * keys in the Worker's order. A pass that cannot take the maintenance lock
 * or the migration fence is MAINTENANCE_IN_PROGRESS, which the action
 * answers 409 LIFECYCLE_STATE_CONFLICT. A refused or failed pass throws its
 * LIFECYCLE_PASS_ADMIN_ERRORS entry, so the action records a failure audit
 * and answers that error, as the Worker does. Erasure-era items are the
 * constant not-applicable values of owner decision OD-4.
 *
 * The pass's folded purges (MAINT-PURGE) map to the Worker's keys: expired
 * handoffs to expiredIdentityHandoffs*, sign-in admission windows to
 * expiredSignInAdmissions*, and the device-lifecycle counts to the Worker's
 * five stale and expired counts. When the pass ran no purge (a cycle already
 * complete in both rows, whose first complete pass ran them) those keys are
 * absent, never reported as done.
 *
 * The code is the Worker's conjunction (scheduled maintenance's complete),
 * one of the Worker's two result codes: OK when the lifecycle, the
 * quarantine reconciliation and, when this pass ran them, the handoff and
 * sign-in window purges are complete, otherwise MAINTENANCE_INCOMPLETE. A
 * device-lifecycle backlog does not enter it, as on the Worker, although the
 * pass itself reports it as partial (MAINTENANCE_PURGE_BACKLOG).
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
      if (result.outcome !== "complete" && result.outcome !== "partial") {
        const answer = Object.hasOwn(LIFECYCLE_PASS_ADMIN_ERRORS, result.code)
          ? LIFECYCLE_PASS_ADMIN_ERRORS[result.code]
          : PASS_INTERNAL_ERROR;
        throw new ApiError(answer.status, answer.code);
      }
      const purges = result.maintenancePurges;
      const handoffs = purges === null ? null : purges.identity.handoffs;
      const signInAdmissions = purges === null ? null : purges.identity.signInAdmissions;
      const device = purges === null ? null : purges.deviceLifecycle;
      const complete = result.lifecycleComplete && result.quarantineReconciliationComplete
        && (purges === null || (handoffs.complete && signInAdmissions.complete));
      return Object.freeze({
        code: complete ? "OK" : "MAINTENANCE_INCOMPLETE",
        lifecycleComplete: result.lifecycleComplete,
        quarantineRetentionComplete: result.quarantineRetentionComplete,
        restoreReplayComplete: result.appendOnlyNotApplicable.restoreReplayComplete,
        quarantineReconciliationComplete: result.quarantineReconciliationComplete,
        ...(handoffs === null ? {} : {
          expiredIdentityHandoffsPurged: handoffs.purged,
          expiredIdentityHandoffPurgeComplete: handoffs.complete,
        }),
        expiredDeletionTombstonesPurged: 0,
        deletionTombstonePurgeComplete: result.appendOnlyNotApplicable.deletionTombstoneRetentionComplete,
        expiredPrimaryIdentityReenrollmentCooldownsPurged: 0,
        primaryIdentityReenrollmentCooldownPurgeComplete: true,
        expiredIdentityReenrollmentCooldownsPurged: 0,
        identityReenrollmentCooldownPurgeComplete: true,
        ...(signInAdmissions === null ? {} : {
          expiredSignInAdmissionsPurged: signInAdmissions.purged,
          signInAdmissionPurgeComplete: signInAdmissions.complete,
        }),
        ...(device === null ? {} : {
          staleDevicePairingsRevoked: device.pairingsRevoked,
          staleDeviceCredentialsRevoked: device.devicesRevoked,
          staleDeviceUploadAuthorizationsRevoked: device.uploadsRevoked,
          expiredDeviceCredentialRotationsPurged: device.rotationsPurged,
          expiredDevicePairingEventsPurged: device.pairingEventsPurged,
        }),
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

/**
 * The edge-tier binding names agree across CR-3, EP-6's replay and the edge
 * policy, in any order; otherwise EDGE_TIER_BINDINGS_DRIFT. The runtime
 * passes the three module lists; the lists are a parameter only so the check
 * can drift each one.
 */
export function assertEdgeTierBindings({
  configuration = EDGE_TIER_RATE_LIMIT_BINDINGS,
  replay = EDGE_ADMISSION_REPLAY_BINDINGS,
  policy = EDGE_ADMISSION_BINDINGS,
} = {}) {
  const sorted = (names) => JSON.stringify([...names].sort());
  if (sorted(configuration) !== sorted(replay) || sorted(configuration) !== sorted(policy)) {
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
  const adminOpen = adminHostPolicy === "chokepoint";
  const portedRouteIds = [...POSTGRES_PORTED_WORKER_ROUTE_IDS, ...(adminOpen ? ADMIN_HOST_ROUTE_IDS : [])];
  assertIdentityLinkRotationComposable(configuration.vars.IDENTITY_LINK_SECRET_VERSION, portedRouteIds);
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
    // The gate reads on the data pool, never the readiness pool: with TTL 0
    // every gated request makes its own receipt read, and on the one
    // readiness connection those reads would queue /api/ready and
    // /api/health behind request traffic (and each other). Every caller
    // reads the gate before it takes a data connection and holds none while
    // it waits, so the gate's checkout cannot deadlock the family's.
    const storageGate = createPostgresStorageGate({
      primaryPool: dataPool,
      schemaOptions: { primarySchema },
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      positiveTtlMilliseconds: PRODUCTION_STORAGE_GATE_TTL_MILLISECONDS,
      clock,
    });
    const requestContextStore = createRequestContextStore();
    const requestContext = requestContextStore.accessor;
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
