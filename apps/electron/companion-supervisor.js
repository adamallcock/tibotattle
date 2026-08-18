import { spawn as nodeSpawn } from "node:child_process";

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

function companionEnvironment(environment, parentPid) {
  const selected = {};
  for (const key of COMPANION_ENVIRONMENT_KEYS) {
    if (Object.hasOwn(environment, key) && typeof environment[key] === "string") {
      selected[key] = environment[key];
    }
  }
  // The child is a Node companion launched by Electron, never another GUI.
  selected.ELECTRON_RUN_AS_NODE = "1";
  selected.USAGE_MONITOR_PORT = "0";
  selected.USAGE_MONITOR_PARENT_PID = String(parentPid);
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
      let parser;

      const cleanupStartup = () => {
        if (startupTimer !== null) clearTimer(startupTimer);
        startupTimer = null;
        currentChild?.stdout?.off?.("data", onStdout);
      };

      const terminateStartupChild = (target, done) => {
        if (!target || typeof target.once !== "function") {
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

      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanupStartup();
        if (currentGeneration === generation) {
          state = "stopped";
          child = null;
          ready = null;
        }
        terminateStartupChild(currentChild, () => rejectStart(error));
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
        if (!settled) {
          fail(shellError("companion_exit_before_ready"));
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
          env: companionEnvironment(environment, parentPid),
          stdio: ["ignore", "pipe", "pipe"],
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
