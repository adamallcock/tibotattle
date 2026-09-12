import { createHash, timingSafeEqual } from "node:crypto";

import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY,
  createWindowsAccountObservationBrokerBackendFromEnvironment,
  isWindowsAccountObservationBrokerError,
  windowsAccountObservationBrokerConfiguration,
} from "../../src/platform/index.js";

const CONTROL_SCHEMA = "windows-account-observation-qualification-smoke-ipc-v1";
const PHASES = new Set(["create-v1", "restart-read-v1"]);
const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// Only fixed stage numbers cross the child-process boundary. Native errors,
// account identifiers, record values, and IPC diagnostics stay local.
let failureExitCode = 41;

const INITIAL_READ_FAILURE_EXIT_CODES = new Map([
  ["windows_account_observation_broker_unavailable", 47],
  ["windows_account_observation_broker_locked", 48],
  ["windows_account_observation_broker_denied", 49],
  ["windows_account_observation_broker_recovery_required", 50],
  ["windows_account_observation_broker_timeout", 51],
  ["windows_account_observation_broker_protocol", 52],
  ["windows_account_observation_broker_invalid_configuration", 53],
]);

function initialReadFailureExitCode(error) {
  try {
    if (isWindowsAccountObservationBrokerError(error) !== true) return 42;
    return INITIAL_READ_FAILURE_EXIT_CODES.get(error.code) ?? 42;
  } catch {
    return 42;
  }
}

function argumentsForQualification() {
  const values = process.argv.slice(2);
  if (values.length !== 2 || !PHASES.has(values[0])
      || typeof values[1] !== "string" || !RUN_ID.test(values[1])) {
    throw new Error("invalid qualification arguments");
  }
  return Object.freeze({ phase: values[0], runId: values[1].toLowerCase() });
}

function exact(value, keys) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && keys.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

function isStartMessage(message, expected) {
  try {
    return exact(message, ["schemaVersion", "kind", "phase", "runId"])
      && message.schemaVersion === CONTROL_SCHEMA
      && message.kind === "start-v1"
      && message.phase === expected.phase
      && typeof message.runId === "string"
      && message.runId.toLowerCase() === expected.runId;
  } catch {
    return false;
  }
}

function isControlMessage(message) {
  try {
    return message !== null && typeof message === "object" && !Array.isArray(message)
      && message.schemaVersion === CONTROL_SCHEMA;
  } catch {
    return false;
  }
}

function syntheticSecret(runId) {
  return createHash("sha256")
    .update(`tibotattle-windows-account-observation-ipc-smoke-v1:${runId}`)
    .digest();
}

function sameSecret(left, right) {
  try {
    return Buffer.isBuffer(left)
      && Buffer.isBuffer(right)
      && left.byteLength === 32
      && right.byteLength === 32
      && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

async function readExact(backend, expected) {
  let observed = null;
  try {
    observed = await backend.read(WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY);
    return sameSecret(observed, expected);
  } finally {
    observed?.fill?.(0);
  }
}

async function run({ phase, runId }) {
  const configuration = windowsAccountObservationBrokerConfiguration();
  if (configuration?.ipc !== true) {
    failureExitCode = 53;
    throw new Error("missing fixed IPC broker");
  }
  const backend = createWindowsAccountObservationBrokerBackendFromEnvironment();
  if (backend === null) {
    failureExitCode = 53;
    throw new Error("missing fixed IPC broker");
  }
  const expected = syntheticSecret(runId);
  try {
    if (phase === "create-v1") {
      let existing = null;
      try {
        failureExitCode = 42;
        try {
          existing = await backend.read(WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY);
        } catch (error) {
          failureExitCode = initialReadFailureExitCode(error);
          throw error;
        }
        if (existing !== null) {
          failureExitCode = 46;
          throw new Error("unexpected existing synthetic record");
        }
      } finally {
        existing?.fill?.(0);
      }
      failureExitCode = 43;
      if (await backend.createIfMissing(
        WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY,
        expected,
      ) !== "created") {
        throw new Error("record was not created");
      }
      failureExitCode = 44;
      if (!(await readExact(backend, expected))) throw new Error("readback mismatch");
      return;
    }
    failureExitCode = 45;
    if (!(await readExact(backend, expected))) throw new Error("restart read mismatch");
  } finally {
    expected.fill(0);
  }
}

let started = false;
let finished = false;
let expectedArguments = null;

function finishFailure() {
  if (finished) return;
  finished = true;
  process.off("message", onMessage);
  process.exit(failureExitCode);
}

function finishSuccess() {
  if (finished) return;
  finished = true;
  process.off("message", onMessage);
  process.stdout.write("USAGE_MONITOR_READY http://127.0.0.1:4545/\n");
  setInterval(() => {}, 1_000);
}

function onMessage(message) {
  if (finished || !isControlMessage(message)) return;
  if (started || !isStartMessage(message, expectedArguments)) {
    failureExitCode = 41;
    finishFailure();
    return;
  }
  started = true;
  // Listener installation for the Windows observation backend deliberately
  // happens only after the parent broker and this control handshake are ready.
  // Accountless and broker frames use different schemas and remain ignored here.
  void run(expectedArguments).then(finishSuccess, finishFailure);
}

try {
  expectedArguments = argumentsForQualification();
  if (typeof process.send !== "function") throw new Error("missing parent IPC");
  process.on("message", onMessage);
  process.send(Object.freeze({ schemaVersion: CONTROL_SCHEMA, kind: "ready-v1" }), (error) => {
    if (error && !started) {
      failureExitCode = 41;
      finishFailure();
    }
  });
} catch {
  failureExitCode = 41;
  finishFailure();
}
