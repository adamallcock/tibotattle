import assert from "node:assert/strict";
import {
  lstat,
  link,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as application from "../src/application/index.js";
import * as applicationOwner from
  "../src/application/local-export-artifact-storage.js";
import * as exportApi from "../src/export/index.js";
import * as platform from "../src/platform/index.js";
import * as platformOwner from
  "../src/platform/owner-only-export-artifact-storage.js";
import * as storage from "../src/storage.js";
import {
  LEGACY_STORAGE_DIRECT_IMPORTERS,
  checkArchitectureBoundaries,
} from "../scripts/check-architecture-boundaries.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM_EXPORTS = Object.freeze([
  "createOwnerOnlyExportArtifactStorageContext",
]);
const APPLICATION_EXPORTS = Object.freeze([
  "createLocalExportArtifactStorageContext",
]);
const PLATFORM_CONTEXT_METHODS = Object.freeze([
  "enumerateOwnerOnlyExportDestinationEntries",
  "openOwnerOnlyExportDestination",
  "projectOwnerOnlyExportArtifactPath",
  "readOwnerOnlyExportArtifactIfPresent",
  "recoverOwnerOnlyPairTransactions",
  "recoverOwnerOnlyPairTransactionsForDestination",
  "recoverOwnerOnlyPairTransactionsUnderLease",
  "withExportDestinationLease",
  "writeOwnerOnlyPairNoClobber",
  "writeOwnerOnlyPairNoClobberForDestination",
  "writeOwnerOnlyPairNoClobberUnderLease",
]);
const APPLICATION_CONTEXT_API = Object.freeze([
  "defaultActivityMarkerFile",
  ...PLATFORM_CONTEXT_METHODS,
]);

function ownerStorageConfiguration(overrides = {}) {
  return {
    stableJson: exportApi.stableJson,
    maximumCanonicalBundleBytes:
      exportApi.DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes,
    maximumEncodedArtifactBytes:
      exportApi.DEFAULT_EXPORT_RESOURCE_LIMITS.maximumEncodedArtifactBytes,
    maximumDirectoryEntries:
      exportApi.DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
    createResourceLimitError: (code) => new exportApi.ExportResourceLimitError(code),
    ...overrides,
  };
}

function assertNoCanary(error, expected) {
  assert.match(String(error?.message ?? error), expected);
  assert.doesNotMatch(String(error?.message ?? error), /canary|foreign-secret/u);
  return true;
}

async function source(relativePath) {
  return readFile(resolve(REPOSITORY_ROOT, relativePath), "utf8");
}

test("owner, application, and platform expose exact reviewed artifact APIs", () => {
  assert.deepEqual(Object.keys(platformOwner).sort(), [...PLATFORM_EXPORTS]);
  assert.equal(
    platform.createOwnerOnlyExportArtifactStorageContext,
    platformOwner.createOwnerOnlyExportArtifactStorageContext,
  );
  assert.deepEqual(Object.keys(applicationOwner).sort(), [...APPLICATION_EXPORTS]);
  assert.equal(
    application.createLocalExportArtifactStorageContext,
    applicationOwner.createLocalExportArtifactStorageContext,
  );
  assert.equal(storage.stableJson, exportApi.stableJson);
  const platformContext = platform.createOwnerOnlyExportArtifactStorageContext(
    ownerStorageConfiguration(),
  );
  assert.deepEqual(Object.keys(platformContext).sort(), [...PLATFORM_CONTEXT_METHODS].sort());
  const applicationContext = application.createLocalExportArtifactStorageContext({
    createStorage: platform.createOwnerOnlyExportArtifactStorageContext,
    activityMarkerFile: platform.defaultActivityMarkerFile,
  });
  assert.deepEqual(Object.keys(applicationContext).sort(), [...APPLICATION_CONTEXT_API].sort());
  for (const name of [
    "recoverOwnerOnlyPairTransactions",
    "recoverOwnerOnlyPairTransactionsUnderLease",
    "withExportDestinationLease",
    "writeOwnerOnlyPairNoClobber",
    "writeOwnerOnlyPairNoClobberUnderLease",
  ]) {
    assert.equal(typeof storage[name], "function", name);
  }
});

test("application binding preserves receipt-first publication and legacy compatibility", async () => {
  const context = application.createLocalExportArtifactStorageContext({
    createStorage: platform.createOwnerOnlyExportArtifactStorageContext,
    activityMarkerFile: platform.defaultActivityMarkerFile,
  });
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-artifact-owner-"));
  const bundle = join(directory, "bundle.umx");
  const receipt = join(directory, "receipt.json");
  try {
    await context.writeOwnerOnlyPairNoClobber({
      firstPath: bundle,
      firstContent: "bundle\n",
      secondPath: receipt,
      secondContent: "receipt\n",
    });
    assert.equal(await readFile(bundle, "utf8"), "bundle\n");
    assert.equal(await readFile(receipt, "utf8"), "receipt\n");
    assert.equal(context.defaultActivityMarkerFile, platform.defaultActivityMarkerFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("platform mechanics do not import export, application, or legacy storage", async () => {
  const ownerSource = await source(
    "src/platform/owner-only-export-artifact-storage.js",
  );
  assert.match(ownerSource, /from "node:fs\/promises"/u);
  assert.doesNotMatch(ownerSource, /\.\.\/(?:application|export)(?:\/|["'])/u);
  assert.doesNotMatch(ownerSource, /(?:from|import\()\s*["']\.\.\/storage\.js/u);
  assert.match(ownerSource, /The OS user is the local trust boundary/u);
  assert.match(ownerSource, /no portable openat-style directory capability/u);
  assert.doesNotMatch(ownerSource, /const bytes = await handle\.readFile\(\)/u);
  assert.match(ownerSource, /const overflow = Buffer\.allocUnsafe\(1\)/u);
  assert.match(ownerSource, /descriptorStats\.size,\n      \);/u);
  assert.match(ownerSource, /if \(readCompleted\)/u);
  assert.doesNotMatch(ownerSource, /recoveryFileRead/u);
  assert.match(ownerSource, /await handle\.close\(\);\n    if \(configuredRecoveryFileCloseFailpoint === undefined\) return;/u);
  assert.match(ownerSource, /configuredRecoveryFileCloseFailpoint,\n      undefined,\n      \[\],/u);
  assert.doesNotMatch(ownerSource, /\[handle\],\n      "Local export storage recovery file close failed"/u);

  const localReview = await source("local-review/cli.js");
  assert.doesNotMatch(localReview, /from "\.\.\/src\/storage\.js"/u);
  assert.match(localReview, /createLocalExportArtifactStorageContext/u);
});

test("frozen legacy-storage ledger matches the checked production graph", async () => {
  const result = await checkArchitectureBoundaries();
  assert.equal(result.ok, true);
  assert.deepEqual(result.directStorageCallers, [...LEGACY_STORAGE_DIRECT_IMPORTERS]);
  assert.equal(LEGACY_STORAGE_DIRECT_IMPORTERS.includes("local-review/cli.js"), false);
});

test("lock handoff cleanup releases only its verified stale claim on both acquisition branches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-lock-handoff-"));
  const stalePid = "99999999";
  const staleToken = "11111111-1111-4111-8111-111111111111";
  const lockName = ".app-usagemonitor-export.lock";
  const claimName = `.app-usagemonitor-export.lock.claim.${stalePid}.${staleToken}`;
  try {
    for (const sourceName of [claimName, lockName]) {
      await symlink(`pid=${stalePid};token=${staleToken}`, join(directory, sourceName));
      let synchronizationCalls = 0;
      const storageContext = platform.createOwnerOnlyExportArtifactStorageContext(
        ownerStorageConfiguration({
          async directorySync() {
            synchronizationCalls += 1;
            if (synchronizationCalls === 1) throw new Error("canary stale handoff sync");
          },
        }),
      );
      await assert.rejects(
        storageContext.withExportDestinationLease(directory, async () => "never"),
        (error) => assertNoCanary(error, /directory synchronization failed/u),
      );
      const afterFailure = await readdir(directory);
      assert.equal(afterFailure.some((name) => name.startsWith(".app-usagemonitor-export.lock")), false);
      assert.equal(
        await storageContext.withExportDestinationLease(directory, async () => "recovered"),
        "recovered",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("post-symlink inspection preserves the primary error without deleting replacement locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-lock-post-symlink-"));
  const lockPath = join(directory, ".app-usagemonitor-export.lock");
  try {
    let inspections = 0;
    const statFailure = platform.createOwnerOnlyExportArtifactStorageContext(
      ownerStorageConfiguration({
        async lockStat(path) {
          inspections += 1;
          if (inspections === 1) throw new Error("canary lstat");
          return lstat(path);
        },
      }),
    );
    await assert.rejects(
      statFailure.withExportDestinationLease(directory, async () => "never"),
      (error) => assertNoCanary(error, /lock inspection failed/u),
    );
    // The first inspection did not capture an inode. Cleanup must leave even
    // its own candidate for normal stale-lock recovery rather than guessing.
    assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
    await unlink(lockPath);

    const sameTargetReplacement = platform.createOwnerOnlyExportArtifactStorageContext(
      ownerStorageConfiguration({
        async lockStat(path) {
          const target = await readlink(path);
          await unlink(path);
          await symlink(target, path);
          throw new Error("canary same-target replacement");
        },
      }),
    );
    await assert.rejects(
      sameTargetReplacement.withExportDestinationLease(directory, async () => "never"),
      (error) => assertNoCanary(error, /lock inspection failed/u),
    );
    assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
    await unlink(lockPath);

    const replacement = platform.createOwnerOnlyExportArtifactStorageContext(
      ownerStorageConfiguration({
        async directorySync() {
          await unlink(lockPath);
          await symlink("foreign-secret", lockPath);
          throw new Error("canary replacement sync");
        },
      }),
    );
    await assert.rejects(
      replacement.withExportDestinationLease(directory, async () => "never"),
      (error) => assertNoCanary(error, /directory synchronization failed/u),
    );
    assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
    await unlink(lockPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public storage and application boundaries reject Proxy and getter ports without invoking them", async () => {
  const canary = () => { throw new Error("canary getter"); };
  const hostileConfiguration = new Proxy({}, { get: canary });
  assert.throws(
    () => platform.createOwnerOnlyExportArtifactStorageContext(hostileConfiguration),
    (error) => assertNoCanary(error, /configuration is invalid/u),
  );

  const hostileSerializer = new Proxy(exportApi.stableJson, {
    get() { throw new Error("canary bind getter"); },
    apply() { throw new Error("canary callable proxy"); },
  });
  assert.throws(
    () => platform.createOwnerOnlyExportArtifactStorageContext(
      ownerStorageConfiguration({ stableJson: hostileSerializer }),
    ),
    (error) => assertNoCanary(error, /stableJson must be a function/u),
  );

  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-hostile-port-"));
  const storageContext = platform.createOwnerOnlyExportArtifactStorageContext(ownerStorageConfiguration());
  try {
    await assert.rejects(
      storageContext.writeOwnerOnlyPairNoClobber(new Proxy({}, { get: canary })),
      (error) => assertNoCanary(error, /Paired export request is invalid/u),
    );
    await assert.rejects(
      storageContext.recoverOwnerOnlyPairTransactions(new Proxy({}, { get: canary })),
      (error) => assertNoCanary(error, /Export recovery request is invalid/u),
    );
    await assert.rejects(
      storageContext.withExportDestinationLease(
        directory,
        async () => "never",
        new Proxy({}, { get: canary }),
      ),
      (error) => assertNoCanary(error, /options are invalid/u),
    );
    await assert.rejects(
      storageContext.writeOwnerOnlyPairNoClobber({
        get firstPath() { throw new Error("canary pair getter"); },
      }),
      (error) => assertNoCanary(error, /Paired export request is invalid/u),
    );
    await assert.rejects(
      storageContext.withExportDestinationLease(directory, async () => "never", {
        lockFailpoint: new Proxy(async () => {}, { apply: canary }),
      }),
      (error) => assertNoCanary(error, /options are invalid/u),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  assert.throws(
    () => application.createLocalExportArtifactStorageContext(new Proxy({}, { get: canary })),
    (error) => assertNoCanary(error, /configuration is required/u),
  );
  assert.throws(
    () => application.createLocalExportArtifactStorageContext({
      createStorage: () => new Proxy({}, { get: canary }),
      activityMarkerFile: () => null,
    }),
    (error) => assertNoCanary(error, /owner-only export artifact storage is required/u),
  );
});

test("public artifact-storage snapshots never invoke accessor configuration, port, pair, request, or option fields", async () => {
  const platformConfigReads = { stableJson: 0, maximumDirectoryEntries: 0 };
  const configWithAccessor = ownerStorageConfiguration();
  Object.defineProperty(configWithAccessor, "stableJson", {
    get() { platformConfigReads.stableJson += 1; throw new Error("canary platform config"); },
  });
  assert.throws(
    () => platform.createOwnerOnlyExportArtifactStorageContext(configWithAccessor),
    /configuration is invalid/u,
  );
  assert.equal(platformConfigReads.stableJson, 0);

  const directoryConfigAccessor = ownerStorageConfiguration();
  Object.defineProperty(directoryConfigAccessor, "maximumDirectoryEntries", {
    get() { platformConfigReads.maximumDirectoryEntries += 1; throw new Error("canary platform config"); },
  });
  assert.throws(
    () => platform.createOwnerOnlyExportArtifactStorageContext(directoryConfigAccessor),
    /configuration is invalid/u,
  );
  assert.equal(platformConfigReads.maximumDirectoryEntries, 0);

  let recoveryCloseFailpointConfigReads = 0;
  const closeConfigWithAccessor = ownerStorageConfiguration();
  Object.defineProperty(closeConfigWithAccessor, "recoveryFileCloseFailpoint", {
    get() { recoveryCloseFailpointConfigReads += 1; throw new Error("canary recovery close config"); },
  });
  assert.throws(
    () => platform.createOwnerOnlyExportArtifactStorageContext(closeConfigWithAccessor),
    /configuration is invalid/u,
  );
  assert.equal(recoveryCloseFailpointConfigReads, 0);

  let platformPrototypeHasCalls = 0;
  const platformPrototypeConfiguration = Object.create(new Proxy({}, {
    has() { platformPrototypeHasCalls += 1; throw new Error("canary platform prototype has"); },
  }));
  assert.throws(
    () => platform.createOwnerOnlyExportArtifactStorageContext(platformPrototypeConfiguration),
    /stableJson must be a function/u,
  );
  assert.equal(platformPrototypeHasCalls, 0);

  let applicationConfigReads = 0;
  const applicationConfig = {
    createStorage: platform.createOwnerOnlyExportArtifactStorageContext,
    activityMarkerFile: platform.defaultActivityMarkerFile,
  };
  Object.defineProperty(applicationConfig, "createStorage", {
    get() { applicationConfigReads += 1; throw new Error("canary application config"); },
  });
  assert.throws(
    () => application.createLocalExportArtifactStorageContext(applicationConfig),
    /configuration is invalid/u,
  );
  assert.equal(applicationConfigReads, 0);

  let applicationPrototypeHasCalls = 0;
  const applicationPrototypeConfiguration = Object.create(new Proxy({}, {
    has() { applicationPrototypeHasCalls += 1; throw new Error("canary application prototype has"); },
  }));
  assert.throws(
    () => application.createLocalExportArtifactStorageContext(applicationPrototypeConfiguration),
    /configuration is invalid/u,
  );
  assert.equal(applicationPrototypeHasCalls, 0);

  let storageMethodReads = 0;
  const concrete = platform.createOwnerOnlyExportArtifactStorageContext(ownerStorageConfiguration());
  const hostileStorage = {};
  for (const name of Object.keys(concrete)) hostileStorage[name] = concrete[name];
  Object.defineProperty(hostileStorage, "openOwnerOnlyExportDestination", {
    get() { storageMethodReads += 1; throw new Error("canary storage port"); },
  });
  assert.throws(
    () => application.createLocalExportArtifactStorageContext({
      createStorage: () => hostileStorage,
      activityMarkerFile: platform.defaultActivityMarkerFile,
    }),
    /owner-only export artifact storage is invalid/u,
  );
  assert.equal(storageMethodReads, 0);

  const context = platform.createOwnerOnlyExportArtifactStorageContext(ownerStorageConfiguration());
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-snapshot-fields-"));
  try {
    let pairReads = 0;
    await assert.rejects(context.writeOwnerOnlyPairNoClobber({
      get firstPath() { pairReads += 1; throw new Error("canary pair"); },
    }), /Paired export request is invalid/u);
    assert.equal(pairReads, 0);

    let requestReads = 0;
    await assert.rejects(context.recoverOwnerOnlyPairTransactions({
      get directory() { requestReads += 1; throw new Error("canary request"); },
    }), /Export recovery request is invalid/u);
    assert.equal(requestReads, 0);

    let optionReads = 0;
    await assert.rejects(context.withExportDestinationLease(directory, async () => {}, {
      get failpoint() { optionReads += 1; throw new Error("canary options"); },
    }), /options are invalid/u);
    assert.equal(optionReads, 0);

    let openRequestReads = 0;
    await assert.rejects(context.openOwnerOnlyExportDestination({
      get directory() { openRequestReads += 1; throw new Error("canary open"); },
    }), /Export destination request is invalid/u);
    assert.equal(openRequestReads, 0);

    let requestPrototypeHasCalls = 0;
    const requestWithProxyPrototype = Object.create(new Proxy({}, {
      has() { requestPrototypeHasCalls += 1; throw new Error("canary request prototype has"); },
    }));
    await assert.rejects(
      context.openOwnerOnlyExportDestination(requestWithProxyPrototype),
      /Export destination directory is required/u,
    );
    assert.equal(requestPrototypeHasCalls, 0);

    const opened = await context.openOwnerOnlyExportDestination({ directory });
    let newPairReads = 0;
    await assert.rejects(
      context.writeOwnerOnlyPairNoClobberForDestination(opened.destination, {
        get firstBasename() { newPairReads += 1; throw new Error("canary new pair"); },
      }),
      /Paired export request is invalid/u,
    );
    assert.equal(newPairReads, 0);
    let artifactRequestReads = 0;
    await assert.rejects(
      context.readOwnerOnlyExportArtifactIfPresent(opened.destination, {
        get basename() { artifactRequestReads += 1; throw new Error("canary artifact request"); },
      }),
      /Owner-only export artifact request is invalid/u,
    );
    assert.equal(artifactRequestReads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("application lease facade preserves exact callback throws and normalizes platform failures", async () => {
  const context = application.createLocalExportArtifactStorageContext({
    createStorage: platform.createOwnerOnlyExportArtifactStorageContext,
    activityMarkerFile: platform.defaultActivityMarkerFile,
  });
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-callback-identity-"));
  try {
    const expected = new Error("callback canary identity");
    await assert.rejects(
      context.withExportDestinationLease(directory, async () => { throw expected; }),
      (actual) => actual === expected,
    );
    await assert.rejects(
      context.withExportDestinationLease(directory, async () => { throw "primitive callback identity"; }),
      (actual) => actual === "primitive callback identity",
    );
    await assert.rejects(
      context.withExportDestinationLease(join(directory, "missing"), async () => "never"),
      (error) => assertNoCanary(error, /Local export storage operation failed/u),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const exactLimit = new exportApi.ExportResourceLimitError("directory_entries");
  const resourceFacade = application.createLocalExportArtifactStorageContext({
    createStorage(configuration) {
      return {
        ...platform.createOwnerOnlyExportArtifactStorageContext(configuration),
        enumerateOwnerOnlyExportDestinationEntries: async () => { throw exactLimit; },
      };
    },
    activityMarkerFile: platform.defaultActivityMarkerFile,
  });
  await assert.rejects(
    resourceFacade.enumerateOwnerOnlyExportDestinationEntries(Object.freeze({})),
    (actual) => actual === exactLimit,
  );
});

test("opaque destination capabilities preserve absence, bounds, defensive bytes, recovery, and owner-only identities", async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-opaque-destination-"));
  const destinationPath = join(parent, "destination");
  const context = platform.createOwnerOnlyExportArtifactStorageContext(ownerStorageConfiguration());
  try {
    const opened = await context.openOwnerOnlyExportDestination({ directory: destinationPath });
    assert.equal(opened.status, "absent");
    await assert.rejects(
      context.enumerateOwnerOnlyExportDestinationEntries(Object.freeze({})),
      /capability is invalid/u,
    );
    assert.deepEqual(await context.enumerateOwnerOnlyExportDestinationEntries(opened.destination), []);
    assert.deepEqual(
      await context.readOwnerOnlyExportArtifactIfPresent(opened.destination, { basename: "bundle.umx" }),
      { status: "absent" },
    );
    assert.equal(
      await context.projectOwnerOnlyExportArtifactPath(opened.destination, { basename: "bundle.umx" }),
      join(await realpath(parent), "destination", "bundle.umx"),
    );
    await context.writeOwnerOnlyPairNoClobberForDestination(opened.destination, {
      firstBasename: "bundle.umx",
      firstContent: "bundle\n",
      secondBasename: "receipt.json",
      secondContent: "receipt\n",
    });
    const first = await context.readOwnerOnlyExportArtifactIfPresent(opened.destination, {
      basename: "bundle.umx",
      maximumBytes: 64,
    });
    assert.equal(first.status, "present");
    assert.equal(first.bytes.toString("utf8"), "bundle\n");
    first.bytes.fill(0);
    const second = await context.readOwnerOnlyExportArtifactIfPresent(opened.destination, { basename: "bundle.umx" });
    assert.equal(second.bytes.toString("utf8"), "bundle\n");
    assert.deepEqual(await context.enumerateOwnerOnlyExportDestinationEntries(opened.destination), [
      "bundle.umx", "receipt.json",
    ]);

    await link(join(destinationPath, "bundle.umx"), join(destinationPath, "bundle-copy.umx"));
    await assert.rejects(
      context.readOwnerOnlyExportArtifactIfPresent(opened.destination, { basename: "bundle.umx" }),
      /Invalid export recovery artifact/u,
    );
    await unlink(join(destinationPath, "bundle-copy.umx"));
    await chmod(join(destinationPath, "bundle.umx"), 0o644);
    await assert.rejects(
      context.readOwnerOnlyExportArtifactIfPresent(opened.destination, { basename: "bundle.umx" }),
      /Invalid export recovery artifact/u,
    );
    await chmod(join(destinationPath, "bundle.umx"), 0o600);

    const limited = platform.createOwnerOnlyExportArtifactStorageContext(ownerStorageConfiguration({
      maximumDirectoryEntries: 1,
    }));
    const limitedOpened = await limited.openOwnerOnlyExportDestination({ directory: destinationPath });
    await assert.rejects(
      limited.enumerateOwnerOnlyExportDestinationEntries(limitedOpened.destination),
      (error) => error instanceof exportApi.ExportResourceLimitError,
    );

    const interruptedPath = join(parent, "interrupted-destination");
    const interrupted = await context.openOwnerOnlyExportDestination({ directory: interruptedPath });
    await assert.rejects(
      context.writeOwnerOnlyPairNoClobberForDestination(interrupted.destination, {
        firstBasename: "bundle.umx",
        firstContent: "replayed bundle\n",
        secondBasename: "receipt.json",
        secondContent: "replayed receipt\n",
      }, {
        async failpoint(marker) {
          if (marker === "after_receipt") throw new Error("interrupted publication");
        },
      }),
      /interrupted publication/u,
    );
    assert.deepEqual(
      await context.recoverOwnerOnlyPairTransactionsForDestination(interrupted.destination),
      { recovered: 1, transactionsFound: 1 },
    );
    assert.equal(
      (await context.readOwnerOnlyExportArtifactIfPresent(interrupted.destination, {
        basename: "bundle.umx",
      })).bytes.toString("utf8"),
      "replayed bundle\n",
    );

    await rm(destinationPath, { recursive: true, force: true });
    await writeFile(destinationPath, "replacement");
    await assert.rejects(
      context.readOwnerOnlyExportArtifactIfPresent(opened.destination, { basename: "bundle.umx" }),
      /Export destination must be a real directory|Owner-only export destination changed/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("owner-only artifact reads use bounded positioned reads and report close failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-bounded-owner-read-"));
  const writer = platform.createOwnerOnlyExportArtifactStorageContext(ownerStorageConfiguration());
  try {
    await writer.writeOwnerOnlyPairNoClobber({
      firstPath: join(directory, "bundle.umx"),
      firstContent: "bundle\n",
      secondPath: join(directory, "receipt.json"),
      secondContent: "receipt\n",
    });

    const exactReader = platform.createOwnerOnlyExportArtifactStorageContext(ownerStorageConfiguration());
    const exactDestination = await exactReader.openOwnerOnlyExportDestination({ directory });
    assert.equal(
      (await exactReader.readOwnerOnlyExportArtifactIfPresent(exactDestination.destination, {
        basename: "bundle.umx",
      })).bytes.toString("utf8"),
      "bundle\n",
    );
    const closeFailure = platform.createOwnerOnlyExportArtifactStorageContext(ownerStorageConfiguration({
      async recoveryFileCloseFailpoint(...argumentsList) {
        assert.deepEqual(argumentsList, []);
        throw new Error("canary close");
      },
    }));
    const closeFailureDestination = await closeFailure.openOwnerOnlyExportDestination({ directory });
    await assert.rejects(
      closeFailure.readOwnerOnlyExportArtifactIfPresent(closeFailureDestination.destination, {
        basename: "bundle.umx",
      }),
      (error) => assertNoCanary(error, /recovery file close failed/u),
    );

  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
