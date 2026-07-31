import assert from "node:assert/strict";
import test from "node:test";

import {
  createOwnerOnlyLocalMetadataBundlePairReader,
} from "../src/platform/local-metadata-bundle-files.js";

class SafeFileError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const OWNER_UID = typeof process.getuid === "function"
  ? process.getuid()
  : 501;
const PARENT_PATH = "/virtual";
const BUNDLE_PATH = `${PARENT_PATH}/bundle.json`;
const RECEIPT_PATH = `${PARENT_PATH}/receipt.json`;

function directoryStats({
  dev = 1,
  ino = 10,
  uid = OWNER_UID,
  mode = 0o40700,
} = {}) {
  return {
    dev,
    ino,
    uid,
    mode,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
}

function fileStats({
  dev = 1,
  ino,
  size,
  uid = OWNER_UID,
  mode = 0o100600,
  nlink = 1,
  mtimeMs = 100,
  ctimeMs = 100,
} = {}) {
  return {
    dev,
    ino,
    size,
    uid,
    mode,
    nlink,
    mtimeMs,
    ctimeMs,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem({
  bundleBytes = Buffer.from("bundle"),
  receiptBytes = Buffer.from("receipt"),
  realpathOverride = null,
  lstatOverride = null,
  openOverride = null,
} = {}) {
  const calls = {
    allocations: [],
    lstats: [],
    opens: [],
    reads: [],
    realpaths: [],
  };
  const sources = new Map([
    [BUNDLE_PATH, bundleBytes],
    [RECEIPT_PATH, receiptBytes],
  ]);
  const identities = new Map([
    [BUNDLE_PATH, 21],
    [RECEIPT_PATH, 22],
  ]);
  const pathLstatCounts = new Map();
  const descriptorStatCounts = new Map();

  const fileSystem = {
    allocate(size) {
      calls.allocations.push(size);
      return Buffer.allocUnsafe(size);
    },
    async realpath(path) {
      calls.realpaths.push(path);
      if (realpathOverride) {
        return realpathOverride(path, calls.realpaths.length);
      }
      return PARENT_PATH;
    },
    async lstat(path) {
      calls.lstats.push(path);
      const call = (pathLstatCounts.get(path) ?? 0) + 1;
      pathLstatCounts.set(path, call);
      if (lstatOverride) {
        const overridden = lstatOverride(path, call);
        if (overridden !== undefined) return overridden;
      }
      if (path === PARENT_PATH) return directoryStats();
      const source = sources.get(path);
      if (!source) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return fileStats({
        ino: identities.get(path),
        size: source.byteLength,
      });
    },
    async open(path, flags) {
      calls.opens.push({ path, flags });
      if (openOverride) {
        const overridden = await openOverride(path, flags, {
          calls,
          identities,
          sources,
        });
        if (overridden !== undefined) return overridden;
      }
      const source = sources.get(path);
      const ino = identities.get(path);
      if (!source || ino === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return {
        async close() {},
        async read(target, offset, length, position) {
          calls.reads.push({ length, path, position });
          if (position >= source.byteLength) return { bytesRead: 0 };
          const bytesRead = Math.min(length, source.byteLength - position);
          target.set(
            source.subarray(position, position + bytesRead),
            offset,
          );
          return { bytesRead };
        },
        async stat() {
          const call = (descriptorStatCounts.get(path) ?? 0) + 1;
          descriptorStatCounts.set(path, call);
          return fileStats({ ino, size: source.byteLength });
        },
      };
    },
  };
  return { calls, fileSystem };
}

function readerOptions(overrides = {}) {
  return {
    bundleFile: BUNDLE_PATH,
    receiptFile: RECEIPT_PATH,
    maximumBundleBytes: 1024,
    maximumReceiptBytes: 1024,
    createError: (code) => new SafeFileError(code),
    ...overrides,
  };
}

function assertCode(expectedCode) {
  return (error) =>
    error instanceof SafeFileError && error.code === expectedCode;
}

test("limits fail closed before any filesystem operation", async () => {
  for (const scenario of [
    {
      overrides: { maximumBundleBytes: 0 },
      code: "maximum_bundle_bytes",
    },
    {
      overrides: { maximumBundleBytes: Number.MAX_SAFE_INTEGER + 1 },
      code: "maximum_bundle_bytes",
    },
    {
      overrides: { maximumReceiptBytes: undefined },
      code: "maximum_receipt_bytes",
    },
  ]) {
    const { calls, fileSystem } = createFakeFileSystem();
    const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
      fileSystem,
    });
    await assert.rejects(
      readPair(readerOptions(scenario.overrides)),
      assertCode(scenario.code),
    );
    assert.equal(calls.realpaths.length, 0);
    assert.equal(calls.lstats.length, 0);
    assert.equal(calls.opens.length, 0);
    assert.equal(calls.allocations.length, 0);
  }
});

test("reads each exact descriptor size with only a one-byte growth probe", async () => {
  const bundleBytes = Buffer.from("12345");
  const receiptBytes = Buffer.from("abc");
  const { calls, fileSystem } = createFakeFileSystem({
    bundleBytes,
    receiptBytes,
  });
  const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
    fileSystem,
  });

  const result = await readPair(readerOptions({
    maximumBundleBytes: bundleBytes.byteLength,
    maximumReceiptBytes: receiptBytes.byteLength,
  }));

  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result.bundleBytes, bundleBytes);
  assert.deepEqual(result.receiptBytes, receiptBytes);
  assert.deepEqual(
    calls.allocations,
    [receiptBytes.byteLength, 1, bundleBytes.byteLength, 1],
  );
  assert.deepEqual(
    calls.reads.map(({ length, path, position }) => ({
      length,
      path,
      position,
    })),
    [
      { length: receiptBytes.byteLength, path: RECEIPT_PATH, position: 0 },
      { length: 1, path: RECEIPT_PATH, position: receiptBytes.byteLength },
      { length: bundleBytes.byteLength, path: BUNDLE_PATH, position: 0 },
      { length: 1, path: BUNDLE_PATH, position: bundleBytes.byteLength },
    ],
  );
});

test("supports partial descriptor reads without widening any allocation", async () => {
  const { calls, fileSystem } = createFakeFileSystem({
    openOverride(path, _flags, { calls: observed, identities, sources }) {
      if (path !== RECEIPT_PATH) return undefined;
      const source = sources.get(path);
      return {
        async close() {},
        async read(target, offset, length, position) {
          observed.reads.push({ length, path, position });
          if (position >= source.byteLength) return { bytesRead: 0 };
          const bytesRead = Math.min(
            2,
            length,
            source.byteLength - position,
          );
          target.set(
            source.subarray(position, position + bytesRead),
            offset,
          );
          return { bytesRead };
        },
        async stat() {
          return fileStats({
            ino: identities.get(path),
            size: source.byteLength,
          });
        },
      };
    },
  });
  const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
    fileSystem,
  });

  const result = await readPair(readerOptions());

  assert.equal(result.receiptBytes.toString("utf8"), "receipt");
  assert.deepEqual(calls.allocations, [7, 1, 6, 1]);
  assert.deepEqual(
    calls.reads.filter(({ path }) => path === RECEIPT_PATH)
      .map(({ length, position }) => ({ length, position })),
    [
      { length: 7, position: 0 },
      { length: 5, position: 2 },
      { length: 3, position: 4 },
      { length: 1, position: 6 },
      { length: 1, position: 7 },
    ],
  );
});

test("detects growth with the one-byte probe before post-read parsing", async () => {
  const { calls, fileSystem } = createFakeFileSystem({
    openOverride(path, _flags, { calls: observed, identities, sources }) {
      if (path !== RECEIPT_PATH) return undefined;
      const original = sources.get(path);
      const grown = Buffer.concat([original, Buffer.from("x")]);
      return {
        async close() {},
        async read(target, offset, length, position) {
          observed.reads.push({ length, path, position });
          if (position >= grown.byteLength) return { bytesRead: 0 };
          const bytesRead = Math.min(length, grown.byteLength - position);
          target.set(grown.subarray(position, position + bytesRead), offset);
          return { bytesRead };
        },
        async stat() {
          return fileStats({
            ino: identities.get(path),
            size: original.byteLength,
          });
        },
      };
    },
  });
  const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
    fileSystem,
  });

  await assert.rejects(
    readPair(readerOptions()),
    assertCode("receipt_changed_during_read"),
  );
  assert.deepEqual(calls.allocations, [7, 1]);
  assert.deepEqual(
    calls.reads.map(({ length, position }) => ({ length, position })),
    [
      { length: 7, position: 0 },
      { length: 1, position: 7 },
    ],
  );
});

test("rejects oversized and non-owner artifacts before open or allocation", async () => {
  for (const scenario of [
    {
      lstatOverride(path) {
        if (path === RECEIPT_PATH) {
          return fileStats({ ino: 22, size: 1025 });
        }
        return undefined;
      },
      code: "receipt_size",
    },
    {
      lstatOverride(path) {
        if (path === RECEIPT_PATH) {
          return fileStats({
            ino: 22,
            size: 7,
            uid: OWNER_UID + 1,
          });
        }
        return undefined;
      },
      code: "receipt_owner",
    },
  ]) {
    const { calls, fileSystem } = createFakeFileSystem(scenario);
    const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
      fileSystem,
    });
    await assert.rejects(
      readPair(readerOptions()),
      assertCode(scenario.code),
    );
    assert.equal(calls.opens.length, 0);
    assert.equal(calls.allocations.length, 0);
  }
});

test("requires both requested paths to resolve under one canonical parent", async () => {
  const { calls, fileSystem } = createFakeFileSystem({
    realpathOverride(path) {
      return path === "/bundle-parent"
        ? "/canonical-bundle-parent"
        : "/canonical-receipt-parent";
    },
    lstatOverride(path) {
      if (
        path === "/canonical-bundle-parent"
        || path === "/canonical-receipt-parent"
      ) {
        return directoryStats();
      }
      return undefined;
    },
  });
  const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
    fileSystem,
  });
  await assert.rejects(
    readPair(readerOptions({
      bundleFile: "/bundle-parent/bundle.json",
      receiptFile: "/receipt-parent/receipt.json",
    })),
    assertCode("paths_not_adjacent"),
  );
  assert.equal(calls.opens.length, 0);
  assert.equal(calls.allocations.length, 0);
});

test("detects pathname replacement between lstat and descriptor open", async () => {
  const { calls, fileSystem } = createFakeFileSystem({
    openOverride(path, _flags, { sources }) {
      if (path !== RECEIPT_PATH) return undefined;
      const source = sources.get(path);
      return {
        async close() {},
        async read() {
          throw new Error("must not read");
        },
        async stat() {
          return fileStats({ ino: 999, size: source.byteLength });
        },
      };
    },
  });
  const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
    fileSystem,
  });
  await assert.rejects(
    readPair(readerOptions()),
    assertCode("receipt_changed_during_open"),
  );
  assert.equal(calls.opens.length, 1);
  assert.equal(calls.reads.length, 0);
  assert.equal(calls.allocations.length, 0);
});

test("detects same-inode mutation between lstat and descriptor open", async () => {
  const { calls, fileSystem } = createFakeFileSystem({
    openOverride(path, _flags, { identities, sources }) {
      if (path !== RECEIPT_PATH) return undefined;
      const source = sources.get(path);
      return {
        async close() {},
        async read() {
          throw new Error("must not read");
        },
        async stat() {
          return fileStats({
            ino: identities.get(path),
            size: source.byteLength,
            mtimeMs: 101,
            ctimeMs: 101,
          });
        },
      };
    },
  });
  const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
    fileSystem,
  });
  await assert.rejects(
    readPair(readerOptions()),
    assertCode("receipt_changed_during_open"),
  );
  assert.equal(calls.opens.length, 1);
  assert.equal(calls.allocations.length, 0);
});

test("detects pathname replacement after the bounded read", async () => {
  const { calls, fileSystem } = createFakeFileSystem({
    lstatOverride(path, call) {
      if (path === RECEIPT_PATH && call === 2) {
        return fileStats({ ino: 999, size: 7 });
      }
      return undefined;
    },
  });
  const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
    fileSystem,
  });
  await assert.rejects(
    readPair(readerOptions()),
    assertCode("receipt_changed_during_read"),
  );
  assert.deepEqual(calls.allocations, [7, 1]);
  assert.equal(calls.reads.length, 2);
});

test("detects canonical parent replacement after an artifact read", async () => {
  const { calls, fileSystem } = createFakeFileSystem({
    realpathOverride(_path, call) {
      return call >= 6 ? "/replacement-parent" : PARENT_PATH;
    },
  });
  const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
    fileSystem,
  });
  await assert.rejects(
    readPair(readerOptions()),
    assertCode("parent_directory_changed"),
  );
  assert.deepEqual(calls.allocations, [7, 1]);
  assert.equal(calls.reads.length, 2);
  assert.equal(calls.opens.length, 1);
});

test("detects same-path canonical parent inode replacement", async () => {
  let parentLstatCalls = 0;
  const { calls, fileSystem } = createFakeFileSystem({
    lstatOverride(path) {
      if (path !== PARENT_PATH) return undefined;
      parentLstatCalls += 1;
      return directoryStats({
        ino: parentLstatCalls >= 6 ? 999 : 10,
      });
    },
  });
  const readPair = createOwnerOnlyLocalMetadataBundlePairReader({
    fileSystem,
  });
  await assert.rejects(
    readPair(readerOptions()),
    assertCode("parent_directory_changed"),
  );
  assert.equal(calls.opens.length, 1);
});
