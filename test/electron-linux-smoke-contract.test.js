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
  combineStartupRefreshEvidence,
  createSyntheticHome,
  ELECTRON_LINUX_SMOKE_DEGRADED_FAILURE_CODES,
  ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES,
  fixedRuntimeFailureDiagnostics,
  isAllowedRendererNetworkURL,
  isLinuxDashboardTarget,
  isLinuxInspectablePageTarget,
  observeLocalRefreshRequests,
  reserveLinuxInspectablePageTargets,
  selectLinuxDashboardTarget,
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
  assert.match(source, /validateDesktopFirstRunReceipt/u);
  assert.match(source, /DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME/u);
  assert.match(source, /--user-data-dir=/u);
  assert.match(source, /selectLinuxDashboardTarget/u);
  assert.match(source, /selectLinuxDashboardTarget\(targets, port\)/u);
  assert.match(source, /reserveLinuxInspectablePageTargets/u);
  assert.match(source, /attemptedPageTargetIds/u);
  assert.match(source, /Promise\.all\(inspectablePages\.map/u);
  assert.match(source, /attachedPages\.get\(target\.id\)/u);
  assert.doesNotMatch(source, /Target\.setAutoAttach/u);
  assert.match(source, /dashboardUrl\.origin !== selectedDashboardUrl\.origin/u);
  assert.doesNotMatch(
    source,
    /targets\.find\(\(entry\) => entry\.type === "page"/u,
    "the first available page cannot stand in for the dashboard",
  );
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
