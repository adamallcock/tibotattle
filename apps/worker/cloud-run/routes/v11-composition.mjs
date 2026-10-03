/**
 * One-call composition of the v1.1 intake family for the PostgreSQL origin
 * (GCP fast path, IN-2). ../origin-intake-composition.mjs composes it for
 * server.mjs: it mounts `dispatch` on the private origin before the v1.2
 * dispatch, registers the envelope next to v1.2 with the
 * telemetry-contribution-v1.1 format, and the contributions preamble claims
 * non-v1.2 envelopes under the v1.1 accountless gate. The notes below record
 * why each hand-off has its shape.
 *
 * It binds the four v1.1 route modules and the telemetry-envelope-v1.1
 * registration to the origin's PostgreSQL adapters. `adapters` are the
 * already-imported TypeScript modules (server.mjs imports them from ../src
 * and esbuild bundles them); nothing here opens a pool, reads process.env or
 * picks a runtime adapter (family contract FC-3).
 *
 * Mounting the four routes (lead hand-off). The IN-1 route-module seam
 * replaces only named built-ins and resolves a module by exact method and
 * pathname, so it refuses these additive modules, and even an additive
 * extension would let a wrong method fall through to the origin's
 * non-module path instead of the Worker's registry 405 (assertWorkerRouteMethod
 * with its Allow header). `dispatch(request)` therefore serves every method of
 * `pathnames` and answers null for any other path: the lead mounts it on the
 * private origin before the v1.2 dispatch, as server.mjs mounts the other
 * pathname dispatches, and a wrong method reaches the module's own 405 with
 * the Worker's Allow value (POST, or GET, POST for day manifests). The
 * `routeModules` stay for a seam that answers that 405 itself.
 *
 * Contributions (lead hand-off). The envelope registration goes to
 * createContributionEnvelopeRegistry next to v1.2 with ownsReceipt: true (the
 * handler resolves its claim itself). Its transport needs the
 * telemetry-contribution-v1.1 upload-authorization format (IN-3), which the
 * preamble runs before dispatch as the Worker's transport write gate. The
 * preamble must claim a non-v1.2 envelope with
 * claimPostgresDeviceUploadAuthorization(..., { schema,
 * accountlessAuthorizationVersion: "v1.1" }), d43c8f92's claim gate: the
 * default ("v1.2") also demands the typed-v1.2 grant, which refuses a shipped
 * accountless client that holds only the v1.1 lease graph with 401
 * UPLOAD_AUTH_INVALID.
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
  personalDevices: Object.freeze(["authenticatePostgresPersonalSession", "assertPostgresPersonalSessionCsrf"]),
  controls: Object.freeze(["assertPostgresCollectionControlFromPool"]),
  crypto: Object.freeze(["decryptSyntheticEnvelope", "sha256Hex"]),
  boundedBody: Object.freeze(["readBoundedRequestBody"]),
});

/**
 * @param {{
 *   adapters: Record<string, Record<string, unknown>>,
 *   primaryPool: unknown,
 *   schema: Readonly<{ primarySchema: string }>,
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
  const { live, bearer, transport, personalDevices, controls, crypto, boundedBody } = options.adapters;
  const { primaryPool, schema, maxRequestBytes } = options;
  // OD-CR-6 (i): every route's error body carries the root's request id.
  const requestContext = options.requestContext;
  if (requestContext !== undefined && typeof requestContext !== "function") {
    throw routeConfigurationError(route, "requestContext must be a function");
  }
  const device = {
    primaryPool, schema, maxRequestBytes, requestContext,
    admissionEnv: options.admissionEnv,
    assertAdmissionBindings: options.assertAdmissionBindings,
    assertAttemptAllowed: options.assertAttemptAllowed,
    // DB-1 with the Worker's generic v1.1 accountless gate.
    authenticateDevice: (pool, header, routeOptions) => bearer.authenticatePostgresDeviceBearer(pool, header, {
      ...routeOptions, accountlessAuthorizationVersion: "v1.1",
    }),
    assertCollectionControl: controls.assertPostgresCollectionControlFromPool,
    readBoundedRequestBody: boundedBody.readBoundedRequestBody,
  };
  const consent = createTelemetryV11ConsentRouteModule({
    primaryPool, schema, maxRequestBytes, requestContext,
    authenticatePersonalSession: personalDevices.authenticatePostgresPersonalSession,
    assertPersonalSessionCsrf: personalDevices.assertPostgresPersonalSessionCsrf,
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
  const routeModules = Object.freeze([consent, ...dayManifests, predecessor, activate]);
  // One handler per pathname: the two day-manifest modules share theirs, and
  // every handler checks the method first, before any other step.
  const byPathname = new Map(routeModules.map((routeModule) => [routeModule.pathname, routeModule.handler]));
  async function dispatch(request) {
    let pathname;
    try { ({ pathname } = new URL(request.url)); } catch { return null; }
    const handler = byPathname.get(pathname);
    return handler === undefined ? null : handler(request);
  }
  return Object.freeze({
    routeModules,
    pathnames: Object.freeze([...byPathname.keys()]),
    dispatch,
    envelopeRegistration,
  });
}
