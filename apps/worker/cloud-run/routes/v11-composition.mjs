/**
 * One-call composition of the v1.1 intake family for the PostgreSQL origin
 * (GCP fast path, IN-2), for the integration lead's server.mjs wiring.
 *
 * It binds the four v1.1 route modules and the telemetry-envelope-v1.1
 * registration to the origin's PostgreSQL adapters. `adapters` are the
 * already-imported TypeScript modules (server.mjs imports them from ../src
 * and esbuild bundles them); nothing here opens a pool, reads process.env or
 * picks a runtime adapter (family contract FC-3).
 *
 * The route modules are additive (overridesBuiltIn: false): the IN-1
 * registry must accept registry routes the origin has no built-in for before
 * they can be mounted. The envelope registration goes to
 * createContributionEnvelopeRegistry next to v1.2, and its transport needs
 * the telemetry-contribution-v1.1 upload-authorization format (IN-3).
 */

import { createTelemetryV11ContributionEnvelope } from "../envelopes/v11.mjs";
import { createTelemetryV11ConsentRouteModule } from "./v11-device-telemetry-consents.mjs";
import { createTelemetryV11DayManifestRouteModules } from "./v11-day-manifests.mjs";
import { createTelemetryV11DomainActivateRouteModule } from "./v11-domain-activate.mjs";
import { createTelemetryV11DomainPredecessorRouteModule } from "./v11-domain-predecessor.mjs";
import { routeConfigurationError } from "./v11-route-support.mjs";

const ADAPTER_EXPORTS = Object.freeze({
  live: Object.freeze([
    "grantPostgresTelemetryV11Consent", "registerPostgresTelemetryV11DayManifest",
    "readPostgresTelemetryV11DayChunkVector", "readPostgresTelemetryV11DayCandidates",
    "createPostgresTelemetryV11Domain", "readPostgresTelemetryV11StorageReplay",
    "persistPostgresTypedV11StagedChunk", "readPostgresTelemetryV11UploadOutcome",
    "recordPostgresTelemetryV11UploadReceipt", "registerPostgresTelemetryV11PendingObject",
    "retirePostgresTelemetryV11PendingObject", "validatePostgresTelemetryV11StagedChunk",
  ]),
  bearer: Object.freeze(["authenticatePostgresDeviceBearer"]),
  transport: Object.freeze(["abandonPostgresDeviceUploadAuthorization"]),
  ledgerAuthority: Object.freeze(["hasPostgresDeletionTombstone"]),
  personalDevices: Object.freeze(["authenticatePostgresPersonalSession", "assertPostgresPersonalSessionCsrf"]),
  controls: Object.freeze(["assertPostgresCollectionControlFromPool"]),
  crypto: Object.freeze(["decryptSyntheticEnvelope", "sha256Hex"]),
  boundedBody: Object.freeze(["readBoundedRequestBody"]),
});

/**
 * @param {{
 *   adapters: Record<string, Record<string, unknown>>,
 *   primaryPool: unknown, ledgerPool: unknown,
 *   schema: Readonly<{ primarySchema: string, ledgerSchema: string }>,
 *   admissionEnv: unknown,
 *   assertAdmissionBindings: (env: unknown) => void,
 *   assertAttemptAllowed: (...args: unknown[]) => Promise<void>,
 *   maxRequestBytes: number,
 *   socialConsentVersion: string,
 *   sourceNamespace: string,
 *   envelopePublicJwk: string,
 *   envelopePrivateJwk: string,
 * }} options
 */
export function createTelemetryV11OriginIntake(options) {
  const route = "telemetry_v11_composition";
  if (options === null || typeof options !== "object" || options.adapters === null
      || typeof options.adapters !== "object") {
    throw routeConfigurationError(route, "adapters are required");
  }
  for (const [moduleName, names] of Object.entries(ADAPTER_EXPORTS)) {
    const adapter = options.adapters[moduleName];
    for (const name of names) {
      if (typeof adapter?.[name] !== "function") {
        throw routeConfigurationError(route, moduleName + "." + name + " must be a function");
      }
    }
  }
  const { live, bearer, transport, ledgerAuthority, personalDevices, controls, crypto, boundedBody } = options.adapters;
  const { primaryPool, ledgerPool, schema, maxRequestBytes } = options;
  const device = {
    primaryPool, ledgerPool, schema, maxRequestBytes,
    admissionEnv: options.admissionEnv,
    assertAdmissionBindings: options.assertAdmissionBindings,
    assertAttemptAllowed: options.assertAttemptAllowed,
    // DB-1 with the Worker's generic v1.1 accountless gate.
    authenticateDevice: (pool, header, routeOptions) => bearer.authenticatePostgresDeviceBearer(pool, header, {
      ...routeOptions, accountlessAuthorizationVersion: "v1.1",
    }),
    hasDeletionTombstone: ledgerAuthority.hasPostgresDeletionTombstone,
    assertCollectionControl: controls.assertPostgresCollectionControlFromPool,
    readBoundedRequestBody: boundedBody.readBoundedRequestBody,
  };
  const consent = createTelemetryV11ConsentRouteModule({
    primaryPool, ledgerPool, schema, maxRequestBytes,
    authenticatePersonalSession: personalDevices.authenticatePostgresPersonalSession,
    assertPersonalSessionCsrf: personalDevices.assertPostgresPersonalSessionCsrf,
    hasDeletionTombstone: ledgerAuthority.hasPostgresDeletionTombstone,
    assertCollectionControl: controls.assertPostgresCollectionControlFromPool,
    grantConsent: live.grantPostgresTelemetryV11Consent,
    readBoundedRequestBody: boundedBody.readBoundedRequestBody,
    socialConsentVersion: options.socialConsentVersion,
  });
  const dayManifests = createTelemetryV11DayManifestRouteModules({
    ...device,
    registerDayManifest: live.registerPostgresTelemetryV11DayManifest,
    readDayChunkVector: live.readPostgresTelemetryV11DayChunkVector,
    readDayCandidates: live.readPostgresTelemetryV11DayCandidates,
  });
  const domain = { ...device, createDomain: live.createPostgresTelemetryV11Domain };
  const predecessor = createTelemetryV11DomainPredecessorRouteModule(domain);
  const activate = createTelemetryV11DomainActivateRouteModule(domain);
  const envelopeRegistration = createTelemetryV11ContributionEnvelope({
    readStorageReplay: live.readPostgresTelemetryV11StorageReplay,
    persistStagedChunk: live.persistPostgresTypedV11StagedChunk,
    readUploadOutcome: live.readPostgresTelemetryV11UploadOutcome,
    recordUploadReceipt: live.recordPostgresTelemetryV11UploadReceipt,
    registerPendingObject: live.registerPostgresTelemetryV11PendingObject,
    retirePendingObject: live.retirePostgresTelemetryV11PendingObject,
    abandonUploadAuthorization: transport.abandonPostgresDeviceUploadAuthorization,
    validateStagedChunk: live.validatePostgresTelemetryV11StagedChunk,
    decryptSyntheticEnvelope: crypto.decryptSyntheticEnvelope,
    sha256Hex: crypto.sha256Hex,
    socialConsentVersion: options.socialConsentVersion,
    sourceNamespace: options.sourceNamespace,
    envelopePublicJwk: options.envelopePublicJwk,
    envelopePrivateJwk: options.envelopePrivateJwk,
  });
  return Object.freeze({
    routeModules: Object.freeze([consent, ...dayManifests, predecessor, activate]),
    envelopeRegistration,
  });
}
