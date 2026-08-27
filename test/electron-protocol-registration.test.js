import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const REPOSITORY_ROOT = resolve(".");
const DEVELOPMENT_CONFIG_PATH = resolve(
  "apps/electron/electron-builder.config.cjs",
);
const RELEASE_CONFIG_PATH = resolve(
  "apps/electron/electron-builder.release.config.cjs",
);
const WINDOWS_PROTOCOL_INCLUDE_PATH = resolve(
  "apps/electron/windows-protocol-registration.nsh",
);
const PACKAGE_VERSION = JSON.parse(
  readFileSync(resolve("package.json"), "utf8"),
).version;

const EXPECTED_MAC_PROTOCOL = Object.freeze({
  name: "com.usagemonitor.local.open",
  schemes: ["usagemonitor"],
  role: "Viewer",
});

const REQUIRED_RELEASE_ENVIRONMENT = Object.freeze({
  TIBOTATTLE_ELECTRON_TARGET: "win32",
  TIBOTATTLE_ELECTRON_SIGNING_MODE: "azure-trusted-signing",
  TIBOTATTLE_ELECTRON_VERSION: PACKAGE_VERSION,
  TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME: "Adam Allcock",
  TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: "https://eus.codesigning.azure.net/",
  TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME: "tibotattlesigning",
  TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME: "tibotattle-windows-public",
});

const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  "CSC_LINK",
  "WIN_CSC_LINK",
  "CSC_KEY_PASSWORD",
  "WIN_CSC_KEY_PASSWORD",
  "CSC_NAME",
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "CSC_FOR_PULL_REQUEST",
  "CSC_CERTIFICATE_FILE",
  "CSC_CERTIFICATE_PASSWORD",
  "WIN_CERTIFICATE_FILE",
  "WIN_CERTIFICATE_PASSWORD",
  "TIBOTATTLE_WINDOWS_PFX_PATH",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_USERNAME",
  "AZURE_PASSWORD",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "AZURE_CODE_SIGNING_PROFILE_NAME",
  "AZURE_CODE_SIGNING_ENDPOINT",
  "AZURE_CODE_SIGNING_PUBLISHER_NAME",
  "AZURE_CODE_SIGNING_TIMESTAMP_URL",
  "ARM_CLIENT_ID",
  "ARM_TENANT_ID",
  "ARM_SUBSCRIPTION_ID",
  "ARM_CLIENT_SECRET",
  "ARM_CLIENT_CERTIFICATE_PATH",
  "ARM_CLIENT_CERTIFICATE_PASSWORD",
  "ARM_USERNAME",
  "ARM_PASSWORD",
  "ARM_FEDERATED_TOKEN_FILE",
]);
const FORBIDDEN_ENVIRONMENT_PATTERN = /(?:^|_)(?:WIN_)?CSC(?:_|$)|(?:^|_)(?:PFX|P12)(?:_|$)/u;

function cleanEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (FORBIDDEN_ENVIRONMENT_NAMES.has(name)
        || FORBIDDEN_ENVIRONMENT_PATTERN.test(name.toUpperCase())) {
      delete environment[name];
    }
  }
  Object.assign(environment, overrides);
  return environment;
}

function loadConfig(configPath, environment) {
  const source = [
    `const config = require(${JSON.stringify(configPath)});`,
    "process.stdout.write(JSON.stringify({",
    "  appId: config.appId,",
    "  protocols: config.protocols,",
    "  mac: config.mac,",
    "  win: config.win,",
    "  nsis: config.nsis,",
    "}));",
  ].join("\n");
  return JSON.parse(execFileSync(process.execPath, ["-e", source], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    encoding: "utf8",
  }));
}

test("macOS Electron packaging declares only the existing semantic deep-link scheme", () => {
  const config = loadConfig(DEVELOPMENT_CONFIG_PATH, cleanEnvironment({
    TIBOTATTLE_ELECTRON_TARGET: "darwin",
  }));

  assert.deepEqual(config.mac.protocols, [EXPECTED_MAC_PROTOCOL]);
  assert.equal(config.protocols, undefined);
  assert.equal(config.win.protocols, undefined);
  assert.equal(config.win.target[0].target, "dir");
  assert.equal(config.nsis, undefined);
  assert.equal(config.mac.protocols.length, 1);
  assert.deepEqual(config.mac.protocols[0].schemes, ["usagemonitor"]);
});

test("Windows development directory packaging makes no installed protocol claim", () => {
  const config = loadConfig(DEVELOPMENT_CONFIG_PATH, cleanEnvironment({
    TIBOTATTLE_ELECTRON_TARGET: "win32",
  }));

  // The shared config object still contains the macOS target definition, but
  // this invocation selects the Windows directory target below. No Windows
  // target or installer option registers a protocol in this lane.
  assert.deepEqual(config.mac.protocols, [EXPECTED_MAC_PROTOCOL]);
  assert.equal(config.protocols, undefined);
  assert.equal(config.win.protocols, undefined);
  assert.equal(config.win.target[0].target, "dir");
  assert.equal(config.nsis, undefined);
});

test("Windows production NSIS uses one closed protocol association include", () => {
  const config = loadConfig(
    RELEASE_CONFIG_PATH,
    cleanEnvironment(REQUIRED_RELEASE_ENVIRONMENT),
  );
  assert.equal(config.mac, undefined);
  assert.equal(config.protocols, undefined);
  assert.equal(config.win.target[0].target, "nsis");
  assert.equal(config.win.signExecutable, true);
  assert.equal(config.win.signAndEditExecutable, true);
  assert.equal(config.nsis.script, undefined);
  assert.equal(resolve(config.nsis.include), WINDOWS_PROTOCOL_INCLUDE_PATH);

  const include = readFileSync(config.nsis.include, "utf8");
  assert.match(
    include,
    /WriteRegStr SHELL_CONTEXT "Software\\Classes\\usagemonitor" "URL Protocol" ""/u,
  );
  assert.match(
    include,
    /Software\\Classes\\usagemonitor\\shell\\open\\command/u,
  );
  assert.match(include, /'"\$appExe" "%1"'/u);
  assert.match(
    include,
    /DeleteRegKey SHELL_CONTEXT "Software\\Classes\\usagemonitor"/u,
  );

  const registeredKeys = [
    ...include.matchAll(/Software\\Classes\\([A-Za-z0-9._-]+)/gu),
  ].map((match) => match[1]);
  assert.deepEqual([...new Set(registeredKeys)], ["usagemonitor"]);
  assert.doesNotMatch(include, /https?:|oauth|token|[?](?:code|next)=|#fragment/iu);
  assert.doesNotMatch(include, /setAsDefaultProtocolClient/u);
});
