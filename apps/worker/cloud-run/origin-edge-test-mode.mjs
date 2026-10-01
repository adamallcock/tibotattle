/**
 * EDGE_ORIGIN_MODE=edge-test: the fastpath-test origin behind the EP-6 edge
 * boundary (GCP fast path, EORIGIN).
 *
 * A sub-mode of POSTGRES_TEST_HTTP_MODE=fastpath-test that puts the
 * Cloudflare-edge origin boundary (postgres-edge-origin-dispatch.mjs, EP-6)
 * in process in front of the unchanged fastpath-test composition, so a local
 * or test edge in gcp mode reaches the real PostgreSQL routes. It never
 * enables a request path by itself: without POSTGRES_TEST_HTTP_MODE the
 * origin still refuses to start, the production value
 * ('cloudflare-worker-iam', postgres-production-configuration.mjs) stays
 * reserved for the production composition, and every other value is refused.
 *
 * server.mjs composes it only when readEdgeTestOriginConfiguration returns a
 * configuration:
 * - the six edge-tier admission bindings become the EP-6 replay bindings
 *   (edgeTestAdmissionEnv), so every route replays the edge's outcome at the
 *   Worker's own call point; the identity-keyed upload limits stay
 *   PostgreSQL limiters;
 * - the dispatch origin is EDGE_TEST_PUBLIC_ORIGIN, the public origin EP-6
 *   rebuilds every request on;
 * - composeEdgeTestOrigin wraps the composition: EP-6 first, then an
 *   admin-host guard that answers the existing unported 503, because
 *   fastpath-test serves no admin route;
 * - serve() builds requests with edgeTestRequestFromNode, which keeps the
 *   raw headers EP-6 must see (x-serverless-authorization, x-tibotattle-*),
 *   and writes every boundary refusal with writeEdgeTestBoundaryRefusal;
 * - every boundary refusal, here or in EP-6, logs exactly one content-free
 *   edge_origin_boundary_refusal line naming its constant reason
 *   (logEdgeTestBoundaryRefusal), so a live 421 can be explained from the
 *   origin's log while the answer itself stays constant.
 *
 * Plain ESM like origin-fastpath-mode.mjs. It imports only the edge/origin
 * contract, the EP-6 modules and the fastpath constants; it opens no pool,
 * reads no network and logs nothing but those refusal lines.
 */

import {
  EDGE_HEADERS,
  ORIGIN_BOUNDARY_ERROR_BODY,
  canonicalRunAppOrigin,
  isEdgeOriginAudience,
  isEdgeServiceAccountEmail,
} from "../src/edge-origin-contract.ts";
import {
  EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS,
  EDGE_ORIGIN_INVOKER_TOKEN_REFUSAL_REASONS,
  MAX_EDGE_ORIGIN_INVOKER_SHAPE_SEGMENTS,
  MAX_EDGE_ORIGIN_URL_LENGTH,
  MAX_EDGE_ORIGIN_VERIFIER_ACCOUNTS,
  ORIGIN_BOUNDARY_ERROR_HEADERS,
  createEdgeOriginDispatch,
  edgeRequestContext,
} from "./postgres-edge-origin-dispatch.mjs";
import { EDGE_ADMISSION_REPLAY_BINDINGS } from "./postgres-edge-admission-limiters.mjs";
import { FASTPATH_TEST_CLOUD_TARGET, FASTPATH_TEST_MODE } from "./origin-fastpath-mode.mjs";

export const EDGE_TEST_ORIGIN_MODE = "edge-test";

/**
 * The public origin EP-6 rebuilds requests on, and the dispatch origin of the
 * composition behind it. A reserved test TLD; the edge's PUBLIC_ORIGIN in the
 * local end-to-end test and the live check (admin host admin.tibotattle.test).
 */
export const EDGE_TEST_PUBLIC_ORIGIN = "https://tibotattle.test";

/**
 * The GCP fast-path test origin's service URL. Its check pins it equal to
 * scripts/gcp-fastpath-test-deploy.mjs FASTPATH_TEST.originUrl; product code
 * never imports scripts/.
 */
export const EDGE_TEST_CLOUD_ORIGIN = "https://tibotattle-fastpath-test-origin-806510610397.us-east1.run.app";

/**
 * The WORKER_ROUTE_POLICY ids the fastpath-test composition serves behind the
 * boundary. Every other forwarded (route, method) pair answers exactly
 * EDGE_TEST_UNPORTED_BODY; postgres-origin-edge-test.spec.mjs probes both
 * sides, so a wrong entry fails.
 */
export const EDGE_TEST_SERVED_ROUTE_IDS = Object.freeze([
  "health",
  "envelope_key",
  "contributions",
  "community_daily",
  "session",
  "logout",
  "participant_devices",
  "participant_device_revocation",
  "device_pairing",
  "device_pairing_claim",
  "telemetry_v11_consent",
  "telemetry_v12_consent",
  "device_upload_authorization",
  "device_disconnect",
  "device_credential_renew",
  "device_sync_state",
  "device_sync_manifest",
  "device_sync_capabilities",
  "device_sync_capabilities_v12",
  "telemetry_v11_day_manifests",
  "telemetry_v11_domain_predecessor",
  "telemetry_v11_domain_activate",
  "telemetry_v12_day_manifests",
  "telemetry_v12_domain_predecessor",
  "telemetry_v12_domain_activate",
  "accountless_enrollment",
  "accountless_ownership",
  "accountless_telemetry_v12_authorization",
  "accountless_renewal",
]);

/**
 * The composition's existing answer for a route it does not serve
 * (postgres-test-dispatch.mjs json(503, ...)), which EP-6 marks.
 */
export const EDGE_TEST_UNPORTED_BODY = "{\"status\":\"not_ready\",\"error\":\"POSTGRES_TEST_ROUTE_UNSUPPORTED\"}";

/** postgres-test-dispatch.mjs json()'s headers, so both unported answers are equal. */
const EDGE_TEST_UNPORTED_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

/** Cloud Run's listen pair for the edge-test origin (the direct deploy variant). */
const EDGE_TEST_CLOUD_LISTEN = Object.freeze({ host: "0.0.0.0", port: 8080 });
const LOOPBACK_HOST = "127.0.0.1";
const DECIMAL_PORT = /^[0-9]+$/u;
const DEFAULT_LOCAL_PORT = "8080";

if (canonicalRunAppOrigin(EDGE_TEST_CLOUD_ORIGIN) !== EDGE_TEST_CLOUD_ORIGIN) {
  throw new TypeError("EDGE_TEST_CLOUD_ORIGIN must be a canonical run.app origin");
}

/** Configurations readEdgeTestOriginConfiguration issued; nothing else composes. */
const issuedConfigurations = new WeakSet();

function configurationError(code) {
  return Object.assign(new Error(code), { code });
}

function refuse(code) {
  throw configurationError(code);
}

/** Unset and empty are both absent, as everywhere in the origin's env. */
function envValue(env, name) {
  const value = env === null || typeof env !== "object" ? undefined : env[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 0-4 distinct service-account emails, comma-separated, never the invoker. */
function verifierAccounts(raw, invokerServiceAccount) {
  if (raw === undefined) return Object.freeze([]);
  const accounts = raw.split(",");
  if (accounts.length > MAX_EDGE_ORIGIN_VERIFIER_ACCOUNTS
      || accounts.some((account) => !isEdgeServiceAccountEmail(account)
        || account === invokerServiceAccount)
      || new Set(accounts).size !== accounts.length) {
    refuse("EDGE_TEST_ORIGIN_VERIFIERS_INVALID");
  }
  return Object.freeze(accounts);
}

/** http://127.0.0.1[:port] exactly, as fastpath-test requires of HOST_ORIGIN. */
function isLoopbackHostOrigin(value, port) {
  if (typeof value !== "string") return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.origin === value
    && url.protocol === "http:"
    && url.hostname === LOOPBACK_HOST
    && Number(url.port || "80") === port;
}

/**
 * The listen pair. Locally: HOST 127.0.0.1 (the default) and HOST_ORIGIN
 * http://127.0.0.1:<PORT>, exactly as fastpath-test requires. On Cloud Run
 * (K_SERVICE set): only the fast-path origin service, HOST 0.0.0.0, PORT 8080
 * and HOST_ORIGIN EDGE_TEST_CLOUD_ORIGIN. Neither takes a PUBLIC_ORIGIN or
 * ADMIN_HOST_ORIGIN: the public origin is EDGE_TEST_PUBLIC_ORIGIN.
 */
function listenConfiguration(env) {
  if (envValue(env, "PUBLIC_ORIGIN") !== undefined || envValue(env, "ADMIN_HOST_ORIGIN") !== undefined) {
    refuse("EDGE_TEST_ORIGIN_LISTEN_INVALID");
  }
  const hostOrigin = envValue(env, "HOST_ORIGIN");
  if (envValue(env, "K_SERVICE") !== undefined) {
    if (envValue(env, "K_SERVICE") !== FASTPATH_TEST_CLOUD_TARGET.originService
        || envValue(env, "HOST") !== EDGE_TEST_CLOUD_LISTEN.host
        || envValue(env, "PORT") !== String(EDGE_TEST_CLOUD_LISTEN.port)
        || hostOrigin !== EDGE_TEST_CLOUD_ORIGIN) {
      refuse("EDGE_TEST_ORIGIN_LISTEN_INVALID");
    }
    return Object.freeze({
      host: EDGE_TEST_CLOUD_LISTEN.host,
      port: EDGE_TEST_CLOUD_LISTEN.port,
      hostOrigin: EDGE_TEST_CLOUD_ORIGIN,
      cloud: true,
    });
  }
  const host = envValue(env, "HOST") ?? LOOPBACK_HOST;
  const rawPort = envValue(env, "PORT") ?? DEFAULT_LOCAL_PORT;
  const port = DECIMAL_PORT.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (host !== LOOPBACK_HOST || !Number.isSafeInteger(port) || port < 1 || port > 65_535
      || !isLoopbackHostOrigin(hostOrigin, port)) {
    refuse("EDGE_TEST_ORIGIN_LISTEN_INVALID");
  }
  return Object.freeze({ host, port, hostOrigin, cloud: false });
}

/**
 * Reads EDGE_ORIGIN_MODE and its settings. Returns null when EDGE_ORIGIN_MODE
 * is unset or empty (fastpath-test is then exactly as before). Otherwise a
 * frozen { audience, invokerServiceAccount, verifierServiceAccounts,
 * publicOrigin, listen: { host, port, hostOrigin, cloud } }, or a thrown
 * configuration error, checked in this order:
 * - any POSTGRES_TEST_HTTP_MODE other than fastpath-test, or none:
 *   EDGE_TEST_ORIGIN_MODE_REQUIRES_FASTPATH_TEST (with no test mode
 *   createRuntime refuses with POSTGRES_WORKER_REQUEST_PATH_UNSUPPORTED
 *   before it reads this);
 * - a value other than 'edge-test': EDGE_TEST_ORIGIN_MODE_INVALID;
 * - EDGE_ORIGIN_AUDIENCE, EDGE_INVOKER_SERVICE_ACCOUNT and
 *   EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS (comma-separated, 0-4, distinct,
 *   never the invoker): _AUDIENCE_INVALID, _INVOKER_INVALID, _VERIFIERS_INVALID;
 * - ANALYTICS_V2_ENABLED other than '1': EDGE_TEST_COMMUNITY_DAILY_MODULE_REQUIRED,
 *   so the only community/daily behind the edge replays the public read;
 * - the listen pair (listenConfiguration): EDGE_TEST_ORIGIN_LISTEN_INVALID.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {{ postgresTestMode?: string | null }} options the validated POSTGRES_TEST_HTTP_MODE
 */
export function readEdgeTestOriginConfiguration(env, { postgresTestMode = null } = {}) {
  const mode = envValue(env, "EDGE_ORIGIN_MODE");
  if (mode === undefined) return null;
  if (postgresTestMode !== FASTPATH_TEST_MODE) refuse("EDGE_TEST_ORIGIN_MODE_REQUIRES_FASTPATH_TEST");
  if (mode !== EDGE_TEST_ORIGIN_MODE) refuse("EDGE_TEST_ORIGIN_MODE_INVALID");
  const audience = envValue(env, "EDGE_ORIGIN_AUDIENCE");
  if (!isEdgeOriginAudience(audience)) refuse("EDGE_TEST_ORIGIN_AUDIENCE_INVALID");
  const invokerServiceAccount = envValue(env, "EDGE_INVOKER_SERVICE_ACCOUNT");
  if (!isEdgeServiceAccountEmail(invokerServiceAccount)) refuse("EDGE_TEST_ORIGIN_INVOKER_INVALID");
  const verifierServiceAccounts = verifierAccounts(
    envValue(env, "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS"), invokerServiceAccount,
  );
  if (envValue(env, "ANALYTICS_V2_ENABLED") !== "1") refuse("EDGE_TEST_COMMUNITY_DAILY_MODULE_REQUIRED");
  const listen = listenConfiguration(env);
  const configuration = Object.freeze({
    audience,
    invokerServiceAccount,
    verifierServiceAccounts,
    publicOrigin: EDGE_TEST_PUBLIC_ORIGIN,
    listen,
  });
  issuedConfigurations.add(configuration);
  return configuration;
}

/**
 * serve()'s one exception to POSTGRES_TEST_PRIVATE_HOST_REQUIRED: a Cloud Run
 * edge-test configuration listening on exactly its pinned pair, with
 * K_SERVICE still the fast-path origin service.
 */
export function isEdgeTestCloudListen(configuration, host, port, env) {
  return issuedConfigurations.has(configuration)
    && configuration.listen.cloud === true
    && host === EDGE_TEST_CLOUD_LISTEN.host
    && port === EDGE_TEST_CLOUD_LISTEN.port
    && envValue(env, "K_SERVICE") === FASTPATH_TEST_CLOUD_TARGET.originService;
}

/**
 * A frozen copy of the origin's admission env with the six edge-tier bindings
 * (EDGE_ADMISSION_REPLAY_BINDINGS) replaced by the replay bindings of
 * admission (createEdgeAdmissionLimiters()). Every other entry, including
 * UPLOAD_AUTHORIZATION_RATE_LIMIT and UPLOAD_PRINCIPAL_RATE_LIMIT, is kept.
 */
export function edgeTestAdmissionEnv(admissionEnv, admission) {
  const bindings = admission !== null && typeof admission === "object" ? admission.bindings : undefined;
  if (admissionEnv === null || typeof admissionEnv !== "object"
      || bindings === null || typeof bindings !== "object"
      || EDGE_ADMISSION_REPLAY_BINDINGS.some((name) => typeof bindings[name]?.limit !== "function")) {
    throw Object.assign(new TypeError("EDGE_TEST_ADMISSION_ENV_INVALID"), {
      code: "EDGE_TEST_ADMISSION_ENV_INVALID",
    });
  }
  const env = { ...admissionEnv };
  for (const name of EDGE_ADMISSION_REPLAY_BINDINGS) env[name] = bindings[name];
  return Object.freeze(env);
}

function edgeTestUnportedResponse() {
  return new Response(EDGE_TEST_UNPORTED_BODY, { status: 503, headers: EDGE_TEST_UNPORTED_HEADERS });
}

/**
 * The edge-test origin: createEdgeOriginDispatch (EP-6) on
 * EDGE_TEST_PUBLIC_ORIGIN with the configured accounts and audience, in front
 * of inner (the fastpath-test postgresTestDispatch). A request EP-6 rebuilt
 * on the admin host answers EDGE_TEST_UNPORTED_BODY (503, JSON, no-store)
 * without reaching inner: fastpath-test serves no admin route. admission must
 * be the instance whose bindings edgeTestAdmissionEnv installed. Each EP-6
 * refusal logs its one reason line (logEdgeTestBoundaryRefusal).
 */
export function composeEdgeTestOrigin({ configuration, admission, inner, clock = Date.now } = {}) {
  if (!issuedConfigurations.has(configuration)) refuse("EDGE_TEST_ORIGIN_MODE_INVALID");
  if (typeof inner !== "function") {
    throw Object.assign(new TypeError("EDGE_ORIGIN_INNER_INVALID"), { code: "EDGE_ORIGIN_INNER_INVALID" });
  }
  return createEdgeOriginDispatch({
    invokerServiceAccount: configuration.invokerServiceAccount,
    verifierServiceAccounts: configuration.verifierServiceAccounts,
    audience: configuration.audience,
    publicOrigin: configuration.publicOrigin,
    admission,
    clock,
    onRefusal: (diagnostic) => logEdgeTestBoundaryRefusal(diagnostic),
    async inner(request) {
      if (edgeRequestContext(request)?.hostKind === "admin") return edgeTestUnportedResponse();
      return inner(request);
    },
  });
}

/**
 * The constant reason of each edgeTestRequestFromNode refusal site, for
 * diagnostics only (the answer is EP-6's 421 for every one). They never
 * overlap EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS. request_target_unparseable
 * and request_target_origin guard what the URL parser already ensures for a
 * target starting with '/'.
 */
export const EDGE_TEST_REQUEST_REFUSAL_REASONS = Object.freeze([
  "host_origin_invalid",
  "host_origin_not_canonical",
  "host_header_missing",
  "host_mismatch",
  "request_target_invalid",
  "request_target_too_long",
  "request_target_unparseable",
  "request_target_origin",
  "raw_headers_invalid",
  "node_request_invalid",
]);

/** The event of the one log line each edge-test boundary refusal writes. */
export const EDGE_ORIGIN_BOUNDARY_REFUSAL_EVENT = "edge_origin_boundary_refusal";

const LOGGED_REFUSAL_REASONS = new Set([
  ...EDGE_TEST_REQUEST_REFUSAL_REASONS,
  ...EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS,
]);
const SHAPED_REFUSAL_REASONS = new Set(EDGE_ORIGIN_INVOKER_TOKEN_REFUSAL_REASONS);
const UNCLASSIFIED_REFUSAL_REASON = "unclassified";

/** Thrown by edgeTestRequestFromNode; serve() answers it with the boundary refusal. */
export class EdgeTestBoundaryRefusal extends Error {
  constructor(reason) {
    super("EDGE_TEST_ORIGIN_BOUNDARY_REFUSED");
    this.name = "EdgeTestBoundaryRefusal";
    this.code = "EDGE_TEST_ORIGIN_BOUNDARY_REFUSED";
    this.reason = reason;
  }
}

function boundaryRefusal(reason) {
  throw new EdgeTestBoundaryRefusal(reason);
}

function shapeFlags(value) {
  return Array.isArray(value)
    ? value.slice(0, MAX_EDGE_ORIGIN_INVOKER_SHAPE_SEGMENTS).map((flag) => flag === true)
    : [];
}

/**
 * The log line for one boundary refusal, built field by field from an
 * allowlist: {"event":"edge_origin_boundary_refusal","reason":<code>}, plus,
 * for an EP-6 invoker-token refusal only, "invokerShape" with the delivered
 * header's 'Bearer ' prefix flag, segment count, per-segment empty and
 * base64url flags and whether the third segment is Google's
 * SIGNATURE_REMOVED_BY_GOOGLE. A reason outside the two reason lists is
 * logged as 'unclassified'; nothing else a diagnostic carries (no header
 * value, token, email, host, address or path) can reach the line.
 */
export function edgeTestBoundaryRefusalLogLine(diagnostic) {
  const candidate = diagnostic !== null && typeof diagnostic === "object" ? diagnostic.reason : undefined;
  const reason = LOGGED_REFUSAL_REASONS.has(candidate) ? candidate : UNCLASSIFIED_REFUSAL_REASON;
  const line = { event: EDGE_ORIGIN_BOUNDARY_REFUSAL_EVENT, reason };
  const shape = SHAPED_REFUSAL_REASONS.has(reason) ? diagnostic.invokerShape : null;
  if (shape !== null && typeof shape === "object") {
    line.invokerShape = {
      bearerPrefix: shape.bearerPrefix === true,
      segments: Number.isSafeInteger(shape.segments) && shape.segments >= 0 ? shape.segments : null,
      segmentEmpty: shapeFlags(shape.segmentEmpty),
      segmentBase64url: shapeFlags(shape.segmentBase64url),
      signatureRemovedByGoogle: shape.signatureRemovedByGoogle === true,
    };
  }
  return JSON.stringify(line);
}

/**
 * Writes edgeTestBoundaryRefusalLogLine(diagnostic) as one line through log
 * (console.log, looked up when called, by default). A diagnostic is an
 * EP-6 { reason, invokerShape } or an EdgeTestBoundaryRefusal. Logging never
 * throws, so it cannot change the constant answer.
 */
export function logEdgeTestBoundaryRefusal(diagnostic, log = (line) => console.log(line)) {
  try {
    log(edgeTestBoundaryRefusalLogLine(diagnostic));
  } catch {
    // The refusal is answered the same way whether or not its line was written.
  }
}

/**
 * Whether the request's framing carries a body: chunked, or a declared
 * length other than zero. Node presents an empty stream for every other
 * request, which the Worker sees as no body (request.body null), so the
 * origin answers its 'missing body' checks as the Worker does.
 */
function hasRequestBody(req) {
  if (req.headers["transfer-encoding"] !== undefined) return true;
  const declared = req.headers["content-length"];
  return declared !== undefined && declared !== "0";
}

/**
 * The raw body as a web stream that touches the Node request only when it is
 * first read (high-water mark 0), so a refusal or a limited admission never
 * pulls a byte off the socket.
 *
 * Cancelling it stops reading without destroying the request: a handler that
 * stops at its byte limit (413 BODY_TOO_LARGE on a chunked body, which has
 * no declared length to refuse first) is about to answer, and that answer
 * must reach the caller. The unread rest of the body is drained and
 * discarded, so the response is followed by a clean close instead of a reset
 * that would lose it. (Readable.toWeb's cancel destroys the socket, which
 * turned that 413 into a connection error the edge reported as 503.)
 */
function lazyRequestBody(req) {
  let iterator = null;
  return new ReadableStream({
    async pull(controller) {
      iterator ??= req.iterator({ destroyOnReturn: false });
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    },
    async cancel() {
      if (iterator !== null) await iterator.return();
      req.resume();
    },
  }, { highWaterMark: 0 });
}

/**
 * The Request for EP-6, built from the raw Node request: the Host header must
 * be HOST_ORIGIN's host; the URL is HOST_ORIGIN plus the raw path and query
 * (at most MAX_EDGE_ORIGIN_URL_LENGTH characters, path starting with '/');
 * every raw header is copied (EP-6 needs x-serverless-authorization and the
 * x-tibotattle-* headers, and strips them), repeated values joined as Headers
 * joins them; a body is streamed with duplex 'half'; an AbortController
 * follows the request's abort and the response's close. Anything else throws
 * EdgeTestBoundaryRefusal with its constant reason
 * (EDGE_TEST_REQUEST_REFUSAL_REASONS); serve() logs it with
 * logEdgeTestBoundaryRefusal.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ hostOrigin: string }} options
 */
export function edgeTestRequestFromNode(req, res, { hostOrigin } = {}) {
  let base;
  try { base = new URL(hostOrigin); } catch { boundaryRefusal("host_origin_invalid"); }
  if (base.origin !== hostOrigin) boundaryRefusal("host_origin_not_canonical");
  const host = req.headers.host;
  if (typeof host !== "string") boundaryRefusal("host_header_missing");
  if (host.toLowerCase() !== base.host) boundaryRefusal("host_mismatch");
  const path = req.url;
  if (typeof path !== "string" || !path.startsWith("/")) boundaryRefusal("request_target_invalid");
  const href = hostOrigin + path;
  if (href.length > MAX_EDGE_ORIGIN_URL_LENGTH) boundaryRefusal("request_target_too_long");
  let url;
  try { url = new URL(href); } catch { boundaryRefusal("request_target_unparseable"); }
  if (url.origin !== hostOrigin || !url.pathname.startsWith("/")) boundaryRefusal("request_target_origin");
  const headers = new Headers();
  try {
    const raw = req.rawHeaders;
    for (let index = 0; index + 1 < raw.length; index += 2) headers.append(raw[index], raw[index + 1]);
  } catch {
    boundaryRefusal("raw_headers_invalid");
  }
  const method = req.method ?? "GET";
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD" && hasRequestBody(req)) {
    init.body = lazyRequestBody(req);
    init.duplex = "half";
  }
  const controller = new AbortController();
  init.signal = controller.signal;
  let request;
  try { request = new Request(url.href, init); } catch { boundaryRefusal("node_request_invalid"); }
  req.once("aborted", () => controller.abort());
  req.once("close", () => {
    if (!req.complete) controller.abort();
  });
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return request;
}

/** How long a connection lingers for the rest of a body after an early answer. */
export const EDGE_TEST_LINGER_MAX_MILLISECONDS = 15_000;

/**
 * Lingering close (RFC 9112 section 9.6) under an answer written before the
 * request body has finished arriving: a 413 at the byte limit of a chunked
 * body, or a 401, 415 or 429 refusal that never reads the body. Node closes
 * such a connection as soon as the answer is written, while the caller is
 * still sending; the close then resets the connection and the caller can lose
 * the answer, which the edge reports as 503 EDGE_ORIGIN_UNAVAILABLE instead
 * of the origin's refusal. Here the close waits until the rest of the body has
 * been received and discarded (the lazy body's cancel, or Node's own dump of
 * a body nobody read), or EDGE_TEST_LINGER_MAX_MILLISECONDS pass. Only this
 * request's socket is affected, and only its close is delayed.
 *
 * @param {import("node:http").IncomingMessage} req
 */
export function lingerAfterEarlyEdgeTestAnswer(req) {
  const socket = req.socket;
  if (req.complete || socket === null || typeof socket.destroySoon !== "function") return;
  const destroySoon = socket.destroySoon;
  const received = new Promise((resolveReceived) => {
    const done = () => {
      clearTimeout(timer);
      resolveReceived();
    };
    const timer = setTimeout(done, EDGE_TEST_LINGER_MAX_MILLISECONDS);
    req.once("end", done);
    req.once("close", done);
    socket.once("close", done);
  });
  socket.destroySoon = function lingeringDestroySoon() {
    void received.then(() => destroySoon.call(socket));
  };
}

/** EP-6's constant refusal: a 421 without the origin marker. */
export function isEdgeOriginBoundaryRefusal(response) {
  return response instanceof Response
    && response.status === 421
    && !response.headers.has(EDGE_HEADERS.originMarker);
}

/**
 * Writes the constant boundary refusal (421, ORIGIN_BOUNDARY_ERROR_BODY,
 * ORIGIN_BOUNDARY_ERROR_HEADERS with connection: close). The request body is
 * never read; Node ends the socket once the response is written.
 *
 * @param {import("node:http").ServerResponse} res
 */
export function writeEdgeTestBoundaryRefusal(res) {
  res.writeHead(421, {
    ...ORIGIN_BOUNDARY_ERROR_HEADERS,
    "content-length": String(Buffer.byteLength(ORIGIN_BOUNDARY_ERROR_BODY)),
  });
  res.end(ORIGIN_BOUNDARY_ERROR_BODY);
}
