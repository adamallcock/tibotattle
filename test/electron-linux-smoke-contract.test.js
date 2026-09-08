import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import test from "node:test";
import { validateDesktopFirstRunReceipt } from "../apps/electron/desktop-first-run.js";
import {
  assertContainerContract,
  classifyAutomaticStartupRefreshReceipt,
  createLinuxCompanionProcessDiagnostics,
  createRendererReadinessCompanionSnapshotObserver,
  combineStartupRefreshEvidence,
  createRendererReadinessDiagnostics,
  createSyntheticHome,
  ELECTRON_LINUX_SMOKE_DEGRADED_FAILURE_CODES,
  ELECTRON_LINUX_SMOKE_FAILURE_STAGES,
  ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES,
  fixedRuntimeFailureDiagnostics,
  isAllowedRendererNetworkURL,
  isLinuxDashboardTarget,
  isLinuxInspectablePageTarget,
  observeLocalRefreshRequests,
  probeRendererReadinessPrimaryApis,
  reserveLinuxInspectablePageTargets,
  runSmoke,
  selectLinuxDashboardTarget,
  validateRendererReadinessDiagnostics,
  validateLinuxCompanionProcessDiagnostics,
  waitFor,
} from "../scripts/smoke-electron-linux.mjs";

test("Linux companion process diagnostics preserve the first unexpected exit across restarts", () => {
  const collector = createLinuxCompanionProcessDiagnostics();
  const started = { event: "started", phase: "starting", outcome: null };
  const crashed = { event: "exited", phase: "ready", outcome: "signal_abrt" };
  const stopped = { event: "exited", phase: "stopping", outcome: "signal_term" };
  const marker = (event) => `TIBOTATTLE_ELECTRON_COMPANION_PROCESS ${JSON.stringify(event)}\n`;
  assert.deepEqual(collector.snapshot(), { lastEvent: null, firstUnexpectedExit: null });
  const input = marker(started) + marker(crashed) + marker(started) + marker(stopped);
  for (let offset = 0; offset < input.length; offset += 7) collector.feed(Buffer.from(input.slice(offset, offset + 7)));
  assert.deepEqual(collector.snapshot(), { lastEvent: stopped, firstUnexpectedExit: crashed });
});

test("Linux companion process diagnostics discard private, malformed and oversized lines", () => {
  const collector = createLinuxCompanionProcessDiagnostics();
  const marker = (event) => `TIBOTATTLE_ELECTRON_COMPANION_PROCESS ${JSON.stringify(event)}\n`;
  collector.feed("private/path with private-token\nTIBOTATTLE_ELECTRON_COMPANION_PROCESS {bad}\n");
  collector.feed(marker({ event: "exited", phase: "ready", outcome: "private-native-text" }));
  collector.feed(marker({ event: "started", phase: "ready", outcome: null }));
  collector.feed(marker({ event: "exited", phase: "ready", outcome: "exit_nonzero", path: "/private/path" }));
  collector.feed("TIBOTATTLE_ELECTRON_COMPANION_PROCESS " + " ".repeat(600));
  collector.feed(marker({ event: "exited", phase: "ready", outcome: "signal_segv" }));
  assert.deepEqual(collector.snapshot(), { lastEvent: null, firstUnexpectedExit: null });
  const cleanExit = { event: "exited", phase: "starting", outcome: "exit_zero" };
  collector.feed(marker(cleanExit));
  assert.deepEqual(collector.snapshot(), { lastEvent: cleanExit, firstUnexpectedExit: cleanExit });
  assert.equal(JSON.stringify(collector.snapshot()).includes("private"), false);
});

test("Linux companion receipt validation rejects inconsistent and open-ended records", () => {
  const exited = { event: "exited", phase: "starting", outcome: "exit_nonzero" };
  const valid = { lastEvent: exited, firstUnexpectedExit: exited };
  assert.deepEqual(validateLinuxCompanionProcessDiagnostics(valid), valid);
  for (const invalid of [
    null, [], {}, { ...valid, path: "/private/path" },
    { lastEvent: null, firstUnexpectedExit: exited },
    { lastEvent: exited, firstUnexpectedExit: { ...exited, phase: "stopping" } },
    { lastEvent: exited, firstUnexpectedExit: { event: "started", phase: "starting", outcome: null } },
    { lastEvent: { ...exited, private: "value" }, firstUnexpectedExit: null },
  ]) assert.equal(validateLinuxCompanionProcessDiagnostics(invalid), null);
});

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

test("Linux renderer readiness diagnostics retain only allowlisted module and primary API states", () => {
  const cdp = new FakeCdp();
  cdp.evaluate = async () => ({
    assets: [{ asset: "data-client.js", responseClass: "2xx", completion: "timing_recorded" }],
    primaryApis: [{ endpoint: "quality", responseClass: "5xx", completion: "timing_recorded" }],
  });
  const diagnostics = createRendererReadinessDiagnostics({ cdp });
  assert.equal(
    diagnostics.bindSelectedDashboardUrl("http://127.0.0.1:45678/"),
    "http://127.0.0.1:45678",
  );
  const request = (requestId, path) => cdp.emit("Network.requestWillBeSent", {
    requestId,
    request: { url: `http://127.0.0.1:45678/${path}` },
  });
  const response = (requestId, status, path) => cdp.emit("Network.responseReceived", {
    requestId,
    response: { status, ...(path === undefined ? {} : { url: `http://127.0.0.1:45678/${path}` }) },
  });
  request("asset-app", "app.js");
  response("asset-app", 200);
  cdp.emit("Network.loadingFinished", { requestId: "asset-app" });
  response("asset-client", 200, "data-client.js");
  request("overview", "api/local/overview");
  response("overview", 503);
  cdp.emit("Network.loadingFinished", { requestId: "overview" });
  request("gradient", "api/local/gradient");
  response("gradient", 200);
  cdp.emit("Network.loadingFinished", { requestId: "gradient" });
  request("weekly", "api/local/weekly");
  cdp.emit("Network.loadingFailed", { requestId: "weekly" });
  cdp.emit("Runtime.exceptionThrown", {
    exceptionDetails: {
      url: "",
      exception: { className: "TypeError" },
      stackTrace: { callFrames: [{
        url: "http://127.0.0.1:45678/app.js",
        lineNumber: 23,
      }] },
    },
  });
  // Unknown paths and later exceptions cannot enter the retained diagnostic.
  request("outside", "private-value.js");
  cdp.emit("Runtime.exceptionThrown", {
    exceptionDetails: {
      url: "http://127.0.0.1:45678/private-value.js",
      lineNumber: 99,
      exception: { className: "ReferenceError" },
    },
  });

  const snapshot = diagnostics.snapshot();
  assert.deepEqual(snapshot.exception, {
    observed: true, classification: "type", asset: "app.js", line: 24,
  });
  assert.deepEqual(snapshot.assets.find(({ asset }) => asset === "app.js"), {
    asset: "app.js", responseClass: "2xx", completion: "finished",
  });
  assert.deepEqual(snapshot.assets.find(({ asset }) => asset === "data-client.js"), {
    asset: "data-client.js", responseClass: "2xx", completion: "unobserved",
  });
  assert.deepEqual(snapshot.primaryApis, [
    { endpoint: "overview", responseClass: "5xx", completion: "finished" },
    { endpoint: "gradient", responseClass: "2xx", completion: "finished" },
    { endpoint: "weekly", responseClass: "unobserved", completion: "failed" },
    { endpoint: "quality", responseClass: "unobserved", completion: "unobserved" },
  ]);
  assert.deepEqual(snapshot.primaryProbe, [
    { endpoint: "overview", responseClass: "unobserved", outcome: "unobserved" },
    { endpoint: "gradient", responseClass: "unobserved", outcome: "unobserved" },
    { endpoint: "weekly", responseClass: "unobserved", outcome: "unobserved" },
    { endpoint: "quality", responseClass: "unobserved", outcome: "unobserved" },
  ]);
  assert.deepEqual(snapshot.companionSnapshot, { status: "unobserved", errorCode: null });
  assert.equal(JSON.stringify(snapshot).includes("127.0.0.1"), false);
  assert.equal(validateRendererReadinessDiagnostics({
    ...snapshot,
    exception: { ...snapshot.exception, asset: "private-value.js" },
  }), null);
  assert.equal(validateRendererReadinessDiagnostics({
    ...snapshot,
    companionSnapshot: { status: "failed", errorCode: "private-value" },
  }), null);
  assert.equal(validateRendererReadinessDiagnostics({ ...snapshot, unexpected: "value" }), null);
  diagnostics.dispose();
});

test("Linux renderer diagnostics bind a blank page target only after its selected loopback navigation", async () => {
  const cdp = new FakeCdp();
  cdp.evaluate = async (expression) => {
    assert.match(expression, /http:\/\/127\.0\.0\.1:45678/u);
    return { assets: [], primaryApis: [] };
  };
  const diagnostics = createRendererReadinessDiagnostics({ cdp });
  assert.equal(diagnostics.bindSelectedDashboardUrl("about:blank"), null);
  assert.equal(diagnostics.bindSelectedDashboardUrl("file:///tmp/recovery.html"), null);
  assert.equal(
    diagnostics.bindSelectedDashboardUrl("http://127.0.0.1:45678/"),
    "http://127.0.0.1:45678",
  );
  assert.equal(diagnostics.bindSelectedDashboardUrl("http://127.0.0.1:45679/"), null);

  cdp.emit("Network.requestWillBeSent", {
    requestId: "overview",
    request: { url: "http://127.0.0.1:45678/api/local/overview" },
  });
  cdp.emit("Network.responseReceived", {
    requestId: "overview",
    response: { status: 503 },
  });
  cdp.emit("Network.loadingFinished", { requestId: "overview" });

  let probedOrigin = null;
  const snapshot = await diagnostics.snapshotWithTimingAndProbe({
    probe: async (origin) => {
      probedOrigin = origin;
      return [
        { endpoint: "overview", responseClass: "5xx", outcome: "response" },
        { endpoint: "gradient", responseClass: "unobserved", outcome: "request_failed" },
        { endpoint: "weekly", responseClass: "unobserved", outcome: "request_failed" },
        { endpoint: "quality", responseClass: "unobserved", outcome: "request_failed" },
      ];
    },
  });
  assert.equal(probedOrigin, "http://127.0.0.1:45678");
  assert.deepEqual(snapshot.primaryApis[0], {
    endpoint: "overview", responseClass: "5xx", completion: "finished",
  });
  assert.deepEqual(snapshot.primaryProbe[0], {
    endpoint: "overview", responseClass: "5xx", outcome: "response",
  });
  diagnostics.dispose();
});

test("Linux renderer diagnostic probe shares one bounded deadline and timing evidence never claims network completion", async () => {
  const calls = [];
  const probe = await probeRendererReadinessPrimaryApis("http://127.0.0.1:45678", {
    timeoutMs: 20,
    fetchImpl: async (url, { signal }) => {
      const endpoint = new URL(url).pathname.split("/").at(-1);
      calls.push(endpoint);
      if (endpoint === "overview") return { status: 503 };
      if (endpoint === "gradient") return { status: 200 };
      if (endpoint === "weekly") throw new Error("synthetic request failure");
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true });
      });
    },
  });
  assert.deepEqual(calls.sort(), ["gradient", "overview", "quality", "weekly"]);
  assert.deepEqual(probe, [
    { endpoint: "overview", responseClass: "5xx", outcome: "response" },
    { endpoint: "gradient", responseClass: "2xx", outcome: "response" },
    { endpoint: "weekly", responseClass: "unobserved", outcome: "request_failed" },
    { endpoint: "quality", responseClass: "unobserved", outcome: "timeout" },
  ]);

  const cdp = new FakeCdp();
  cdp.evaluate = async () => ({
    assets: [{ asset: "app.js", responseClass: "2xx", completion: "timing_recorded" }],
    primaryApis: [{ endpoint: "overview", responseClass: "5xx", completion: "timing_recorded" }],
  });
  const diagnostics = createRendererReadinessDiagnostics({ cdp });
  assert.equal(
    diagnostics.bindSelectedDashboardUrl("http://127.0.0.1:45678/"),
    "http://127.0.0.1:45678",
  );
  const snapshot = await diagnostics.snapshotWithTimingAndProbe({ probe: async () => probe });
  assert.deepEqual(snapshot.assets.find(({ asset }) => asset === "app.js"), {
    asset: "app.js", responseClass: "2xx", completion: "timing_recorded",
  });
  assert.deepEqual(snapshot.primaryApis[0], {
    endpoint: "overview", responseClass: "5xx", completion: "timing_recorded",
  });
  assert.deepEqual(snapshot.primaryProbe, probe);
  diagnostics.dispose();
});

test("Linux renderer companion snapshot observer retains only closed health state and drains its active read", async () => {
  let calls = 0;
  const observer = createRendererReadinessCompanionSnapshotObserver("http://127.0.0.1:45678/", {
    pollIntervalMs: 1,
    requestTimeoutMs: 100,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        snapshot: calls === 1
          ? { status: "building", errorCode: null }
          : { status: "failed", errorCode: "collector_projection_unavailable" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await waitFor(
    () => observer.snapshot().status === "failed",
    500,
    "terminal companion snapshot observation",
  );
  assert.deepEqual(observer.snapshot(), {
    status: "failed", errorCode: "collector_projection_unavailable",
  });
  const stoppedCalls = calls;
  await new Promise((resolveWait) => setTimeout(resolveWait, 15));
  assert.equal(calls, stoppedCalls, "a terminal snapshot stops low-frequency health observation");
  await observer.stop();

  let abortObserved = false;
  let readerCancelled = false;
  let resolveRead = null;
  const reader = {
    read: () => new Promise((resolveReadResult) => { resolveRead = resolveReadResult; }),
    cancel: async () => {
      readerCancelled = true;
      resolveRead?.({ done: true, value: undefined });
    },
    releaseLock() {},
  };
  const pending = createRendererReadinessCompanionSnapshotObserver("http://127.0.0.1:45679/", {
    pollIntervalMs: 100,
    requestTimeoutMs: 100,
    fetchImpl: async (_url, { signal }) => {
      signal.addEventListener("abort", () => { abortObserved = true; }, { once: true });
      return {
        status: 200,
        redirected: false,
        headers: { get: () => null },
        body: {
          getReader: () => reader,
          cancel: async () => {},
        },
      };
    },
  });
  await waitFor(() => resolveRead !== null, 500, "active companion health read");
  await pending.stop();
  assert.equal(abortObserved, true);
  assert.equal(readerCancelled, true);
  assert.deepEqual(pending.snapshot(), { status: "unobserved", errorCode: null });
});

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
  assert.match(source, /validateDesktopFirstRunReceipt/u);
  assert.match(source, /DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME/u);
  assert.match(source, /--user-data-dir=/u);
  assert.match(source, /selectLinuxDashboardTarget/u);
  assert.match(source, /selectLinuxDashboardTarget\(targets, port\)/u);
  assert.match(source, /reserveLinuxInspectablePageTargets/u);
  assert.match(source, /attemptedPageTargetIds/u);
  assert.match(source, /Promise\.all\(inspectablePages\.map/u);
  assert.match(source, /attachedPages\.get\(target\.id\)/u);
  assert.match(
    source,
    /rendererReadinessDiagnostics\.bindSelectedDashboardUrl\(selectedDashboardUrl\.href\)/u,
  );
  assert.doesNotMatch(source, /Target\.setAutoAttach/u);
  assert.match(source, /dashboardUrl\.origin !== selectedDashboardUrl\.origin/u);
  assert.doesNotMatch(
    source,
    /targets\.find\(\(entry\) => entry\.type === "page"/u,
    "the first available page cannot stand in for the dashboard",
  );
  assert.match(source, /localDashboardReady/u);
  assert.match(source, /readyMarker:[\s\S]*titleMatches:[\s\S]*overviewHeadingPresent:/u);
  assert.match(source, /failureStage = rendererReadinessFailureStage\(snapshot\)/u);
  assert.match(source, /failureStage = "renderer_late_network"/u);
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
  assert.match(source, /\/proc\/\$\{pid\}\/stat/u);
  assert.match(source, /descendantIdentitiesAtReady/u);
  assert.match(source, /linuxProcessIdentityIsAlive/u);
  assert.doesNotMatch(
    source,
    /once\(child, "exit"\)[\s\S]{0,300}descendantsOf\(child\.pid\)/u,
  );
  assert.match(entry, /USAGE_MONITOR_ELECTRON_SMOKE_CONTROL/u);
  assert.match(entry, /lifecycle\.requestQuit\(\)/u);
  assert.match(entry, /process\.platform !== "win32"/u);
  assert.match(gate, /platform !== "win32"/u);
  assert.match(gate, /windowsProductionReady: false/u);
  assert.doesNotMatch(source, /windowsProductionReady\s*:\s*true/u);
  assert.match(dockerfile, /node:26\.2\.0-bookworm-slim@sha256:/u);
  assert.doesNotMatch(dockerfile, /TARGETPLATFORM/u);
  assert.match(dockerfile, /ARG TIBOTATTLE_QUALIFICATION_REVISION/u);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/u);
  assert.match(dockerfile, /TIBOTATTLE_IMAGE_SOURCE_REVISION/u);
  assert.match(
    dockerfile,
    /FROM node:26\.2\.0-bookworm-slim@sha256:445b8cda0ec3563106c5a62b4663b3831314ecc81d2645a774b308f203f25cf0/u,
  );
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node patches \.\/patches/u);
  assert.match(dockerfile, /pnpm install --frozen-lockfile/u);
  assert.match(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.match(dockerfile, /curl --fail --silent --show-error --location --retry 3/u);
  assert.match(
    dockerfile,
    /50e1cdefbf8590e0d89b0276314a99c7b98e8eed732204c6f1a1c2a38376ed87/u,
  );
  assert.match(dockerfile, /sha256sum --check --strict/u);
  assert.match(dockerfile, /unzip -q/u);
  assert.match(dockerfile, /printf 'electron' > \/workspace\/node_modules\/electron\/path\.txt/u);
  assert.doesNotMatch(dockerfile, /printf 'electron\\n'/u);
  assert.doesNotMatch(dockerfile, /node node_modules\/electron\/install\.js/u);
  assert.match(dockerfile, /xvfb-run/u);
  assert.match(dockerfile, /-nolisten tcp/u);
  assert.match(dockerfile, /ELECTRON_DISABLE_SANDBOX=0/u);
  assert.match(dockerfile, /USER node/u);
  assert.doesNotMatch(dockerignore, /!patches\//u);
  const readyWait = source.indexOf("const ready = await waitFor");
  const diagnosticsBind = source.indexOf(
    "rendererReadinessDiagnostics.bindSelectedDashboardUrl(selectedDashboardUrl.href)",
  );
  const companionSnapshotObserver = source.indexOf(
    "createRendererReadinessCompanionSnapshotObserver(",
    diagnosticsBind,
  );
  const runtimeEnabled = source.indexOf('await cdp.request("Runtime.enable")', diagnosticsBind);
  const companionSnapshotStop = source.indexOf("await companionSnapshotObserver.stop()", readyWait);
  const automaticRefresh = source.indexOf("await assertAutomaticStartupRefresh({");
  assert.ok(
    readyWait >= 0 && automaticRefresh > readyWait,
    "the startup refresh check is ordered after the readiness wait",
  );
  assert.ok(
    diagnosticsBind >= 0 && diagnosticsBind < readyWait,
    "renderer diagnostics bind only after the selected loopback target is known",
  );
  assert.ok(
    companionSnapshotObserver > diagnosticsBind && companionSnapshotObserver < readyWait
      && companionSnapshotStop > readyWait,
    "the existing health state is observed only during the unchanged readiness wait",
  );
  assert.ok(
    runtimeEnabled > diagnosticsBind && runtimeEnabled < readyWait,
    "runtime exception observation starts only after the renderer diagnostic origin is bound",
  );
  const pageObserver = source.indexOf("pageRefreshObserver = observeLocalRefreshRequests");
  const networkEnabled = source.indexOf('await pageCdp.request("Network.enable")', pageObserver);
  const pageEnabled = source.indexOf('await pageCdp.request("Page.enable")', pageObserver);
  assert.ok(
    pageObserver >= 0 && pageEnabled > pageObserver && networkEnabled > pageEnabled,
    "each page installs its refresh and network observers before enabling CDP domains",
  );
  const reload = source.indexOf('await cdp.request("Page.reload"');
  const freshDocument = source.indexOf('"dashboard fresh-document render"');
  assert.ok(
    reload >= 0 && freshDocument > reload,
    "the Linux lane proves a fresh document before the reload refresh check",
  );
  assert.equal(
    packageJson.scripts["container:electron-linux:build"],
    "node ./scripts/build-electron-linux-container.mjs --architecture arm64",
  );
  assert.match(packageJson.scripts["container:electron-linux:test"], /--platform=linux\/arm64/u);
  assert.match(packageJson.scripts["container:electron-linux:test"], /--cap-add=SYS_ADMIN/u);
  assert.match(packageJson.scripts["container:electron-linux:test"], /--network none/u);
  assert.equal(
    packageJson.scripts["container:electron-linux:build:amd64"],
    "node ./scripts/build-electron-linux-container.mjs --architecture amd64",
  );
  assert.match(
    packageJson.scripts["container:electron-linux:test:amd64"],
    /--platform=linux\/amd64[\s\S]*--network none[\s\S]*USAGE_MONITOR_LINUX_IMAGE_PLATFORM=linux\/amd64[\s\S]*tibotattle-electron-linux-amd64:test/u,
  );
});

test("Linux smoke seeds a production-validated returning-user receipt", async () => {
  const fixture = await createSyntheticHome();
  try {
    const receipt = JSON.parse(await readFile(fixture.firstRunReceiptFile, "utf8"));
    assert.deepEqual(validateDesktopFirstRunReceipt(receipt), {
      schemaVersion: "tibotattle-desktop-first-run-v1",
      acknowledged: true,
    });
    assert.equal((await stat(fixture.firstRunReceiptFile)).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.settingsRoot)).mode & 0o777, 0o700);
    assert.match(
      fixture.firstRunReceiptFile,
      /user-data[\\/]desktop-settings[\\/]desktop-first-run-v1\.json$/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Linux smoke selects only the exact ephemeral loopback dashboard target", () => {
  const debugPort = 43123;
  const dashboardPort = 49299;
  const target = (url, overrides = {}) => ({
    id: "dashboard-target",
    type: "page",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/1`,
    ...overrides,
  });
  const valid = target(`http://127.0.0.1:${dashboardPort}/`);
  assert.equal(
    isLinuxInspectablePageTarget(target("data:text/html,<h1>loading</h1>"), debugPort),
    true,
  );
  assert.equal(isLinuxDashboardTarget(valid, debugPort), true);
  assert.equal(selectLinuxDashboardTarget([
    target("data:text/html,<h1>loading</h1>"),
    target("file:///tmp/recovery.html"),
    target(`https://127.0.0.1:${dashboardPort}/`),
    target(`http://localhost:${dashboardPort}/`),
    target(`http://127.0.0.1:${dashboardPort}/electron-settings.html`),
    target(`http://127.0.0.1:${dashboardPort}/#weekly`),
    target(`http://127.0.0.1:${dashboardPort}/?ready=1`),
    target(`http://user:pass@127.0.0.1:${dashboardPort}/`),
    target(`http://127.0.0.2:${dashboardPort}/`),
    { ...valid, type: "other" },
    {
      ...valid,
      webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort + 1}/devtools/page/2`,
    },
    valid,
  ], debugPort), valid);
  assert.equal(
    selectLinuxDashboardTarget([valid], debugPort, "dashboard-target"),
    valid,
  );
  assert.equal(
    selectLinuxDashboardTarget([valid], debugPort, "other-target"),
    undefined,
  );
  for (const rejected of [
    target("data:text/html,<h1>loading</h1>"),
    target("file:///tmp/recovery.html"),
    target(`https://127.0.0.1:${dashboardPort}/`),
    target(`http://localhost:${dashboardPort}/`),
    target(`http://127.0.0.1:${dashboardPort}/electron-settings.html`),
    target(`http://127.0.0.1:${dashboardPort}/#weekly`),
    target(`http://127.0.0.1:${dashboardPort}/?ready=1`),
    target(`http://user:pass@127.0.0.1:${dashboardPort}/`),
    target("http://127.0.0.1/"),
    target(`http://127.0.0.2:${dashboardPort}/`),
    { ...valid, type: "other" },
    { ...valid, webSocketDebuggerUrl: "" },
    {
      ...valid,
      webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort + 1}/devtools/page/2`,
    },
    {
      ...valid,
      webSocketDebuggerUrl: `ws://localhost:${debugPort}/devtools/page/2`,
    },
    {
      ...valid,
      webSocketDebuggerUrl: `wss://127.0.0.1:${debugPort}/devtools/page/2`,
    },
    { ...valid, id: "" },
  ]) {
    assert.equal(isLinuxDashboardTarget(rejected, debugPort), false);
  }
  assert.equal(
    isLinuxInspectablePageTarget({ ...valid, type: "worker" }, debugPort),
    false,
  );
  assert.equal(selectLinuxDashboardTarget(null, debugPort), undefined);
  assert.equal(selectLinuxDashboardTarget([valid], debugPort, ""), undefined);
});

test("Linux smoke bounds distinct CDP connection attempts before opening sockets", () => {
  const debugPort = 43123;
  const target = (id) => ({
    id,
    type: "page",
    url: "data:text/html,<h1>loading</h1>",
    webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/${id}`,
  });
  const attempted = new Set();
  const first = reserveLinuxInspectablePageTargets([
    target("one"),
    target("one"),
    target("two"),
  ], debugPort, attempted, 2);
  assert.deepEqual(first.map(({ id }) => id), ["one", "two"]);
  assert.deepEqual([...attempted], ["one", "two"]);
  assert.deepEqual(
    reserveLinuxInspectablePageTargets([target("one")], debugPort, attempted, 2),
    [],
  );
  assert.throws(
    () => reserveLinuxInspectablePageTargets([target("three")], debugPort, attempted, 2),
    /too many inspectable page targets/u,
  );
  assert.deepEqual([...attempted], ["one", "two"]);
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
    {
      status: "completed",
      refreshId: "refresh-new",
      terminalStatus: "succeeded",
    },
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

  const degradedRefresh = {
    status: "degraded",
    refreshId: "refresh-partial",
    errorCode: "refresh_degraded",
    failedStep: "unified_index",
    failureCode: "codex_rollout_generation_ambiguous",
    result: {
      unifiedIndex: {
        status: "ingested",
        generation: {
          status: "partial",
          blockReason: "codex_rollout_sources_quarantined",
          skippedSourceCount: 1,
          skippedThreadCount: 1,
          reasonCounts: { codex_rollout_generation_ambiguous: 1 },
          discoveryComplete: true,
          diagnosticsComplete: true,
          usageProvenanceComplete: true,
          sourceOrderComplete: true,
          quotaProvenanceComplete: true,
        },
      },
      accounting: {
        status: "replay_safe",
        sourceMode: "unified",
        coverageStatus: "partial",
        generationMatched: true,
        fallbackCount: 0,
        diagnosticsAvailable: true,
      },
    },
  };
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: degradedRefresh,
      expectedRefreshId: "refresh-partial",
    }),
    {
      status: "completed",
      refreshId: "refresh-partial",
      terminalStatus: "degraded",
      degradedFailureCode: "codex_rollout_generation_ambiguous",
    },
  );
  for (const failureCode of ELECTRON_LINUX_SMOKE_DEGRADED_FAILURE_CODES) {
    const candidate = structuredClone(degradedRefresh);
    candidate.failureCode = failureCode;
    candidate.result.unifiedIndex.generation.reasonCounts = { [failureCode]: 1 };
    assert.equal(classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: candidate,
      expectedRefreshId: "refresh-partial",
    }).status, "completed", failureCode);
  }
  for (const invalid of [
    { ...degradedRefresh, failureCode: "private_failure" },
    {
      ...degradedRefresh,
      result: {
        ...degradedRefresh.result,
        accounting: {
          ...degradedRefresh.result.accounting,
          generationMatched: false,
        },
      },
    },
  ]) {
    assert.deepEqual(
      classifyAutomaticStartupRefreshReceipt({
        phase: "completion",
        requestCount: 1,
        refresh: invalid,
        expectedRefreshId: "refresh-partial",
      }),
      { status: "failed", errorCode: codes.degradedInvalid },
    );
  }

  assert.deepEqual(
    combineStartupRefreshEvidence(
      { terminalStatus: "succeeded", degradedFailureCode: null },
      {
        terminalStatus: "degraded",
        degradedFailureCode: "codex_rollout_generation_ambiguous",
      },
    ),
    {
      terminalStatus: "degraded",
      degradedFailureCode: "codex_rollout_generation_ambiguous",
    },
  );
  assert.throws(
    () => combineStartupRefreshEvidence(
      {
        terminalStatus: "degraded",
        degradedFailureCode: "codex_rollout_generation_ambiguous",
      },
      {
        terminalStatus: "degraded",
        degradedFailureCode: "codex_rollout_lineage_invalid",
      },
    ),
    { code: codes.degradedInvalid },
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

test("Linux smoke polling bounds a predicate that never settles", async () => {
  const started = Date.now();
  await assert.rejects(
    waitFor(() => new Promise(() => {}), 20, "bounded predicate"),
    /bounded predicate timed out/u,
  );
  assert.equal(Date.now() - started < 1_000, true);
});

test("Linux smoke exposes only closed failure-stage boundaries to callers", () => {
  assert.deepEqual(ELECTRON_LINUX_SMOKE_FAILURE_STAGES, [
    "startup",
    "target",
    "renderer_readiness_unobserved",
    "renderer_readiness_marker_false_title_false_heading_false",
    "renderer_readiness_marker_false_title_false_heading_true",
    "renderer_readiness_marker_false_title_true_heading_false",
    "renderer_readiness_marker_false_title_true_heading_true",
    "renderer_readiness_marker_true_title_false_heading_false",
    "renderer_readiness_marker_true_title_false_heading_true",
    "renderer_readiness_marker_true_title_true_heading_false",
    "renderer_origin",
    "renderer_health",
    "renderer_resource",
    "renderer_navigation",
    "initial_refresh",
    "reload_refresh",
    "observation",
    "renderer_late_network",
    "quit_cleanup",
  ]);
  assert.equal(Object.isFrozen(ELECTRON_LINUX_SMOKE_FAILURE_STAGES), true);
});

test("Linux smoke refuses an invalid container before resolving its default Electron binary", async () => {
  let resolverCalls = 0;
  let fixtureCalls = 0;
  await assert.rejects(runSmoke({
    binaryResolver() {
      resolverCalls += 1;
      return "/private/tmp/unused-electron";
    },
    readContainerContract() {
      throw new Error("invalid test container");
    },
    async fixtureFactory() {
      fixtureCalls += 1;
      throw new Error("fixture must not be created");
    },
  }), /invalid test container/u);
  assert.equal(resolverCalls, 0);
  assert.equal(fixtureCalls, 0);
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
    sourceRevision: "1234567890abcdef1234567890abcdef12345678",
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
    sourceRevision: "1234567890abcdef1234567890abcdef12345678",
    networkBoundary: "network-none",
    networkBoundaryEvidence: "loopback-only",
  });
  assert.throws(() => assertContainerContract({
    ...common,
    sourceRevision: "unbound",
    networkInterfacesImpl: () => ({
      lo: [{ address: "127.0.0.1", internal: true }],
    }),
  }), /exact image source revision/u);
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
