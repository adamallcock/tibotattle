#!/usr/bin/env node

/**
 * A7 (CR-7 phase A): the read-only verifier smoke of the GCP origin.
 *
 * Owner-run and protected: --execute reads the live origin, which is a
 * production (or staging) read. Without --execute the script validates its
 * inputs and the environment's rollout target and prints the plan; it runs
 * no gcloud and makes no request.
 *
 * --execute, in this order, with one verifier identity token held in memory:
 * 1. the token: createGcloudIdentityTokenSource (scripts/production-edge-mode.mjs)
 *    impersonating the target's verifier account for its origin audience;
 *    without it nothing else runs;
 * 2. GET /api/health with the token: 200, marked x-tibotattle-origin: 1, the
 *    Worker's secure JSON headers, a body that passes
 *    validatePostgresHealthBody, and deployment.sourceCommit equal to
 *    --expect-commit;
 * 3. GET /api/ready with the token: marked, secure headers, a body that passes
 *    validatePostgresReadinessBody for its status, and status equal to
 *    --expect-ready (ready or not_ready: OD-CR-4, required, no default);
 * 4. GET /api/v1/envelope-key and GET /api/health?x=1 with the token: each
 *    EP-6's unmarked 421 (a verifier is confined to the two plain GETs);
 * 5. GET /api/health with no token: Google's front end answers 401 or 403,
 *    unmarked (the origin is IAM-private);
 * 6. the rollout's own gate, verifyEdgeOriginBeforeGcp: with --expect-ready
 *    ready it must pass with originCommit equal to --expect-commit; with
 *    not_ready it must refuse with EDGE_ORIGIN_VERIFIER_INVALID (/api/ready
 *    answers 503), which is the OD-CR-4 roll blocker this records.
 *
 * The verifier account and audience come from OPS-2's
 * rolloutTarget(environment), validated by OPS-10's validateRolloutTarget.
 * The RolloutTarget names no service URL, so --upstream-origin (a canonical
 * run.app origin) is required: the owner reads it from the service, as
 * OPS-10's roll does.
 *
 * The receipt is content-free: probe names, statuses, marker booleans, the
 * sha256 of each body's key-path list, validity and equality booleans and
 * closed codes. The token, the verifier account, the audience, the origin
 * and every body value stay out of it, and out of every error.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  EDGE_HEADERS,
  ORIGIN_BOUNDARY_ERROR_BODY,
  canonicalRunAppOrigin,
} from "../src/edge-origin-contract.ts";
import { validatePostgresHealthBody } from "../src/postgres-health-contract.ts";
import { validatePostgresReadinessBody } from "../src/postgres-readiness-contract.ts";
import { loadRolloutTargetFromInfraManifest, validateRolloutTarget } from "./gcp-production-rollout.mjs";
import { createGcloudIdentityTokenSource, verifyEdgeOriginBeforeGcp } from "./production-edge-mode.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

export const ORIGIN_SMOKE_RECEIPT_SCHEMA = "tibotattle-gcp-origin-verifier-smoke-v1";
export const ORIGIN_SMOKE_ENVIRONMENTS = Object.freeze(["production", "staging"]);
/** OD-CR-4: the readiness the owner expects; required, there is no default. */
export const ORIGIN_SMOKE_READY_EXPECTATIONS = Object.freeze(["ready", "not_ready"]);
export const ORIGIN_SMOKE_TIMEOUT_MS = 10_000;
export const ORIGIN_SMOKE_MAX_BODY_BYTES = 64 * 1024;

/** The probes, in execution order. */
export const ORIGIN_SMOKE_PROBES = Object.freeze([
  Object.freeze({ probe: "health", path: "/api/health", withToken: true }),
  Object.freeze({ probe: "ready", path: "/api/ready", withToken: true }),
  Object.freeze({ probe: "verifier_off_path", path: "/api/v1/envelope-key", withToken: true }),
  Object.freeze({ probe: "verifier_query", path: "/api/health?x=1", withToken: true }),
  Object.freeze({ probe: "no_token", path: "/api/health", withToken: false }),
]);

/** Every code the smoke can end with. */
export const ORIGIN_SMOKE_CODES = Object.freeze([
  "ORIGIN_SMOKE_ARGUMENT_INVALID",
  "ORIGIN_SMOKE_TARGET_UNAVAILABLE",
  "ORIGIN_SMOKE_TOKEN_UNAVAILABLE",
  "ORIGIN_SMOKE_HEALTH_UNREACHABLE",
  "ORIGIN_SMOKE_HEALTH_INVALID",
  "ORIGIN_SMOKE_HEALTH_COMMIT_MISMATCH",
  "ORIGIN_SMOKE_READY_UNREACHABLE",
  "ORIGIN_SMOKE_READY_INVALID",
  "ORIGIN_SMOKE_READY_UNEXPECTED",
  "ORIGIN_SMOKE_CONFINEMENT_UNREACHABLE",
  "ORIGIN_SMOKE_CONFINEMENT_BROKEN",
  "ORIGIN_SMOKE_IAM_UNREACHABLE",
  "ORIGIN_SMOKE_IAM_OPEN",
  "ORIGIN_SMOKE_ROLL_GATE_REFUSED",
  "ORIGIN_SMOKE_ROLL_GATE_COMMIT_MISMATCH",
  "ORIGIN_SMOKE_ROLL_GATE_UNEXPECTED",
]);

const COMMIT = /^[0-9a-f]{40}$/u;
const MARKER_VALUE = "1";
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/u;
const ARGUMENT = /^--([a-z-]+)(?:=(.*))?$/u;
const VALUE_FLAGS = new Set(["environment", "upstream-origin", "expect-commit", "expect-ready"]);

function smokeError(code) {
  return Object.assign(new Error(code), { code });
}

function fail(code) {
  throw smokeError(code);
}

/** A closed code from any thrown value, never its message. */
function codeOf(error, fallback) {
  const code = error !== null && typeof error === "object" ? error.code : undefined;
  return typeof code === "string" && CODE.test(code) ? code : fallback;
}

/**
 * Parse argv: --environment, --upstream-origin, --expect-commit and
 * --expect-ready are each required exactly once; --execute is optional and
 * takes no value. Anything else is ORIGIN_SMOKE_ARGUMENT_INVALID.
 */
export function parseOriginSmokeArgs(argv) {
  if (!Array.isArray(argv)) fail("ORIGIN_SMOKE_ARGUMENT_INVALID");
  const values = new Map();
  let execute = false;
  for (const argument of argv) {
    const match = typeof argument === "string" ? ARGUMENT.exec(argument) : null;
    if (match === null) fail("ORIGIN_SMOKE_ARGUMENT_INVALID");
    const [, name, value] = match;
    if (name === "execute") {
      if (value !== undefined || execute) fail("ORIGIN_SMOKE_ARGUMENT_INVALID");
      execute = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name) || value === undefined || values.has(name)) fail("ORIGIN_SMOKE_ARGUMENT_INVALID");
    values.set(name, value);
  }
  const environment = values.get("environment");
  const upstreamOrigin = values.get("upstream-origin");
  const expectCommit = values.get("expect-commit");
  const expectReady = values.get("expect-ready");
  if (!ORIGIN_SMOKE_ENVIRONMENTS.includes(environment)
      || canonicalRunAppOrigin(upstreamOrigin) !== upstreamOrigin
      || typeof expectCommit !== "string" || !COMMIT.test(expectCommit)
      || !ORIGIN_SMOKE_READY_EXPECTATIONS.includes(expectReady)) {
    fail("ORIGIN_SMOKE_ARGUMENT_INVALID");
  }
  return Object.freeze({ environment, upstreamOrigin, expectCommit, expectReady, execute });
}

/** The key paths of a JSON value, in order (a.b, a.c, ...); arrays are leaves. */
function keyPaths(value, prefix = "") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).flatMap((key) => [`${prefix}${key}`, ...keyPaths(value[key], `${prefix}${key}.`)]);
}

/** sha256 of the body's key-path list: proves the shape, carries no value. */
export function keySetSha256(body) {
  return createHash("sha256").update(JSON.stringify(keyPaths(body))).digest("hex");
}

function marked(response) {
  return response.headers.get(EDGE_HEADERS.originMarker) === MARKER_VALUE;
}

function secureJsonHeaders(response) {
  return response.headers.get("content-type")?.split(";", 1)[0] === "application/json"
    && response.headers.get("cache-control") === "no-store"
    && response.headers.get("referrer-policy") === "no-referrer"
    && response.headers.get("x-content-type-options") === "nosniff";
}

/** The response text up to ORIGIN_SMOKE_MAX_BODY_BYTES, else null. */
async function boundedText(response) {
  try {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") <= ORIGIN_SMOKE_MAX_BODY_BYTES ? text : null;
  } catch {
    return null;
  }
}

function parsedObject(text) {
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The health probe's verdict over a fetched response (pure apart from reading its body). */
export async function evaluateHealthProbe(response, { expectCommit }) {
  const body = parsedObject(await boundedText(response));
  const valid = body !== null && validatePostgresHealthBody(body).length === 0;
  const commitMatches = valid && body.deployment.sourceCommit === expectCommit;
  const ok = response.status === 200 && marked(response) && secureJsonHeaders(response) && valid;
  return Object.freeze({
    probe: "health",
    status: response.status,
    marked: marked(response),
    ok: ok && commitMatches,
    code: !ok ? "ORIGIN_SMOKE_HEALTH_INVALID" : commitMatches ? null : "ORIGIN_SMOKE_HEALTH_COMMIT_MISMATCH",
    keySetSha256: body === null ? null : keySetSha256(body),
    valid,
    commitMatches,
  });
}

/** The readiness probe's verdict: a valid body whose status is the expected one. */
export async function evaluateReadyProbe(response, { expectReady }) {
  const body = parsedObject(await boundedText(response));
  const valid = body !== null && validatePostgresReadinessBody(body, response.status).length === 0;
  const readyStatus = valid ? body.status : null;
  const ok = marked(response) && secureJsonHeaders(response) && valid;
  return Object.freeze({
    probe: "ready",
    status: response.status,
    marked: marked(response),
    ok: ok && readyStatus === expectReady,
    code: !ok ? "ORIGIN_SMOKE_READY_INVALID" : readyStatus === expectReady ? null : "ORIGIN_SMOKE_READY_UNEXPECTED",
    keySetSha256: body === null ? null : keySetSha256(body),
    valid,
    readyStatus,
  });
}

/** A confinement probe: EP-6's constant, unmarked 421. */
export async function evaluateConfinementProbe(response, probe) {
  const text = await boundedText(response);
  const ok = response.status === 421 && !marked(response) && text === ORIGIN_BOUNDARY_ERROR_BODY;
  return Object.freeze({
    probe,
    status: response.status,
    marked: marked(response),
    ok,
    code: ok ? null : "ORIGIN_SMOKE_CONFINEMENT_BROKEN",
  });
}

/** The no-token probe: Google's front end refuses (401 or 403), unmarked. */
export async function evaluateNoTokenProbe(response) {
  await boundedText(response);
  const ok = (response.status === 401 || response.status === 403) && !marked(response);
  return Object.freeze({
    probe: "no_token",
    status: response.status,
    marked: marked(response),
    ok,
    code: ok ? null : "ORIGIN_SMOKE_IAM_OPEN",
  });
}

/** The rollout gate's verdict for the expected readiness (OD-CR-4). */
export function evaluateRollGate(verification, { expectCommit, expectReady }) {
  const passed = verification?.ok === true;
  const gateCode = passed ? null : codeOf(verification, "ROLL_GATE_UNCLASSIFIED");
  const commitMatches = passed && verification.originCommit === expectCommit;
  let code = null;
  if (expectReady === "ready") {
    if (!passed) code = "ORIGIN_SMOKE_ROLL_GATE_REFUSED";
    else if (!commitMatches) code = "ORIGIN_SMOKE_ROLL_GATE_COMMIT_MISMATCH";
  } else if (passed || gateCode !== "EDGE_ORIGIN_VERIFIER_INVALID") {
    code = "ORIGIN_SMOKE_ROLL_GATE_UNEXPECTED";
  }
  return Object.freeze({ ok: code === null, code, passed, gateCode, commitMatches });
}

function plan(args) {
  return Object.freeze({
    schema: ORIGIN_SMOKE_RECEIPT_SCHEMA,
    environment: args.environment,
    mode: "dry-run",
    expectReady: args.expectReady,
    verifier: "rolloutTarget",
    probes: ORIGIN_SMOKE_PROBES,
    rollGate: "verifyEdgeOriginBeforeGcp",
  });
}

async function fetchProbe(fetchImpl, upstreamOrigin, path, token) {
  const url = new URL(path, upstreamOrigin).href;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      ...(token === null ? {} : { [EDGE_HEADERS.invokerToken]: `Bearer ${token}` }),
    },
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(ORIGIN_SMOKE_TIMEOUT_MS),
  });
  // Redirects are errors, so the answer must come from exactly this URL.
  if (response === null || typeof response !== "object" || response.url !== url
      || !Number.isSafeInteger(response.status) || typeof response.headers?.get !== "function"
      || typeof response.text !== "function") {
    throw smokeError("PROBE_RESPONSE_INVALID");
  }
  return response;
}

const UNREACHABLE_CODES = Object.freeze({
  health: "ORIGIN_SMOKE_HEALTH_UNREACHABLE",
  ready: "ORIGIN_SMOKE_READY_UNREACHABLE",
  verifier_off_path: "ORIGIN_SMOKE_CONFINEMENT_UNREACHABLE",
  verifier_query: "ORIGIN_SMOKE_CONFINEMENT_UNREACHABLE",
  no_token: "ORIGIN_SMOKE_IAM_UNREACHABLE",
});

const INVALID_CODES = Object.freeze({
  health: "ORIGIN_SMOKE_HEALTH_INVALID",
  ready: "ORIGIN_SMOKE_READY_INVALID",
  verifier_off_path: "ORIGIN_SMOKE_CONFINEMENT_BROKEN",
  verifier_query: "ORIGIN_SMOKE_CONFINEMENT_BROKEN",
  no_token: "ORIGIN_SMOKE_IAM_OPEN",
});

/**
 * Run the smoke. dependencies (all optional, for the offline check):
 * loadTarget(environment) => RolloutTarget (default: the OPS-2 manifest);
 * createTokenSource({verifierAccount, audience}) => async () => token
 * (default: gcloud impersonation); fetchImpl (default: global fetch);
 * verifyOrigin (default: verifyEdgeOriginBeforeGcp). Returns the receipt;
 * never throws past argument and target validation.
 */
export async function runOriginSmoke(argv, {
  loadTarget = loadRolloutTargetFromInfraManifest,
  createTokenSource = createGcloudIdentityTokenSource,
  fetchImpl = globalThis.fetch,
  verifyOrigin = verifyEdgeOriginBeforeGcp,
} = {}) {
  const args = parseOriginSmokeArgs(argv);
  let target;
  try {
    target = validateRolloutTarget(await loadTarget(args.environment), args.environment);
  } catch (error) {
    throw smokeError(codeOf(error, "ORIGIN_SMOKE_TARGET_UNAVAILABLE"));
  }
  if (!args.execute) return plan(args);
  const receipt = {
    schema: ORIGIN_SMOKE_RECEIPT_SCHEMA,
    environment: args.environment,
    mode: "execute",
    expectReady: args.expectReady,
    ok: false,
    code: null,
    probes: [],
    rollGate: null,
  };
  const finish = () => {
    receipt.code = receipt.probes.find((probe) => probe.code !== null)?.code ?? receipt.rollGate?.code ?? receipt.code;
    receipt.ok = receipt.code === null;
    return Object.freeze({ ...receipt, probes: Object.freeze([...receipt.probes]) });
  };
  let token = null;
  try {
    const obtain = createTokenSource({ verifierAccount: target.verifierServiceAccount, audience: target.originAudience });
    token = await obtain();
  } catch (error) {
    receipt.code = codeOf(error, "ORIGIN_SMOKE_TOKEN_UNAVAILABLE");
    return finish();
  }
  try {
    for (const { probe, path, withToken } of ORIGIN_SMOKE_PROBES) {
      let response;
      try {
        response = await fetchProbe(fetchImpl, args.upstreamOrigin, path, withToken ? token : null);
      } catch {
        receipt.probes.push(Object.freeze({ probe, status: null, marked: false, ok: false,
          code: UNREACHABLE_CODES[probe] }));
        continue;
      }
      try {
        if (probe === "health") receipt.probes.push(await evaluateHealthProbe(response, args));
        else if (probe === "ready") receipt.probes.push(await evaluateReadyProbe(response, args));
        else if (probe === "no_token") receipt.probes.push(await evaluateNoTokenProbe(response));
        else receipt.probes.push(await evaluateConfinementProbe(response, probe));
      } catch {
        // A response this script cannot read is not the answer it requires.
        receipt.probes.push(Object.freeze({ probe, status: response.status, marked: false, ok: false,
          code: INVALID_CODES[probe] }));
      }
    }
    let verification;
    try {
      verification = await verifyOrigin({ upstreamOrigin: args.upstreamOrigin, identityToken: token, fetchImpl });
    } catch (error) {
      verification = { ok: false, code: codeOf(error, "ROLL_GATE_UNCLASSIFIED") };
    }
    receipt.rollGate = evaluateRollGate(verification, args);
  } finally {
    token = null;
  }
  return finish();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    const receipt = await runOriginSmoke(process.argv.slice(2));
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.mode === "execute" && receipt.ok !== true) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ schema: ORIGIN_SMOKE_RECEIPT_SCHEMA, ok: false,
      code: codeOf(error, "ORIGIN_SMOKE_ARGUMENT_INVALID") }));
    process.exitCode = 2;
  }
}
