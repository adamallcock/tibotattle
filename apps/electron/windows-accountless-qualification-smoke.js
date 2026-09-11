import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { attachAccountlessParentChannel } from "../../src/platform/index.js";
import {
  createWindowsElectronQualificationAccountlessCredentialBackend,
  validateWindowsElectronQualificationRunId,
} from "./windows-qualification.js";

const SCHEMA = "windows-accountless-qualification-smoke-v1";
const PHASES = Object.freeze(["create-v1", "verify-delete-v1"]);
const HELPER_PATH = fileURLToPath(new URL(
  "./windows-accountless-qualification-smoke-child.mjs",
  import.meta.url,
));
const CHILD_TIMEOUT_MILLISECONDS = 10_000;
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
]);
const QUALIFICATION_PREFERENCE = Object.freeze({
  available: true,
  current: true,
  enabled: true,
  policyVersion: "accountless-opt-out-v1",
  destinationOrigin: null,
});

function smokeFailure() {
  return new Error("Windows accountless qualification smoke failed");
}

function exactMessage(value, keys) {
  try {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  } catch {
    return false;
  }
}

function childEnvironment(environment) {
  const selected = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    if (typeof environment?.[key] === "string" && !environment[key].includes("\0")) {
      selected[key] = environment[key];
    }
  }
  selected.ELECTRON_RUN_AS_NODE = "1";
  return selected;
}

function isChild(value) {
  try {
    return value !== null
      && typeof value === "object"
      && typeof value.on === "function"
      && typeof value.off === "function"
      && typeof value.send === "function"
      && typeof value.kill === "function";
  } catch {
    return false;
  }
}

function isReadyMessage(value) {
  return exactMessage(value, ["kind", "schemaVersion"])
    && value.schemaVersion === SCHEMA
    && value.kind === "ready-v1";
}

function isResultMessage(value) {
  return exactMessage(value, ["kind", "schemaVersion", "status"])
    && value.schemaVersion === SCHEMA
    && value.kind === "result-v1"
    && (value.status === "passed-v1" || value.status === "failed-v1");
}

function stopOwnedChild(child) {
  try {
    if (child?.killed !== true) child?.kill("SIGTERM");
  } catch {
    // A process can exit between the fixed timeout and its cleanup action.
  }
}

function runPhase({
  backend,
  environment,
  executable,
  helperPath,
  phase,
  runId,
  spawnProcess,
}) {
  return new Promise((resolvePhase, rejectPhase) => {
    let child = null;
    let broker = null;
    let settled = false;
    let ready = false;
    let result = null;
    let controlMessages = 0;
    const settle = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child?.off?.("message", onMessage);
      child?.off?.("error", onError);
      child?.off?.("exit", onExit);
      try {
        broker?.dispose?.();
      } catch {
        // The child is already being closed; the parent broker cannot escape.
      }
      if (error !== null) stopOwnedChild(child);
      if (error === null) resolvePhase();
      else rejectPhase(smokeFailure());
    };
    const onError = () => settle(smokeFailure());
    const onExit = (code, signal) => {
      if (result === "passed-v1" && code === 0 && signal === null) {
        settle();
      } else {
        settle(smokeFailure());
      }
    };
    const onMessage = (message) => {
      if (!isReadyMessage(message) && !isResultMessage(message)) return;
      controlMessages += 1;
      if (controlMessages > 2) {
        settle(smokeFailure());
        return;
      }
      if (isReadyMessage(message)) {
        if (ready || controlMessages !== 1) {
          settle(smokeFailure());
          return;
        }
        ready = true;
        try {
          child.send(Object.freeze({
            schemaVersion: SCHEMA,
            kind: "start-v1",
            phase,
            runId,
          }), (error) => {
            if (error) settle(smokeFailure());
          });
        } catch {
          settle(smokeFailure());
        }
        return;
      }
      if (!ready || controlMessages !== 2 || result !== null) {
        settle(smokeFailure());
        return;
      }
      result = message.status;
      if (result !== "passed-v1") settle(smokeFailure());
    };
    const timeout = setTimeout(() => settle(smokeFailure()), CHILD_TIMEOUT_MILLISECONDS);
    timeout.unref?.();
    try {
      child = spawnProcess(executable, [helperPath], {
        env: childEnvironment(environment),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
      if (!isChild(child)) throw smokeFailure();
      broker = attachAccountlessParentChannel({
        channel: child,
        backend,
        readPreference: async () => QUALIFICATION_PREFERENCE,
      });
      if (!broker || typeof broker.dispose !== "function") throw smokeFailure();
      child.on("message", onMessage);
      child.on("error", onError);
      child.on("exit", onExit);
    } catch {
      settle(smokeFailure());
    }
  });
}

async function runWithBackend({
  backend,
  environment,
  executable = process.execPath,
  helperPath = HELPER_PATH,
  runId,
  spawnProcess = nodeSpawn,
} = {}) {
  if (!backend || typeof backend !== "object"
      || ["read", "createIfMissing", "deleteExact"].some(
        (operation) => typeof backend[operation] !== "function")
      || typeof executable !== "string" || executable.length === 0
      || typeof helperPath !== "string" || helperPath.length === 0
      || typeof spawnProcess !== "function") {
    throw smokeFailure();
  }
  const selectedRunId = validateWindowsElectronQualificationRunId(runId);
  for (const phase of PHASES) {
    await runPhase({
      backend,
      environment,
      executable,
      helperPath,
      phase,
      runId: selectedRunId,
      spawnProcess,
    });
  }
  return Object.freeze({ status: "passed-v1" });
}

/**
 * Exercise only the qualification-only FD3 storage path. The packaged
 * Windows context and its independently branded platform context are checked
 * before a native backend is constructed. The normal companion receives no
 * accountless mode/origin and this helper is never a renderer route.
 */
export async function runWindowsAccountlessQualificationSmoke({
  context,
  environment = process.env,
} = {}) {
  const runId = validateWindowsElectronQualificationRunId(
    environment?.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID,
  );
  const backend = await createWindowsElectronQualificationAccountlessCredentialBackend({
    context,
    environment,
    runId,
  });
  return runWithBackend({ backend, environment, runId });
}

/** Dependency-injected process seam for the plain-Node FD3 smoke contract. */
export async function runWindowsAccountlessQualificationSmokeForTest(options = {}) {
  return runWithBackend(options);
}
