/**
 * Shared contract for the PostgreSQL route families of the Cloud Run host.
 *
 * The Cloudflare Worker (src/index.ts) is the behavioural reference. Each
 * route family is ported as new modules that import this file; the
 * composition root owns registration, the request context, logging and the
 * route registry.
 *
 * FAMILY CONVENTIONS (FC). Later work items cite these rules as "FC".
 *
 * FC-1  New files only. A family adds its own modules, specs and staged
 *       migrations. It never edits the composition hubs (cloud-run/server.mjs,
 *       postgres-test-dispatch.mjs, request-boundary.mjs, oauth-gateway.mjs,
 *       src/route-registry.ts, src/backend-composition.ts), package.json
 *       scripts or migration gate constants; the integrator wires it in.
 * FC-2  Shape. A family exports create<Family>Dispatch(deps), which returns
 *       async (request) => Response, plus a frozen <FAMILY>_PATHNAMES list
 *       accepted by assertFrozenPathnames. The dispatcher takes exactly one
 *       argument (DISPATCH_CONTRACT); context never travels as a second one.
 * FC-3  Dependencies. deps carries pools, schemaOptions, a frozen
 *       Worker-shaped env (an explicit allowlist, never spread from
 *       process.env; read it with Reflect.get), origins, storageGate,
 *       requestContext and, when the root supplies it, clock. Families never
 *       read process.env, open pools or pick runtime adapters themselves.
 * FC-4  Request context. deps.requestContext(request) is a read-only accessor
 *       over a root-owned WeakMap keyed on the exact Request object
 *       (postgres-request-context.mjs). Use requestIdFor and adminIdentityFor;
 *       never derive a request id or an admin identity from headers, query
 *       strings or bodies. An admin family refuses with its Worker code when
 *       adminIdentityFor returns null and never re-verifies Access itself.
 * FC-5  Worker envelope and headers. Responses go through workerJson,
 *       workerError or apiErrorToResponse: JSON_SECURITY_HEADERS, an error
 *       body of exactly {error: {code, requestId, details?}}, Allow only on a
 *       405 and retry-after only where the Worker sends one. A failure that
 *       is not an ApiError answers 500 INTERNAL_ERROR with no message text.
 * FC-6  Logging. Families never emit request_failed (or any other
 *       per-request outcome) log; the root classifies every response. A
 *       family log is a fixed, content-free event name. Never log bodies,
 *       ids, tokens, cookies, IP addresses, SQL or driver error text.
 * FC-7  Rate limits. Address-keyed limits call exactly the Worker's
 *       src/admission.ts helper, with the same purpose and at the same point
 *       in the route order (the EP-1 edge admission policy). At the origin
 *       they run against edge-admission replay bindings, so an extra or
 *       different limiter call answers 503. A missing call is not detected:
 *       the edge outcome is silently discarded and the route serves as if
 *       admitted, so the call is mandatory and only the EP-12 parity rows
 *       catch its absence. Identity-keyed upload limits (upload_authorization)
 *       are origin-tier PostgreSQL limiters.
 * FC-8  No host checks and no retries. The edge and the root own host
 *       routing; a family never retries a transaction, a fetch or an object
 *       write.
 * FC-9  JSON request bodies use readBoundedJsonRequest (Worker parity: 415,
 *       400, 413 and 408, fatal UTF-8, optional strict duplicate-key refusal).
 * FC-10 Migrations. New PostgreSQL DDL goes in
 *       apps/worker/postgres/staged-migrations/<role>/<NNNN>_<name>.sql with
 *       the plan-assigned number; the integrator promotes it. PG17 specs
 *       apply it through postgres-test/staged-migrations-harness.mjs and skip
 *       cleanly when PG_TEST_SOCKET and PG_TEST_HOST are both unset.
 * FC-12 Uploads. Post-claim contribution handlers follow
 *       POST_CLAIM_HANDLER_CONTRACT. There is deliberately no
 *       upload-authorization format contract: the upload pipeline owns every
 *       format through one transport write assertion.
 */

import { readBoundedRequestBody } from "../src/bounded-body.ts";
import { JSON_HEADERS, MAX_REQUEST_BYTES } from "../src/constants.ts";
import { ApiError, errorResponse, jsonResponse } from "../src/errors.ts";
import { parseStrictJson } from "../src/strict-json.ts";

/**
 * @typedef {Readonly<{
 *   requestId: string,
 *   routeId: string,
 *   adminIdentityKey?: string,
 * }>} FamilyRequestContext
 * @typedef {(request: Request) => FamilyRequestContext | undefined} RequestContextAccessor
 * @typedef {Readonly<{
 *   pools: unknown,
 *   schemaOptions: Readonly<{ primarySchema: string }>,
 *   env: Readonly<Record<string, unknown>>,
 *   origins: unknown,
 *   storageGate: unknown,
 *   requestContext: RequestContextAccessor,
 *   clock?: () => number,
 * }>} FamilyDeps
 * @typedef {(request: Request) => Promise<Response>} FamilyDispatcher
 * @typedef {(deps: FamilyDeps) => FamilyDispatcher} FamilyDispatchFactory
 * @typedef {Readonly<{ bytes: Uint8Array, raw: string, value: unknown }>} BoundedJsonBody
 * @typedef {Readonly<{
 *   body: BoundedJsonBody,
 *   participant: Readonly<{
 *     id: string,
 *     consentVersion: string | null,
 *     ownerKind: "social" | "accountless",
 *   }>,
 *   deviceId: string,
 *   authorizationId: string,
 *   authorizationKind: "device",
 *   heartbeat: Readonly<{ assertActive: () => Promise<void> }>,
 *   requestId: string,
 * }>} PostClaimHandlerInput
 * @typedef {Readonly<{
 *   envelopeSchemaVersions: readonly string[],
 *   handle: (input: PostClaimHandlerInput) => Promise<Response>,
 * }>} PostClaimHandler
 */

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,79}$/u;
const REQUEST_ID = /^[\x21-\x7e]{1,128}$/u;
const HTTP_METHOD = /^[A-Z]{1,16}$/u;
const PATHNAME = /^\/[\x21-\x7e]*$/u;
const MAX_PATHNAME_LENGTH = 512;
const ENVELOPE_SCHEMA_VERSION = /^[a-z][a-z0-9.-]{0,79}$/u;

/** The Worker JSON headers (src/constants.ts JSON_HEADERS), including no-store. */
export const JSON_SECURITY_HEADERS = Object.freeze({ ...JSON_HEADERS });

/** The Worker's control-route body policy (src/index.ts CONTROL_BODY_READ_POLICY). */
export const CONTROL_BODY_READ_POLICY = Object.freeze({
  maximumTotalMilliseconds: 15_000,
  maximumIdleMilliseconds: 5_000,
});

/**
 * Descriptor of the family dispatch contract (FC-2, FC-3). It is data, not
 * behaviour: the root registry and family checks compare against it.
 */
export const DISPATCH_CONTRACT = Object.freeze({
  schemaVersion: "tibotattle-postgres-family-dispatch-v1",
  factory: "create<Family>Dispatch(deps) => async (request) => Response",
  pathnamesExport: "<FAMILY>_PATHNAMES",
  dispatcherArity: 1,
  dependencyKeys: Object.freeze([
    "pools",
    "schemaOptions",
    "env",
    "origins",
    "storageGate",
    "requestContext",
    "clock",
  ]),
  requestContextKeys: Object.freeze(["requestId", "routeId", "adminIdentityKey"]),
});

/**
 * Descriptor of a post-claim contribution handler (FC-12). The upload
 * pipeline claims the one-use authorization, holds the ingress lease and
 * heartbeat, checks cookies, participant, source device and the transport
 * write authority, then calls handle() for the envelope's version.
 * handle() returns the contribution Response whose JSON body carries a string
 * contributionId; it must not claim, abandon, record receipts, check cookies,
 * call ingress limiters or release leases.
 */
export const POST_CLAIM_HANDLER_CONTRACT = Object.freeze({
  schemaVersion: "tibotattle-postgres-post-claim-handler-v1",
  handlerKeys: Object.freeze(["envelopeSchemaVersions", "handle"]),
  inputKeys: Object.freeze([
    "body",
    "participant",
    "deviceId",
    "authorizationId",
    "authorizationKind",
    "heartbeat",
    "requestId",
  ]),
  bodyKeys: Object.freeze(["bytes", "raw", "value"]),
  participantKeys: Object.freeze(["id", "consentVersion", "ownerKind"]),
  heartbeatKeys: Object.freeze(["assertActive"]),
  responseBody: "JSON object with a string contributionId",
  pipelineOwned: Object.freeze([
    "authorization_claim",
    "authorization_abandon",
    "upload_receipt",
    "cookie_check",
    "ingress_limit",
    "ingress_lease_release",
  ]),
});

function contractError(code) {
  return Object.assign(new TypeError(code), { code });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validRequestId(requestId) {
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
    throw contractError("FAMILY_REQUEST_ID_INVALID");
  }
  return requestId;
}

function validStatus(status, minimum) {
  if (!Number.isSafeInteger(status) || status < minimum || status > 599) {
    throw contractError("FAMILY_RESPONSE_STATUS_INVALID");
  }
  return status;
}

function validAllow(allow) {
  if (!Array.isArray(allow) || allow.length === 0
      || allow.some((method) => typeof method !== "string" || !HTTP_METHOD.test(method))
      || new Set(allow).size !== allow.length) {
    throw contractError("FAMILY_ALLOW_INVALID");
  }
  return Object.freeze([...allow]);
}

/** Worker jsonResponse (src/errors.ts): JSON_SECURITY_HEADERS then extraHeaders. */
export function workerJson(status, body, extraHeaders) {
  return jsonResponse(body, validStatus(status, 200), extraHeaders);
}

function withAllowAndNoStore(response, allowed) {
  const headers = new Headers(response.headers);
  if (allowed !== undefined) headers.set("allow", allowed.join(", "));
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Map a thrown value to the Worker error response (index.ts catch path):
 * an ApiError keeps its status, code, public details, response headers and a
 * 405 Allow list; anything else is 500 INTERNAL_ERROR. The message of the
 * thrown value never reaches the response.
 */
export function apiErrorToResponse(error, requestId) {
  validRequestId(requestId);
  const apiError = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR");
  const allowed = Reflect.get(apiError, "allowed");
  return withAllowAndNoStore(
    errorResponse(apiError, requestId),
    Array.isArray(allowed) ? allowed : undefined,
  );
}

/**
 * Build a Worker error response directly. The body is exactly
 * {error: {code, requestId, details?}}; Allow and retry-after appear only
 * when passed.
 */
export function workerError({
  code,
  status,
  requestId,
  allow,
  retryAfter,
  details,
} = {}) {
  if (typeof code !== "string" || !ERROR_CODE.test(code)) {
    throw contractError("FAMILY_ERROR_CODE_INVALID");
  }
  validStatus(status, 400);
  validRequestId(requestId);
  const allowed = allow === undefined ? undefined : validAllow(allow);
  if (retryAfter !== undefined
      && (!Number.isSafeInteger(retryAfter) || retryAfter < 1)) {
    throw contractError("FAMILY_RETRY_AFTER_INVALID");
  }
  if (details !== undefined && !isPlainObject(details)) {
    throw contractError("FAMILY_ERROR_DETAILS_INVALID");
  }
  const error = new ApiError(status, code, {
    ...(details === undefined ? {} : { publicDetails: details }),
    ...(retryAfter === undefined ? {} : { responseHeaders: { "retry-after": String(retryAfter) } }),
  });
  if (allowed !== undefined) Object.defineProperty(error, "allowed", { value: allowed });
  return apiErrorToResponse(error, requestId);
}

function contextFor(deps, request) {
  const accessor = deps === null || typeof deps !== "object"
    ? undefined
    : Reflect.get(deps, "requestContext");
  if (typeof accessor !== "function") return undefined;
  const context = accessor(request);
  return context === null || typeof context !== "object" ? undefined : context;
}

/**
 * The root's request id for this exact Request, so the log line, diagnostic
 * row and error body share one id. Only an unregistered request (a unit
 * harness) receives a freshly minted id.
 */
export function requestIdFor(deps, request) {
  const requestId = contextFor(deps, request)?.requestId;
  return typeof requestId === "string" && REQUEST_ID.test(requestId)
    ? requestId
    : crypto.randomUUID();
}

/** The Access-verified, owner-pinned admin identity, or null. */
export function adminIdentityFor(deps, request) {
  const identityKey = contextFor(deps, request)?.adminIdentityKey;
  return typeof identityKey === "string" && identityKey.length > 0 ? identityKey : null;
}

function validBodyReadPolicy(policy) {
  if (!isPlainObject(policy)) throw contractError("FAMILY_BODY_POLICY_INVALID");
  const total = policy.maximumTotalMilliseconds;
  const idle = policy.maximumIdleMilliseconds;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(idle)
      || idle < 1 || total < idle) {
    throw contractError("FAMILY_BODY_POLICY_INVALID");
  }
  return Object.freeze({ maximumTotalMilliseconds: total, maximumIdleMilliseconds: idle });
}

/**
 * Worker readBoundedJson (index.ts) with a per-route byte cap and optional
 * strict duplicate-key refusal (src/strict-json.ts). The media type before
 * ';' must be exactly application/json (415 CONTENT_TYPE_INVALID); a declared
 * content-length must be a non-negative safe integer (400 BODY_INVALID) not
 * above the cap (413 BODY_TOO_LARGE); the streamed body is bounded by bytes
 * (413), total and idle time (408 BODY_TIMEOUT); a missing body, invalid
 * UTF-8 or invalid JSON is 400 BODY_INVALID. Decoding is fatal and, exactly
 * like the Worker, consumes one leading byte-order mark, so `raw` omits it
 * while `bytes` keeps the bytes as received.
 */
export async function readBoundedJsonRequest(request, {
  maxBytes = MAX_REQUEST_BYTES,
  strict = false,
  policy = CONTROL_BODY_READ_POLICY,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_REQUEST_BYTES) {
    throw contractError("FAMILY_BODY_LIMIT_INVALID");
  }
  if (typeof strict !== "boolean") throw contractError("FAMILY_BODY_MODE_INVALID");
  const readPolicy = validBodyReadPolicy(policy);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new ApiError(415, "CONTENT_TYPE_INVALID");
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new ApiError(400, "BODY_INVALID");
    if (length > maxBytes) throw new ApiError(413, "BODY_TOO_LARGE");
  }
  const bytes = await readBoundedRequestBody(request, maxBytes, readPolicy);
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ApiError(400, "BODY_INVALID");
  }
  let value;
  if (strict) {
    // Like every Worker strict reader: jsonc-parser's recursive tree parse
    // throws RangeError on deeply nested input, and only an ApiError keeps
    // its own code; anything else is the client's malformed body.
    try {
      value = parseStrictJson(raw, "BODY_INVALID");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "BODY_INVALID");
    }
  } else {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ApiError(400, "BODY_INVALID");
    }
  }
  return Object.freeze({ bytes, raw, value });
}

/**
 * A family pathname list must be frozen, non-empty, unique, and made of
 * absolute printable-ASCII pathnames with no query or fragment.
 */
export function assertFrozenPathnames(list) {
  if (!Array.isArray(list) || !Object.isFrozen(list) || list.length === 0) {
    throw contractError("FAMILY_PATHNAMES_INVALID");
  }
  const seen = new Set();
  for (const pathname of list) {
    if (typeof pathname !== "string" || pathname.length > MAX_PATHNAME_LENGTH
        || !PATHNAME.test(pathname) || pathname.includes("?") || pathname.includes("#")) {
      throw contractError("FAMILY_PATHNAMES_INVALID");
    }
    if (seen.has(pathname)) throw contractError("FAMILY_PATHNAMES_DUPLICATE");
    seen.add(pathname);
  }
  return list;
}

/** A dispatcher is a function of exactly one parameter, the Request. */
export function assertDispatcher(dispatcher) {
  if (typeof dispatcher !== "function" || dispatcher.length !== DISPATCH_CONTRACT.dispatcherArity) {
    throw contractError("FAMILY_DISPATCHER_INVALID");
  }
  return dispatcher;
}

/**
 * Validate one post-claim handler at construction and return a frozen copy
 * holding the validated version list and handle function.
 */
export function validatePostClaimHandler(handler) {
  if (handler === null || typeof handler !== "object" || Array.isArray(handler)) {
    throw contractError("POST_CLAIM_HANDLER_INVALID");
  }
  const keys = Object.keys(handler).sort();
  const expected = [...POST_CLAIM_HANDLER_CONTRACT.handlerKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw contractError("POST_CLAIM_HANDLER_INVALID");
  }
  const { envelopeSchemaVersions: versions, handle } = handler;
  if (typeof handle !== "function") throw contractError("POST_CLAIM_HANDLER_FUNCTION_MISSING");
  if (!Array.isArray(versions) || !Object.isFrozen(versions)) {
    throw contractError("POST_CLAIM_HANDLER_VERSIONS_NOT_FROZEN");
  }
  if (versions.length === 0
      || versions.some((version) => typeof version !== "string"
        || !ENVELOPE_SCHEMA_VERSION.test(version))) {
    throw contractError("POST_CLAIM_HANDLER_VERSIONS_INVALID");
  }
  if (new Set(versions).size !== versions.length) {
    throw contractError("POST_CLAIM_HANDLER_VERSION_DUPLICATE");
  }
  return Object.freeze({ envelopeSchemaVersions: Object.freeze([...versions]), handle });
}

/**
 * Validate a pipeline's handler list and index it by envelope version. A
 * version claimed by two handlers is refused at construction.
 */
export function createPostClaimHandlerRegistry(handlers) {
  if (!Array.isArray(handlers)) throw contractError("POST_CLAIM_HANDLERS_INVALID");
  const byVersion = new Map();
  for (const candidate of handlers) {
    const handler = validatePostClaimHandler(candidate);
    for (const version of handler.envelopeSchemaVersions) {
      if (byVersion.has(version)) throw contractError("POST_CLAIM_HANDLER_VERSION_DUPLICATE");
      byVersion.set(version, handler);
    }
  }
  const versions = Object.freeze([...byVersion.keys()].sort());
  return Object.freeze({
    versions,
    handlerFor(version) {
      return typeof version === "string" ? byVersion.get(version) : undefined;
    },
  });
}
