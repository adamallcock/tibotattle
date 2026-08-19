import assert from "node:assert/strict";
import test from "node:test";

import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  createWindowsPreparedArtifactStorageContext,
  isWindowsPreparedArtifactStorage,
  isWindowsPreparedArtifactStorageError,
} from "../src/platform/windows-prepared-artifact-storage.js";
import {
  createWindowsPreparedContributionContext,
  isWindowsPreparedContributionContext,
} from "../src/application/windows-prepared-contribution.js";
import {
  materializeTelemetryContributions,
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
} from "../src/telemetry-contribution-builder.js";

const ROOT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\prepared";
const ROOT_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function childIdentity(number) {
  return Object.freeze({
    volumeSerialNumber: ROOT_IDENTITY.volumeSerialNumber,
    fileId: number.toString(16).padStart(32, "0"),
    linkCount: 1,
  });
}

function nativeError(code) {
  const error = new Error("native details must not cross the boundary");
  error.code = `WINDOWS_FILESYSTEM_${code}`;
  return error;
}

function metadata(identity, { directory = false } = {}) {
  return {
    identity,
    isDirectory: directory,
    isRegularFile: !directory,
    isReparsePoint: false,
    ownerMatches: true,
    nullDacl: false,
    daclProtected: true,
    broadAccess: false,
    nonOwnerAllow: false,
    unrecognizedAce: false,
    finalPathResolved: true,
  };
}

function windowsStorageFixture() {
  const entries = new Map([
    [ROOT, { identity: ROOT_IDENTITY, directory: true }],
  ]);
  const calls = [];
  let nextIdentity = 2;

  function absolute(relative) {
    return `${ROOT}\\${relative}`;
  }

  function requireRoot(rootPath, rootIdentity) {
    if (rootPath !== ROOT
        || rootIdentity.fileId !== ROOT_IDENTITY.fileId
        || rootIdentity.volumeSerialNumber
          !== ROOT_IDENTITY.volumeSerialNumber
        || rootIdentity.linkCount !== ROOT_IDENTITY.linkCount) {
      throw nativeError("IDENTITY_MISMATCH");
    }
  }

  function readEntry(relative) {
    const entry = entries.get(absolute(relative));
    if (!entry) throw nativeError("NOT_FOUND");
    return entry;
  }

  function ensureDirectoryPath(relative) {
    let current = "";
    let selected;
    for (const component of relative.split("\\")) {
      current = current ? `${current}\\${component}` : component;
      const path = absolute(current);
      selected = entries.get(path);
      if (!selected) {
        selected = {
          identity: childIdentity(nextIdentity),
          directory: true,
        };
        nextIdentity += 1;
        entries.set(path, selected);
      } else if (!selected.directory) {
        throw nativeError("NOT_DIRECTORY");
      }
    }
    return selected.identity;
  }

  function moveTree(source, target) {
    const sourcePrefix = `${absolute(source)}\\`;
    const moved = [];
    for (const [path, entry] of entries) {
      if (path === absolute(source) || path.startsWith(sourcePrefix)) {
        moved.push([path, entry]);
      }
    }
    if (moved.length === 0) throw nativeError("NOT_FOUND");
    for (const [path] of moved) entries.delete(path);
    for (const [path, entry] of moved) {
      const suffix = path.slice(absolute(source).length);
      entries.set(`${absolute(target)}${suffix}`, entry);
    }
    return moved[0][1];
  }

  function replaceDirectory(relative) {
    const path = absolute(relative);
    const entry = entries.get(path);
    if (!entry?.directory) throw new Error("directory fixture is missing");
    entries.set(path, {
      identity: childIdentity(nextIdentity),
      directory: true,
    });
    nextIdentity += 1;
  }

  const binding = {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion:
      "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion:
      "windows-companion-instance-mutex-v1",
    preparedArtifactContractVersion: "windows-prepared-artifact-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
    companionInstanceMutexSafe: false,
    preparedArtifactSafe: false,
    inspectPath(path) {
      calls.push(["inspectPath", path]);
      if (path !== ROOT) throw nativeError("NOT_FOUND");
      return metadata(ROOT_IDENTITY, { directory: true });
    },
    ensureDirectory(path) {
      calls.push(["ensureDirectory", path]);
      if (path !== ROOT) throw nativeError("NOT_FOUND");
      return ROOT_IDENTITY;
    },
    readFile() { throw nativeError("OPERATION_FAILED"); },
    readFileBounded() { throw nativeError("OPERATION_FAILED"); },
    createFile() { throw nativeError("OPERATION_FAILED"); },
    deleteFile() { throw nativeError("OPERATION_FAILED"); },
    replaceFile() { throw nativeError("OPERATION_FAILED"); },
    inspectProtectedChild() { throw nativeError("OPERATION_FAILED"); },
    readProtectedChild() { throw nativeError("OPERATION_FAILED"); },
    createProtectedChild() { throw nativeError("OPERATION_FAILED"); },
    deleteProtectedChild() { throw nativeError("OPERATION_FAILED"); },
    replaceProtectedChild() { throw nativeError("OPERATION_FAILED"); },
    acquireSqliteStateLease() { throw nativeError("OPERATION_FAILED"); },
    releaseSqliteStateLease() {},
    acquireCredentialAuditFileGuard() { throw nativeError("OPERATION_FAILED"); },
    releaseCredentialAuditFileGuard() {},
    acquireCredentialMutex() { throw nativeError("OPERATION_FAILED"); },
    releaseCredentialMutex() {},
    acquireCompanionInstanceMutex() { throw nativeError("OPERATION_FAILED"); },
    releaseCompanionInstanceMutex() {},
    inspectPreparedChild(rootPath, rootIdentity, childPath) {
      calls.push(["inspectPreparedChild", rootPath, rootIdentity, childPath]);
      requireRoot(rootPath, rootIdentity);
      const entry = readEntry(childPath);
      return metadata(entry.identity, { directory: entry.directory });
    },
    ensurePreparedDirectory(rootPath, rootIdentity, childPath) {
      calls.push(["ensurePreparedDirectory", rootPath, rootIdentity, childPath]);
      requireRoot(rootPath, rootIdentity);
      return ensureDirectoryPath(childPath);
    },
    enumeratePreparedDirectory(rootPath, rootIdentity, childPath, maximumEntries) {
      calls.push([
        "enumeratePreparedDirectory",
        rootPath,
        rootIdentity,
        childPath,
        maximumEntries,
      ]);
      requireRoot(rootPath, rootIdentity);
      const prefix = `${absolute(childPath)}\\`;
      const result = [];
      for (const [path, entry] of entries) {
        if (!path.startsWith(prefix)) continue;
        const name = path.slice(prefix.length);
        if (name.includes("\\")) continue;
        result.push({
          name,
          identity: entry.identity,
          isDirectory: entry.directory,
          isRegularFile: !entry.directory,
          isReparsePoint: false,
        });
      }
      if (result.length > maximumEntries) {
        throw nativeError("PREPARED_DIRECTORY_LIMIT");
      }
      return result;
    },
    removePreparedDirectory(rootPath, rootIdentity, childPath, expected) {
      calls.push(["removePreparedDirectory", rootPath, rootIdentity, childPath, expected]);
      requireRoot(rootPath, rootIdentity);
      const entry = readEntry(childPath);
      if (!entry.directory || entry.identity.fileId !== expected.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      const prefix = `${absolute(childPath)}\\`;
      if ([...entries.keys()].some((path) => path.startsWith(prefix))) {
        throw nativeError("PREPARED_DIRECTORY_NOT_EMPTY");
      }
      entries.delete(absolute(childPath));
      return { removed: true, identity: entry.identity };
    },
    renamePreparedDirectory(rootPath, rootIdentity, source, expected, target) {
      calls.push(["renamePreparedDirectory", rootPath, rootIdentity, source, expected, target]);
      requireRoot(rootPath, rootIdentity);
      const entry = readEntry(source);
      if (!entry.directory || entry.identity.fileId !== expected.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      if (entries.has(absolute(target))) throw nativeError("ALREADY_EXISTS");
      moveTree(source, target);
      return { renamed: true, identity: entry.identity };
    },
    createPreparedFile(rootPath, rootIdentity, childPath, data) {
      calls.push(["createPreparedFile", rootPath, rootIdentity, childPath, Buffer.from(data)]);
      requireRoot(rootPath, rootIdentity);
      if (entries.has(absolute(childPath))) throw nativeError("ALREADY_EXISTS");
      const identity = childIdentity(nextIdentity);
      nextIdentity += 1;
      entries.set(absolute(childPath), {
        identity,
        directory: false,
        data: Buffer.from(data),
      });
      return identity;
    },
    readPreparedFile(rootPath, rootIdentity, childPath, maximumBytes) {
      calls.push(["readPreparedFile", rootPath, rootIdentity, childPath, maximumBytes]);
      requireRoot(rootPath, rootIdentity);
      const entry = readEntry(childPath);
      if (entry.directory) throw nativeError("NOT_REGULAR_FILE");
      if (entry.data.length > maximumBytes) throw nativeError("FILE_TOO_LARGE");
      return { data: Buffer.from(entry.data), identity: entry.identity };
    },
    deletePreparedFile(rootPath, rootIdentity, childPath, expected) {
      calls.push(["deletePreparedFile", rootPath, rootIdentity, childPath, expected]);
      requireRoot(rootPath, rootIdentity);
      const entry = readEntry(childPath);
      if (entry.directory || entry.identity.fileId !== expected.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      entries.delete(absolute(childPath));
      return { deleted: true, identity: entry.identity };
    },
    publishPreparedFile(rootPath, rootIdentity, source, expected, target) {
      calls.push(["publishPreparedFile", rootPath, rootIdentity, source, expected, target]);
      requireRoot(rootPath, rootIdentity);
      const entry = readEntry(source);
      if (entry.directory || entry.identity.fileId !== expected.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      if (entries.has(absolute(target))) throw nativeError("ALREADY_EXISTS");
      moveTree(source, target);
      return { published: true, identity: entry.identity };
    },
  };
  return {
    calls,
    replaceDirectory,
    storage: createWindowsPreparedArtifactStorageContext({
      adapter: createWindowsFilesystemAdapter({
        platform: "win32",
        architecture: "x64",
        binding,
      }),
      rootPath: ROOT,
    }),
  };
}

function contributionBundle() {
  return {
    schemaVersion: "usage-metadata-bundle-v0.1",
    createdAt: "2026-07-26T23:24:52.000Z",
    coveredAt: {
      startAt: "2026-07-26T23:00:00.000Z",
      endAt: "2026-07-26T23:24:52.000Z",
    },
    clientPlatform: "windows",
    records: {
      usageEvents: [{
        schemaVersion: "usage-event-v0.1",
        eventTime: "2026-07-26T23:00:06.717Z",
        provider: "openai_codex",
        modelId: "gpt-5.6-sol",
        modelRecognition: "recognized",
        modelFingerprint: null,
        billingSurface: "chatgpt_subscription",
        speedMode: "standard",
        apiServiceTier: "unknown",
        reasoningEffort: "unknown",
        components: {
          inputUncachedTokens: 101,
          inputCacheReadTokens: 200,
          inputCacheWriteTokens: 0,
          outputTextTokens: 5,
          outputReasoningTokens: 2,
        },
        totalInputContextTokens: 301,
        surface: "extension_or_ide",
        agentScope: "root",
        lineageDisposition: "standalone",
        toolClassCounts: {
          webSearch: 0,
          fileSearch: 0,
          codeInterpreter: 0,
          hostedShell: 0,
          computerUse: 0,
          mcp: 0,
          applyPatch: 0,
          localShell: 0,
          subagent: 0,
          toolGateway: 0,
          other: 0,
          unknown: 0,
        },
        outcome: "unknown",
        eventId: `event:v2:${"a".repeat(64)}`,
        sessionScopeId: `session:v1:${"b".repeat(64)}`,
        accountScopeId: "unattributed",
      }],
      quotaSnapshots: [],
      activityMarkers: [],
    },
  };
}

function createWindowsContext() {
  const fixture = windowsStorageFixture();
  const context = createWindowsPreparedContributionContext({
    storage: fixture.storage,
    isStorage: isWindowsPreparedArtifactStorage,
    isStorageError: isWindowsPreparedArtifactStorageError,
    uuid: () => "00000000-0000-4000-8000-000000000099",
  });
  return { ...fixture, context };
}

test("Windows prepared application context requires an authentic storage brand", () => {
  const { storage } = createWindowsContext();
  assert.throws(
    () => createWindowsPreparedContributionContext({
      storage: {},
      isStorage: isWindowsPreparedArtifactStorage,
      isStorageError: isWindowsPreparedArtifactStorageError,
    }),
    /storage is invalid/u,
  );
  assert.throws(
    () => createWindowsPreparedContributionContext({
      storage: { ...storage },
      isStorage: isWindowsPreparedArtifactStorage,
      isStorageError: isWindowsPreparedArtifactStorageError,
    }),
    /storage is invalid/u,
  );
  const { context } = createWindowsContext();
  assert.equal(isWindowsPreparedContributionContext(context), true);
  assert.equal(isWindowsPreparedContributionContext({ ...context }), false);
  assert.equal(context.readiness, false);
  assert.equal(context.productionSafe, false);
  assert.equal(storage.readiness, false);
});

test("Windows materialization uses only the injected branded storage context", async () => {
  const { calls, context } = createWindowsContext();
  const outputDirectory = `${ROOT}\\prepared-set-00000000-0000-4000-8000-000000000001`;
  context.ensureDirectory(outputDirectory);
  await assert.rejects(
    materializeTelemetryContributions({
      bundleFile: "C:\\source\\review.umx.json",
      receiptFile: "C:\\source\\review.umx.json.privacy-receipt.json",
      outputDirectory,
      preparedContributionContext: { ...context },
      isPreparedContributionContext: isWindowsPreparedContributionContext,
      async loadVerifiedSource() {
        assert.fail("forged prepared context must be rejected first");
      },
    }),
    (error) => error?.code === "prepared_context_invalid",
  );
  const result = await materializeTelemetryContributions({
    bundleFile: "C:\\source\\review.umx.json",
    receiptFile: "C:\\source\\review.umx.json.privacy-receipt.json",
    outputDirectory,
    preparedContributionContext: context,
    isPreparedContributionContext: isWindowsPreparedContributionContext,
    async loadVerifiedSource() {
      return {
        bundle: contributionBundle(),
        summary: {
          verdict: "passed",
          transportReady: false,
        },
      };
    },
  });
  assert.equal(result.sourcePrivacyVerdict, "passed");
  assert.equal(result.batchCount, 1);
  assert.equal(result.preparedSet.manifestBasename,
    "prepared-contribution-set-v0.1.json");
  assert.ok(calls.some(([name]) => name === "createPreparedFile"));
  assert.ok(calls.some(([name]) => name === "publishPreparedFile"));
  assert.match(
    result.files[0].file,
    /prepared-set-00000000-0000-4000-8000-000000000001[\\/]telemetry-contribution-000001\.json$/u,
  );
  assert.equal(result.files[0].basename, "telemetry-contribution-000001.json");
  assert.equal(result.builderVersion, TELEMETRY_CONTRIBUTION_BUILDER_VERSION);
  // The context's verifier reopens the native-backed bytes; no POSIX verifier
  // or hard-link publication path is involved in this run.
  assert.ok(calls.filter(([name]) => name === "readPreparedFile").length >= 2);
  await assert.rejects(
    materializeTelemetryContributions({
      bundleFile: "C:\\source\\review.umx.json",
      receiptFile: "C:\\source\\review.umx.json.privacy-receipt.json",
      outputDirectory,
      preparedContributionContext: context,
      isPreparedContributionContext: isWindowsPreparedContributionContext,
      async loadVerifiedSource() {
        return {
          bundle: contributionBundle(),
          summary: { verdict: "passed", transportReady: false },
        };
      },
    }),
    (error) => error?.code === "prepared_contribution_set_publication_invalid",
  );
});

test("Windows staging remains uncommitted when manifest publication is interrupted", async () => {
  const { calls, context } = createWindowsContext();
  const outputDirectory = `${ROOT}\\preparing-00000000-0000-4000-8000-000000000002`;
  context.ensureDirectory(outputDirectory);
  await assert.rejects(
    materializeTelemetryContributions({
      bundleFile: "C:\\source\\review.umx.json",
      receiptFile: "C:\\source\\review.umx.json.privacy-receipt.json",
      outputDirectory,
      preparedContributionContext: context,
      isPreparedContributionContext: isWindowsPreparedContributionContext,
      async loadVerifiedSource() {
        return {
          bundle: contributionBundle(),
          summary: { verdict: "passed", transportReady: false },
        };
      },
      async failpoint(name) {
        if (name === "after_manifest_stage") {
          throw new Error("simulated interruption");
        }
      },
    }),
    /simulated interruption/u,
  );
  assert.ok(calls.some(([name, , , relative]) =>
    name === "createPreparedFile"
      && relative.includes("preparing-00000000-0000-4000-8000-000000000002")
      && relative.endsWith(".stage")));
  assert.equal(
    calls.some(([name, , , relative]) =>
      name === "publishPreparedFile"
        && relative.endsWith("prepared-contribution-set-v0.1.json")),
    false,
  );
});

test("Windows prepared handles reject same-root directory identity replacement", async () => {
  const { calls, context, replaceDirectory } = createWindowsContext();
  const outputDirectory = `${ROOT}\\identity-swap`;
  context.ensureDirectory(outputDirectory);
  const handle = context.ensureDirectory(outputDirectory);
  replaceDirectory("identity-swap");
  const createCallsBefore = calls.filter(([name]) => name === "createPreparedFile").length;
  await assert.rejects(
    context.publishPreparedContributionFile({
      directory: handle,
      name: "telemetry-contribution-000001.json",
      content: "x",
    }),
    (error) => error?.code === "prepared_contribution_set_directory_invalid",
  );
  assert.equal(
    calls.filter(([name]) => name === "createPreparedFile").length,
    createCallsBefore,
  );
});
