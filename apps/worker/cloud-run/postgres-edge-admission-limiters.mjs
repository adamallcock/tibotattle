/**
 * Edge-admission replay limiters for the Cloud Run origin.
 *
 * In gcp mode the Cloudflare edge evaluates every address-keyed limit with
 * the unchanged src/admission.ts helpers and its Workers Rate Limiting
 * bindings, then sends only the outcome ('v1;<purpose>;allowed|limited|
 * unavailable', src/edge-origin-contract.ts) to the origin. The origin runs
 * the same unchanged helpers at the same point in each route (FC-7), against
 * the eight replay bindings created here instead of real limiters, so the
 * Worker's ordering, status codes, envelopes and retry-after headers are kept
 * without the origin ever seeing a client address.
 *
 * run(admission, fn) scopes one decoded edge outcome (or null when the edge
 * sent none) to fn through AsyncLocalStorage; the bindings read it at the
 * handler's own call point:
 * - 'allowed' resolves {success: true};
 * - 'limited' resolves {success: false}, so the helper answers its 429 with
 *   retry-after 60;
 * - anything else throws a plain Error, which the helper answers as its 503
 *   with retry-after 60: no store (a call outside run), no outcome, the
 *   outcome 'unavailable', a key outside the Worker's key shape, a key whose
 *   purpose differs from the outcome's, a key or purpose the binding never
 *   receives from the Worker helpers, or a call the Worker helper sequence
 *   never makes (a repeated binding, a client call before its coarse call or
 *   after a refusal, or any call after a limited or refused one).
 *
 * The client segment of a key is only shape-checked. At the origin no
 * cf-connecting-ip is ever present, so the helper derives it from the
 * 'unavailable' subject under the origin's IDENTITY_LINK_SECRET; the outcome
 * comes solely from the edge. Nothing here logs, and no error carries a key.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  EDGE_ADMISSION_OUTCOMES,
  EDGE_ADMISSION_PURPOSES,
} from "../src/edge-origin-contract.ts";

/** The eight edge-tier binding names (EP-1 EDGE_ADMISSION_BINDINGS). */
export const EDGE_ADMISSION_REPLAY_BINDINGS = Object.freeze([
  "ENROLLMENT_RATE_LIMIT",
  "RECOVERY_RATE_LIMIT",
  "CLIENT_ATTEMPT_RATE_LIMIT",
  "DEVICE_SYNC_CLIENT_RATE_LIMIT",
  "DEVICE_SYNC_RATE_LIMIT",
  "PUBLIC_READ_RATE_LIMIT",
  "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
  "UPLOAD_INGRESS_CLIENT_RATE_LIMIT",
]);

const PUBLIC_READ_PURPOSE = "public_aggregate_read";
const UPLOAD_INGRESS_PURPOSE = "upload_ingress";
const DEVICE_SYNC_CREDENTIAL_PURPOSE = "device_sync_credential";
/** The src/admission.ts AttemptPurpose values: every other contract purpose. */
const ATTEMPT_PURPOSES = Object.freeze(EDGE_ADMISSION_PURPOSES.filter(
  (purpose) => purpose !== PUBLIC_READ_PURPOSE
    && purpose !== UPLOAD_INGRESS_PURPOSE
    && purpose !== DEVICE_SYNC_CREDENTIAL_PURPOSE,
));

/**
 * What each binding receives from the Worker helpers: its stage in the
 * helper's call sequence and the purposes whose keys it is given. A 'coarse'
 * binding receives only ':global' keys and a 'client' binding only
 * ':client:<hex>' keys.
 */
const BINDING_RULES = Object.freeze({
  ENROLLMENT_RATE_LIMIT: Object.freeze({ stage: "coarse", purposes: ATTEMPT_PURPOSES }),
  RECOVERY_RATE_LIMIT: Object.freeze({ stage: "coarse", purposes: ATTEMPT_PURPOSES }),
  CLIENT_ATTEMPT_RATE_LIMIT: Object.freeze({ stage: "client", purposes: ATTEMPT_PURPOSES }),
  DEVICE_SYNC_CLIENT_RATE_LIMIT: Object.freeze({
    stage: "client",
    purposes: Object.freeze([DEVICE_SYNC_CREDENTIAL_PURPOSE]),
  }),
  DEVICE_SYNC_RATE_LIMIT: Object.freeze({
    stage: "coarse",
    purposes: Object.freeze([DEVICE_SYNC_CREDENTIAL_PURPOSE]),
  }),
  PUBLIC_READ_RATE_LIMIT: Object.freeze({
    stage: "client",
    purposes: Object.freeze([PUBLIC_READ_PURPOSE]),
  }),
  UPLOAD_INGRESS_REQUEST_RATE_LIMIT: Object.freeze({
    stage: "coarse",
    purposes: Object.freeze([UPLOAD_INGRESS_PURPOSE]),
  }),
  UPLOAD_INGRESS_CLIENT_RATE_LIMIT: Object.freeze({
    stage: "client",
    purposes: Object.freeze([UPLOAD_INGRESS_PURPOSE]),
  }),
});

const DEVICE_SYNC_CREDENTIAL_KEY_PATTERN =
  /^usage-monitor:device_sync:credential:(global|client:[0-9a-f]{64})$/u;
const REPLAY_KEY_PATTERN = /^usage-monitor:([a-z_]+):(global|client:[0-9a-f]{64})$/u;
const MAX_REPLAY_KEY_LENGTH = 256;

function replayRefusal(code) {
  return Object.assign(new Error(code), { code });
}

function contractError(code) {
  return Object.assign(new TypeError(code), { code });
}

/** A purpose whose Worker helper calls a coarse binding before the client one. */
function hasCoarseStage(purpose) {
  return purpose !== PUBLIC_READ_PURPOSE;
}

function normalizedAdmission(admission) {
  if (admission === null) return null;
  if (admission === undefined || typeof admission !== "object"
      || !EDGE_ADMISSION_PURPOSES.includes(admission.purpose)
      || !EDGE_ADMISSION_OUTCOMES.includes(admission.outcome)) {
    throw contractError("EDGE_ADMISSION_REPLAY_OUTCOME_INVALID");
  }
  return Object.freeze({ purpose: admission.purpose, outcome: admission.outcome });
}

function parseReplayKey(options) {
  const key = options !== null && typeof options === "object" ? options.key : undefined;
  if (typeof key !== "string" || key.length > MAX_REPLAY_KEY_LENGTH) return null;
  const credentialMatch = DEVICE_SYNC_CREDENTIAL_KEY_PATTERN.exec(key);
  if (credentialMatch !== null) {
    return {
      purpose: DEVICE_SYNC_CREDENTIAL_PURPOSE,
      stage: credentialMatch[1] === "global" ? "coarse" : "client",
    };
  }
  const match = REPLAY_KEY_PATTERN.exec(key);
  if (match === null) return null;
  return { purpose: match[1], stage: match[2] === "global" ? "coarse" : "client" };
}

/**
 * Create the replay bindings and their scope. One instance serves the whole
 * process: every run() has its own store, so concurrent requests never share
 * an outcome or a call sequence.
 */
export function createEdgeAdmissionLimiters() {
  const storage = new AsyncLocalStorage();

  function replayDeviceSyncCredential(store, name, parsed, rule) {
    const { admission } = store;
    if (admission.outcome === "unavailable") {
      throw replayRefusal("EDGE_ADMISSION_REPLAY_UNAVAILABLE");
    }
    if (store.credentialCalls < 2) {
      const expected = store.credentialCalls === 0
        ? { name: "DEVICE_SYNC_CLIENT_RATE_LIMIT", stage: "client" }
        : { name: "DEVICE_SYNC_RATE_LIMIT", stage: "coarse" };
      if (name !== expected.name || parsed.stage !== expected.stage) {
        throw replayRefusal("EDGE_ADMISSION_REPLAY_SEQUENCE_INVALID");
      }
      store.credentialCalls += 1;
      if (admission.outcome === "limited") {
        store.closed = true;
        return { success: false };
      }
      // The origin authenticates only after the edge's client-then-location
      // credential pair. Keep this run open for its optional attempt replay.
      store.closed = false;
      return { success: true };
    }

    const expected = store.deferredCalls === 0
      ? { name: "RECOVERY_RATE_LIMIT", stage: "coarse" }
      : { name: "CLIENT_ATTEMPT_RATE_LIMIT", stage: "client" };
    if (store.deferredCalls >= 2 || name !== expected.name
        || parsed.purpose !== "device_sync" || parsed.stage !== expected.stage
        || !rule.purposes.includes(parsed.purpose)) {
      throw replayRefusal("EDGE_ADMISSION_REPLAY_SEQUENCE_INVALID");
    }
    store.deferredCalls += 1;
    if (store.deferredCalls === 2) {
      store.deferredAttempt = true;
      store.closed = true;
    } else {
      store.closed = false;
    }
    // The edge applies the actual attempt budget after this 401 response.
    return { success: true };
  }

  function admit(name, options) {
    const store = storage.getStore();
    if (store === undefined) throw replayRefusal("EDGE_ADMISSION_REPLAY_NO_CONTEXT");
    if (store.closed) throw replayRefusal("EDGE_ADMISSION_REPLAY_SEQUENCE_INVALID");
    // Close before validating this call. Only an allowed, correctly ordered
    // intermediate stage below reopens the run; a caught refusal cannot be
    // used to retry a different binding inside the same request.
    store.closed = true;
    // Any refusal, and any call after a limited outcome, closes the run: the
    // Worker helper stops at its first refusal, so a later call is a
    // divergence, never a second chance.
    const { admission } = store;
    if (admission === null) throw replayRefusal("EDGE_ADMISSION_REPLAY_NO_OUTCOME");
    const parsed = parseReplayKey(options);
    if (parsed === null) throw replayRefusal("EDGE_ADMISSION_REPLAY_KEY_INVALID");
    const rule = BINDING_RULES[name];
    if (parsed.stage !== rule.stage || !rule.purposes.includes(parsed.purpose)) {
      throw replayRefusal("EDGE_ADMISSION_REPLAY_BINDING_MISMATCH");
    }
    const deferredAttemptPurpose = admission.purpose === DEVICE_SYNC_CREDENTIAL_PURPOSE
      && store.credentialCalls === 2
      && parsed.purpose === "device_sync";
    if (parsed.purpose !== admission.purpose && !deferredAttemptPurpose) {
      throw replayRefusal("EDGE_ADMISSION_REPLAY_PURPOSE_MISMATCH");
    }
    if (admission.purpose === DEVICE_SYNC_CREDENTIAL_PURPOSE) {
      return replayDeviceSyncCredential(store, name, parsed, rule);
    }
    store.closed = true;
    // The helper sequence: coarse then client, or the client call alone for
    // the public read. An open run has made at most one (allowed coarse) call.
    const expectedStage = store.calls === 0 && hasCoarseStage(admission.purpose)
      ? "coarse"
      : "client";
    if (rule.stage !== expectedStage) {
      throw replayRefusal("EDGE_ADMISSION_REPLAY_SEQUENCE_INVALID");
    }
    if (admission.outcome === "unavailable") {
      throw replayRefusal("EDGE_ADMISSION_REPLAY_UNAVAILABLE");
    }
    store.calls += 1;
    if (admission.outcome === "limited") return { success: false };
    // Only an allowed coarse call leaves room for the helper's client call.
    store.closed = rule.stage === "client";
    return { success: true };
  }

  const bindings = Object.freeze(Object.fromEntries(EDGE_ADMISSION_REPLAY_BINDINGS.map((name) => [
    name,
    Object.freeze({
      async limit(options) {
        return admit(name, options);
      },
    }),
  ])));

  /**
   * Run fn with one edge outcome in scope. admission is the decoded header
   * ({purpose, outcome}, frozen or not) or null when the edge sent none.
   * Returns fn's own result.
   */
  function run(admission, fn) {
    if (typeof fn !== "function") throw contractError("EDGE_ADMISSION_REPLAY_FUNCTION_INVALID");
    const store = {
      admission: normalizedAdmission(admission),
      calls: 0,
      closed: false,
      credentialCalls: 0,
      deferredCalls: 0,
      deferredAttempt: false,
    };
    return storage.run(store, fn);
  }

  /** Run fn and report whether its failed device bearer deferred an edge charge. */
  async function runWithReport(admission, fn) {
    if (typeof fn !== "function") throw contractError("EDGE_ADMISSION_REPLAY_FUNCTION_INVALID");
    const store = {
      admission: normalizedAdmission(admission),
      calls: 0,
      closed: false,
      credentialCalls: 0,
      deferredCalls: 0,
      deferredAttempt: false,
    };
    const result = await storage.run(store, fn);
    return Object.freeze({ result, deferredAttempt: store.deferredAttempt });
  }

  return Object.freeze({ bindings, run, runWithReport });
}
