import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { launchDesktopRuntime } from "../apps/electron/desktop-runtime.js";
import {
  createAccountlessSignedStagingRehearsalMetadata,
} from "../scripts/lib/electron-builder-package-json.mjs";
import {
  SIGNED_STAGING_CONSUMER_SCHEMA_VERSION,
  SIGNED_STAGING_CONSUMER_STATUS,
  inspectSignedStagingArtifact,
  parseSignedStagingConsumerArguments,
  preseedSignedStagingDisposableOptOut,
  prepareSignedStagingDisposableProfile,
  runSignedStagingConsumer,
  signedStagingProfilePathForHome,
  signedStagingRuntimeSettingsPathForProfile,
  verifySignedStagingDisposableOptOut,
} from "../scripts/consume-signed-electron-staging.mjs";

const SOURCE_REVISION = "a".repeat(40);
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function currentAccount() {
  const uid = process.getuid?.();
  const details = userInfo();
  assert.equal(Number.isSafeInteger(uid), true);
  assert.equal(details.uid, uid);
  assert.equal(typeof details.username, "string");
  assert.equal(details.username.length > 0, true);
  return Object.freeze({ uid, username: details.username });
}

function signedMetadata(sourceRevision = SOURCE_REVISION) {
  const account = currentAccount();
  return createAccountlessSignedStagingRehearsalMetadata({
    expectedTestUID: account.uid,
    expectedTestUsername: account.username,
    sourceRevision,
  });
}

function cleanRunnerEnvironment(extra = {}) {
  return Object.freeze({
    GITHUB_ACTIONS: "true",
    RUNNER_ARCH: "ARM64",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "macOS",
    ...extra,
  });
}

async function homeFixture(t) {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "tibotattle-signed-consumer-home-"));
  const home = join(root, "home");
  const appData = join(home, "Library", "Application Support");
  await mkdir(appData, { recursive: true, mode: 0o700 });
  await Promise.all([chmod(home, 0o700), chmod(join(home, "Library"), 0o700), chmod(appData, 0o700)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return Object.freeze({ home, appData });
}

async function artifactFixture(t, {
  manifest = { tibotattleAccountlessSignedStagingRehearsal: signedMetadata() },
} = {}) {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "tibotattle-signed-consumer-app-"));
  const appPath = join(root, "TiboTattle.app");
  const resources = join(appPath, "Contents", "Resources");
  const executable = join(appPath, "Contents", "MacOS", "TiboTattle");
  const archive = join(resources, "app.asar");
  await mkdir(resources, { recursive: true, mode: 0o700 });
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true, mode: 0o700 });
  await writeFile(executable, "fixture executable\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(archive, "fixture archive\n", { mode: 0o600 });
  const asarSha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  t.after(() => rm(root, { recursive: true, force: true }));
  return Object.freeze({
    appPath,
    archive,
    asarSha256,
    manifest,
    sourceRevision: manifest.tibotattleAccountlessSignedStagingRehearsal?.sourceRevision
      ?? SOURCE_REVISION,
  });
}

function artifactDependencies(manifest, { verifySignature = async () => true } = {}) {
  return {
    architecture: "arm64",
    asar: {
      extractFile() {
        return Buffer.from(JSON.stringify(manifest));
      },
    },
    platform: "darwin",
    verifySignature,
  };
}

function preseedInputs({ home, metadata, environment = cleanRunnerEnvironment() }) {
  const account = currentAccount();
  return {
    metadata,
    environment,
    getuid: () => account.uid,
    getUserInfo: () => ({
      uid: account.uid,
      username: account.username,
      homedir: home,
    }),
    platform: "darwin",
    architecture: "arm64",
  };
}

class RuntimeChild extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.stderr = new EventEmitter();
    this.stdout = new EventEmitter();
  }

  send(_message, callback) {
    callback?.();
    return true;
  }

  kill() {
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

class RuntimeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.visible = false;
    this.webContents = new EventEmitter();
    this.webContents.session = {};
    this.webContents.mainFrame = { isMainFrame: true, parent: null };
    this.webContents.send = () => {};
    this.webContents.getURL = () => this.url ?? "";
  }

  loadURL(url) {
    this.url = url;
    return Promise.resolve();
  }

  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}

class RuntimeTray extends EventEmitter {
  setToolTip() {}
  setContextMenu() {}
  destroy() {}
}

class RuntimeApp extends EventEmitter {
  constructor(profileRoot) {
    super();
    this.profileRoot = profileRoot;
    this.isPackaged = true;
    this.ready = false;
  }

  getName() { return "TiboTattle"; }
  getVersion() { return "0.1.19"; }
  getPath(name) {
    assert.equal(name, "userData");
    return this.profileRoot;
  }
  requestSingleInstanceLock() { return true; }
  async whenReady() { this.ready = true; }
  quit() {}
}

function signedRuntimeComposition(metadata) {
  return Object.freeze({
    createMacOSCredentialBackend: () => Object.freeze({
      read: async () => null,
      createIfMissing: async () => ({ status: "created" }),
      deleteExact: async () => ({ status: "deleted" }),
    }),
    executionProfile: metadata.executionProfile,
    expectedTestUID: metadata.expectedTestUID,
    expectedTestUsername: metadata.expectedTestUsername,
    origin: metadata.origin,
    policyVersion: metadata.contributionPolicy,
  });
}

test("signed staging consumer parser requires explicit verified inputs and rejects launch controls", () => {
  const appPath = "/tmp/TiboTattle.app";
  const asarSha256 = "b".repeat(64);
  assert.deepEqual(parseSignedStagingConsumerArguments([
    "--app", appPath,
    "--source-revision", SOURCE_REVISION,
    "--asar-sha256", asarSha256,
  ]), {
    appPath,
    sourceRevision: SOURCE_REVISION,
    asarSha256,
  });
  for (const argv of [
    [],
    ["--app", appPath, "--source-revision", SOURCE_REVISION],
    ["--app", "relative/TiboTattle.app", "--source-revision", SOURCE_REVISION, "--asar-sha256", asarSha256],
    ["--app", appPath, "--source-revision", SOURCE_REVISION, "--asar-sha256", asarSha256, "--execute-disposable-opt-out"],
    ["--app", appPath, "--source-revision", SOURCE_REVISION, "--asar-sha256", asarSha256, "--acknowledge-disposable-opt-out", "signed-staging-disposable-opt-out-v1"],
    ["--app", appPath, "--app", appPath, "--source-revision", SOURCE_REVISION, "--asar-sha256", asarSha256],
  ]) {
    assert.throws(() => parseSignedStagingConsumerArguments(argv), {
      code: "ELECTRON_SIGNED_STAGING_CONSUMER_INPUT_INVALID",
    });
  }
});

test("dry artifact verification binds the app archive, package marker, source revision, and codesign gate", async (t) => {
  const metadata = signedMetadata();
  const fixture = await artifactFixture(t, {
    manifest: { tibotattleAccountlessSignedStagingRehearsal: metadata },
  });
  let signatureCalls = 0;
  const receipt = await inspectSignedStagingArtifact({
    appPath: fixture.appPath,
    sourceRevision: fixture.sourceRevision,
    asarSha256: fixture.asarSha256,
  }, artifactDependencies(fixture.manifest, {
    verifySignature: async () => {
      signatureCalls += 1;
      return true;
    },
  }));
  assert.equal(signatureCalls, 1);
  assert.deepEqual(receipt, {
    schemaVersion: SIGNED_STAGING_CONSUMER_SCHEMA_VERSION,
    status: SIGNED_STAGING_CONSUMER_STATUS.artifactVerified,
    execution: "dry",
    signature: "verified",
    sourceRevision: fixture.sourceRevision,
    asarSha256: fixture.asarSha256,
  });
  await assert.rejects(inspectSignedStagingArtifact({
    appPath: fixture.appPath,
    sourceRevision: fixture.sourceRevision,
    asarSha256: "c".repeat(64),
  }, artifactDependencies(fixture.manifest)), {
    code: "ELECTRON_SIGNED_STAGING_CONSUMER_ARTIFACT_DIGEST_INVALID",
  });
  await assert.rejects(inspectSignedStagingArtifact({
    appPath: fixture.appPath,
    sourceRevision: fixture.sourceRevision,
    asarSha256: fixture.asarSha256,
  }, artifactDependencies({
    tibotattleAccountlessSignedStagingRehearsal: metadata,
    tibotattleDistribution: {},
  })), {
    code: "ELECTRON_SIGNED_STAGING_CONSUMER_METADATA_INVALID",
  });
  await assert.rejects(inspectSignedStagingArtifact({
    appPath: fixture.appPath,
    sourceRevision: fixture.sourceRevision,
    asarSha256: fixture.asarSha256,
  }, {
    ...artifactDependencies(fixture.manifest),
    getuid: () => currentAccount().uid + 1,
  }), {
    code: "ELECTRON_SIGNED_STAGING_CONSUMER_APP_INVALID",
  });
});

test("artifact intake rejects a symlinked bundle ancestor", async (t) => {
  const metadata = signedMetadata();
  const fixture = await artifactFixture(t, {
    manifest: { tibotattleAccountlessSignedStagingRehearsal: metadata },
  });
  const contents = join(fixture.appPath, "Contents");
  const originalContents = join(dirname(fixture.appPath), "Contents-original");
  await rename(contents, originalContents);
  await symlink(originalContents, contents);
  await assert.rejects(inspectSignedStagingArtifact({
    appPath: fixture.appPath,
    sourceRevision: fixture.sourceRevision,
    asarSha256: fixture.asarSha256,
  }, artifactDependencies(fixture.manifest)), {
    code: "ELECTRON_SIGNED_STAGING_CONSUMER_APP_INVALID",
  });
});

test("preseed refuses an unbound account or ambient authority before creating a profile", async (t) => {
  const { home } = await homeFixture(t);
  const metadata = signedMetadata();
  const profile = signedStagingProfilePathForHome(home);
  const account = currentAccount();
  await assert.rejects(preseedSignedStagingDisposableOptOut({
    ...preseedInputs({ home, metadata }),
    getUserInfo: () => ({
      uid: account.uid,
      username: `${account.username}-wrong`,
      homedir: home,
    }),
  }), {
    code: "ELECTRON_SIGNED_STAGING_CONSUMER_ACCOUNT_CONTEXT_INVALID",
  });
  await assert.rejects(lstat(profile), { code: "ENOENT" });
  await assert.rejects(preseedSignedStagingDisposableOptOut(preseedInputs({
    home,
    metadata,
    environment: cleanRunnerEnvironment({ USAGE_MONITOR_TEST_LANE: "hostile" }),
  })), {
    code: "ELECTRON_SIGNED_STAGING_CONSUMER_ACCOUNT_CONTEXT_INVALID",
  });
  await assert.rejects(lstat(profile), { code: "ENOENT" });
});

test("preseed rejects a symlinked home ancestor before creating a profile", async (t) => {
  const { home } = await homeFixture(t);
  const metadata = signedMetadata();
  const linkedHome = join(dirname(home), "linked-home");
  await symlink(home, linkedHome);
  await assert.rejects(preseedSignedStagingDisposableOptOut(preseedInputs({
    home: linkedHome,
    metadata,
  })), {
    code: "ELECTRON_SIGNED_STAGING_CONSUMER_PROFILE_UNSAFE",
  });
  await assert.rejects(lstat(signedStagingProfilePathForHome(home)), { code: "ENOENT" });
});

test("preseed writes only canonical first-run and sharing opt-out records below the signed runtime resolver", async (t) => {
  const { home } = await homeFixture(t);
  const metadata = signedMetadata();
  const seed = await preseedSignedStagingDisposableOptOut(preseedInputs({ home, metadata }));
  const profile = signedStagingProfilePathForHome(home);
  assert.equal(seed.profileRoot, profile);
  assert.equal(seed.settingsRoot, signedStagingRuntimeSettingsPathForProfile(profile));
  assert.equal(await verifySignedStagingDisposableOptOut(seed), true);
  assert.equal((await lstat(seed.profileRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(seed.runtimeProfileRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(seed.settingsRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(seed.settingsRoot, "desktop-first-run-v1.json"))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(seed.settingsRoot, "accountless-sharing-v1.json"))).mode & 0o777, 0o600);

  const existingProfile = join(home, "Library", "Application Support", "TiboTattle Signed Staging Rehearsal Existing");
  await mkdir(existingProfile, { mode: 0o700 });
  await chmod(existingProfile, 0o700);
  await writeFile(join(existingProfile, "sentinel"), "preserve\n", { mode: 0o600 });
  const existingHome = join(home, "existing-home");
  const existingAppData = join(existingHome, "Library", "Application Support");
  await mkdir(existingAppData, { recursive: true, mode: 0o700 });
  await chmod(existingAppData, 0o700);
  const expectedExistingProfile = signedStagingProfilePathForHome(existingHome);
  await mkdir(expectedExistingProfile, { mode: 0o700 });
  await chmod(expectedExistingProfile, 0o700);
  const sentinel = join(expectedExistingProfile, "sentinel");
  await writeFile(sentinel, "preserve\n", { mode: 0o600 });
  await assert.rejects(preseedSignedStagingDisposableOptOut(preseedInputs({
    home: existingHome,
    metadata,
  })), {
    code: "ELECTRON_SIGNED_STAGING_CONSUMER_PROFILE_NOT_FRESH",
  });
  assert.equal(await readFile(sentinel, "utf8"), "preserve\n");
});

test("a failed preseed preserves its partial profile and refuses automatic recovery", async (t) => {
  const { home } = await homeFixture(t);
  const metadata = signedMetadata();
  const profile = signedStagingProfilePathForHome(home);
  await assert.rejects(preseedSignedStagingDisposableOptOut(
    preseedInputs({ home, metadata }),
    {
      createFirstRunBackend() {
        return Object.freeze({
          async save() { throw new Error("fixture write failure"); },
        });
      },
    },
  ), {
    code: "ELECTRON_SIGNED_STAGING_CONSUMER_OPT_OUT_INVALID",
  });
  assert.equal((await lstat(profile)).isDirectory(), true);
  await assert.rejects(preseedSignedStagingDisposableOptOut(preseedInputs({ home, metadata })), {
    code: "ELECTRON_SIGNED_STAGING_CONSUMER_PROFILE_NOT_FRESH",
  });
});

test("consumer is verification-only and rejects all exported execution controls before inspecting an artifact", async (t) => {
  const metadata = signedMetadata();
  const fixture = await artifactFixture(t, {
    manifest: { tibotattleAccountlessSignedStagingRehearsal: metadata },
  });
  let signatureCalls = 0;
  const dry = await runSignedStagingConsumer({
    appPath: fixture.appPath,
    sourceRevision: fixture.sourceRevision,
    asarSha256: fixture.asarSha256,
  }, {
    ...artifactDependencies(fixture.manifest),
    verifySignature: async () => {
      signatureCalls += 1;
      return true;
    },
  });
  assert.deepEqual(dry, {
    schemaVersion: SIGNED_STAGING_CONSUMER_SCHEMA_VERSION,
    status: SIGNED_STAGING_CONSUMER_STATUS.artifactVerified,
    execution: "dry",
    signature: "verified",
    sourceRevision: fixture.sourceRevision,
    asarSha256: fixture.asarSha256,
  });
  assert.equal(signatureCalls, 1);
  for (const options of [
    { executeDisposableOptOut: true },
    { acknowledgement: "signed-staging-disposable-opt-out-v1" },
    {
      acknowledgement: "signed-staging-disposable-opt-out-v1",
      executeDisposableOptOut: true,
    },
  ]) {
    await assert.rejects(runSignedStagingConsumer({
      appPath: fixture.appPath,
      sourceRevision: fixture.sourceRevision,
      asarSha256: fixture.asarSha256,
      ...options,
    }, {
      ...artifactDependencies(fixture.manifest),
      verifySignature: async () => {
        signatureCalls += 1;
        return true;
      },
    }), {
      code: "ELECTRON_SIGNED_STAGING_CONSUMER_INPUT_INVALID",
    });
  }
  assert.equal(signatureCalls, 1);
});

test("consumer preseed remains the actual signed-staging runtime sharing resolver after launch", async (t) => {
  const { home } = await homeFixture(t);
  const metadata = signedMetadata();
  const seed = await preseedSignedStagingDisposableOptOut(preseedInputs({ home, metadata }));
  const app = new RuntimeApp(seed.profileRoot);
  let child;
  const desktop = await launchDesktopRuntime({
    runtime: {
      app,
      BrowserWindow: RuntimeWindow,
      Tray: RuntimeTray,
      Menu: { buildFromTemplate: (template) => ({ template }) },
      dialog: {
        showMessageBox: async () => ({ response: 0 }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
      icon: "fixture-icon",
    },
    app,
    paths: {
      companionScript: join(REPOSITORY_ROOT, "apps", "local", "server.js"),
      companionCwd: REPOSITORY_ROOT,
      resourceRoot: REPOSITORY_ROOT,
      preloadPath: join(REPOSITORY_ROOT, "apps", "electron", "preload.cjs"),
    },
    environment: cleanRunnerEnvironment({ HOME: seed.profileRoot }),
    platform: "darwin",
    architecture: "arm64",
    accountlessSignedStagingRehearsal: signedRuntimeComposition(metadata),
    getuid: () => currentAccount().uid,
    getUserInfo: () => ({ uid: currentAccount().uid, username: currentAccount().username }),
    prepareNativeHandover: async () => ({ status: "no_legacy_state" }),
    supervisorOptions: {
      spawnChild() {
        child = new RuntimeChild();
        queueMicrotask(() => child.stdout.emit(
          "data",
          Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4811/\n"),
        ));
        return child;
      },
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
    },
  });
  try {
    assert.ok(child);
    const record = join(seed.settingsRoot, "accountless-sharing-v1.json");
    assert.equal((await lstat(record)).isFile(), true);
    assert.equal((await lstat(record)).mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(record, "utf8"));
    assert.deepEqual({
      basis: persisted.basis,
      destinationOrigin: persisted.destinationOrigin,
      enabled: persisted.enabled,
      state: persisted.state,
    }, {
      basis: "user_choice",
      destinationOrigin: metadata.origin,
      enabled: false,
      state: "disabled",
    });
    assert.equal(await verifySignedStagingDisposableOptOut(seed), true);
  } finally {
    await desktop.lifecycle.requestQuit();
  }
});


test("signed staging default-on preparation is explicit and uses the policy default", async (t) => {
  const { home } = await homeFixture(t);
  const seed = await prepareSignedStagingDisposableProfile({
    ...preseedInputs({ home, metadata: signedMetadata() }), initialSharing: "fresh",
  });
  const stored = JSON.parse(await seed.shareBackend.load());
  assert.equal(stored.basis, "default_on");
  assert.equal(stored.enabled, true);
  await assert.rejects(prepareSignedStagingDisposableProfile({
    ...preseedInputs({ home, metadata: signedMetadata() }), initialSharing: "anything",
  }), { code: "ELECTRON_SIGNED_STAGING_CONSUMER_INPUT_INVALID" });
});
