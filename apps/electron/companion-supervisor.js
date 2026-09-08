import { spawn as nodeSpawn } from "node:child_process";

import {
  LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV,
  LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
} from "../../src/platform/index.js";
import { shellError } from "./errors.js";
import { createCompanionReadyLineParser } from "./ready-line.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

// The renderer/launcher environment is not a credential transport. Keep the
// child input explicit: platform runtime discovery plus the reviewed
// TiboTattle/Codex/Claude configuration knobs only. NODE_OPTIONS, arbitrary
// provider credentials, and unrelated shell secrets never cross the boundary.
const COMPANION_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_STATE_HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "CODEX_HOME",
  "CODEX_BIN",
  "CODEX_THREAD_ID",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PROJECT_DIRECTORY",
  "USAGE_MONITOR_ACCOUNTING_SOURCE_MODE",
  "USAGE_MONITOR_RESOURCE_ROOT",
  "USAGE_MONITOR_STATE_ROOT",
  "USAGE_MONITOR_CONTRIBUTION_QUEUE_FILE",
  "USAGE_MONITOR_PREPARED_DIRECTORY",
  "USAGE_MONITOR_CENTRAL_ORIGIN",
  "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION",
  "USAGE_MONITOR_TEST_LANE",
  "USAGE_MONITOR_ACCOUNTLESS_ORIGIN",
  "USAGE_MONITOR_ACCOUNTLESS_MODE",
]);

function assertTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new TypeError(`${label} must be a bounded positive integer`);
  }
}

function discardStream(stream) {
  stream?.on?.("data", () => {});
  stream?.resume?.();
}

function killChild(child, signal) {
  try {
    child?.kill?.(signal);
  } catch {
    // The process may have exited between the bounded state transition and
    // kill(). The supervisor reports only its fixed lifecycle result.
  }
}

function disposeCredentialBroker(broker) {
  try { broker?.dispose?.(); } catch { /* Child teardown must still complete. */ }
}

function companionEnvironment(environment, parentPid, credentialBrokerKind = null) {
  const selected = {};
  for (const key of COMPANION_ENVIRONMENT_KEYS) {
    if (Object.hasOwn(environment, key) && typeof environment[key] === "string") {
      selected[key] = environment[key];
    }
  }
  // Only the explicit local Mac QA lane can select a private identity file.
  // Never pass secret bytes or silently fall back to Keychain on a broken pair.
  if (environment.USAGE_MONITOR_TEST_LANE === "macos-electron-local-qa-v1") {
    const file = environment.USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE;
    const enabled = environment.USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY;
    if (file !== undefined || enabled !== undefined) {
      if (typeof file !== "string" || !file.startsWith("/") || file.includes("\0")
          || enabled !== "1" || environment.USAGE_MONITOR_CENTRAL_ORIGIN
          || environment.APP_USAGEMONITOR_EXPORT_SECRET !== undefined) {
        throw shellError("electron_configuration_invalid");
      }
      selected.USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE = file;
      selected.USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY = "1";
    }
  }
  // The child is a Node companion launched by Electron, never another GUI.
  selected.ELECTRON_RUN_AS_NODE = "1";
  selected.USAGE_MONITOR_PORT = "0";
  selected.USAGE_MONITOR_PARENT_PID = String(parentPid);
  // Only an explicitly composed parent broker can announce this descriptor.
  // An inherited native-app FD is never accepted from the launch environment.
  if (credentialBrokerKind === "macos_keychain") {
    selected.USAGE_MONITOR_KEYCHAIN_BROKER_FD = "4";
  }
  if (credentialBrokerKind === "linux_secret_service") {
    selected.USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD = "4";
  }
  if (credentialBrokerKind === "windows_account_observation") {
    selected[WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV] =
      WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER;
  }
  if (credentialBrokerKind === "linux_account_observation") {
    selected[LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV] =
      LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER;
  }
  return selected;
}

/**
 * Own exactly one local companion child. The supervisor never forwards child
 * output and never includes child error text in a rejection.
 */
export function createCompanionSupervisor({
  spawnChild = nodeSpawn,
  command = process.execPath,
  args = [],
  cwd,
  environment = process.env,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  parentPid = process.pid,
  onUnexpectedExit,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  attachPrivateChannel,
  attachCredentialBroker,
  attachLinuxSecretServiceBroker,
  attachWindowsAccountObservationBroker,
  attachLinuxAccountObservationBroker,
} = {}) {
  if (typeof spawnChild !== "function") throw new TypeError("spawnChild is required");
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError("command is required");
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new TypeError("args must be strings");
  }
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  if (attachPrivateChannel !== undefined && typeof attachPrivateChannel !== "function") {
    throw new TypeError("private channel factory is invalid");
  }
  if (attachCredentialBroker !== undefined && typeof attachCredentialBroker !== "function") {
    throw new TypeError("credential broker factory is invalid");
  }
  if (attachLinuxSecretServiceBroker !== undefined
      && typeof attachLinuxSecretServiceBroker !== "function") {
    throw new TypeError("Linux Secret Service broker factory is invalid");
  }
  if (attachWindowsAccountObservationBroker !== undefined
      && typeof attachWindowsAccountObservationBroker !== "function") {
    throw new TypeError("Windows account-observation broker factory is invalid");
  }
  if (attachLinuxAccountObservationBroker !== undefined
      && typeof attachLinuxAccountObservationBroker !== "function") {
    throw new TypeError("Linux account-observation broker factory is invalid");
  }
  if ([attachCredentialBroker, attachLinuxSecretServiceBroker,
    attachWindowsAccountObservationBroker, attachLinuxAccountObservationBroker]
    .filter((factory) => factory !== undefined).length > 1) {
    throw new TypeError("credential broker factories are mutually exclusive");
  }
  assertTimeout(startupTimeoutMs, "startupTimeoutMs");
  assertTimeout(shutdownTimeoutMs, "shutdownTimeoutMs");
  if (!Number.isSafeInteger(parentPid) || parentPid < 2) {
    throw new TypeError("parentPid is invalid");
  }
  if (onUnexpectedExit !== undefined && typeof onUnexpectedExit !== "function") {
    throw new TypeError("onUnexpectedExit must be a function");
  }

  let state = "stopped";
  let child = null;
  let ready = null;
  let startPromise = null;
  let stopPromise = null;
  let generation = 0;
  let unexpectedExitHandler = onUnexpectedExit;
  let privateChannel = null;
  let credentialBroker = null;
  const selectedCredentialBroker = attachCredentialBroker ?? attachLinuxSecretServiceBroker;
  const selectedAccountObservationBroker = attachWindowsAccountObservationBroker
    ?? attachLinuxAccountObservationBroker;
  const requiresNodeIpc = attachPrivateChannel !== undefined
    || selectedAccountObservationBroker !== undefined;
  const credentialBrokerKind = attachCredentialBroker !== undefined ? "macos_keychain"
    : attachLinuxSecretServiceBroker !== undefined ? "linux_secret_service"
      : attachWindowsAccountObservationBroker !== undefined ? "windows_account_observation"
        : attachLinuxAccountObservationBroker !== undefined ? "linux_account_observation" : null;

  function stateSnapshot() {
    return Object.freeze({
      state,
      hasChild: child !== null,
      origin: ready?.origin ?? null,
    });
  }

  function start() {
    if (state === "ready") return Promise.resolve(ready);
    if (state === "starting" && startPromise !== null) return startPromise;
    if (state === "stopping") return Promise.reject(shellError("companion_busy"));

    const currentGeneration = ++generation;
    state = "starting";
    startPromise = new Promise((resolveStart, rejectStart) => {
      let settled = false;
      let startupTimer = null;
      let currentChild = null;
      let currentPrivateChannel = null;
      let currentCredentialBroker = null;
      let parser;

      const cleanupStartup = () => {
        if (startupTimer !== null) clearTimer(startupTimer);
        startupTimer = null;
        currentChild?.stdout?.off?.("data", onStdout);
      };

      const terminateStartupChild = (target, done, { alreadyExited = false } = {}) => {
        if (alreadyExited || !target || typeof target.once !== "function") {
          done();
          return;
        }
        let finished = false;
        let timer = null;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (timer !== null) clearTimer(timer);
          target.removeListener?.("exit", finish);
          done();
        };
        target.once("exit", finish);
        killChild(target, "SIGKILL");
        timer = setTimer(finish, shutdownTimeoutMs);
        timer?.unref?.();
      };

      const fail = (error, { childAlreadyExited = false } = {}) => {
        if (settled) return;
        settled = true;
        cleanupStartup();
        disposeCredentialBroker(currentCredentialBroker);
        if (credentialBroker === currentCredentialBroker) credentialBroker = null;
        if (currentGeneration === generation) {
          state = "stopped";
          child = null;
          ready = null;
        }
        terminateStartupChild(
          currentChild,
          () => rejectStart(error),
          { alreadyExited: childAlreadyExited },
        );
      };

      const succeed = (value) => {
        if (settled) return;
        settled = true;
        cleanupStartup();
        // The ready line is the only stdout contract. Keep draining any later
        // child output so a full pipe cannot stall the companion, but never
        // forward or retain that output in the desktop process.
        discardStream(currentChild?.stdout);
        if (currentGeneration !== generation) {
          killChild(currentChild, "SIGKILL");
          rejectStart(shellError("companion_busy"));
          return;
        }
        state = "ready";
        child = currentChild;
        ready = value;
        resolveStart(value);
      };

      const onStdout = (chunk) => {
        try {
          parser.feed(chunk);
        } catch {
          fail(shellError("companion_ready_invalid"));
        }
      };

      const onError = () => {
        fail(shellError("companion_spawn_failed"));
      };

      const onExit = () => {
        disposeCredentialBroker(currentCredentialBroker);
        if (credentialBroker === currentCredentialBroker) credentialBroker = null;
        currentPrivateChannel?.dispose();
        if (privateChannel === currentPrivateChannel) privateChannel = null;
        if (!settled) {
          fail(shellError("companion_exit_before_ready"), { childAlreadyExited: true });
          return;
        }
        currentChild?.off?.("error", onError);
        if (currentGeneration !== generation || child !== currentChild) return;
        child = null;
        ready = null;
        state = "stopped";
        try {
          unexpectedExitHandler?.(Object.freeze({ kind: "companion_exit" }));
        } catch {
          // The lifecycle observer cannot change the supervisor state.
        }
      };

      parser = createCompanionReadyLineParser({
        onReady: (value) => succeed(value),
      });
      try {
        currentChild = spawnChild(command, [...args], {
          cwd,
          env: companionEnvironment(environment, parentPid, credentialBrokerKind),
          // Windows observation and FD3 accountless share the one inherited
          // Node IPC channel, with distinct closed schemas. macOS/Linux keep
          // their existing FD4 pipe contracts unchanged.
          stdio: selectedCredentialBroker
            ? ["ignore", "pipe", "pipe", attachPrivateChannel ? "ipc" : "ignore", "pipe"]
            : (attachPrivateChannel || selectedAccountObservationBroker)
              ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        fail(shellError("companion_spawn_failed"));
        return;
      }
      if (!currentChild || typeof currentChild.once !== "function") {
        fail(shellError("companion_spawn_failed"));
        return;
      }
      const childAlreadyExited = Number.isSafeInteger(currentChild.exitCode)
        || typeof currentChild.signalCode === "string";
      if (childAlreadyExited || (requiresNodeIpc && currentChild.connected === false)) {
        fail(shellError("companion_exit_before_ready"), { childAlreadyExited });
        return;
      }
      try {
        if (selectedCredentialBroker) {
          currentCredentialBroker = selectedCredentialBroker(currentChild.stdio?.[4]);
          if (typeof currentCredentialBroker?.dispose !== "function") {
            throw new TypeError("credential broker is invalid");
          }
          credentialBroker = currentCredentialBroker;
        }
        if (selectedAccountObservationBroker) {
          currentCredentialBroker = selectedAccountObservationBroker(currentChild);
          if (typeof currentCredentialBroker?.dispose !== "function") {
            throw new TypeError("credential broker is invalid");
          }
          credentialBroker = currentCredentialBroker;
        }
        if (attachPrivateChannel) {
          currentPrivateChannel = attachPrivateChannel(currentChild);
          privateChannel = currentPrivateChannel;
        }
      } catch { fail(shellError("companion_spawn_failed")); return; }
      discardStream(currentChild.stderr);
      if (!currentChild.stdout || typeof currentChild.stdout.on !== "function") {
        fail(shellError("companion_spawn_failed"));
        return;
      }
      currentChild.stdout.on("data", onStdout);
      currentChild.once("exit", onExit);
      currentChild.on?.("error", onError);
      startupTimer = setTimer(() => {
        fail(shellError("companion_start_timeout"));
      }, startupTimeoutMs);
      startupTimer?.unref?.();
    });
    startPromise.catch(() => {});
    return startPromise;
  }

  function stop() {
    if (stopPromise !== null) return stopPromise;
    if (child === null) {
      if (state === "starting") return Promise.reject(shellError("companion_busy"));
      state = "stopped";
      ready = null;
      return Promise.resolve();
    }

    const currentChild = child;
    const currentGeneration = generation;
    state = "stopping";
    disposeCredentialBroker(credentialBroker);
    credentialBroker = null;
    privateChannel?.invalidate();
    ++generation;
    stopPromise = new Promise((resolveStop, rejectStop) => {
      let finished = false;
      let timer = null;
      const finish = (error = null) => {
        if (finished) return;
        finished = true;
        if (timer !== null) clearTimer(timer);
        currentChild.removeListener?.("exit", onStopExit);
        child = null;
        ready = null;
        state = "stopped";
        if (error === null) resolveStop();
        else rejectStop(error);
      };
      const onStopExit = () => finish();
      currentChild.once?.("exit", onStopExit);
      killChild(currentChild, "SIGTERM");
      timer = setTimer(() => {
        killChild(currentChild, "SIGKILL");
        finish(shellError("companion_shutdown_timeout"));
      }, shutdownTimeoutMs);
      timer?.unref?.();
      // Keep the generation referenced to make the intent explicit: a late
      // event from the old child cannot affect a later start.
      void currentGeneration;
    }).finally(() => {
      stopPromise = null;
    });
    stopPromise.catch(() => {});
    return stopPromise;
  }

  return Object.freeze({
    start,
    stop,
    invalidatePrivateChannel() { return privateChannel?.invalidate(); },
    setUnexpectedExitHandler(handler) {
      if (handler !== undefined && typeof handler !== "function") {
        throw new TypeError("handler must be a function");
      }
      unexpectedExitHandler = handler;
    },
    get state() {
      return stateSnapshot();
    },
  });
}
