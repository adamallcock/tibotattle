import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createCompanionSupervisor } from "./companion-supervisor.js";
import {
  createWindowsQualificationAccountObservationHandover,
} from "./desktop-windows-account-observation-qualification.js";
import {
  validateWindowsElectronQualificationRunId,
} from "./windows-qualification.js";

const CHILD_PATH = fileURLToPath(new URL(
  "./windows-account-observation-qualification-smoke-child.mjs",
  import.meta.url,
));
const PHASES = Object.freeze(["create-v1", "restart-read-v1"]);
const RESTART_READ_PHASES = Object.freeze(["restart-read-v1"]);
const CONTROL_SCHEMA = "windows-account-observation-qualification-smoke-ipc-v1";

// The outer NSIS lifecycle reuses one deterministic synthetic record across
// two top-level Electron processes. This selector remains inside the already
// qualified smoke route; absent configuration preserves the standalone
// create-and-restart proof.
export const WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_PHASE_ENVIRONMENT_KEY =
  "USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_PHASE";
export const WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_FIRST_PHASE =
  "create-and-restart-v1";
export const WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_RESTART_PHASE =
  "restart-read-v1";
const CHILD_FAILURE_STAGES = new Map([
  [41, "child_configuration"],
  [42, "child_initial_read"],
  [43, "child_create"],
  [44, "child_readback"],
  [45, "child_restart_read"],
  [46, "child_initial_read_existing_record"],
  [47, "child_initial_read_broker_unavailable"],
  [48, "child_initial_read_broker_locked"],
  [49, "child_initial_read_broker_denied"],
  [50, "child_initial_read_broker_recovery_required"],
  [51, "child_initial_read_broker_timeout"],
  [52, "child_initial_read_broker_protocol"],
  [53, "child_initial_read_broker_invalid_configuration"],
]);
const FAILURE_STAGES = new Set([
  "preparation",
  "startup",
  "shutdown",
  ...CHILD_FAILURE_STAGES.values(),
]);
const trustedSmokeErrors = new WeakSet();

export const WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_SMOKE_FAILURE_STAGES = Object.freeze([
  "preparation",
  "startup",
  "shutdown",
  ...CHILD_FAILURE_STAGES.values(),
]);

export class WindowsAccountObservationQualificationSmokeError extends Error {
  constructor(stage) {
    if (!FAILURE_STAGES.has(stage)) {
      throw new TypeError("Unknown Windows account-observation smoke failure stage");
    }
    super("Windows account-observation qualification smoke failed");
    this.name = "WindowsAccountObservationQualificationSmokeError";
    this.code = "windows_account_observation_qualification_smoke_failed";
    Object.defineProperty(this, "stage", {
      value: stage,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    trustedSmokeErrors.add(this);
  }
}

function smokeFailure(stage) {
  return new WindowsAccountObservationQualificationSmokeError(stage);
}

/** Return a fixed failure stage without exposing child/native error detail. */
export function classifyWindowsAccountObservationSmokeFailure(error) {
  try {
    return error !== null
      && typeof error === "object"
      && trustedSmokeErrors.has(error)
      && Object.getPrototypeOf(error) === WindowsAccountObservationQualificationSmokeError.prototype
      && FAILURE_STAGES.has(error.stage)
      ? error.stage
      : null;
  } catch {
    return null;
  }
}

function exactOptions(value, keys) {
  try {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key));
  } catch {
    return false;
  }
}

function isControlMessage(message) {
  try {
    return message !== null
      && typeof message === "object"
      && !Array.isArray(message)
      && message.schemaVersion === CONTROL_SCHEMA;
  } catch {
    return false;
  }
}

function isReadyMessage(message) {
  try {
    return isControlMessage(message)
      && Object.keys(message).sort().join(",") === "kind,schemaVersion"
      && message.kind === "ready-v1";
  } catch {
    return false;
  }
}

function validChannel(channel) {
  try {
    return channel !== null
      && typeof channel === "object"
      && channel.connected !== false
      && typeof channel.on === "function"
      && typeof channel.off === "function"
      && typeof channel.send === "function";
  } catch {
    return false;
  }
}

function lifecyclePhases(environment) {
  const phase = Object.hasOwn(environment, WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_PHASE_ENVIRONMENT_KEY)
    ? environment[WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_PHASE_ENVIRONMENT_KEY]
    : undefined;
  if (phase === undefined || phase === WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_FIRST_PHASE) {
    return PHASES;
  }
  if (phase === WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_RESTART_PHASE) {
    return RESTART_READ_PHASES;
  }
  throw new Error("invalid lifecycle phase");
}

/**
 * Attach the observation broker first, then begin the child phase only after
 * its independently installed control listener has acknowledged readiness.
 * The control schema is closed and distinct from both accountless and broker
 * messages, so sharing the Node IPC descriptor cannot consume either route.
 */
function attachHandoverWithControl({ handover, phase, runId }, channel) {
  if (!validChannel(channel)) throw new Error("invalid child IPC channel");
  let disposed = false;
  let attached = false;
  let ready = false;
  let started = false;
  let broker = null;

  const cleanup = () => {
    try { channel.off("message", onMessage); } catch { /* Child is closing. */ }
    try { broker?.dispose?.(); } catch { /* Supervisor teardown stays bounded. */ }
    broker = null;
  };
  const abort = () => {
    if (disposed) return;
    disposed = true;
    cleanup();
    try { channel.kill?.(); } catch { /* The owned child may already be gone. */ }
  };
  const sendStart = () => {
    if (disposed || !attached || !ready || started) return;
    started = true;
    try {
      if (channel.connected === false) throw new Error("child IPC is closed");
      channel.send(Object.freeze({
        schemaVersion: CONTROL_SCHEMA,
        kind: "start-v1",
        phase,
        runId,
      }), (error) => {
        if (error) abort();
      });
    } catch {
      abort();
    }
  };
  function onMessage(message) {
    if (disposed || !isControlMessage(message)) return;
    if (!isReadyMessage(message) || ready) {
      abort();
      return;
    }
    ready = true;
    sendStart();
  }

  channel.on("message", onMessage);
  try {
    broker = handover.attachWindowsAccountObservationBroker(channel);
    if (broker === null || typeof broker !== "object" || typeof broker.dispose !== "function") {
      throw new Error("invalid Windows observation broker");
    }
    attached = true;
    sendStart();
  } catch (error) {
    disposed = true;
    cleanup();
    throw error;
  }
  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    },
  });
}

async function runWithDependencies({
  environment,
  qualificationContext,
}, {
  createHandover,
  createSupervisor,
  spawnChild,
  validateRunId,
}) {
  if (typeof createHandover !== "function"
      || typeof createSupervisor !== "function"
      || typeof spawnChild !== "function"
      || typeof validateRunId !== "function") {
    throw smokeFailure("preparation");
  }
  let phases;
  let runId;
  let handover;
  try {
    runId = validateRunId(environment?.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID);
    phases = lifecyclePhases(environment);
    handover = createHandover({ qualificationContext, environment });
    if (handover === null || typeof handover !== "object"
        || typeof handover.attachWindowsAccountObservationBroker !== "function") {
      throw new Error("invalid handover");
    }
  } catch {
    throw smokeFailure("preparation");
  }

  for (const phase of phases) {
    let supervisor = null;
    let childExitCode = null;
    try {
      supervisor = createSupervisor({
        command: process.execPath,
        args: [CHILD_PATH, phase, runId],
        environment,
        spawnChild(command, args, options) {
          const child = spawnChild(command, args, options);
          child?.once?.("exit", (code) => {
            childExitCode = Number.isSafeInteger(code) ? code : null;
          });
          return child;
        },
        attachWindowsAccountObservationBroker(channel) {
          return attachHandoverWithControl({ handover, phase, runId }, channel);
        },
      });
      if (supervisor === null || typeof supervisor !== "object"
          || typeof supervisor.start !== "function" || typeof supervisor.stop !== "function") {
        throw new Error("invalid supervisor");
      }
      await supervisor.start();
    } catch {
      try { await supervisor?.stop?.(); } catch { /* Fixed smoke failure below. */ }
      throw smokeFailure(CHILD_FAILURE_STAGES.get(childExitCode) ?? "startup");
    }
    try {
      await supervisor.stop();
    } catch {
      try { await supervisor?.stop?.(); } catch { /* Fixed smoke failure below. */ }
      throw smokeFailure("shutdown");
    }
  }
  // The fixed IPC capability has no delete operation. The outer Windows
  // runner must use a disposable account/profile and reports that account
  // lifetime as its cleanup boundary; this smoke never broadens the wire.
  return Object.freeze({ status: "passed-v1" });
}

/**
 * Exercise the supervisor-owned Windows Node IPC route twice in a packaged
 * qualification run. The first child refuses any pre-existing record, writes
 * a deterministic synthetic secret through the fixed parent broker, and reads
 * it back. A fresh child then proves restart retention over a new owned IPC
 * channel. This function deliberately has no named-pipe or child-native
 * fallback: IPC support is qualified only by the Windows runner.
 */
export async function runWindowsAccountObservationQualificationSmoke(options = {}) {
  if (!exactOptions(options, ["context", "environment"])) {
    throw smokeFailure("preparation");
  }
  return runWithDependencies({
    environment: options.environment,
    qualificationContext: options.context,
  }, {
    createHandover: createWindowsQualificationAccountObservationHandover,
    createSupervisor: createCompanionSupervisor,
    spawnChild: nodeSpawn,
    validateRunId: validateWindowsElectronQualificationRunId,
  });
}

/** Plain-Node dependency seam for phase ordering and failure containment. */
export async function runWindowsAccountObservationQualificationSmokeForTest(
  options = {},
  dependencies = {},
) {
  if (!exactOptions(options, ["environment", "qualificationContext"])
      || !exactOptions(dependencies, ["createHandover", "createSupervisor", "spawnChild", "validateRunId"])) {
    throw smokeFailure("preparation");
  }
  return runWithDependencies(options, dependencies);
}
