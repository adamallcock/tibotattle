import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createDesktopOwnedDownloadRegistry,
  DESKTOP_OWNED_DOWNLOAD_ID_PATTERN,
  DESKTOP_OWNED_DOWNLOAD_KINDS,
  DESKTOP_OWNED_DOWNLOAD_MAX_ENTRIES,
  DESKTOP_OWNED_DOWNLOAD_MAX_FILENAME_BYTES,
  DESKTOP_OWNED_DOWNLOAD_MIME_TYPES,
  installDesktopOwnedDownloadHandler,
  shareCardDownloadMetadata,
} from "../desktop-owned-downloads.js";

const ROOT = "/trusted/downloads";
const CANONICAL_ROOT = "/trusted/downloads";
const ID_ONE = "00000000-0000-4000-8000-000000000001";
const ID_TWO = "00000000-0000-4000-8000-000000000002";
const ID_THREE = "00000000-0000-4000-8000-000000000003";

function directoryStats() {
  return {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    nlink: 2,
  };
}

function fileStats({ symlink = false, nlink = 1 } = {}) {
  return {
    isDirectory: () => false,
    isFile: () => !symlink,
    isSymbolicLink: () => symlink,
    nlink,
  };
}

function fakeFs({
  root = ROOT,
  canonicalRoot = CANONICAL_ROOT,
  finalPaths = new Map(),
  lstatOverrides = new Map(),
  realpathOverrides = new Map(),
} = {}) {
  const calls = [];
  return {
    calls,
    fs: {
      async lstat(value) {
        calls.push(["lstat", value]);
        if (lstatOverrides.has(value)) {
          const override = lstatOverrides.get(value);
          if (override instanceof Error) throw override;
          return override;
        }
        if (value === root) return directoryStats();
        if (value === canonicalRoot && value === root) return directoryStats();
        if (finalPaths.has(value)) return finalPaths.get(value);
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
      async realpath(value) {
        calls.push(["realpath", value]);
        if (realpathOverrides.has(value)) {
          const override = realpathOverrides.get(value);
          if (override instanceof Error) throw override;
          return override;
        }
        if (value === root) return canonicalRoot;
        if (value === canonicalRoot) return canonicalRoot;
        if (finalPaths.has(value)) return value;
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
      lstatSync(value) {
        calls.push(["lstatSync", value]);
        if (lstatOverrides.has(value)) {
          const override = lstatOverrides.get(value);
          if (override instanceof Error) throw override;
          return override;
        }
        if (value === root) return directoryStats();
        if (value === canonicalRoot && value === root) return directoryStats();
        if (finalPaths.has(value)) return finalPaths.get(value);
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
    },
  };
}

const fakePath = {
  sep: "/",
  resolve(value) {
    if (value !== ROOT) throw new Error("unexpected root");
    return ROOT;
  },
  join(...parts) {
    return parts.join("/").replaceAll(/\/+/gu, "/");
  },
  relative(root, value) {
    if (root === value) return "";
    if (value.startsWith(`${root}/`)) return value.slice(root.length + 1);
    return `../${value.replace(/^\//u, "")}`;
  },
  isAbsolute(value) {
    return value.startsWith("/");
  },
};

function sequence(...ids) {
  let index = 0;
  return () => ids[index++] ?? ids.at(-1);
}

async function registryFixture({
  fsFixture = fakeFs(),
  ids = [ID_ONE, ID_TWO, ID_THREE],
  maxEntries,
  reveal = async () => {},
} = {}) {
  const randomUUID = sequence(...ids);
  const registry = await createDesktopOwnedDownloadRegistry({
    rootPath: ROOT,
    fs: fsFixture.fs,
    path: fakePath,
    reveal,
    randomUUID,
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });
  return { registry, fsFixture };
}

function metadata(filename = "tibotattle-results.png") {
  return {
    kind: "share_card",
    mime: "image/png",
    filename,
  };
}

test("owned download contract is bounded to the current share-card type", () => {
  assert.deepEqual(DESKTOP_OWNED_DOWNLOAD_KINDS, ["share_card"]);
  assert.deepEqual(DESKTOP_OWNED_DOWNLOAD_MIME_TYPES, ["image/png"]);
  assert.equal(DESKTOP_OWNED_DOWNLOAD_MAX_ENTRIES, 16);
  assert.equal(DESKTOP_OWNED_DOWNLOAD_MAX_FILENAME_BYTES, 120);
  assert.equal(DESKTOP_OWNED_DOWNLOAD_ID_PATTERN.test(ID_ONE), true);
  assert.equal(Object.isFrozen(DESKTOP_OWNED_DOWNLOAD_KINDS), true);
  assert.equal(Object.isFrozen(DESKTOP_OWNED_DOWNLOAD_MIME_TYPES), true);
});

test("registration generates an opaque UUID and keeps destination main-process-only", async () => {
  const { registry } = await registryFixture();
  const registered = await registry.registerDownload(metadata());
  assert.equal(registered.id, ID_ONE);
  assert.equal(DESKTOP_OWNED_DOWNLOAD_ID_PATTERN.test(registered.id), true);
  assert.equal(registered.kind, "share_card");
  assert.equal(registered.mime, "image/png");
  assert.equal(registered.filename, "tibotattle-results.png");
  assert.equal(registered.destination, `${CANONICAL_ROOT}/${ID_ONE}-tibotattle-results.png`);
  assert.deepEqual(registry.inspect(ID_ONE), {
    id: ID_ONE,
    kind: "share_card",
    mime: "image/png",
    filename: "tibotattle-results.png",
    state: "registered",
  });
  assert.equal(registry.destinationFor(ID_ONE), registered.destination);
  assert.equal(Object.hasOwn(registry.inspect(ID_ONE), "destination"), false);
  assert.equal(Object.isFrozen(registered), true);
});

test("registration rejects paths, URLs, caller identifiers, extra fields, and unsafe metadata", async () => {
  const { registry } = await registryFixture();
  const rejected = [
    null,
    [],
    { ...metadata(), id: ID_ONE },
    { ...metadata(), path: "/tmp/private" },
    { ...metadata(), url: "https://example.test/private" },
    { ...metadata(), content: "secret" },
    { ...metadata(), error: "/Users/private" },
    { kind: "unknown", mime: "image/png", filename: "tibotattle.png" },
    { kind: "share_card", mime: "application/octet-stream", filename: "tibotattle.png" },
    { kind: "share_card", mime: "image/png", filename: "../private.png" },
    { kind: "share_card", mime: "image/png", filename: "..\\private.png" },
    { kind: "share_card", mime: "image/png", filename: "/private.png" },
    { kind: "share_card", mime: "image/png", filename: "private/child.png" },
    { kind: "share_card", mime: "image/png", filename: "private\\child.png" },
    { kind: "share_card", mime: "image/png", filename: ".private.png" },
    { kind: "share_card", mime: "image/png", filename: "CON.png" },
    { kind: "share_card", mime: "image/png", filename: "tibotattle-results.jpg" },
    { kind: "share_card", mime: "image/png", filename: "tibotattle-results.png", extra: true },
    { kind: "share_card", mime: "image/png", filename: "tibotattle..png" },
    { kind: "share_card", mime: "image/png", filename: "" },
    { kind: "share_card", mime: "image/png", filename: "tibotattle-results.png\n" },
    { kind: "share_card", mime: "image/png", filename: "x".repeat(120) + ".png" },
  ];
  for (const value of rejected) {
    await assert.rejects(() => registry.registerDownload(value), TypeError);
  }
  assert.equal(registry.size, 0);
});

test("registration never claims an existing or inaccessible destination", async () => {
  const destination = `${CANONICAL_ROOT}/${ID_ONE}-tibotattle-results.png`;
  const existing = fakeFs({
    finalPaths: new Map([[destination, fileStats()]]),
  });
  const existingRegistry = await registryFixture({ fsFixture: existing });
  await assert.rejects(
    () => existingRegistry.registry.registerDownload(metadata()),
    (error) => error instanceof TypeError && !error.message.includes(destination),
  );
  assert.equal(existingRegistry.registry.size, 0);

  const permissionError = new Error("private path");
  permissionError.code = "EACCES";
  const inaccessible = fakeFs({
    lstatOverrides: new Map([[destination, permissionError]]),
  });
  const inaccessibleRegistry = await registryFixture({ fsFixture: inaccessible });
  await assert.rejects(
    () => inaccessibleRegistry.registry.registerDownload(metadata()),
    (error) => error instanceof TypeError
      && !error.message.includes("private")
      && !error.message.includes(destination),
  );
  assert.equal(inaccessibleRegistry.registry.size, 0);
});

test("completion requires the registered UUID and verifies a regular unlinked file twice", async () => {
  const finalPaths = new Map();
  const fsFixture = fakeFs({ finalPaths });
  const revealCalls = [];
  const { registry } = await registryFixture({
    fsFixture,
    reveal: async (value) => revealCalls.push(value),
  });
  const registered = await registry.registerDownload(metadata());
  finalPaths.set(registered.destination, fileStats());
  assert.equal(await registry.completeDownload(registered.id), true);
  assert.deepEqual(registry.inspect(registered.id), {
    id: registered.id,
    kind: "share_card",
    mime: "image/png",
    filename: registered.filename,
    state: "completed",
  });
  assert.equal(await registry.revealLatest(), "revealed");
  assert.deepEqual(revealCalls, [registered.destination]);
  assert.deepEqual(
    fsFixture.calls.filter(([method, value]) => value === registered.destination)
      .map(([method]) => method),
    ["lstat", "lstat", "realpath", "lstat", "realpath", "lstat", "realpath", "lstat", "realpath"],
  );
});

test("reveal is unavailable before explicit completion and never accepts a renderer path", async () => {
  const { registry } = await registryFixture();
  const registered = await registry.registerDownload(metadata());
  assert.equal(await registry.revealLatest(), "none");
  await assert.rejects(() => registry.revealLatest("/private/renderer-path"), TypeError);
  await assert.rejects(() => registry.completeDownload("/private/renderer-id"), TypeError);
  await assert.rejects(() => registry.failDownload("not-an-opaque-id"), TypeError);
  assert.equal(registry.inspect(registered.id).state, "registered");
});

test("symlinks, hard links, missing files, and outside-root canonical paths fail closed", async () => {
  for (const stats of [
    fileStats({ symlink: true }),
    fileStats({ nlink: 2 }),
  ]) {
    const finalPaths = new Map();
    const fsFixture = fakeFs({ finalPaths });
    const { registry } = await registryFixture({ fsFixture });
    const registered = await registry.registerDownload(metadata());
    finalPaths.set(registered.destination, stats);
    assert.equal(await registry.completeDownload(registered.id), false);
    assert.equal(registry.inspect(registered.id), null);
    assert.equal(await registry.revealLatest(), "none");
  }

  {
    const finalPaths = new Map();
    const fsFixture = fakeFs({ finalPaths });
    const { registry } = await registryFixture({ fsFixture });
    const registered = await registry.registerDownload(metadata());
    assert.equal(await registry.completeDownload(registered.id), false);
    assert.equal(registry.inspect(registered.id), null);
  }

  {
    const finalPaths = new Map();
    const fsFixture = fakeFs({
      finalPaths,
      realpathOverrides: new Map([
        [`${CANONICAL_ROOT}/${ID_ONE}-tibotattle-results.png`, "/outside/escape.png"],
      ]),
    });
    const { registry } = await registryFixture({ fsFixture });
    const registered = await registry.registerDownload(metadata());
    finalPaths.set(registered.destination, fileStats());
    assert.equal(await registry.completeDownload(registered.id), false);
    assert.equal(registry.inspect(registered.id), null);
  }
});

test("root must be a real directory and canonicalization cannot disclose paths", async () => {
  const badRoots = [
    { lstat: { isDirectory: () => false, isSymbolicLink: () => false } },
    { lstat: { isDirectory: () => true, isSymbolicLink: () => true } },
  ];
  for (const rootStats of badRoots) {
    const fsFixture = fakeFs({ lstatOverrides: new Map([[ROOT, rootStats.lstat]]) });
    await assert.rejects(
      () => registryFixture({ fsFixture }),
      (error) => error instanceof TypeError
        && !error.message.includes(ROOT)
        && !error.message.includes("private"),
    );
  }
});

test("duplicate generated IDs are rejected without replacing an existing registration", async () => {
  const { registry } = await registryFixture({ ids: [ID_ONE, ID_ONE, ID_ONE, ID_ONE, ID_ONE, ID_ONE, ID_ONE, ID_ONE, ID_ONE] });
  await registry.registerDownload(metadata());
  await assert.rejects(() => registry.registerDownload(metadata("second.png")), TypeError);
  assert.equal(registry.size, 1);
  assert.equal(registry.inspect(ID_ONE).filename, "tibotattle-results.png");
});

test("registry capacity is bounded and completed entries are evicted first", async () => {
  const ids = Array.from({ length: 20 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  const finalPaths = new Map();
  const fsFixture = fakeFs({ finalPaths });
  const { registry } = await registryFixture({
    fsFixture,
    ids,
    maxEntries: 2,
  });
  const first = await registry.registerDownload(metadata("first.png"));
  finalPaths.set(first.destination, fileStats());
  assert.equal(await registry.completeDownload(first.id), true);
  const second = await registry.registerDownload(metadata("second.png"));
  const third = await registry.registerDownload(metadata("third.png"));
  assert.equal(registry.size, 2);
  assert.equal(registry.inspect(first.id), null);
  assert.equal(registry.inspect(second.id).state, "registered");
  assert.equal(registry.inspect(third.id).state, "registered");
  await assert.rejects(() => registry.registerDownload(metadata("fourth.png")), TypeError);
});

test("failed downloads are removed and reveal errors remain fixed-status only", async () => {
  const { registry } = await registryFixture({ reveal: async () => { throw new Error("/private/raw"); } });
  const registered = await registry.registerDownload(metadata());
  assert.equal(await registry.failDownload(registered.id), true);
  assert.equal(registry.inspect(registered.id), null);
  assert.equal(await registry.failDownload(registered.id), false);

  const finalPaths = new Map();
  const fsFixture = fakeFs({ finalPaths });
  const revealed = await registryFixture({
    fsFixture,
    reveal: async () => { throw new Error("/private/raw"); },
  });
  const completed = await revealed.registry.registerDownload(metadata());
  finalPaths.set(completed.destination, fileStats());
  assert.equal(await revealed.registry.completeDownload(completed.id), true);
  assert.equal(await revealed.registry.revealLatest(), "unavailable");
});

test("clear removes all internal ownership without exposing content", async () => {
  const { registry } = await registryFixture();
  await registry.registerDownload(metadata());
  assert.equal(registry.size, 1);
  registry.clear();
  assert.equal(registry.size, 0);
  assert.equal(await registry.revealLatest(), "none");
});

class FakeDownloadItem extends EventEmitter {
  constructor({ url, mime = "image/png", filename = "tibotattle-results-TT-012345.png" } = {}) {
    super();
    this.url = url;
    this.mime = mime;
    this.filename = filename;
    this.savePath = null;
    this.cancelled = false;
  }

  getURL() { return this.url; }
  getMimeType() { return this.mime; }
  getFilename() { return this.filename; }
  setSavePath(value) { this.savePath = value; }
  cancel() { this.cancelled = true; }
  finish(state) { this.emit("done", {}, state); }
}

function validBlobURL() {
  return "blob:http://127.0.0.1:8791/4a4e02e8-2cbf-4dfb-bb2a-4f6e4c0efb90";
}

test("share-card download metadata requires the current loopback blob origin and safe filename", () => {
  const valid = shareCardDownloadMetadata({
    origin: "http://127.0.0.1:8791",
    url: validBlobURL(),
    mime: "image/png",
    filename: "tibotattle-results-TT-012345.png",
  });
  assert.deepEqual(valid, {
    kind: "share_card",
    mime: "image/png",
    filename: "tibotattle-results-TT-012345.png",
    url: validBlobURL(),
  });
  for (const invalid of [
    { url: "https://127.0.0.1:8791/card.png", mime: "image/png", filename: valid.filename },
    { url: "blob:http://127.0.0.1:8792/id", mime: "image/png", filename: valid.filename },
    { url: "blob:http://evil.example/id", mime: "image/png", filename: valid.filename },
    { url: `${validBlobURL()}?redirect=1`, mime: "image/png", filename: valid.filename },
    { url: validBlobURL(), mime: "image/jpeg", filename: valid.filename },
    { url: validBlobURL(), mime: "image/png", filename: "private.png" },
  ]) {
    assert.equal(
      shareCardDownloadMetadata({ origin: "http://127.0.0.1:8791", ...invalid }),
      null,
    );
  }
});

test("will-download reserves an internal destination and completes only a clean dashboard download", async () => {
  const finalPaths = new Map();
  const fsFixture = fakeFs({ finalPaths });
  const revealCalls = [];
  const states = [];
  const { registry } = await registryFixture({
    fsFixture,
    reveal: async (value) => revealCalls.push(value),
  });
  const session = new EventEmitter();
  const dashboard = new EventEmitter();
  const item = new FakeDownloadItem({ url: validBlobURL() });
  let prevented = false;
  const installed = installDesktopOwnedDownloadHandler({
    session,
    dashboardWebContents: dashboard,
    origin: "http://127.0.0.1:8791",
    registry,
    onState: (state) => {
      states.push({
        state,
        registryState: registry.inspect(ID_ONE)?.state ?? null,
      });
    },
  });
  session.emit("will-download", { preventDefault() { prevented = true; } }, item, dashboard);
  assert.equal(prevented, false);
  assert.match(item.savePath, /00000000-0000-4000-8000-000000000001-tibotattle-results-TT-012345\.png$/u);
  finalPaths.set(item.savePath, fileStats());
  item.finish("completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.inspect("00000000-0000-4000-8000-000000000001").state, "completed");
  assert.deepEqual(states, [{
    state: { command: "shareCardDownloadCompleted" },
    registryState: "completed",
  }]);
  assert.equal(Object.isFrozen(states[0].state), true);
  assert.equal(await registry.revealLatest(), "revealed");
  assert.deepEqual(revealCalls, [item.savePath]);
  installed.remove();
  assert.equal(session.listenerCount("will-download"), 0);
});

test("accepted downloads emit one fixed failure state for every failed completion path", async () => {
  const cases = [
    {
      name: "non-completed state",
      finishState: "cancelled",
    },
    {
      name: "mutated metadata",
      mutate(item) {
        item.filename = "private.png";
      },
      finishState: "completed",
    },
    {
      name: "metadata read error",
      mutate(item) {
        item.getFilename = () => { throw new Error("/private/raw"); };
      },
      finishState: "completed",
    },
    {
      name: "final file verification failure",
      finishState: "completed",
    },
  ];

  for (const value of cases) {
    const finalPaths = new Map();
    const fsFixture = fakeFs({ finalPaths });
    const states = [];
    const { registry } = await registryFixture({ fsFixture });
    const session = new EventEmitter();
    const dashboard = new EventEmitter();
    const installed = installDesktopOwnedDownloadHandler({
      session,
      dashboardWebContents: dashboard,
      origin: "http://127.0.0.1:8791",
      registry,
      onState: (state) => states.push(state),
    });
    const item = new FakeDownloadItem({ url: validBlobURL() });
    session.emit("will-download", { preventDefault() {} }, item, dashboard);
    value.mutate?.(item);
    if (value.name === "final file verification failure") {
      // Leave the final path absent so completeDownload returns false only
      // after its regular-file and canonical-path checks.
    } else if (value.name === "mutated metadata") {
      // The changed filename must fail before the registry is completed.
      finalPaths.set(item.savePath, fileStats());
    }
    item.finish(value.finishState);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(states, [{ command: "shareCardDownloadFailed" }], value.name);
    assert.equal(registry.size, 0, value.name);
    installed.remove();
  }
});

test("a timed-out renderer attempt cannot accept a second item while the first is pending", async () => {
  const finalPaths = new Map();
  const fsFixture = fakeFs({ finalPaths });
  const states = [];
  const { registry } = await registryFixture({
    fsFixture,
    ids: [ID_ONE, ID_TWO],
  });
  const session = new EventEmitter();
  const dashboard = new EventEmitter();
  const installed = installDesktopOwnedDownloadHandler({
    session,
    dashboardWebContents: dashboard,
    origin: "http://127.0.0.1:8791",
    registry,
    onState: (state) => states.push(state),
  });

  const first = new FakeDownloadItem({ url: validBlobURL() });
  session.emit("will-download", { preventDefault() {} }, first, dashboard);
  assert.match(first.savePath, /00000000-0000-4000-8000-000000000001-/u);

  // Model the renderer's bounded save timeout: it starts a new user-visible
  // attempt while Electron still owns the first item's completion callback.
  const second = new FakeDownloadItem({ url: validBlobURL() });
  let prevented = false;
  session.emit("will-download", {
    preventDefault() { prevented = true; },
  }, second, dashboard);
  assert.equal(prevented, true);
  assert.equal(second.cancelled, true);
  assert.equal(second.savePath, null);
  assert.equal(registry.size, 1);
  assert.deepEqual(states, [{ command: "shareCardDownloadFailed" }]);

  // The first item completes late. It may settle only its own entry, and the
  // rejected second event must not receive a completion signal.
  finalPaths.set(first.savePath, fileStats());
  first.finish("completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(states, [
    { command: "shareCardDownloadFailed" },
    { command: "shareCardDownloadCompleted" },
  ]);
  assert.equal(registry.inspect(ID_ONE).state, "completed");
  assert.equal(registry.inspect(ID_TWO), null);
  installed.remove();
});

test("a completion exception is converted to a fixed failure after registry cleanup", async () => {
  let failed = 0;
  const states = [];
  const registry = {
    prepareDownload(value) {
      return Object.freeze({
        ...value,
        id: ID_ONE,
        destination: `${ROOT}/${ID_ONE}-${value.filename}`,
      });
    },
    async completeDownload() {
      throw new Error("/private/raw");
    },
    async failDownload() {
      failed += 1;
      return true;
    },
  };
  const session = new EventEmitter();
  const dashboard = new EventEmitter();
  const installed = installDesktopOwnedDownloadHandler({
    session,
    dashboardWebContents: dashboard,
    origin: "http://127.0.0.1:8791",
    registry,
    onState: (state) => states.push(state),
  });
  const item = new FakeDownloadItem({ url: validBlobURL() });
  session.emit("will-download", { preventDefault() {} }, item, dashboard);
  item.finish("completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failed, 1);
  assert.deepEqual(states, [{ command: "shareCardDownloadFailed" }]);
  installed.remove();
});

test("state observer failures are contained and cannot change a verified completion", async () => {
  const finalPaths = new Map();
  const fsFixture = fakeFs({ finalPaths });
  const { registry } = await registryFixture({ fsFixture });
  const session = new EventEmitter();
  const dashboard = new EventEmitter();
  const installed = installDesktopOwnedDownloadHandler({
    session,
    dashboardWebContents: dashboard,
    origin: "http://127.0.0.1:8791",
    registry,
    onState: () => { throw new Error("observer failed"); },
  });
  const item = new FakeDownloadItem({ url: validBlobURL() });
  session.emit("will-download", { preventDefault() {} }, item, dashboard);
  finalPaths.set(item.savePath, fileStats());
  item.finish("completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.inspect(ID_ONE).state, "completed");
  installed.remove();
});

test("rejected downloads do not emit trusted state", async () => {
  const { registry } = await registryFixture();
  const session = new EventEmitter();
  const dashboard = new EventEmitter();
  const states = [];
  const installed = installDesktopOwnedDownloadHandler({
    session,
    dashboardWebContents: dashboard,
    origin: "http://127.0.0.1:8791",
    registry,
    onState: (state) => states.push(state),
  });
  const item = new FakeDownloadItem({ url: "https://evil.example/private.png" });
  session.emit("will-download", { preventDefault() {} }, item, dashboard);
  item.finish("completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(states, []);
  assert.equal(registry.size, 0);
  installed.remove();
});

test("removal and stale dashboard windows stay silent even if completion settles later", async () => {
  let releaseCompletion;
  const completion = new Promise((resolve) => { releaseCompletion = resolve; });
  const states = [];
  const registry = {
    prepareDownload(value) {
      return Object.freeze({
        ...value,
        id: ID_ONE,
        destination: `${ROOT}/${ID_ONE}-${value.filename}`,
      });
    },
    async completeDownload() {
      await completion;
      return true;
    },
    async failDownload() {
      return true;
    },
  };
  const session = new EventEmitter();
  const dashboard = new EventEmitter();
  const installed = installDesktopOwnedDownloadHandler({
    session,
    dashboardWebContents: dashboard,
    origin: "http://127.0.0.1:8791",
    registry,
    onState: (state) => states.push(state),
  });
  const item = new FakeDownloadItem({ url: validBlobURL() });
  session.emit("will-download", { preventDefault() {} }, item, dashboard);
  item.finish("completed");
  installed.remove();
  releaseCompletion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(states, []);

});

test("a stale dashboard window stays silent after an accepted download", async () => {
  const staleStates = [];
  const staleRegistry = await registryFixture();
  const staleSession = new EventEmitter();
  const staleDashboard = new EventEmitter();
  staleDashboard.isDestroyed = () => false;
  const staleInstalled = installDesktopOwnedDownloadHandler({
    session: staleSession,
    dashboardWebContents: staleDashboard,
    origin: "http://127.0.0.1:8791",
    registry: staleRegistry.registry,
    onState: (state) => staleStates.push(state),
  });
  const staleItem = new FakeDownloadItem({ url: validBlobURL() });
  staleSession.emit("will-download", { preventDefault() {} }, staleItem, staleDashboard);
  staleDashboard.isDestroyed = () => true;
  staleItem.finish("completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(staleStates, []);
  assert.equal(staleRegistry.registry.size, 0);
  staleInstalled.remove();
});

test("state observer is optional but must be callable when supplied", async () => {
  const { registry } = await registryFixture();
  const session = new EventEmitter();
  const dashboard = new EventEmitter();
  assert.throws(() => installDesktopOwnedDownloadHandler({
    session,
    dashboardWebContents: dashboard,
    origin: "http://127.0.0.1:8791",
    registry,
    onState: "/private/callback",
  }), TypeError);
});

test("will-download rejects Settings, stale, remote, redirected, and unsafe items", async () => {
  const { registry } = await registryFixture();
  const session = new EventEmitter();
  const dashboard = new EventEmitter();
  const settings = new EventEmitter();
  const installed = installDesktopOwnedDownloadHandler({
    session,
    dashboardWebContents: dashboard,
    origin: "http://127.0.0.1:8791",
    registry,
  });
  const cases = [
    { sender: settings, url: validBlobURL() },
    { sender: {}, url: validBlobURL() },
    { sender: dashboard, url: "blob:http://127.0.0.1:8792/id" },
    { sender: dashboard, url: "https://evil.example/card.png" },
    { sender: dashboard, url: validBlobURL(), mime: "image/jpeg" },
    { sender: dashboard, url: validBlobURL(), filename: "../../private.png" },
  ];
  for (const value of cases) {
    const item = new FakeDownloadItem(value);
    let prevented = false;
    session.emit("will-download", { preventDefault() { prevented = true; } }, item, value.sender);
    assert.equal(prevented, true);
    assert.equal(item.cancelled, true);
    assert.equal(item.savePath, null);
  }
  assert.equal(registry.size, 0);
  installed.remove();
});

test("removing the dashboard handler forgets an unfinished download", async () => {
  const { registry } = await registryFixture();
  const session = new EventEmitter();
  const dashboard = new EventEmitter();
  const installed = installDesktopOwnedDownloadHandler({
    session,
    dashboardWebContents: dashboard,
    origin: "http://127.0.0.1:8791",
    registry,
  });
  const item = new FakeDownloadItem({ url: validBlobURL() });
  session.emit("will-download", { preventDefault() {} }, item, dashboard);
  assert.equal(registry.size, 1);
  installed.remove();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.size, 0);
  item.finish("completed");
  assert.equal(await registry.revealLatest(), "none");
});
