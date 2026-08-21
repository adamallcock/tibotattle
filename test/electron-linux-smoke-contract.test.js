import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertContainerContract,
  fixedRuntimeFailureDiagnostics,
  isAllowedRendererNetworkURL,
} from "../scripts/smoke-electron-linux.mjs";

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
  assert.match(packageJson.scripts["container:electron-linux:build"], /--platform=linux\/arm64/u);
  assert.doesNotMatch(packageJson.scripts["container:electron-linux:build"], /--build-arg/u);
  assert.match(packageJson.scripts["container:electron-linux:test"], /--platform=linux\/arm64/u);
  assert.match(packageJson.scripts["container:electron-linux:test"], /--cap-add=SYS_ADMIN/u);
  assert.match(packageJson.scripts["container:electron-linux:test"], /--network none/u);
  assert.equal(Object.hasOwn(packageJson.scripts, "container:electron-linux:build:amd64"), false);
  assert.equal(Object.hasOwn(packageJson.scripts, "container:electron-linux:test:amd64"), false);
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
