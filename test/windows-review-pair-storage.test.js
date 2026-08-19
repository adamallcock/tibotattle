import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_ARTIFACT_BYTES,
  createWindowsPreparedArtifactStorageContext,
} from "../src/platform/windows-prepared-artifact-storage.js";
import {
  WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_BUNDLE_BYTES,
  createWindowsReviewPairStorageContext,
  isWindowsReviewPairStorage,
} from "../src/platform/windows-review-pair-storage.js";

const ROOT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\prepared";
const ROOT_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function identity(number) {
  return Object.freeze({
    volumeSerialNumber: ROOT_IDENTITY.volumeSerialNumber,
    fileId: number.toString(16).padStart(32, "0"),
    linkCount: 1,
  });
}

function nativeError(code) {
  const error = new Error("native detail must not cross the boundary");
  error.code = `WINDOWS_FILESYSTEM_${code}`;
  return error;
}

function metadata(value, { directory = false } = {}) {
  return {
    identity: value,
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

function createFixture() {
  const entries = new Map([
    [ROOT, { identity: ROOT_IDENTITY, directory: true }],
  ]);
  const calls = [];
  let nextIdentity = 2;

  function full(relativeName) {
    return relativeName ? `${ROOT}\\${relativeName}` : ROOT;
  }

  function requireRoot(rootPath, rootIdentity) {
    if (rootPath !== ROOT
        || rootIdentity.fileId !== ROOT_IDENTITY.fileId
        || rootIdentity.volumeSerialNumber !== ROOT_IDENTITY.volumeSerialNumber
        || rootIdentity.linkCount !== ROOT_IDENTITY.linkCount) {
      throw nativeError("IDENTITY_MISMATCH");
    }
  }

  function get(relativeName) {
    const entry = entries.get(full(relativeName));
    if (!entry) throw nativeError("NOT_FOUND");
    return entry;
  }

  function ensureDirectory(relativeName) {
    const components = relativeName.split("\\");
    let current = "";
    let currentIdentity = ROOT_IDENTITY;
    for (const component of components) {
      current = current ? `${current}\\${component}` : component;
      const path = full(current);
      const existing = entries.get(path);
      if (existing && !existing.directory) throw nativeError("NOT_DIRECTORY");
      if (existing) {
        currentIdentity = existing.identity;
      } else {
        currentIdentity = identity(nextIdentity++);
        entries.set(path, { identity: currentIdentity, directory: true });
      }
    }
    return currentIdentity;
  }

  const binding = {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion: "windows-companion-instance-mutex-v1",
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
      if (path === ROOT) return ROOT_IDENTITY;
      requireRoot(ROOT, ROOT_IDENTITY);
      return ensureDirectory(path.slice(`${ROOT}\\`.length));
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
    acquireCredentialMutex() { return { lease: {}, abandoned: false }; },
    releaseCredentialMutex() {},
    acquireCompanionInstanceMutex() { return { lease: {}, abandoned: false }; },
    releaseCompanionInstanceMutex() {},
    acquireCredentialAuditFileGuard() { return { lease: {} }; },
    releaseCredentialAuditFileGuard() {},
    acquireSqliteStateLease() {
      return { lease: {}, databaseIdentity: ROOT_IDENTITY, journalIdentity: ROOT_IDENTITY };
    },
    releaseSqliteStateLease() {},
    inspectPreparedChild(rootPath, rootIdentity, childPath) {
      calls.push(["inspectPreparedChild", childPath]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(childPath);
      return metadata(entry.identity, { directory: entry.directory });
    },
    ensurePreparedDirectory(rootPath, rootIdentity, childPath) {
      calls.push(["ensurePreparedDirectory", childPath]);
      requireRoot(rootPath, rootIdentity);
      return ensureDirectory(childPath);
    },
    enumeratePreparedDirectory(rootPath, rootIdentity, childPath, maximumEntries) {
      calls.push(["enumeratePreparedDirectory", childPath]);
      requireRoot(rootPath, rootIdentity);
      const prefix = `${full(childPath)}\\`;
      const result = [];
      for (const [path, entry] of entries) {
        if (!path.startsWith(prefix)) continue;
        const remainder = path.slice(prefix.length);
        if (remainder.includes("\\")) continue;
        result.push({
          name: remainder,
          identity: entry.identity,
          isDirectory: entry.directory,
          isRegularFile: !entry.directory,
          isReparsePoint: false,
        });
      }
      if (result.length > maximumEntries) throw nativeError("PREPARED_DIRECTORY_LIMIT");
      return result;
    },
    removePreparedDirectory(rootPath, rootIdentity, childPath, expected) {
      calls.push(["removePreparedDirectory", childPath]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(childPath);
      if (!entry.directory || entry.identity.fileId !== expected.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      const prefix = `${full(childPath)}\\`;
      if ([...entries.keys()].some((path) => path.startsWith(prefix))) {
        throw nativeError("PREPARED_DIRECTORY_NOT_EMPTY");
      }
      entries.delete(full(childPath));
      return { removed: true, identity: entry.identity };
    },
    renamePreparedDirectory() { throw nativeError("OPERATION_FAILED"); },
    createPreparedFile(rootPath, rootIdentity, childPath, data) {
      calls.push(["createPreparedFile", childPath]);
      requireRoot(rootPath, rootIdentity);
      const path = full(childPath);
      if (entries.has(path)) throw nativeError("ALREADY_EXISTS");
      const parent = childPath.split("\\").slice(0, -1).join("\\");
      if (!get(parent).directory) throw nativeError("NOT_DIRECTORY");
      const fileIdentity = identity(nextIdentity++);
      entries.set(path, {
        identity: fileIdentity,
        directory: false,
        data: Buffer.from(data),
      });
      return fileIdentity;
    },
    readPreparedFile(rootPath, rootIdentity, childPath, maximumBytes) {
      calls.push(["readPreparedFile", childPath]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(childPath);
      if (entry.directory) throw nativeError("NOT_REGULAR_FILE");
      if (entry.data.length > maximumBytes) throw nativeError("FILE_TOO_LARGE");
      return { data: Buffer.from(entry.data), identity: entry.identity };
    },
    deletePreparedFile(rootPath, rootIdentity, childPath, expected) {
      calls.push(["deletePreparedFile", childPath]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(childPath);
      if (entry.directory || entry.identity.fileId !== expected.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      entries.delete(full(childPath));
      return { deleted: true, identity: entry.identity };
    },
    publishPreparedFile(rootPath, rootIdentity, source, expected, target) {
      calls.push(["publishPreparedFile", source, target]);
      requireRoot(rootPath, rootIdentity);
      const sourcePath = full(source);
      const targetPath = full(target);
      const entry = entries.get(sourcePath);
      if (!entry || entry.directory || entry.identity.fileId !== expected.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      if (entries.has(targetPath)) throw nativeError("ALREADY_EXISTS");
      entries.set(targetPath, entry);
      entries.delete(sourcePath);
      return { published: true, identity: entry.identity };
    },
  };
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  const storage = createWindowsPreparedArtifactStorageContext({
    adapter,
    rootPath: ROOT,
    maximumFileBytes: WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_ARTIFACT_BYTES,
  });
  return { entries, calls, storage };
}

function createContext() {
  const fixture = createFixture();
  const context = createWindowsReviewPairStorageContext({
    platform: "win32",
    storage: fixture.storage,
    createTransactionId: () => "123e4567-e89b-42d3-a456-426614174000",
  });
  return { fixture, context };
}

const PAIR = Object.freeze({
  directory: "reviews\\review-1",
  bundleName: "review.umx.json",
  receiptName: "review.umx.json.privacy-receipt.json",
  bundleContent: Buffer.from("bundle-bytes"),
  receiptContent: Buffer.from("receipt-bytes"),
});

test("Windows review-pair composition is branded and remains fail-closed", () => {
  const { storage } = createFixture();
  const context = createWindowsReviewPairStorageContext({
    platform: "win32",
    storage,
  });
  assert.equal(isWindowsReviewPairStorage(context), true);
  assert.equal(context.productionSafe, false);
  assert.equal(context.readiness, false);
  assert.equal(context.reviewPairSafe, false);
  assert.throws(
    () => createWindowsReviewPairStorageContext({
      platform: "win32",
      storage: { ...storage },
    }),
    (error) => error.code === "windows_review_pair_storage_invalid_storage",
  );
  assert.throws(
    () => createWindowsReviewPairStorageContext({ platform: "darwin", storage }),
    (error) => error.code === "windows_review_pair_storage_invalid_platform",
  );
});

test("Windows review pairs publish receipt first and read receipt first", async () => {
  const { fixture, context } = createContext();
  const result = await context.writeReviewPair(PAIR);
  assert.equal(result.status, "published");
  const publication = fixture.calls
    .filter(([method]) => method === "publishPreparedFile")
    .map(([, source, target]) => ({ source, target }));
  assert.deepEqual(publication, [
    {
      source: "reviews\\review-1\\.transaction-123e4567-e89b-42d3-a456-426614174000.receipt.stage",
      target: "reviews\\review-1\\review.umx.json.privacy-receipt.json",
    },
    {
      source: "reviews\\review-1\\.transaction-123e4567-e89b-42d3-a456-426614174000.bundle.stage",
      target: "reviews\\review-1\\review.umx.json",
    },
  ]);
  const readStart = fixture.calls.length;
  const pair = await context.readReviewPair(PAIR);
  assert.deepEqual(pair.bundleBytes, PAIR.bundleContent);
  assert.deepEqual(pair.receiptBytes, PAIR.receiptContent);
  const reads = fixture.calls.slice(readStart)
    .filter(([method]) => method === "readPreparedFile")
    .map(([, path]) => path);
  assert.deepEqual(reads, [
    "reviews\\review-1\\review.umx.json.privacy-receipt.json",
    "reviews\\review-1\\review.umx.json",
  ]);
  assert.equal(fixture.calls.some(([method]) => method === "link"), false);
  assert.equal(fixture.calls.some(([method]) => method === "symlink"), false);
});

test("Windows review-pair writer refuses an existing target without clobbering", async () => {
  const { context } = createContext();
  await context.writeReviewPair(PAIR);
  await assert.rejects(
    context.writeReviewPair({ ...PAIR, bundleContent: Buffer.from("replacement") }),
    (error) => error.code === "windows_review_pair_storage_already_exists"
      && error.message === "Windows review pair storage operation failed",
  );
});

test("Windows review-pair recovery completes a receipt-only partial publication", async () => {
  const { fixture, context } = createContext();
  await assert.rejects(
    context.writeReviewPair({
      ...PAIR,
      failpoint(marker) {
        if (marker === "after_receipt") throw new Error("simulated interruption");
      },
    }),
    (error) => error.code === "windows_review_pair_storage_unavailable",
  );
  assert.deepEqual(
    (await fixture.storage.readFile(
      `${PAIR.directory}\\${PAIR.receiptName}`,
      1024 * 1024,
    )).data,
    PAIR.receiptContent,
  );
  await assert.rejects(
    context.readReviewPair({ ...PAIR, bundleName: "missing.bundle.json" }),
    (error) => error.code === "windows_review_pair_storage_missing",
  );
  const recovered = await context.recoverReviewPairTransactions({
    directory: PAIR.directory,
  });
  assert.deepEqual(recovered, { recovered: 1, transactionsFound: 1 });
  const pair = await context.readReviewPair(PAIR);
  assert.deepEqual(pair.bundleBytes, PAIR.bundleContent);
  assert.deepEqual(pair.receiptBytes, PAIR.receiptContent);
  assert.equal(
    fixture.entries.has(`${ROOT}\\${PAIR.directory}\\.windows-review-pair-transactions`),
    false,
  );
});

test("Windows review-pair recovery rejects an identity-swapped published receipt", async () => {
  const { fixture, context } = createContext();
  await assert.rejects(
    context.writeReviewPair({
      ...PAIR,
      failpoint(marker) {
        if (marker === "after_receipt") throw new Error("simulated interruption");
      },
    }),
  );
  const receiptPath = `${ROOT}\\${PAIR.directory}\\${PAIR.receiptName}`;
  const original = fixture.entries.get(receiptPath);
  fixture.entries.set(receiptPath, {
    ...original,
    identity: Object.freeze({ ...original.identity, fileId: "00000000000000000000000000000099" }),
  });
  await assert.rejects(
    context.recoverReviewPairTransactions({ directory: PAIR.directory }),
    (error) => error.code === "windows_review_pair_storage_identity_mismatch",
  );
});

test("Windows review-pair storage enforces the 34 MiB bundle bound", async () => {
  const { context } = createContext();
  await assert.rejects(
    context.writeReviewPair({
      ...PAIR,
      bundleContent: Buffer.alloc(WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_BUNDLE_BYTES + 1),
    }),
    (error) => error.code === "windows_review_pair_storage_too_large",
  );
});

test("Windows review-pair compatibility ports use root-bound absolute paths", async () => {
  const { context } = createContext();
  const bundleFile = `${ROOT}\\reviews\\review-1\\review.umx.json`;
  const receiptFile = `${ROOT}\\reviews\\review-1\\review.umx.json.privacy-receipt.json`;
  await context.writeOwnerOnlyPairNoClobber({
    firstPath: bundleFile,
    firstContent: PAIR.bundleContent,
    secondPath: receiptFile,
    secondContent: PAIR.receiptContent,
  });
  const loaded = await context.readOwnerOnlyLocalMetadataBundlePair({
    bundleFile,
    receiptFile,
    maximumBundleBytes: 32 * 1024 * 1024,
    maximumReceiptBytes: 1024 * 1024,
  });
  assert.deepEqual(loaded.bundleBytes, PAIR.bundleContent);
  assert.deepEqual(loaded.receiptBytes, PAIR.receiptContent);
  await assert.rejects(
    context.writeOwnerOnlyPairNoClobber({
      firstPath: `${ROOT}\\..\\escape\\bundle.json`,
      firstContent: PAIR.bundleContent,
      secondPath: receiptFile,
      secondContent: PAIR.receiptContent,
    }),
    (error) => error.code === "windows_review_pair_storage_path_escape",
  );
});

test("Windows review-pair source has no Node filesystem or hard-link fallback", async () => {
  const source = await readFile("src/platform/windows-review-pair-storage.js", "utf8");
  assert.doesNotMatch(source, /from\s+["']node:fs(?:\/promises)?["']/u);
  assert.doesNotMatch(source, /\b(?:link|symlink|hardlink)\s*\(/u);
  assert.match(source, /isWindowsPreparedArtifactStorage/u);
  assert.match(source, /publishFile/u);
});
