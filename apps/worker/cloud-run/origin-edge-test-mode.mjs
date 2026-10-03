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
 * - the inner handler is the production request handler over the one route
 *   registry and the production ported list (D-CRB: edge-test is a byte for
 *   byte rehearsal of the production pipeline, including the admin host's
 *   OD-CR-3 policy and the closed unported answer);
 * - composeEdgeTestOrigin puts EP-6 in front of it, with nothing between;
 * - serve() builds requests with origin-node-request.mjs originRequestFromNode,
 *   which keeps the raw headers EP-6 must see (x-serverless-authorization,
 *   x-tibotattle-*), and writes every boundary refusal with
 *   writeOriginBoundaryRefusal;
 * - every boundary refusal, there or in EP-6, logs exactly one content-free
 *   edge_origin_boundary_refusal line naming its constant reason
 *   (logOriginBoundaryRefusal), so a live 421 can be explained from the
 *   origin's log while the answer itself stays constant.
 *
 * Plain ESM like origin-fastpath-mode.mjs. It imports only the edge/origin
 * contract, the EP-6 modules, the Node adapter and the fastpath constants;
 * it opens no pool, reads no network and logs nothing but those refusal
 * lines.
 */

import {
  canonicalRunAppOrigin,
  isEdgeOriginAudience,
  isEdgeServiceAccountEmail,
} from "../src/edge-origin-contract.ts";
import {
  MAX_EDGE_ORIGIN_VERIFIER_ACCOUNTS,
  createEdgeOriginDispatch,
} from "./postgres-edge-origin-dispatch.mjs";
import { EDGE_ADMISSION_REPLAY_BINDINGS } from "./postgres-edge-admission-limiters.mjs";
import { FASTPATH_TEST_CLOUD_TARGET, FASTPATH_TEST_MODE } from "./origin-fastpath-mode.mjs";
import { logOriginBoundaryRefusal } from "./origin-node-request.mjs";

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

/**
 * The edge-test origin: createEdgeOriginDispatch (EP-6) on
 * EDGE_TEST_PUBLIC_ORIGIN with the configured accounts and audience, in front
 * of inner (the production request handler over the one registry). Nothing
 * stands between EP-6 and inner: the admin host follows inner's OD-CR-3
 * policy, as in production. admission must be the instance whose bindings
 * edgeTestAdmissionEnv installed. Each EP-6 refusal logs its one reason line
 * (logOriginBoundaryRefusal).
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
    onRefusal: (diagnostic) => logOriginBoundaryRefusal(diagnostic),
    inner,
  });
}
