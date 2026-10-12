import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ObjectTransferTargetExistsError,
  runPostgresObjectTransferRehearsal,
} from "./postgres-object-transfer-rehearsal.mjs";
import {
  buildLocalR2WranglerConfig,
  createLocalObjectTransferCheckpointStore,
  createLocalR2TransferSource,
  startLocalR2TransferSession,
  runLocalR2TransferRehearsal,
} from "./local-r2-source-harness.mjs";
import { LOCAL_R2_SOURCE_MAX_STREAM_CHUNK_BYTES } from "./local-r2-source-protocol.mjs";
import localR2Worker from "./local-r2-source-worker.mjs";

const token = randomBytes(32).toString("base64url");
const wranglerToken = "synthetic-cloudflare-api-token";
const prefix = "quarantine/";
const keyA = `${prefix}synthetic-owner-opaque/object-a.bin`;
const keyB = `${prefix}synthetic-owner-opaque/object-b.bin`;

function bytesReadable(bytes, chunkSize = 64 * 1_024) {
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
      }
      controller.close();
    },
  });
}

function makeR2Object(key, bytes, { version = "r2-version-1", etag = "r2-etag-1" } = {}) {
  return {
    key,
    version,
    etag,
    size: bytes.byteLength,
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { retention: "synthetic-quarantine" },
    storageClass: "Standard",
    bytes,
  };
}

function makeR2Bucket(objects) {
  const state = { listCalls: [], getCalls: [], writeCalls: 0, throwOnGet: false };
  const bucket = {
    async list(options) {
      state.listCalls.push(structuredClone(options));
      assert.deepEqual(options.include, ["httpMetadata", "customMetadata"]);
      const all = [...objects.values()]
        .filter(value => value.key.startsWith(options.prefix))
        .sort((left, right) => left.key.localeCompare(right.key));
      const offset = options.cursor === undefined ? 0 : Number(options.cursor.slice("cursor-".length));
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("synthetic invalid cursor");
      const page = all.slice(offset, offset + options.limit).map(value => ({
        key: value.key,
        version: value.version,
        etag: value.etag,
        size: value.size,
        httpMetadata: value.httpMetadata,
        customMetadata: value.customMetadata,
        storageClass: value.storageClass,
      }));
      const nextOffset = offset + page.length;
      return {
        objects: page,
        truncated: nextOffset < all.length,
        ...(nextOffset < all.length ? { cursor: `cursor-${nextOffset}` } : {}),
      };
    },
    async get(requestedKey, options) {
      state.getCalls.push({ requestedKey, options: structuredClone(options) });
      if (state.throwOnGet) throw new Error(`secret=${token} key=${requestedKey}`);
      const value = objects.get(requestedKey);
      if (!value || options.onlyIf?.etagMatches !== value.etag) return null;
      return {
        key: value.key,
        version: value.version,
        etag: value.etag,
        size: value.size,
        httpMetadata: value.httpMetadata,
        customMetadata: value.customMetadata,
        storageClass: value.storageClass,
        body: bytesReadable(value.bytes),
      };
    },
  };
  return { bucket, state };
}

async function collectBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > 16 * 1_024) throw new Error("synthetic request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function startWorkerHttpServer(env, { requests = [], port = 0 } = {}) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = incoming.method === "GET" || incoming.method === "HEAD"
        ? undefined
        : await collectBody(incoming);
      const headers = new Headers();
      for (const name of ["authorization", "content-type", "content-length", "host"]) {
        const value = incoming.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}${incoming.url}`;
      requests.push({ method: incoming.method, url: incoming.url });
      const request = new Request(url, {
        method: incoming.method,
        headers,
        ...(body === undefined ? {} : { body: new Uint8Array(body), duplex: "half" }),
      });
      const response = await localR2Worker.fetch(request, env);
      const responseHeaders = {};
      response.headers.forEach((value, name) => { responseHeaders[name] = value; });
      outgoing.writeHead(response.status, responseHeaders);
      if (!response.body) {
        outgoing.end();
        return;
      }
      for await (const chunk of response.body) {
        if (!outgoing.write(Buffer.from(chunk))) {
          await new Promise(resolve => outgoing.once("drain", resolve));
        }
      }
      outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end("synthetic server error");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

function makeTransferTarget() {
  const objects = new Map();
  let nextGeneration = 1;
  const pages = (entries, cursor, limit) => {
    const offset = cursor === null ? 0 : Number(cursor);
    const objects = entries.slice(offset, offset + limit);
    const nextOffset = offset + objects.length;
    return { objects, nextCursor: nextOffset < entries.length ? String(nextOffset) : null };
  };
  return {
    objects,
    adapter: Object.freeze({
      async listPage({ prefix: requestedPrefix, cursor, limit }) {
        const entries = [...objects.entries()]
          .filter(([key]) => key.startsWith(requestedPrefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => ({ key, size: value.bytes.byteLength, metadata: value.metadata,
            generation: value.generation }));
        return pages(entries, cursor, limit);
      },
      async head(key) {
        const value = objects.get(key);
        return value ? { size: value.bytes.byteLength, metadata: value.metadata, generation: value.generation } : null;
      },
      async openRead({ key, ifGeneration }) {
        const value = objects.get(key);
        if (!value || value.generation !== ifGeneration) throw new Error("synthetic generation mismatch");
        return { generation: value.generation, body: bytesReadable(value.bytes) };
      },
      async putIfAbsent({ key, metadata, ifGenerationMatch, body }) {
        if (ifGenerationMatch !== "0") throw new Error("create-only generation required");
        if (objects.has(key)) throw new ObjectTransferTargetExistsError();
        const chunks = [];
        let size = 0;
        for await (const chunk of body) {
          chunks.push(chunk.slice());
          size += chunk.byteLength;
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const generation = String(nextGeneration++);
        objects.set(key, { bytes, metadata, generation });
        return generation;
      },
    }),
  };
}

function testCheckpoint() {
  const sum = value => createHash("sha256").update(value).digest("hex");
  return Object.freeze({
    schemaVersion: "object-transfer-rehearsal-v1",
    sourceManifestSha256: sum("synthetic source manifest"),
    key: keyA,
    sourceVersion: "r2v1.WyJ2ZXJzaW9uLTEiLCJldGFnLTEiXQ",
    size: 7,
    contentSha256: sum("content"),
    metadataSha256: sum("metadata"),
    targetGeneration: "9001",
  });
}

test("local source session uses a loopback Wrangler config and streams R2 pages and pinned reads into the rehearsal", async () => {
  const payloadA = new Uint8Array(300_000).map((_, index) => index % 251);
  const payloadB = new Uint8Array([9, 8, 7, 6, 5, 4, 3]);
  const objects = new Map([
    [keyA, makeR2Object(keyA, payloadA)],
    [keyB, makeR2Object(keyB, payloadB, { version: "r2-version-2", etag: "r2-etag-2" })],
  ]);
  const { bucket, state } = makeR2Bucket(objects);
  const checkpointsRoot = await mkdtemp(join(tmpdir(), "tibotattle-r2-checkpoints-test-"));
  let fakeChild;
  let workerServer;
  let spawnDetails;
  let runtimeDirectory;
  let capturedToken;
  const spawnImpl = (_binary, args, options) => {
    spawnDetails = { args, options };
    runtimeDirectory = options.cwd;
    fakeChild = new EventEmitter();
    fakeChild.exitCode = null;
    fakeChild.signalCode = null;
    const startServer = async () => {
      const configPath = args[args.indexOf("--config") + 1];
      const config = JSON.parse(await readFile(configPath, "utf8"));
      const variables = await readFile(join(runtimeDirectory, ".dev.vars"), "utf8");
      capturedToken = /^LOCAL_R2_SOURCE_TOKEN=([A-Za-z0-9_-]{43})\n$/u.exec(variables)?.[1];
      assert.ok(capturedToken);
      assert.deepEqual(config.r2_buckets, [{
        binding: "TRANSFER_SOURCE_BUCKET",
        bucket_name: "synthetic-test-bucket",
        remote: true,
      }]);
      const requestedPort = Number(args[args.indexOf("--port") + 1]);
      workerServer = await startWorkerHttpServer({
        LOCAL_R2_SOURCE_TOKEN: capturedToken,
        TRANSFER_SOURCE_BUCKET: bucket,
      }, { port: requestedPort });
      assert.equal(Number(new URL(workerServer.url).port), requestedPort);
    };
    fakeChild.startPromise = startServer();
    fakeChild.kill = signal => {
      void fakeChild.startPromise.then(async () => {
        await workerServer?.close();
        fakeChild.signalCode = signal;
        fakeChild.emit("exit", null, signal);
      });
      return true;
    };
    return fakeChild;
  };

  let session;
  try {
    session = await startLocalR2TransferSession({
      bucketName: "synthetic-test-bucket",
      checkpointDirectory: join(checkpointsRoot, "private-store"),
      startupTimeoutMs: 5_000,
      spawnImpl,
      wranglerEnvironment: { CLOUDFLARE_API_TOKEN: wranglerToken },
    });
    await fakeChild.startPromise;
    assert.match(session.url, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
    assert.equal(spawnDetails.options.stdio, "ignore");
    assert.equal(spawnDetails.options.env.CLOUDFLARE_API_TOKEN, wranglerToken);
    assert.equal(spawnDetails.args.includes("--remote"), false);
    assert.ok(spawnDetails.args.includes("--ip") && spawnDetails.args[spawnDetails.args.indexOf("--ip") + 1] === "127.0.0.1");
    assert.equal(spawnDetails.args.some(argument => argument === capturedToken), false);
    assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(runtimeDirectory, ".dev.vars"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(runtimeDirectory, "wrangler.jsonc"))).mode & 0o777, 0o600);
    assert.equal((await readFile(join(runtimeDirectory, ".dev.vars"), "utf8")).includes(wranglerToken), false);
    assert.equal((await readFile(join(runtimeDirectory, "wrangler.jsonc"), "utf8")).includes(wranglerToken), false);
    assert.equal(spawnDetails.args.some(argument => argument.includes(wranglerToken)), false);

    const first = await session.source.listPage({ prefix, cursor: null, limit: 1 });
    assert.deepEqual(first.objects.map(value => value.key), [keyA]);
    assert.equal(typeof first.nextCursor, "string");
    const second = await session.source.listPage({ prefix, cursor: first.nextCursor, limit: 1 });
    assert.deepEqual(second.objects.map(value => value.key), [keyB]);
    assert.equal(second.nextCursor, null);
    assert.ok(state.listCalls.every(call => call.include.join(",") === "httpMetadata,customMetadata"));
    assert.ok(state.listCalls.every(call => call.limit === 1));
    assert.equal(state.listCalls[0].cursor, undefined);

    const pinned = first.objects[0];
    const opened = await session.source.openRead({ key: pinned.key, ifVersion: pinned.version });
    assert.equal(opened.version, pinned.version);
    const receivedChunks = [];
    let receivedBytes = 0;
    for await (const chunk of opened.body) {
      receivedChunks.push(chunk);
      receivedBytes += chunk.byteLength;
      assert.ok(chunk.byteLength <= LOCAL_R2_SOURCE_MAX_STREAM_CHUNK_BYTES);
    }
    const received = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of receivedChunks) {
      received.set(chunk, offset);
      offset += chunk.byteLength;
    }
    assert.deepEqual(received, payloadA);
    assert.deepEqual(state.getCalls[0], {
      requestedKey: keyA,
      options: { onlyIf: { etagMatches: "r2-etag-1" } },
    });

    const oldObject = objects.get(keyA);
    objects.set(keyA, makeR2Object(keyA, payloadA, { version: "r2-version-replaced", etag: oldObject.etag }));
    await assert.rejects(
      session.source.openRead({ key: keyA, ifVersion: pinned.version }),
      error => error?.code === "OBJECT_TRANSFER_SOURCE_CHANGED",
    );
    objects.set(keyA, oldObject);

    const invalidBefore = state.listCalls.length;
    await assert.rejects(
      session.source.listPage({ prefix, cursor: null, limit: 501 }),
      error => error?.code === "OBJECT_TRANSFER_PAGE_SIZE_INVALID",
    );
    assert.equal(state.listCalls.length, invalidBefore);

    const denied = await fetch(`${session.url}/__local_r2_source/v1/read`, {
      method: "POST",
      headers: { authorization: "Bearer invalid-local-token", "content-type": "application/json" },
      body: JSON.stringify({ key: keyA, ifVersion: pinned.version }),
    });
    assert.equal(denied.status, 404);
    const deniedText = await denied.text();
    assert.equal(deniedText.includes(keyA), false);
    assert.equal(deniedText.includes(capturedToken), false);
    const unsupported = await fetch(`${session.url}/__local_r2_source/v1/read`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${capturedToken}` },
    });
    assert.equal(unsupported.status, 404);
    assert.equal(state.writeCalls, 0);

    const target = makeTransferTarget();
    const receipt = await runPostgresObjectTransferRehearsal({
      source: session.source,
      target: target.adapter,
      checkpoints: session.checkpoints,
      options: {
        prefix,
        pageSize: 1,
        maxObjects: 10,
        maxTotalBytes: 1_024 * 1_024,
        maxAttempts: 2,
        maxObjectsThisRun: 10,
      },
    });
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.sourceObjects, 2);
    assert.equal(receipt.sourceInventorySha256, receipt.targetInventorySha256);
    assert.deepEqual(target.objects.get(keyA).bytes, payloadA);
    assert.deepEqual(target.objects.get(keyB).bytes, payloadB);

    const resumed = await runPostgresObjectTransferRehearsal({
      source: session.source,
      target: target.adapter,
      checkpoints: createLocalObjectTransferCheckpointStore({
        directory: join(checkpointsRoot, "private-store"),
      }),
      options: {
        prefix,
        pageSize: 2,
        maxObjects: 10,
        maxTotalBytes: 1_024 * 1_024,
        maxAttempts: 2,
        maxObjectsThisRun: 10,
      },
    });
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.metrics.resumed, 2);
    const checkpointEntries = await readdir(join(checkpointsRoot, "private-store"));
    assert.equal(checkpointEntries.length, 2);
    assert.ok(checkpointEntries.every(name => /^[0-9a-f]{64}\.json$/u.test(name)));
    assert.ok(checkpointEntries.every(name => !name.includes("synthetic-owner-opaque")));
    assert.equal(state.writeCalls, 0);
  } finally {
    await session?.close();
    await rm(checkpointsRoot, { recursive: true, force: true });
  }
  await assert.rejects(stat(runtimeDirectory), error => error?.code === "ENOENT");
  assert.ok(capturedToken);
});

test("local checkpoint store is private, atomic, immutable, and resumes after a new store instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-r2-checkpoint-store-test-"));
  const directory = join(root, "journal");
  try {
    const firstStore = createLocalObjectTransferCheckpointStore({ directory });
    const checkpoint = testCheckpoint();
    assert.equal(await firstStore.get({
      sourceManifestSha256: checkpoint.sourceManifestSha256,
      key: checkpoint.key,
    }), null);
    await firstStore.put(checkpoint);
    await firstStore.put(checkpoint);
    const secondStore = createLocalObjectTransferCheckpointStore({ directory });
    assert.deepEqual(await secondStore.get({
      sourceManifestSha256: checkpoint.sourceManifestSha256,
      key: checkpoint.key,
    }), checkpoint);
    await assert.rejects(
      secondStore.put({ ...checkpoint, targetGeneration: "9002" }),
      error => error?.code === "OBJECT_TRANSFER_CHECKPOINT_CONFLICT",
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const entryName = (await readdir(directory))[0];
    assert.match(entryName, /^[0-9a-f]{64}\.json$/u);
    assert.equal(entryName.includes(checkpoint.key), false);
    assert.equal((await stat(join(directory, entryName))).mode & 0o777, 0o600);
    const raw = await readFile(join(directory, entryName), "utf8");
    assert.ok(raw.includes(checkpoint.key));
    assert.equal(raw.includes(token), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composed rehearsal writes a content-free owner-only receipt for the selected prefix", async () => {
  const bytes = new Uint8Array([4, 8, 15, 16, 23, 42]);
  const objects = new Map([[keyA, makeR2Object(keyA, bytes)]]);
  const { bucket, state } = makeR2Bucket(objects);
  const root = await mkdtemp(join(tmpdir(), "tibotattle-r2-composed-rehearsal-test-"));
  const receiptFile = join(root, "private-receipts", "synthetic-summary.json");
  let workerServer;
  let fakeChild;
  const spawnImpl = (_binary, args, options) => {
    const runtimeDirectory = options.cwd;
    fakeChild = new EventEmitter();
    fakeChild.exitCode = null;
    fakeChild.signalCode = null;
    const port = Number(args[args.indexOf("--port") + 1]);
    fakeChild.startPromise = (async () => {
      const variables = await readFile(join(runtimeDirectory, ".dev.vars"), "utf8");
      const sessionToken = /^LOCAL_R2_SOURCE_TOKEN=([A-Za-z0-9_-]{43})\n$/u.exec(variables)?.[1];
      assert.ok(sessionToken);
      workerServer = await startWorkerHttpServer({
        LOCAL_R2_SOURCE_TOKEN: sessionToken,
        TRANSFER_SOURCE_BUCKET: bucket,
      }, { port });
    })();
    fakeChild.kill = signal => {
      void fakeChild.startPromise.then(async () => {
        await workerServer?.close();
        fakeChild.signalCode = signal;
        fakeChild.emit("exit", null, signal);
      });
      return true;
    };
    return fakeChild;
  };
  const target = makeTransferTarget();
  try {
    const receipt = await runLocalR2TransferRehearsal({
      bucketName: "synthetic-test-bucket",
      target: target.adapter,
      options: {
        prefix,
        pageSize: 1,
        maxObjects: 10,
        maxTotalBytes: 1_024,
        maxAttempts: 2,
        maxObjectsThisRun: 10,
      },
      checkpointDirectory: join(root, "checkpoints"),
      receiptFile,
      startupTimeoutMs: 5_000,
      spawnImpl,
      wranglerEnvironment: { CLOUDFLARE_API_TOKEN: wranglerToken },
    });
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.sourceObjects, 1);
    assert.equal(target.objects.get(keyA).bytes.byteLength, bytes.byteLength);
    const stored = await readFile(receiptFile, "utf8");
    assert.deepEqual(JSON.parse(stored), receipt);
    assert.equal((await stat(join(root, "private-receipts"))).mode & 0o777, 0o700);
    assert.equal((await stat(receiptFile)).mode & 0o777, 0o600);
    assert.equal(stored.includes(keyA), false);
    assert.equal(stored.includes(token), false);
    assert.equal(state.writeCalls, 0);
    await assert.rejects(
      runLocalR2TransferRehearsal({
        bucketName: "synthetic-test-bucket",
        target: target.adapter,
        options: { prefix, pageSize: 1, maxObjects: 10, maxTotalBytes: 1_024, maxAttempts: 2, maxObjectsThisRun: 10 },
        checkpointDirectory: join(root, "checkpoints"),
        receiptFile,
        spawnImpl: () => assert.fail("must reject an existing receipt before starting Wrangler"),
      }),
      error => error?.code === "OBJECT_TRANSFER_RECEIPT_EXISTS",
    );
    assert.equal(await readFile(receiptFile, "utf8"), stored);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Wrangler config limits the ephemeral Worker to one remote R2 binding", () => {
  const config = buildLocalR2WranglerConfig({
    bucketName: "synthetic-test-bucket",
    workerEntrypoint: "/private/tmp/local-r2-source-worker.mjs",
  });
  assert.deepEqual(config.r2_buckets, [{
    binding: "TRANSFER_SOURCE_BUCKET",
    bucket_name: "synthetic-test-bucket",
    remote: true,
  }]);
  assert.equal(config.main, "/private/tmp/local-r2-source-worker.mjs");
  assert.equal(Object.hasOwn(config, "routes"), false);
  assert.equal(Object.hasOwn(config, "d1_databases"), false);
  assert.equal(Object.hasOwn(config, "workers_dev"), false);
});

test("non-interactive remote R2 launch fails closed when Wrangler has no API token", async () => {
  let spawned = false;
  await assert.rejects(
    startLocalR2TransferSession({
      bucketName: "synthetic-test-bucket",
      wranglerEnvironment: {},
      spawnImpl: () => { spawned = true; throw new Error("unexpected spawn"); },
    }),
    error => error?.code === "LOCAL_R2_CLOUDFLARE_API_TOKEN_REQUIRED",
  );
  assert.equal(spawned, false);
});

test("synthetic local HTTP error paths never echo keys, tokens, or upstream error text", async () => {
  const objects = new Map([[keyA, makeR2Object(keyA, new Uint8Array([1, 2, 3]))]]);
  const { bucket, state } = makeR2Bucket(objects);
  state.throwOnGet = true;
  const server = await startWorkerHttpServer({
    LOCAL_R2_SOURCE_TOKEN: token,
    TRANSFER_SOURCE_BUCKET: bucket,
  });
  try {
    const source = createLocalR2TransferSource({ url: server.url, token });
    const page = await source.listPage({ prefix, cursor: null, limit: 1 });
    await assert.rejects(
      source.openRead({ key: keyA, ifVersion: page.objects[0].version }),
      error => {
        assert.equal(error?.message, "OBJECT_TRANSFER_RETRYABLE");
        assert.equal(error.message.includes(keyA), false);
        assert.equal(error.message.includes(token), false);
        assert.equal(error.message.includes("secret="), false);
        return true;
      },
    );
    assert.deepEqual(state.getCalls[0], {
      requestedKey: keyA,
      options: { onlyIf: { etagMatches: "r2-etag-1" } },
    });
  } finally {
    await server.close();
  }
});
