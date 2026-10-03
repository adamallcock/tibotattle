/**
 * Legacy intake composition for the PostgreSQL origin (GCP fast path, the
 * IN-2 and IN-3 lead hand-offs).
 *
 * server.mjs builds this once at startup in the host modes whose clients
 * reach these routes (ORIGIN_INTAKE_HOST_MODES), and hands the result to
 * createPostgresTestV12DayManifestDispatch and to its route-module registry:
 *
 * - contributionEnvelopes: telemetry-envelope-v1.1 (IN-2,
 *   envelopes/v11.mjs, ownsReceipt: true), telemetry-envelope-v1.0 and
 *   telemetry-envelope-v0.1 (IN-3, envelopes/v10.mjs and v01.mjs, whose
 *   receipt the shared preamble records). Every other version stays
 *   unregistered and keeps the origin's pre-change refusal.
 * - uploadAuthorizationFormats: telemetry-contribution-v1.0, -v1.1 and
 *   -v0.1, each enforced by TA-1's transport write authority
 *   (src/postgres-transport-write-authority.ts), so the envelope and format
 *   tables pair exactly (assertContributionEnvelopeFormats). v0.2 has no
 *   envelope and therefore no format: it is answered 403
 *   TELEMETRY_TRANSPORT_BLOCKED, as d43c8f92 answers its blocked lifecycle.
 * - recordPostgresDeviceUploadReceipt: IN-3's port of d43c8f92
 *   recordDeviceUploadReceipt, which the preamble runs after the v1.0 and
 *   v0.1 handlers.
 * - routeModules: IN-3's POST /api/v1/device/upload-authorizations module,
 *   which replaces the v1.2-only built-in (shipped v1.0 clients send three
 *   body keys). It authenticates the device bearer under the Worker's
 *   generic v1.1 accountless gate, as d43c8f92 handleDeviceUploadAuthorization
 *   does; each format's write authority then decides (v1.2 still requires
 *   the typed-v1.2 grant there). Its storage gate is the dispatch's schema
 *   receipt check (assertStorageCurrent).
 * - pathnames and dispatch(request): IN-2's four v1.1 routes (consent, day
 *   manifests, domain predecessor and activation). A wrong method reaches
 *   the route's own 405 with the Worker registry's Allow value; an allowed
 *   method first passes the same schema receipt check as every built-in
 *   route, so a stale or newer schema refuses with 503
 *   BACKEND_STORAGE_UNAVAILABLE before any v1.1 read or write. pathnames
 *   also lists the two shared legacy-intake routes (SHARED_LEGACY_PATHNAMES)
 *   so that a wrong method on them gets the same registry 405; dispatch
 *   answers null for their allowed method, which the built-in (or the
 *   upload-authorization module) serves. Any other path answers null and the
 *   caller's next route serves it.
 *
 * Every adapter is injected (the TypeScript modules server.mjs imports), so
 * this file opens no pool, reads no environment and picks no runtime
 * adapter. Plain JavaScript so node:test specs can load it directly.
 */

import { createUploadAuthorizationFormats } from "./contribution-envelope-registry.mjs";
import { createTelemetryV01ContributionEnvelope } from "./envelopes/v01.mjs";
import { createTelemetryV10ContributionEnvelope } from "./envelopes/v10.mjs";
import { legacyUploadAuthorizationFormatEntries } from "./upload-authorization-formats.mjs";
import { createUploadAuthorizationRouteModule } from "./routes/upload-authorizations.mjs";
import { createTelemetryV11OriginIntake } from "./routes/v11-composition.mjs";
import { methodNotAllowed, routeErrorResponse } from "./routes/v11-route-support.mjs";
import { requestIdFrom } from "./postgres-request-context.mjs";

const V12_UPLOAD_AUTHORIZATION_SCHEMA_VERSION = "telemetry-contribution-v1.2";

/**
 * The private-origin host modes that compose the legacy intake: those whose
 * clients reach its routes directly (the loopback v1.2 host and the
 * fast-path test origin). The cloud-run-iam mode never composed it and is
 * retired (owner decision OD-6, 2026-10-02); server.mjs refuses that mode
 * outright, and this predicate keeps answering false for it.
 */
export const ORIGIN_INTAKE_HOST_MODES = Object.freeze(["health-and-v12-day-manifest", "fastpath-test"]);

/** Whether server.mjs composes the legacy intake for a POSTGRES_TEST_HTTP_MODE. */
export function originIntakeServedInMode(mode) {
  return ORIGIN_INTAKE_HOST_MODES.includes(mode);
}

/**
 * Legacy-intake routes the v1.2 dispatch already serves for their allowed
 * method. d43c8f92 answers any other method with the registry's 405 and
 * Allow (assertWorkerRouteMethod); the v1.2 dispatch alone would answer 503
 * not_ready, which a client reads as retryable.
 */
const SHARED_LEGACY_PATHNAMES = Object.freeze([
  "/api/v1/device/upload-authorizations",
  "/api/v1/contributions",
]);

/** The legacy formats this origin authorizes: each pairs with a registered envelope. */
export const ORIGIN_INTAKE_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS = Object.freeze([
  "telemetry-contribution-v1.0",
  "telemetry-contribution-v1.1",
  "telemetry-contribution-v0.1",
]);

const ADAPTER_EXPORTS = Object.freeze({
  legacyAdmission: Object.freeze([
    "admitPostgresTelemetryV1Contribution",
    "admitPostgresTelemetryV01Contribution",
    "recordPostgresDeviceUploadReceipt",
  ]),
  transportWriteAuthority: Object.freeze(["assertPostgresTelemetryTransportWriteAllowed"]),
  transport: Object.freeze(["authenticatePostgresDevice"]),
  uploadAuthorization: Object.freeze(["createPostgresDeviceUploadAuthorization"]),
  controls: Object.freeze(["assertPostgresCollectionControlFromPool"]),
  boundedBody: Object.freeze(["readBoundedRequestBody"]),
});

function compositionError(message) {
  return Object.assign(new Error("ORIGIN_INTAKE_COMPOSITION_INVALID: " + message), {
    code: "ORIGIN_INTAKE_COMPOSITION_INVALID",
  });
}

/**
 * @param {{
 *   adapters: Record<string, Record<string, unknown>>,
 *   primaryPool: unknown,
 *   schemaOptions: Readonly<{ primarySchema: string }>,
 *   admissionEnv: Readonly<Record<string, unknown>>,
 *   assertAdmissionBindings: (env: unknown) => void,
 *   assertAttemptAllowed: (...args: unknown[]) => Promise<void>,
 *   assertUploadAuthorizationBindings: (env: unknown) => void,
 *   assertUploadAuthorizationAllowed: (...args: unknown[]) => Promise<void>,
 *   assertV12UploadAllowed: (pool: unknown, device: unknown, nowEpoch: number, options: object) => unknown,
 *   assertStorageCurrent: () => Promise<void>,
 *   routePolicy: readonly { pathname: string, methods: readonly string[] | "all" }[],
 *   maxRequestBytes: number,
 *   socialConsentVersion: string,
 *   sourceNamespace: string,
 *   envelopePublicJwk: string,
 *   envelopePrivateJwk: string,
 * }} options
 */
export function createOriginIntakeComposition(options) {
  if (options === null || typeof options !== "object"
      || options.adapters === null || typeof options.adapters !== "object") {
    throw compositionError("adapters are required");
  }
  const { adapters } = options;
  for (const [moduleName, names] of Object.entries(ADAPTER_EXPORTS)) {
    for (const name of names) {
      if (typeof adapters[moduleName]?.[name] !== "function") {
        throw compositionError(moduleName + "." + name + " must be a function");
      }
    }
  }
  for (const name of ["assertAdmissionBindings", "assertAttemptAllowed", "assertUploadAuthorizationBindings",
    "assertUploadAuthorizationAllowed", "assertV12UploadAllowed", "assertStorageCurrent"]) {
    if (typeof options[name] !== "function") throw compositionError(name + " must be a function");
  }
  if (!Array.isArray(options.routePolicy)) {
    throw compositionError("routePolicy must be the Worker route policy");
  }
  // One application schema: a stale second schema key is refused here
  // rather than reaching a storage adapter at request time.
  if (options.schemaOptions === null || typeof options.schemaOptions !== "object"
      || Object.keys(options.schemaOptions).join(",") !== "primarySchema"
      || typeof options.schemaOptions.primarySchema !== "string") {
    throw compositionError("schemaOptions must carry exactly primarySchema");
  }
  const {
    primaryPool, schemaOptions, admissionEnv, maxRequestBytes, assertStorageCurrent, requestContext,
  } = options;
  if (requestContext !== undefined && typeof requestContext !== "function") {
    throw compositionError("requestContext must be a function");
  }
  const {
    legacyAdmission, transportWriteAuthority, transport, uploadAuthorization, controls, boundedBody,
  } = adapters;

  const v11 = createTelemetryV11OriginIntake({
    adapters: {
      live: adapters.live,
      bearer: adapters.bearer,
      transport: adapters.transport,
      personalDevices: adapters.personalDevices,
      controls: adapters.controls,
      crypto: adapters.crypto,
      boundedBody: adapters.boundedBody,
    },
    primaryPool,
    schema: schemaOptions,
    admissionEnv,
    assertAdmissionBindings: options.assertAdmissionBindings,
    assertAttemptAllowed: options.assertAttemptAllowed,
    maxRequestBytes,
    requestContext,
    socialConsentVersion: options.socialConsentVersion,
    sourceNamespace: options.sourceNamespace,
    envelopePublicJwk: options.envelopePublicJwk,
    envelopePrivateJwk: options.envelopePrivateJwk,
  });

  const legacyFormats = legacyUploadAuthorizationFormatEntries({
    assertTelemetryTransportWriteAllowed: transportWriteAuthority.assertPostgresTelemetryTransportWriteAllowed,
    schemaVersions: ORIGIN_INTAKE_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS,
  });
  const contributionEnvelopes = Object.freeze([
    v11.envelopeRegistration,
    createTelemetryV10ContributionEnvelope({
      admitTelemetryV1Contribution: legacyAdmission.admitPostgresTelemetryV1Contribution,
    }),
    createTelemetryV01ContributionEnvelope({
      admitTelemetryV01Contribution: legacyAdmission.admitPostgresTelemetryV01Contribution,
    }),
  ]);

  const uploadAuthorizations = createUploadAuthorizationRouteModule({
    primaryPool,
    schema: schemaOptions,
    maxRequestBytes,
    admissionEnv,
    requestContext,
    // The module's table is the origin's whole table, v1.2 included, with
    // the same v1.2 entry the dispatch registers.
    formats: createUploadAuthorizationFormats(new Map([
      [V12_UPLOAD_AUTHORIZATION_SCHEMA_VERSION, { assertUploadAllowed: options.assertV12UploadAllowed }],
      ...Object.entries(legacyFormats),
    ])),
    assertStorageCurrent,
    assertAdmissionBindings: options.assertAdmissionBindings,
    assertUploadAuthorizationBindings: options.assertUploadAuthorizationBindings,
    assertUploadAuthorizationAllowed: options.assertUploadAuthorizationAllowed,
    assertUploadRegistrationEnabled: (pool, primarySchema) =>
      controls.assertPostgresCollectionControlFromPool(pool, primarySchema, "uploadRegistration"),
    // d43c8f92 handleDeviceUploadAuthorization authenticates with the
    // generic device gate (the shared v1.1 accountless grant chain).
    authenticateDevice: (pool, header, routeOptions) => transport.authenticatePostgresDevice(pool, header, {
      ...routeOptions, accountlessAuthorizationVersion: "v1.1",
    }),
    readBoundedRequestBody: boundedBody.readBoundedRequestBody,
    createDeviceUploadAuthorization: uploadAuthorization.createPostgresDeviceUploadAuthorization,
  });

  const pathnames = Object.freeze([...v11.pathnames, ...SHARED_LEGACY_PATHNAMES]);
  const sharedPathnames = new Set(SHARED_LEGACY_PATHNAMES);
  const allowedMethods = new Map();
  for (const pathname of pathnames) {
    const policy = options.routePolicy.find((entry) => entry?.pathname === pathname);
    if (!policy || (policy.methods !== "all" && !Array.isArray(policy.methods))) {
      throw compositionError(pathname + " is not a route in the Worker route registry");
    }
    allowedMethods.set(pathname, policy.methods);
  }

  async function dispatch(request) {
    let pathname;
    try { ({ pathname } = new URL(request.url)); } catch { return null; }
    const methods = allowedMethods.get(pathname);
    if (methods === undefined) return null;
    const allowed = methods === "all" || methods.includes(request.method);
    // A shared legacy route: the registry's 405 here, the built-in otherwise.
    if (sharedPathnames.has(pathname)) {
      return allowed ? null : routeErrorResponse(methodNotAllowed(methods), requestIdFrom(requestContext, request));
    }
    // A wrong method keeps the route's own 405; an allowed one is served
    // only against current migration receipts, like every built-in route.
    if (allowed) {
      try {
        await assertStorageCurrent();
      } catch (error) {
        return routeErrorResponse(error, requestIdFrom(requestContext, request));
      }
    }
    return v11.dispatch(request);
  }

  return Object.freeze({
    contributionEnvelopes,
    uploadAuthorizationFormats: legacyFormats,
    recordPostgresDeviceUploadReceipt: legacyAdmission.recordPostgresDeviceUploadReceipt,
    routeModules: Object.freeze([uploadAuthorizations]),
    pathnames,
    dispatch,
  });
}
