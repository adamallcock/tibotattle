#!/usr/bin/env node

/**
 * Run the shared Electron shell against a disposable synthetic home.
 *
 * This is intentionally a source-checkout smoke, not a Linux release claim:
 * the container supplies Electron's Linux runtime and Xvfb, while Windows
 * native bindings, credentials, signing, and installers remain out of scope.
 * The caller must provide the network boundary (`docker run --network none`).
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ELECTRON_MAIN = resolve(REPOSITORY_ROOT, "apps/electron/main.js");
const MAX_STARTUP_MS = 30_000;
const MAX_OPERATION_MS = 10_000;
const MAX_SHUTDOWN_MS = 10_000;

function fail(message) {
  throw new Error(`Electron Linux smoke failed: ${message}`);
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function freeTcpPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = address?.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  if (!Number.isInteger(port) || port < 1) fail("could not reserve a debugging port");
  return port;
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`${label} timed out${lastError ? ` (${lastError.message})` : ""}`);
}

async function createSyntheticHome() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-linux-"));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const claudeHome = join(home, ".claude");
  const stateRoot = join(root, "state");
  const runtimeDirectory = join(root, "runtime");
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true, mode: 0o700 });
  await mkdir(claudeHome, { recursive: true, mode: 0o700 });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  // The companion only needs a readable synthetic source to render its local
  // evidence view. Keep the fixture content intentionally non-user-like.
  await writeFile(
    join(codexHome, "sessions", "rollout-linux-smoke.jsonl"),
    `${JSON.stringify({ type: "session_meta", id: "linux-smoke" })}\n`,
    { mode: 0o600 },
  );
  return Object.freeze({ root, home, codexHome, claudeHome, stateRoot, runtimeDirectory });
}

function electronBinary() {
  const selected = process.env.ELECTRON_BINARY ?? require("electron");
  if (typeof selected !== "string" || selected.length === 0) {
    fail("Electron binary path is unavailable");
  }
  return selected;
}

function descendantsOf(parentPid) {
  const result = [];
  const rows = String(require("node:child_process").execFileSync(
    "ps",
    ["-eo", "pid=,ppid="],
    { encoding: "utf8" },
  ));
  const children = new Map();
  for (const line of rows.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const pending = [...(children.get(parentPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    result.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return result;
}

async function jsonFetch(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function connectCdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await withTimeout(new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP websocket error")), { once: true });
  }), MAX_OPERATION_MS, "CDP connection");

  let nextId = 1;
  const pending = new Map();
  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!Number.isInteger(message.id)) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message ?? "CDP request failed"));
    else request.resolve(message.result ?? {});
  };
  socket.addEventListener("message", onMessage);
  const request = (method, params = {}) => {
    const id = nextId++;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return withTimeout(promise, MAX_OPERATION_MS, `CDP ${method}`);
  };
  const evaluate = async (expression) => {
    const response = await request("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error("renderer evaluation failed");
    return response.result?.value;
  };
  return Object.freeze({
    request,
    evaluate,
    close() {
      socket.close();
      for (const { reject } of pending.values()) reject(new Error("CDP connection closed"));
      pending.clear();
    },
  });
}

async function runSmoke() {
  const fixture = await createSyntheticHome();
  const port = await freeTcpPort();
  const binary = electronBinary();
  const environment = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    HOME: fixture.home,
    TMPDIR: fixture.root,
    XDG_CONFIG_HOME: join(fixture.home, ".config"),
    XDG_CACHE_HOME: join(fixture.home, ".cache"),
    XDG_DATA_HOME: join(fixture.home, ".local", "share"),
    XDG_RUNTIME_DIR: fixture.runtimeDirectory,
    USAGE_MONITOR_RESOURCE_ROOT: REPOSITORY_ROOT,
    USAGE_MONITOR_STATE_ROOT: fixture.stateRoot,
    CODEX_HOME: fixture.codexHome,
    CLAUDE_CONFIG_DIR: fixture.claudeHome,
    USAGE_MONITOR_PORT: "0",
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
    // This opt-in main-process control invokes desktop-lifecycle.requestQuit()
    // without adding a renderer or preload privilege.
    USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "quit-v1",
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
  };
  const child = spawn(binary, [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--disable-gpu",
    ELECTRON_MAIN,
  ], {
    cwd: REPOSITORY_ROOT,
    env: Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  let cdp = null;
  let forcedShutdown = false;
  try {
    if (!child.pid) fail("Electron did not provide a process id");
    const version = await waitFor(
      () => jsonFetch(`http://127.0.0.1:${port}/json/version`),
      MAX_STARTUP_MS,
      "Electron remote debugging endpoint",
    ).catch((error) => {
      // Electron's own stderr contains only bounded runtime diagnostics here;
      // the companion's output is intentionally discarded by its supervisor.
      process.stderr.write(
        `Electron endpoint diagnostics (port ${port}, pid ${child.pid}, `
        + `exit ${child.exitCode ?? "running"}): ${error.message}\n`,
      );
      if (stderr.length > 0) process.stderr.write(`${stderr.slice(-4_000)}\n`);
      throw error;
    });
    const target = await waitFor(async () => {
      const targets = await jsonFetch(`http://127.0.0.1:${port}/json`);
      return targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    }, MAX_STARTUP_MS, "Electron dashboard target");
    cdp = await connectCdp(target);
    const ready = await waitFor(
      async () => {
        const snapshot = await cdp.evaluate(`(() => ({
          ready: document.documentElement?.dataset?.localDashboardReady === "true",
          title: document.title,
          heading: document.querySelector("#overview-title")?.textContent?.trim() ?? "",
          location: location.href,
          resources: performance.getEntriesByType("resource").map((entry) => entry.name),
        }))()`);
        return snapshot.ready && snapshot.title === "TiboTattle" && snapshot.heading
          ? snapshot
          : null;
      },
      MAX_STARTUP_MS,
      "dashboard renderer readiness",
    );
    const dashboardUrl = new URL(ready.location);
    if (dashboardUrl.protocol !== "http:" || dashboardUrl.hostname !== "127.0.0.1") {
      fail("dashboard did not load from the companion loopback origin");
    }
    const health = await jsonFetch(new URL("/api/local/health", dashboardUrl));
    if (health.status !== "ready") fail("companion health was not ready");
    const remoteResources = ready.resources.filter((resource) => {
      try {
        const parsed = new URL(resource);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    });
    if (remoteResources.some((resource) => new URL(resource).origin !== dashboardUrl.origin)) {
      fail("renderer requested a non-loopback resource");
    }

    const descendantsAtReady = descendantsOf(child.pid);
    if (descendantsAtReady.length < 1) fail("Electron had no companion descendant after readiness");

    await cdp.request("Page.reload", { ignoreCache: false });
    await waitFor(
      () => cdp.evaluate("document.documentElement?.dataset?.localDashboardReady === 'true'"),
      MAX_STARTUP_MS,
      "dashboard reload readiness",
    );

    // CDP window bounds are the most deterministic lifecycle control available
    // in a headless desktop lane. A real desktop can additionally exercise the
    // tray's hide/show actions; this lane proves that minimizing/restoring does
    // not lose the renderer or companion.
    let windowMinimizedAndRestored = false;
    try {
      const windowInfo = await cdp.request("Browser.getWindowForTarget");
      if (Number.isInteger(windowInfo.windowId)) {
        await cdp.request("Browser.setWindowBounds", {
          windowId: windowInfo.windowId,
          bounds: { windowState: "minimized" },
        });
        await wait(150);
        await cdp.request("Browser.setWindowBounds", {
          windowId: windowInfo.windowId,
          bounds: { windowState: "normal" },
        });
        await waitFor(
          () => cdp.evaluate("document.documentElement?.dataset?.localDashboardReady === 'true'"),
          MAX_OPERATION_MS,
          "dashboard restore readiness",
        );
        windowMinimizedAndRestored = true;
      }
    } catch (error) {
      // Electron 43's page-scoped CDP endpoint does not expose the browser
      // window-bounds methods. Renderer reload and process/companion cleanup
      // remain mandatory; a desktop runner can add tray/window controls later.
      if (!/wasn't found|method not found/iu.test(error?.message ?? "")) throw error;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      fail("Electron exited before the clean-quit control was sent");
    }
    if (!child.kill("SIGUSR2")) {
      fail("Electron clean-quit control could not be sent");
    }
    await withTimeout(once(child, "exit"), MAX_SHUTDOWN_MS, "Electron clean quit");
    await waitFor(() => descendantsOf(child.pid).length === 0, MAX_SHUTDOWN_MS, "companion cleanup");
    if (child.signalCode !== null || child.exitCode !== 0) {
      fail(child.signalCode === null
        ? `Electron exited with code ${child.exitCode}`
        : `Electron exited via ${child.signalCode}`);
    }
    process.stdout.write(`${JSON.stringify({
      status: "passed",
      electron: version.Browser,
      dashboardOrigin: dashboardUrl.origin,
      descendantCountAtReady: descendantsAtReady.length,
      rendererReloaded: true,
      windowMinimizedAndRestored,
      cleanQuit: true,
      networkBoundary: "caller-enforced-network-none",
    }, null, 2)}\n`);
  } catch (error) {
    forcedShutdown = true;
    throw error;
  } finally {
    cdp?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(forcedShutdown ? "SIGKILL" : "SIGTERM");
      await Promise.race([once(child, "exit"), wait(2_000)]);
    }
    await rm(fixture.root, { recursive: true, force: true });
    if (forcedShutdown) {
      // Keep diagnostics bounded and content-free; the app itself owns all
      // local state under the deleted fixture root.
      if (stdout.length > 0) process.stderr.write("Electron stdout was produced before failure.\n");
      if (stderr.length > 0) process.stderr.write("Electron stderr was produced before failure.\n");
    }
  }
}

await runSmoke();
