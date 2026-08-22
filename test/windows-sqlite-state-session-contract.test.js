import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { constants as SQLITE_CONSTANTS } from "node:sqlite";
import test from "node:test";

import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  WINDOWS_SQLITE_STATE_SESSION_CONTRACT_VERSION,
  WindowsSqliteStateSessionError,
  createWindowsSqliteStateSession,
  isWindowsSqliteStateDatabase,
  isWindowsSqliteStateSession,
  isWindowsSqliteStateSessionError,
} from "../src/platform/windows-sqlite-state-session.js";

const ROOT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\state";
const DATABASE_NAME = "local-collector-state-v1.sqlite";
const IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function nativeError(code) {
  const error = new Error("native detail must not escape");
  error.code = `WINDOWS_FILESYSTEM_${code}`;
  return error;
}

function sameIdentity(left, right) {
  return left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId
    && left?.linkCount === right?.linkCount;
}

function metadata(identity = IDENTITY, overrides = {}) {
  return {
    identity,
    isDirectory: true,
    isRegularFile: false,
    isReparsePoint: false,
    ownerMatches: true,
    nullDacl: false,
    daclProtected: true,
    broadAccess: false,
    nonOwnerAllow: false,
    unrecognizedAce: false,
    finalPathResolved: true,
    ...overrides,
  };
}

function createFixture({
  bindingOverrides = {},
  rootMetadata = metadata(),
  databaseMetadata = metadata(IDENTITY, { isDirectory: false, isRegularFile: true }),
  journalMetadata = metadata(IDENTITY, { isDirectory: false, isRegularFile: true }),
  releaseError = null,
  releaseErrors = null,
} = {}) {
  const calls = [];
  const leases = new Set();
  const pendingReleaseErrors = Array.isArray(releaseErrors)
    ? [...releaseErrors]
    : null;
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
    companionInstanceMutexSafe: false,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
    preparedArtifactSafe: false,
    inspectPath(path) {
      calls.push(["inspectPath", path]);
      if (path !== ROOT) throw nativeError("NOT_FOUND");
      return rootMetadata;
    },
    ensureDirectory() {
      return IDENTITY;
    },
    readFile() {
      throw nativeError("NOT_FOUND");
    },
    readFileBounded() {
      throw nativeError("NOT_FOUND");
    },
    createFile() {
      throw nativeError("OPERATION_FAILED");
    },
    deleteFile() {
      throw nativeError("OPERATION_FAILED");
    },
    replaceFile() {
      throw nativeError("OPERATION_FAILED");
    },
    inspectProtectedChild(rootPath, rootIdentity, childPath) {
      calls.push(["inspectProtectedChild", rootPath, rootIdentity, childPath]);
      if (rootPath !== ROOT || !sameIdentity(rootIdentity, IDENTITY)) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      if (childPath.endsWith("-journal")) return journalMetadata;
      if (childPath === DATABASE_NAME || childPath.endsWith(".sqlite")) {
        return databaseMetadata;
      }
      throw nativeError("NOT_FOUND");
    },
    readProtectedChild() {
      throw nativeError("NOT_FOUND");
    },
    createProtectedChild() {
      throw nativeError("OPERATION_FAILED");
    },
    deleteProtectedChild() {
      throw nativeError("OPERATION_FAILED");
    },
    replaceProtectedChild() {
      throw nativeError("OPERATION_FAILED");
    },
    acquireCredentialAuditFileGuard() {
      throw nativeError("OPERATION_FAILED");
    },
    releaseCredentialAuditFileGuard() {},
    acquireCredentialMutex() {
      throw nativeError("OPERATION_FAILED");
    },
    releaseCredentialMutex() {},
    acquireCompanionInstanceMutex() {
      throw nativeError("OPERATION_FAILED");
    },
    releaseCompanionInstanceMutex() {},
    acquireSqliteStateLease(rootPath, rootIdentity, databaseName) {
      calls.push(["acquireSqliteStateLease", rootPath, rootIdentity, databaseName]);
      if (rootPath !== ROOT || !sameIdentity(rootIdentity, IDENTITY)) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      const lease = Object.freeze({ rootPath, databaseName, token: Symbol("lease") });
      leases.add(lease);
      return {
        databaseIdentity: IDENTITY,
        journalIdentity: IDENTITY,
        lease,
      };
    },
    releaseSqliteStateLease(lease) {
      calls.push(["releaseSqliteStateLease", lease]);
      if (pendingReleaseErrors !== null && pendingReleaseErrors.length > 0) {
        throw pendingReleaseErrors.shift();
      }
      if (releaseError !== null) throw releaseError;
      if (!leases.delete(lease)) throw nativeError("IDENTITY_MISMATCH");
    },
    inspectPreparedChild: () => ({ identity: IDENTITY }),
    ensurePreparedDirectory: () => IDENTITY,
    enumeratePreparedDirectory: () => [],
    removePreparedDirectory: () => ({ removed: true, identity: IDENTITY }),
    renamePreparedDirectory: () => ({ renamed: true, identity: IDENTITY }),
    createPreparedFile: () => IDENTITY,
    readPreparedFile: () => ({ data: Buffer.from("data"), identity: IDENTITY }),
    deletePreparedFile: () => ({ deleted: true, identity: IDENTITY }),
    publishPreparedFile: () => ({ published: true, identity: IDENTITY }),
    ...bindingOverrides,
  };
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  return { adapter, binding, calls, leases };
}

function createDatabase({
  calls,
  pragmaValues = {},
  closeError = null,
  rollbackError = null,
  authorizer = true,
  transaction = false,
} = {}) {
  const values = {
    journal_mode: "persist",
    synchronous: 2,
    foreign_keys: 1,
    trusted_schema: 0,
    temp_store: 2,
    mmap_size: 0,
    ...pragmaValues,
  };
  let isOpen = true;
  let isTransaction = transaction;
  let registeredAuthorizer = null;
  function authorize(sql) {
    if (typeof registeredAuthorizer !== "function") return;
    const pragma = /^\s*PRAGMA\s+(?:[a-z_]+\.)?([a-z_]+)(?:\s*=\s*([^;\s]+))?/iu.exec(sql);
    if (pragma !== null
        && registeredAuthorizer(
          SQLITE_CONSTANTS.SQLITE_PRAGMA,
          pragma[1],
          pragma[2] ?? null,
          null,
          null,
        ) === SQLITE_CONSTANTS.SQLITE_DENY) {
      throw new Error("not authorized");
    }
    if (/^\s*ATTACH\b/iu.test(sql)
        && registeredAuthorizer(SQLITE_CONSTANTS.SQLITE_ATTACH, null, null, null, null)
          === SQLITE_CONSTANTS.SQLITE_DENY) {
      throw new Error("not authorized");
    }
    if (/^\s*DETACH\b/iu.test(sql)
        && registeredAuthorizer(SQLITE_CONSTANTS.SQLITE_DETACH, null, null, null, null)
          === SQLITE_CONSTANTS.SQLITE_DENY) {
      throw new Error("not authorized");
    }
  }
  const database = {
    get isOpen() {
      return isOpen;
    },
    get isTransaction() {
      return isTransaction;
    },
    exec(sql) {
      authorize(sql);
      calls.push(["exec", sql]);
      if (sql === "ROLLBACK;" && rollbackError !== null) throw rollbackError;
      if (sql === "ROLLBACK;") isTransaction = false;
    },
    prepare(sql) {
      calls.push(["prepare", sql]);
      const match = /^PRAGMA ([a-z_]+)(?:=([a-z_]+))?;?$/iu.exec(sql);
      return {
        get() {
          authorize(sql);
          calls.push(["readback", match?.[1] ?? null]);
          if (match === null) return undefined;
          return { [match[1]]: values[match[1]] };
        },
      };
    },
    enableDefensive(value) {
      calls.push(["enableDefensive", value]);
    },
    ...(authorizer ? {
      setAuthorizer(callback) {
        calls.push(["setAuthorizer"]);
        registeredAuthorizer = callback;
      },
    } : {}),
    close() {
      calls.push(["close"]);
      if (closeError !== null) throw closeError;
      isOpen = false;
    },
    get registeredAuthorizer() {
      return registeredAuthorizer;
    },
  };
  return database;
}

function sessionOptions(fixture, database, overrides = {}) {
  return {
    platform: "win32",
    architecture: "x64",
    adapter: fixture.adapter,
    rootPath: ROOT,
    databaseName: DATABASE_NAME,
    databaseFactory(path) {
      fixture.calls.push(["databaseFactory", path]);
      return database;
    },
    ...overrides,
  };
}

function assertSessionError(code) {
  return (error) => {
    assert.equal(isWindowsSqliteStateSessionError(error), true);
    assert.equal(error instanceof WindowsSqliteStateSessionError, true);
    assert.equal(error.code, `windows_sqlite_state_session_${code}`);
    assert.equal(error.message, "Windows SQLite state session operation failed");
    return true;
  };
}

test("the Windows SQLite session is branded, root-bound, and lease-first", () => {
  const fixture = createFixture();
  const databaseCalls = [];
  const database = createDatabase({ calls: databaseCalls });
  const session = createWindowsSqliteStateSession(sessionOptions(fixture, database));

  assert.equal(isWindowsSqliteStateSession(session), true);
  assert.equal(isWindowsSqliteStateSession({ ...session }), false);
  assert.equal(session.contractVersion, WINDOWS_SQLITE_STATE_SESSION_CONTRACT_VERSION);
  assert.equal(session.productionSafe, false);
  assert.equal(session.sqliteStateLeaseSafe, false);
  assert.equal(session.rootPath, ROOT);
  assert.equal(session.databaseName, DATABASE_NAME);
  assert.notEqual(session.database, database);
  assert.equal(isWindowsSqliteStateDatabase(session.database), true);
  assert.equal(isWindowsSqliteStateDatabase({ ...session.database }), false);
  assert.equal(typeof session.database.exec, "function");
  assert.equal(typeof session.database.prepare, "function");
  assert.equal(typeof session.database.isOpen, "boolean");
  assert.equal(typeof session.database.isTransaction, "boolean");
  for (const hidden of ["close", "setAuthorizer", "enableDefensive", "location"]) {
    assert.equal(session.database[hidden], undefined);
  }
  assert.deepEqual(
    fixture.calls.map(([name]) => name),
    [
      "inspectPath",
      "acquireSqliteStateLease",
      "databaseFactory",
      "inspectProtectedChild",
      "inspectProtectedChild",
    ],
  );
  assert.equal(fixture.calls[1][3], DATABASE_NAME);
  assert.equal(fixture.calls[2][1], `${ROOT}\\${DATABASE_NAME}`);
  assert.equal(fixture.calls[3][3], DATABASE_NAME);
  assert.equal(fixture.calls[4][3], `${DATABASE_NAME}-journal`);

  session.close();
  assert.deepEqual(
    databaseCalls.filter(([name]) => name === "close").map(([name]) => name),
    ["close"],
  );
  assert.equal(fixture.calls.at(-1)[0], "releaseSqliteStateLease");
  assert.equal(databaseCalls.some(([name]) => name === "ROLLBACK"), false);
  assert.equal(isWindowsSqliteStateSession(session), true);
});

test("the durable SQLite policy is configured and read back, and ATTACH/DETACH are denied", () => {
  const fixture = createFixture();
  const calls = [];
  const database = createDatabase({ calls });
  const session = createWindowsSqliteStateSession(sessionOptions(fixture, database));
  const authorizer = database.registeredAuthorizer;
  assert.equal(typeof authorizer, "function");
  assert.equal(authorizer(SQLITE_CONSTANTS.SQLITE_ATTACH), SQLITE_CONSTANTS.SQLITE_DENY);
  assert.equal(authorizer(SQLITE_CONSTANTS.SQLITE_DETACH), SQLITE_CONSTANTS.SQLITE_DENY);
  assert.equal(authorizer(SQLITE_CONSTANTS.SQLITE_SELECT), SQLITE_CONSTANTS.SQLITE_OK);

  assert.deepEqual(
    calls.filter(([name]) => name === "exec").map(([, sql]) => sql),
    [
      "PRAGMA synchronous = FULL;",
      "PRAGMA foreign_keys = ON;",
      "PRAGMA trusted_schema = OFF;",
      "PRAGMA temp_store = MEMORY;",
      "PRAGMA mmap_size = 0;",
    ],
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "readback").map(([, name]) => name),
    ["journal_mode", "journal_mode", "synchronous", "foreign_keys", "trusted_schema", "temp_store", "mmap_size"],
  );
  assert.deepEqual(calls.filter(([name]) => name === "enableDefensive"), [["enableDefensive", true]]);
  assert.equal(
    calls.findIndex(([name]) => name === "setAuthorizer")
      > calls.map(([name]) => name).lastIndexOf("readback"),
    true,
  );
  assert.throws(
    () => session.database.exec("ATTACH ':memory:' AS forbidden"),
    assertSessionError("database_unavailable"),
  );
  assert.throws(
    () => session.database.exec("PRAGMA synchronous = OFF"),
    assertSessionError("database_unavailable"),
  );
  assert.throws(
    () => session.database.prepare("PRAGMA journal_mode=PERSIST").get(),
    /not authorized/u,
  );
  assert.equal(session.database.prepare("PRAGMA journal_mode").get().journal_mode, "persist");
  assert.equal(session.database.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(database.registeredAuthorizer(SQLITE_CONSTANTS.SQLITE_PRAGMA, "synchronous", null), SQLITE_CONSTANTS.SQLITE_OK);
  session.close();
});

test("policy refusal closes the database and releases the native lease", () => {
  const fixture = createFixture();
  const calls = [];
  const database = createDatabase({
    calls,
    pragmaValues: { journal_mode: "delete" },
  });
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(fixture, database)),
    assertSessionError("policy_refused"),
  );
  assert.deepEqual(calls.at(-1), ["close"]);
  assert.equal(fixture.calls.at(-1)[0], "releaseSqliteStateLease");
});

test("post-open database and journal identities must match the native lease", () => {
  const otherIdentity = Object.freeze({
    volumeSerialNumber: "0000000000000002",
    fileId: "ffeeddccbbaa99887766554433221100",
    linkCount: 1,
  });
  const databaseFixture = createFixture({
    databaseMetadata: metadata(otherIdentity, { isDirectory: false, isRegularFile: true }),
  });
  const database = createDatabase({ calls: [] });
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(databaseFixture, database)),
    assertSessionError("identity_mismatch"),
  );
  assert.equal(databaseFixture.calls.at(-1)[0], "releaseSqliteStateLease");

  const journalFixture = createFixture({
    journalMetadata: metadata(otherIdentity, { isDirectory: false, isRegularFile: true }),
  });
  const journalDatabase = createDatabase({ calls: [] });
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(journalFixture, journalDatabase)),
    assertSessionError("identity_mismatch"),
  );
  assert.equal(journalFixture.calls.at(-1)[0], "releaseSqliteStateLease");
});

test("post-open identity inspection rejects an unprotected child", () => {
  const fixture = createFixture({
    databaseMetadata: metadata(IDENTITY, {
      isDirectory: false,
      isRegularFile: true,
      ownerMatches: false,
    }),
  });
  const database = createDatabase({ calls: [] });
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(fixture, database)),
    assertSessionError("identity_mismatch"),
  );
  assert.equal(fixture.calls.at(-1)[0], "releaseSqliteStateLease");
});

test("constructor and configuration failures clean up both resources", () => {
  const factoryFixture = createFixture();
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(factoryFixture, null, {
      databaseFactory() {
        throw new Error("factory path must not escape");
      },
    })),
    assertSessionError("database_unavailable"),
  );
  assert.equal(factoryFixture.calls.at(-1)[0], "releaseSqliteStateLease");

  const configurationFixture = createFixture();
  const databaseCalls = [];
  const database = createDatabase({
    calls: databaseCalls,
    authorizer: false,
    pragmaValues: { synchronous: 1 },
  });
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(configurationFixture, database, {
      databaseName: "state.sqlite",
    })),
    assertSessionError("policy_refused"),
  );
  assert.equal(databaseCalls.at(-1)[0], "close");
  assert.equal(configurationFixture.calls.at(-1)[0], "releaseSqliteStateLease");

  const retainedLeaseFixture = createFixture();
  const retainedLeaseDatabaseCalls = [];
  const retainedLeaseDatabase = createDatabase({
    calls: retainedLeaseDatabaseCalls,
    pragmaValues: { synchronous: 1 },
    closeError: new Error("close path must not escape"),
  });
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(retainedLeaseFixture, retainedLeaseDatabase)),
    assertSessionError("policy_refused"),
  );
  assert.equal(
    retainedLeaseFixture.calls.some(([name]) => name === "releaseSqliteStateLease"),
    false,
  );

  const malformedFixture = createFixture();
  const malformedCalls = [];
  const malformedDatabase = {
    isOpen: true,
    exec() {},
    close() {
      malformedCalls.push("close");
    },
  };
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(malformedFixture, malformedDatabase)),
    assertSessionError("database_unavailable"),
  );
  assert.deepEqual(malformedCalls, ["close"]);
  assert.equal(malformedFixture.calls.at(-1)[0], "releaseSqliteStateLease");
});

test("abort rolls back before close and release, and repeated abort/close are idempotent", () => {
  const fixture = createFixture();
  const database = createDatabase({ calls: fixture.calls, transaction: true });
  const session = createWindowsSqliteStateSession(sessionOptions(fixture, database));
  session.abort();
  const lifecycle = fixture.calls
    .filter(([name]) => name === "exec" || name === "close" || name === "releaseSqliteStateLease")
    .map(([name, sql]) => name === "exec" ? sql : name);
  assert.deepEqual(lifecycle.slice(-3), ["ROLLBACK;", "close", "releaseSqliteStateLease"]);
  const countAfterAbort = fixture.calls.length;
  session.abort();
  session.close();
  assert.equal(fixture.calls.length, countAfterAbort);
});

test("close and release failures remain fixed, and release can be retried after closing", () => {
  const closeFixture = createFixture();
  const closeCalls = [];
  const closeDatabase = createDatabase({
    calls: closeCalls,
    closeError: new Error("close path must not escape"),
  });
  const closeSession = createWindowsSqliteStateSession(sessionOptions(closeFixture, closeDatabase));
  assert.throws(() => closeSession.close(), assertSessionError("close_failed"));
  assert.equal(closeFixture.calls.some(([name]) => name === "releaseSqliteStateLease"), false);
  const closeCount = closeCalls.length + closeFixture.calls.length;
  assert.throws(() => closeSession.close(), assertSessionError("close_failed"));
  assert.equal(closeCalls.length + closeFixture.calls.length > closeCount, true);

  const releaseError = new Error("release path must not escape");
  const releaseFixture = createFixture({ releaseErrors: [releaseError] });
  const releaseCalls = [];
  const releaseDatabase = createDatabase({ calls: releaseCalls });
  const releaseSession = createWindowsSqliteStateSession(sessionOptions(releaseFixture, releaseDatabase));
  assert.throws(() => releaseSession.close(), assertSessionError("lease_release_failed"));
  assert.equal(releaseFixture.calls.filter(([name]) => name === "releaseSqliteStateLease").length, 1);
  assert.equal(releaseSession.database.isOpen, false);
  releaseSession.close();
  assert.equal(releaseFixture.calls.filter(([name]) => name === "releaseSqliteStateLease").length, 2);
  assert.equal(releaseFixture.leases.size, 0);
  assert.equal(isWindowsSqliteStateSession(releaseSession), true);
  releaseSession.abort();
  assert.equal(releaseFixture.calls.filter(([name]) => name === "releaseSqliteStateLease").length, 2);
});

test("forged/copied adapters, downgraded platforms, weak roots, and unsafe architectures fail closed", () => {
  const fixture = createFixture();
  const database = createDatabase({ calls: [] });
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(fixture, database, {
      adapter: { ...fixture.adapter },
    })),
    assertSessionError("invalid_adapter"),
  );
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(fixture, database, { platform: "darwin" })),
    assertSessionError("invalid_platform"),
  );
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(fixture, database, { architecture: "arm64" })),
    assertSessionError("unsupported_architecture"),
  );
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(fixture, database, {
      rootPath: "C:\\Users\\tester\\..\\outside",
    })),
    assertSessionError("invalid_root"),
  );
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(fixture, database, {
      databaseName: "..\\outside.sqlite",
    })),
    assertSessionError("invalid_database_name"),
  );
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(fixture, database, {
      databaseName: "CON",
    })),
    assertSessionError("invalid_database_name"),
  );
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(fixture, database, {
      databaseName: "state.sqlite-wal",
    })),
    assertSessionError("invalid_database_name"),
  );
});

test("native-shaped qualification construction rejects absent or copied context", () => {
  const fixture = createFixture();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalArchitecture = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", {
    ...originalPlatform,
    value: "win32",
  });
  Object.defineProperty(process, "arch", {
    ...originalArchitecture,
    value: "x64",
  });
  try {
    const nativeOptions = sessionOptions(fixture, null, {
      databaseFactory: null,
      windowsQualificationResourceRoot:
        "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\resources",
    });
    assert.throws(
      () => createWindowsSqliteStateSession(nativeOptions),
      assertSessionError("invalid_adapter"),
    );
    assert.throws(
      () => createWindowsSqliteStateSession({
        ...nativeOptions,
        windowsQualificationModeContext: Object.freeze({
          contractVersion: "windows-qualification-mode-v1",
          qualificationOnly: true,
          productionSafe: false,
          stateRoot: ROOT,
        }),
      }),
      assertSessionError("invalid_adapter"),
    );
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    Object.defineProperty(process, "arch", originalArchitecture);
  }
});

test("simulated win32 can exercise injected qualification plumbing but never mints production safety", () => {
  const fixture = createFixture();
  const database = createDatabase({ calls: [] });
  const session = createWindowsSqliteStateSession(sessionOptions(fixture, database));
  assert.equal(session.productionSafe, false);
  session.close();
});

test("simulated win32 requires an injected database factory", () => {
  const fixture = createFixture();
  assert.throws(
    () => createWindowsSqliteStateSession({
      platform: "win32",
      architecture: "x64",
      adapter: fixture.adapter,
      rootPath: ROOT,
      databaseName: DATABASE_NAME,
    }),
    assertSessionError("invalid_configuration"),
  );
  assert.deepEqual(fixture.calls.map(([name]) => name), []);
});

test("the session module has no Node filesystem fallback and errors are content-free", () => {
  const source = readFileSync(
    new URL("../src/platform/windows-sqlite-state-session.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:fs(?:\/promises)?/u);
  assert.doesNotMatch(source, /from\s+["'](?:fs|node:fs)/u);

  const fixture = createFixture();
  const secretPath = "C:\\private\\not-for-errors\\state.sqlite";
  assert.throws(
    () => createWindowsSqliteStateSession(sessionOptions(fixture, null, {
      databaseFactory() {
        throw new Error(secretPath);
      },
    })),
    (error) => {
      assertSessionError("database_unavailable")(error);
      assert.doesNotMatch(error.message, /private|state\.sqlite/u);
      return true;
    },
  );
});
