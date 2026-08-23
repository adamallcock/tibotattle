import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertContainerContract,
  classifyAutomaticStartupRefreshReceipt,
  ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES,
  fixedRuntimeFailureDiagnostics,
  isAllowedRendererNetworkURL,
  observeLocalRefreshRequests,
  waitFor,
} from "../scripts/smoke-electron-linux.mjs";

class FakeCdp {
  constructor() {
    this.listeners = new Map();
  }

  on(eventName, listener) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return () => listeners.delete(listener);
  }

  emit(eventName, payload) {
    for (const listener of this.listeners.get(eventName) ?? []) listener(payload);
  }
}

function emitRefresh(cdp, {
  origin,
  requestId,
  loaderId,
}) {
  cdp.emit("Network.requestWillBeSent", {
    request: {
      method: "POST",
      url: `${origin}/api/local/refresh`,
    },
    requestId,
    loaderId,
  });
}

test("Linux Electron smoke keeps the desktop boundary explicit", async () => {
  const source = await readFile("scripts/smoke-electron-linux.mjs", "utf8");
  const entry = await readFile("apps/electron/main.js", "utf8");
  const gate = await readFile("apps/electron/platform-gate.js", "utf8");
  const dockerfile = await readFile("containers/electron-linux/Dockerfile", "utf8");
  const dockerignore = await readFile("containers/electron-linux/Dockerfile.dockerignore", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(source, /USAGE_MONITOR_STATE_ROOT/u);
  assert.match(source, /USAGE_MONITOR_ELECTRON_SMOKE_CONTROL/u);
  assert.match(source, /USAGE_MONITOR_LINUX_IMAGE_PLATFORM/u);
  assert.match(source, /USAGE_MONITOR_LINUX_NETWORK_BOUNDARY/u);
  assert.match(source, /network-none/u);
  assert.match(source, /development-only/u);
  assert.match(source, /localDashboardReady/u);
  assert.match(source, /MAX_REFRESH_MS/u);
  assert.match(source, /Page\.enable/u);
  assert.match(source, /Page\.getFrameTree/u);
  assert.match(source, /Network\.enable/u);
  assert.match(source, /observeLocalRefreshRequests/u);
  assert.match(source, /refreshObserver\.selectOrigin/u);
  assert.match(source, /assertAutomaticStartupRefresh/u);
  assert.match(source, /refreshObserver\.selectLoader/u);
  assert.match(source, /refreshObserver\.seal/u);
  assert.match(source, /automatic startup refresh acceptance/u);
  assert.match(source, /automatic startup refresh completion/u);
  assert.match(source, /previousRefreshId/u);
  assert.match(source, /refreshObserver\.reset\(\)/u);
  assert.match(
    source,
    /selectRequiredRefreshLoader\(refreshObserver, await waitFor\(\s+\(\) => mainFrameLoaderId\(cdp\)/u,
    "initial loader acquisition must poll through a null result",
  );
  assert.doesNotMatch(source, /waitFor\(\s+\(\) => readRequiredRefreshLoader\(cdp\)/u);
  assert.match(source, /Browser\.setWindowBounds/u);
  assert.match(source, /SIGUSR2/u);
  assert.match(source, /descendantsOf/u);
  assert.match(entry, /USAGE_MONITOR_ELECTRON_SMOKE_CONTROL/u);
  assert.match(entry, /lifecycle\.requestQuit\(\)/u);
  assert.match(entry, /process\.platform !== "win32"/u);
  assert.match(gate, /platform !== "win32"/u);
  assert.match(gate, /windowsProductionReady: false/u);
  assert.doesNotMatch(source, /windowsProductionReady\s*:\s*true/u);
  assert.match(dockerfile, /node:26\.2\.0-bookworm-slim@sha256:/u);
  assert.doesNotMatch(dockerfile, /TARGETPLATFORM/u);
  assert.match(
    dockerfile,
    /FROM node:26\.2\.0-bookworm-slim@sha256:445b8cda0ec3563106c5a62b4663b3831314ecc81d2645a774b308f203f25cf0/u,
  );
  assert.match(dockerfile, /COPY --chown=node:node patches \.\/patches/u);
  assert.match(dockerfile, /pnpm install --frozen-lockfile/u);
  assert.match(dockerfile, /xvfb-run/u);
  assert.match(dockerfile, /-nolisten tcp/u);
  assert.match(dockerfile, /ELECTRON_DISABLE_SANDBOX=0/u);
  assert.match(dockerfile, /USER node/u);
  assert.match(dockerignore, /!patches\/\*\*/u);
  const readyWait = source.indexOf("const ready = await waitFor");
  const automaticRefresh = source.indexOf("await assertAutomaticStartupRefresh({");
  assert.ok(
    readyWait >= 0 && automaticRefresh > readyWait,
    "the startup refresh check is ordered after the readiness wait",
  );
  const reload = source.indexOf('await cdp.request("Page.reload"');
  const freshDocument = source.indexOf('"dashboard fresh-document render"');
  assert.ok(
    reload >= 0 && freshDocument > reload,
    "the Linux lane proves a fresh document before the reload refresh check",
  );
  assert.match(packageJson.scripts["container:electron-linux:build"], /--platform=linux\/arm64/u);
  assert.doesNotMatch(packageJson.scripts["container:electron-linux:build"], /--build-arg/u);
  assert.match(packageJson.scripts["container:electron-linux:test"], /--platform=linux\/arm64/u);
  assert.match(packageJson.scripts["container:electron-linux:test"], /--cap-add=SYS_ADMIN/u);
  assert.match(packageJson.scripts["container:electron-linux:test"], /--network none/u);
  assert.equal(Object.hasOwn(packageJson.scripts, "container:electron-linux:build:amd64"), false);
  assert.equal(Object.hasOwn(packageJson.scripts, "container:electron-linux:test:amd64"), false);
});

test("Linux startup refresh evidence requires the validated origin and active loader", () => {
  const cdp = new FakeCdp();
  const observer = observeLocalRefreshRequests(cdp);
  const dashboardOrigin = "http://127.0.0.1:43123";
  const otherLoopbackOrigin = "http://127.0.0.1:43124";

  observer.selectLoader("loader-current");
  emitRefresh(cdp, {
    origin: dashboardOrigin,
    requestId: "current-valid",
    loaderId: "loader-current",
  });
  emitRefresh(cdp, {
    origin: otherLoopbackOrigin,
    requestId: "current-wrong-origin",
    loaderId: "loader-current",
  });
  // Before the renderer location is validated, no request is acceptable
  // evidence, even though both requests use loopback.
  assert.deepEqual(observer.snapshot(), []);

  assert.equal(observer.selectOrigin(dashboardOrigin), dashboardOrigin);
  assert.deepEqual(observer.snapshot(), [{
    requestId: "current-valid",
    loaderId: "loader-current",
    origin: dashboardOrigin,
  }]);
  emitRefresh(cdp, {
    origin: dashboardOrigin,
    requestId: "different-loader",
    loaderId: "loader-old",
  });
  emitRefresh(cdp, {
    origin: otherLoopbackOrigin,
    requestId: "later-wrong-origin",
    loaderId: "loader-current",
  });
  assert.equal(observer.snapshot().length, 1);

  observer.reset();
  observer.selectLoader("loader-fresh");
  emitRefresh(cdp, {
    origin: dashboardOrigin,
    requestId: "fresh-valid",
    loaderId: "loader-fresh",
  });
  assert.equal(observer.snapshot().length, 1);
  observer.seal();
  emitRefresh(cdp, {
    origin: dashboardOrigin,
    requestId: "sealed-request",
    loaderId: "loader-fresh",
  });
  assert.equal(observer.snapshot().length, 1);
  observer.reset();
  assert.equal(observer.selectLoader(null), null);
  emitRefresh(cdp, {
    origin: dashboardOrigin,
    requestId: "foreign-loader-after-invalid-selection",
    loaderId: "loader-foreign",
  });
  assert.deepEqual(observer.snapshot(), []);
  observer.dispose();
});

test("Linux startup refresh receipt semantics are stateful and content-free", () => {
  const codes = ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES;
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: { status: "succeeded", refreshId: "refresh-new" },
      expectedRefreshId: "refresh-new",
    }),
    { status: "completed", refreshId: "refresh-new" },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: 1,
      refresh: { status: "succeeded", refreshId: "refresh-old" },
      previousRefreshId: "refresh-old",
    }),
    { status: "pending" },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: 2,
      refresh: { status: "running", refreshId: "refresh-new" },
    }),
    { status: "failed", errorCode: codes.duplicate },
  );
  for (const [status, errorCode] of [
    ["failed", codes.failed],
    ["cancelled", codes.cancelled],
  ]) {
    assert.deepEqual(
      classifyAutomaticStartupRefreshReceipt({
        phase: "completion",
        requestCount: 1,
        refresh: { status, refreshId: "refresh-new" },
        expectedRefreshId: "refresh-new",
      }),
      { status: "failed", errorCode },
    );
  }
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: { status: "succeeded", refreshId: "refresh-other" },
      expectedRefreshId: "refresh-new",
    }),
    { status: "failed", errorCode: codes.changedReceipt },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: 1,
      refresh: { status: "running" },
      previousRefreshId: "refresh-old",
    }),
    { status: "failed", errorCode: codes.invalidReceipt },
  );
});

test("Linux initial dashboard loader waits through a transient null", async () => {
  let loaderReads = 0;
  const initialLoader = await waitFor(() => {
    loaderReads += 1;
    return loaderReads === 1 ? null : "loader-initial";
  }, 5_000, "initial dashboard loader");
  assert.equal(initialLoader, "loader-initial");
  assert.equal(loaderReads, 2);
});

test("Linux Electron smoke refuses an unbounded host checkout", () => {
  const environment = { ...process.env };
  delete environment.USAGE_MONITOR_LINUX_IMAGE_PLATFORM;
  delete environment.USAGE_MONITOR_LINUX_NETWORK_BOUNDARY;
  const result = spawnSync(
    process.execPath,
    ["scripts/smoke-electron-linux.mjs"],
    { encoding: "utf8", env: environment },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "ELECTRON_LINUX_SMOKE_FAILED\n");
  assert.doesNotMatch(result.stderr, /(?:file:|workspace|rollout-linux-smoke)/iu);
});

test("Linux Electron smoke proves the network boundary from runtime interfaces", () => {
  const common = {
    platform: "linux",
    architecture: "arm64",
    imagePlatform: "linux/arm64",
    networkBoundary: "network-none",
  };
  assert.deepEqual(assertContainerContract({
    ...common,
    networkInterfacesImpl: () => ({
      lo: [{ address: "127.0.0.1", internal: true }],
      loopback6: [{ address: "::1", internal: true }],
    }),
  }), {
    imagePlatform: "linux/arm64",
    architecture: "arm64",
    networkBoundary: "network-none",
    networkBoundaryEvidence: "loopback-only",
  });
  assert.throws(() => assertContainerContract({
    ...common,
    networkInterfacesImpl: () => ({
      lo: [{ address: "127.0.0.1", internal: true }],
      eth0: [{ address: "172.18.0.2", internal: false }],
    }),
  }), /loopback-only network interfaces/u);
  assert.throws(() => assertContainerContract({
    ...common,
    platform: "darwin",
    networkInterfacesImpl: () => ({ lo: [{ address: "127.0.0.1" }] }),
  }), /must run in a Linux container/u);
  assert.throws(() => assertContainerContract({
    ...common,
    networkInterfacesImpl: () => ({}),
  }), /could not prove a loopback-only network boundary/u);
  assert.throws(() => assertContainerContract({
    ...common,
    imagePlatform: "linux/amd64",
    networkInterfacesImpl: () => ({ lo: [{ address: "127.0.0.1" }] }),
  }), /does not match the running architecture/u);
  assert.throws(() => assertContainerContract({
    ...common,
    networkBoundary: "bridge",
    networkInterfacesImpl: () => ({ lo: [{ address: "127.0.0.1" }] }),
  }), /requires the caller-enforced network-none/u);
  assert.throws(() => assertContainerContract({
    ...common,
    networkInterfacesImpl: () => { throw new Error("private sentinel"); },
  }), /could not inspect network interfaces/u);
  assert.throws(() => assertContainerContract({
    ...common,
    networkInterfacesImpl: () => ({ lo: null }),
  }), /network interface data is invalid/u);
});

test("Linux Electron smoke diagnostics and renderer network evidence stay closed", () => {
  const diagnostics = fixedRuntimeFailureDiagnostics({
    stdoutProduced: true,
    stderrProduced: true,
    stdout: "private stdout sentinel",
    stderr: "private stderr sentinel",
  });
  assert.deepEqual(diagnostics, [
    "Electron runtime stdout was produced.\n",
    "Electron runtime stderr was produced.\n",
  ]);
  assert.doesNotMatch(diagnostics.join(""), /private|sentinel/u);

  const origin = "http://127.0.0.1:43123";
  assert.equal(isAllowedRendererNetworkURL(`${origin}/api/local/health`, origin), true);
  assert.equal(isAllowedRendererNetworkURL("https://example.invalid/", origin), false);
  assert.equal(isAllowedRendererNetworkURL("ws://127.0.0.1:43123/socket", origin), false);
  assert.equal(isAllowedRendererNetworkURL("wss://example.invalid/socket", origin), false);
  assert.equal(isAllowedRendererNetworkURL("not a URL", origin), false);
});
