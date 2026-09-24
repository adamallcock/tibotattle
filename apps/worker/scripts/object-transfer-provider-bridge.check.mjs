import assert from "node:assert/strict";
import test from "node:test";
import {
  ObjectTransferRetryableError,
  ObjectTransferTargetExistsError,
  runPostgresObjectTransferRehearsal,
} from "./postgres-object-transfer-rehearsal.mjs";
import {
  ObjectTransferProviderError,
  createGcsJsonApiObjectTransferTarget,
  createR2BindingObjectTransferSource,
  OBJECT_TRANSFER_PROVIDER_PAGE_MAX,
  OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX,
  OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX,
} from "./object-transfer-provider-bridge.mjs";

const key = "quarantine/payload.bin";
const prefix = "quarantine/";
const sourceBytes = new Uint8Array(300_000).map((_, index) => index % 251);

function readable(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function pacedReadable(chunks, delayMilliseconds, firstDelayMilliseconds = delayMilliseconds) {
  let streamController;
  let timer;
  let index = 0;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      const send = () => {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
        timer = setTimeout(send, delayMilliseconds);
      };
      timer = setTimeout(send, firstDelayMilliseconds);
    },
    cancel() { clearTimeout(timer); },
  }, { highWaterMark: 0 });
  return {
    stream,
    abort() {
      clearTimeout(timer);
      try { streamController.error(new Error("synthetic body aborted")); } catch { /* Already closed. */ }
    },
  };
}

async function* boundedChunks(value) {
  for (let offset = 0; offset < value.byteLength; offset += OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX) {
    yield value.subarray(offset, Math.min(value.byteLength, offset + OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX));
  }
}

function jsonResponse(status, value, headers = {}) {
  return new Response(value === null ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function metadata() {
  return { contentType: "application/octet-stream", customMetadata: { retention: "quarantine" } };
}

function customMetadataAtLimit(extraBytes = 0) {
  return Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
    `${index}${"k".repeat(511)}`,
    `v`.repeat(512 + (index === 0 ? extraBytes : 0)),
  ]));
}

function fakeR2Object({ version = "upload-v1", etag = "etag-v1", body = sourceBytes } = {}) {
  return {
    key,
    version,
    etag,
    size: body.byteLength,
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { retention: "quarantine" },
    body: readable([body]),
  };
}

test("R2 source maps bounded listing pages, metadata, and a version plus conditional ETag read", async () => {
  const calls = [];
  const binding = {
    async list(options) {
      calls.push(options);
      return {
        objects: [fakeR2Object()],
        truncated: false,
      };
    },
    async get(requestedKey, options) {
      calls.push({ requestedKey, options });
      return fakeR2Object();
    },
  };
  const source = createR2BindingObjectTransferSource(binding);
  const page = await source.listPage({ prefix, cursor: null, limit: 17 });
  assert.deepEqual(calls[0], {
    prefix,
    limit: 17,
    include: ["httpMetadata", "customMetadata"],
  });
  assert.equal(calls[0].limit, 17);
  assert.equal(page.nextCursor, null);
  assert.equal(page.objects[0].key, key);
  assert.equal(page.objects[0].metadata.contentType, metadata().contentType);
  assert.deepEqual(Object.fromEntries(Object.entries(page.objects[0].metadata.customMetadata)), metadata().customMetadata);

  const opened = await source.openRead({ key, ifVersion: page.objects[0].version });
  assert.equal(calls[1].requestedKey, key);
  assert.deepEqual(calls[1].options, { onlyIf: { etagMatches: "etag-v1" } });
  assert.equal(opened.version, page.objects[0].version);
  const received = [];
  for await (const chunk of opened.body) received.push(chunk);
  assert.equal(received.reduce((sum, chunk) => sum + chunk.byteLength, 0), sourceBytes.byteLength);
  assert.ok(received.every(chunk => chunk.byteLength <= OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX));
});

test("R2 source refuses a changed version even when its content ETag still matches", async () => {
  let conditional;
  const binding = {
    async list(options) {
      assert.deepEqual(options.include, ["httpMetadata", "customMetadata"]);
      return { objects: [fakeR2Object()], truncated: false };
    },
    async get(_requestedKey, options) {
      conditional = options.onlyIf.etagMatches;
      return fakeR2Object({ version: "upload-v2", etag: "etag-v1" });
    },
  };
  const source = createR2BindingObjectTransferSource(binding);
  const page = await source.listPage({ prefix, cursor: null, limit: 1 });
  await assert.rejects(
    source.openRead({ key, ifVersion: page.objects[0].version }),
    error => error instanceof ObjectTransferProviderError && error.code === "OBJECT_TRANSFER_SOURCE_CHANGED",
  );
  assert.equal(conditional, "etag-v1");
});

test("R2 source fails closed when the current transfer contract cannot preserve object metadata", async () => {
  const binding = {
    async list(options) {
      assert.deepEqual(options.include, ["httpMetadata", "customMetadata"]);
      return {
        objects: [{ ...fakeR2Object(), httpMetadata: { contentType: "application/octet-stream", cacheControl: "private" } }],
        truncated: false,
      };
    },
    async get() { throw new Error("not used"); },
  };
  const source = createR2BindingObjectTransferSource(binding);
  await assert.rejects(
    source.listPage({ prefix, cursor: null, limit: 1 }),
    error => error instanceof ObjectTransferProviderError && error.code === "OBJECT_TRANSFER_METADATA_UNSUPPORTED",
  );
});

test("GCS target uses bounded pages and pins media reads to an exact generation", async () => {
  const requests = [];
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      requests.push({ url, init });
      if (url.pathname.endsWith("/o")) {
        return jsonResponse(200, {
          items: [{
            name: key,
            size: String(sourceBytes.byteLength),
            generation: "145",
            contentType: metadata().contentType,
            metadata: metadata().customMetadata,
          }],
        });
      }
      if (init.method === "GET" && url.searchParams.get("alt") === "media") {
        return new Response(readable([new Uint8Array(600_000)]), { status: 200 });
      }
      return jsonResponse(200, {
        name: key,
        size: String(sourceBytes.byteLength),
        generation: "145",
        contentType: metadata().contentType,
        metadata: metadata().customMetadata,
      });
    },
  });

  const page = await target.listPage({ prefix, cursor: null, limit: 23 });
  assert.equal(page.objects.length, 1);
  assert.equal(page.objects[0].generation, "145");
  assert.equal(page.objects[0].metadata.contentType, metadata().contentType);
  assert.equal(requests[0].url.searchParams.get("maxResults"), "23");

  const opened = await target.openRead({ key, ifGeneration: "145" });
  assert.ok(requests[1].url.pathname.startsWith("/download/storage/v1/"));
  assert.equal(requests[1].url.searchParams.get("generation"), "145");
  assert.equal(requests[1].url.searchParams.get("ifGenerationMatch"), "145");
  let bytes = 0;
  for await (const chunk of opened.body) {
    bytes += chunk.byteLength;
    assert.ok(chunk.byteLength <= OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX);
  }
  assert.equal(bytes, 600_000);
});

test("GCS media reads may outlive the total timeout while making steady progress", async () => {
  const bodyBytes = Array.from({ length: 5 }, (_, index) => new Uint8Array([index + 1]));
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    timeoutMilliseconds: 60,
    fetchImpl: async (_input, init) => {
      const body = pacedReadable(bodyBytes, 20);
      init.signal.addEventListener("abort", body.abort, { once: true });
      return new Response(body.stream, { status: 200 });
    },
  });
  const opened = await target.openRead({ key, ifGeneration: "145" });
  let byteCount = 0;
  for await (const chunk of opened.body) byteCount += chunk.byteLength;
  assert.equal(byteCount, 5, "five progress intervals exceed the idle timeout in total");
});

test("GCS media reads fail retryably when the body stops making progress", async () => {
  let aborted = false;
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    timeoutMilliseconds: 30,
    fetchImpl: async (_input, init) => {
      const body = pacedReadable([new Uint8Array([1])], 10, 80);
      init.signal.addEventListener("abort", () => { aborted = true; body.abort(); }, { once: true });
      return new Response(body.stream, { status: 200 });
    },
  });
  const opened = await target.openRead({ key, ifGeneration: "145" });
  await assert.rejects(
    async () => { for await (const _chunk of opened.body) { /* Consume to observe the idle timeout. */ } },
    error => error instanceof ObjectTransferRetryableError,
  );
  assert.equal(aborted, true);
});

test("GCS upload is create-only, bounded, preserves supported metadata, and finalizes a generation", async () => {
  const calls = [];
  const payload = new Uint8Array(OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX + 37_856);
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      if (init.method === "POST") {
        assert.equal(url.searchParams.get("uploadType"), "resumable");
        assert.equal(url.searchParams.get("ifGenerationMatch"), "0");
        assert.equal(init.headers.authorization, "Bearer synthetic-token");
        const body = JSON.parse(init.body);
        assert.equal(body.contentType, metadata().contentType);
        assert.deepEqual(body.metadata, metadata().customMetadata);
        return new Response(null, {
          status: 201,
          headers: { location: "https://storage.googleapis.com/upload/storage/v1/b/tibotattle-test-quarantine/o?upload_id=synthetic-test" },
        });
      }
      if (init.method === "DELETE") return new Response(null, { status: 499 });
      assert.equal(init.method, "PUT");
      assert.equal(init.redirect, "manual", "GCS 308 must reach the resume handler");
      assert.equal(init.headers.authorization, undefined, "the session URI is the upload capability");
      assert.ok(init.body.byteLength <= OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX);
      const putCount = calls.filter(call => call.init.method === "PUT").length;
      const partialEnd = 1024 * 1024 - 1;
      if (putCount === 1) {
        assert.equal(init.body.byteLength, OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX);
        assert.equal(init.headers["content-range"], `bytes 0-${OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX - 1}/*`);
        return new Response(null, {
          status: 308,
          headers: { range: `bytes=0-${partialEnd}` },
        });
      }
      if (putCount === 2) {
        assert.equal(init.headers["content-range"], `bytes ${partialEnd + 1}-${OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX - 1}/*`);
        assert.equal(init.body.byteLength, OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX - partialEnd - 1);
        return new Response(null, {
          status: 308,
          headers: { range: `bytes=0-${OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX - 1}` },
        });
      }
      assert.equal(init.headers["content-range"], `bytes ${OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX}-${payload.byteLength - 1}/${payload.byteLength}`);
      return jsonResponse(200, {
        name: key,
        size: String(payload.byteLength),
        generation: "146",
        contentType: metadata().contentType,
        metadata: metadata().customMetadata,
      });
    },
  });

  async function* body() {
    yield* boundedChunks(payload);
  }
  const result = await target.putIfAbsent({
    key,
    metadata: metadata(),
    ifGenerationMatch: "0",
    body: body(),
  });
  assert.equal(result, "146");
  assert.equal(calls.filter(call => call.init.method === "PUT").length, 3);
});

test("GCS preserves custom metadata exactly at the shared 8 KiB provider limit", async () => {
  const expectedMetadata = customMetadataAtLimit();
  let initialMetadata;
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (_input, init) => {
      if (init.method === "POST") {
        initialMetadata = JSON.parse(init.body).metadata;
        return new Response(null, {
          status: 201,
          headers: { location: "https://storage.googleapis.com/upload/storage/v1/b/tibotattle-test-quarantine/o?upload_id=synthetic-metadata-limit" },
        });
      }
      return jsonResponse(201, {
        name: key,
        size: "0",
        generation: "151",
        contentType: "application/octet-stream",
        metadata: expectedMetadata,
      });
    },
  });
  const result = await target.putIfAbsent({
    key,
    metadata: { contentType: "application/octet-stream", customMetadata: expectedMetadata },
    ifGenerationMatch: "0",
    body: (async function* () {})(),
  });
  assert.equal(result, "151");
  assert.deepEqual(initialMetadata, expectedMetadata);
});

test("GCS rejects custom metadata above 8 KiB before requesting an upload session", async () => {
  let requestCount = 0;
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async () => { requestCount += 1; return jsonResponse(500, null); },
  });
  await assert.rejects(
    target.putIfAbsent({
      key,
      metadata: { contentType: "application/octet-stream", customMetadata: customMetadataAtLimit(1) },
      ifGenerationMatch: "0",
      body: (async function* () {})(),
    }),
    error => error instanceof ObjectTransferProviderError && error.code === "OBJECT_TRANSFER_METADATA_LIMIT",
  );
  assert.equal(requestCount, 0);
});

test("GCS queries persisted offset after an interrupted upload and resumes inside the held block", async () => {
  const calls = [];
  const payload = new Uint8Array(OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX + 37_856)
    .map((_, index) => index % 251);
  const persistedEnd = 1024 * 1024 - 1;
  const blockEnd = OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX - 1;
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (_input, init) => {
      calls.push(init);
      if (init.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { location: "https://storage.googleapis.com/upload/storage/v1/b/tibotattle-test-quarantine/o?upload_id=synthetic-resume" },
        });
      }
      if (init.method === "DELETE") return new Response(null, { status: 499 });
      assert.equal(init.method, "PUT");
      assert.equal(init.headers.authorization, undefined);
      if (init.headers["content-range"] === "bytes */*") {
        assert.equal(init.body.byteLength, 0);
        return new Response(null, { status: 308, headers: { range: `bytes=0-${persistedEnd}` } });
      }
      if (init.headers["content-range"] === `bytes 0-${blockEnd}/*`) {
        assert.deepEqual(init.body, payload.subarray(0, OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX));
        throw new Error("synthetic connection lost after partial server receipt");
      }
      if (init.headers["content-range"] === `bytes ${persistedEnd + 1}-${blockEnd}/*`) {
        assert.deepEqual(init.body, payload.subarray(persistedEnd + 1, OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX));
        return new Response(null, { status: 308, headers: { range: `bytes=0-${blockEnd}` } });
      }
      assert.equal(init.headers["content-range"], `bytes ${OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX}-${payload.byteLength - 1}/${payload.byteLength}`);
      assert.deepEqual(init.body, payload.subarray(OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX));
      return jsonResponse(201, {
        name: key,
        size: String(payload.byteLength),
        generation: "149",
        contentType: metadata().contentType,
        metadata: metadata().customMetadata,
      });
    },
  });
  const result = await target.putIfAbsent({
    key,
    metadata: metadata(),
    ifGenerationMatch: "0",
    body: boundedChunks(payload),
  });
  assert.equal(result, "149");
  assert.deepEqual(calls.map(call => call.method), ["POST", "PUT", "PUT", "PUT", "PUT"]);
});

test("GCS accepts a successful status query after the final upload response is lost", async () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  let uploadRequests = 0;
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (_input, init) => {
      if (init.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { location: "https://storage.googleapis.com/upload/storage/v1/b/tibotattle-test-quarantine/o?upload_id=synthetic-final-response-lost" },
        });
      }
      if (init.method === "DELETE") return new Response(null, { status: 499 });
      if (init.headers["content-range"] === `bytes */${payload.byteLength}`) {
        assert.equal(init.body.byteLength, 0);
        return jsonResponse(200, {
          name: key,
          size: String(payload.byteLength),
          generation: "150",
          contentType: metadata().contentType,
          metadata: metadata().customMetadata,
        });
      }
      uploadRequests += 1;
      assert.deepEqual(init.body, payload);
      throw new Error("synthetic final response lost");
    },
  });
  const result = await target.putIfAbsent({
    key,
    metadata: metadata(),
    ifGenerationMatch: "0",
    body: (async function* () { yield payload; })(),
  });
  assert.equal(result, "150");
  assert.equal(uploadRequests, 1);
});

test("GCS restarts the held block at byte zero when a status query has no Range", async () => {
  const payload = new Uint8Array([5, 6, 7]);
  let putCount = 0;
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (_input, init) => {
      if (init.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { location: "https://storage.googleapis.com/upload/storage/v1/b/tibotattle-test-quarantine/o?upload_id=synthetic-no-range" },
        });
      }
      if (init.headers["content-range"] === "bytes */3") {
        assert.equal(init.body.byteLength, 0);
        return new Response(null, { status: 308 });
      }
      putCount += 1;
      assert.deepEqual(init.body, payload);
      if (putCount === 1) throw new Error("synthetic request failed before any bytes persisted");
      assert.equal(init.headers["content-range"], "bytes 0-2/3");
      return jsonResponse(201, { name: key, size: "3", generation: "152" });
    },
  });
  const result = await target.putIfAbsent({
    key,
    metadata: metadata(),
    ifGenerationMatch: "0",
    body: (async function* () { yield payload; })(),
  });
  assert.equal(result, "152");
  assert.equal(putCount, 2);
});

test("GCS bounds repeated no-progress chunk responses and cancels the session", async () => {
  let dataPuts = 0;
  let cancellations = 0;
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (_input, init) => {
      if (init.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { location: "https://storage.googleapis.com/upload/storage/v1/b/tibotattle-test-quarantine/o?upload_id=synthetic-no-progress" },
        });
      }
      if (init.method === "DELETE") {
        cancellations += 1;
        return new Response(null, { status: 499 });
      }
      dataPuts += 1;
      return new Response(null, { status: 308 });
    },
  });
  const body = boundedChunks(new Uint8Array(OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX + 1));
  await assert.rejects(
    target.putIfAbsent({ key, metadata: metadata(), ifGenerationMatch: "0", body }),
    error => error instanceof ObjectTransferRetryableError,
  );
  assert.equal(dataPuts, 8);
  assert.equal(cancellations, 1);
});

test("the rehearsal restarts an expired GCS session from the pinned source byte zero", async () => {
  const payload = new Uint8Array([11, 12, 13, 14]);
  const sourceVersion = "r2v1.synthetic-version";
  let sourceReads = 0;
  const source = {
    async listPage() {
      return { objects: [{ key, size: payload.byteLength, metadata: metadata(), version: sourceVersion }], nextCursor: null };
    },
    async openRead({ key: requestedKey, ifVersion }) {
      assert.equal(requestedKey, key);
      assert.equal(ifVersion, sourceVersion);
      sourceReads += 1;
      return { version: sourceVersion, body: boundedChunks(payload) };
    },
  };
  const checkpoints = new Map();
  const stored = { bytes: null, generation: "153" };
  const dataBodies = [];
  let sessions = 0;
  let cancellations = 0;
  const objectValue = () => ({
    name: key,
    size: String(payload.byteLength),
    generation: stored.generation,
    contentType: metadata().contentType,
    metadata: metadata().customMetadata,
  });
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (init.method === "POST") {
        sessions += 1;
        return new Response(null, {
          status: 201,
          headers: { location: `https://storage.googleapis.com/upload/storage/v1/b/tibotattle-test-quarantine/o?upload_id=synthetic-restart-${sessions}` },
        });
      }
      if (init.method === "DELETE") {
        cancellations += 1;
        return new Response(null, { status: 499 });
      }
      if (url.searchParams.get("upload_id") === "synthetic-restart-1") {
        assert.equal(init.method, "PUT");
        return new Response(null, { status: 410 });
      }
      if (init.method === "PUT") {
        assert.equal(url.searchParams.get("upload_id"), "synthetic-restart-2");
        assert.equal(init.headers["content-range"], undefined, "a new single-chunk session starts at byte zero");
        dataBodies.push(new Uint8Array(init.body));
        stored.bytes = new Uint8Array(init.body);
        return jsonResponse(201, objectValue());
      }
      if (init.method === "GET" && url.searchParams.get("alt") === "media") {
        assert.equal(url.searchParams.get("generation"), stored.generation);
        return new Response(readable([stored.bytes]), { status: 200 });
      }
      if (url.pathname.endsWith("/o")) {
        return jsonResponse(200, { items: stored.bytes === null ? [] : [objectValue()] });
      }
      return stored.bytes === null ? jsonResponse(404, null) : jsonResponse(200, objectValue());
    },
  });
  const checkpointStore = {
    async get({ sourceManifestSha256, key: checkpointKey }) {
      return checkpoints.get(`${sourceManifestSha256}:${checkpointKey}`) ?? null;
    },
    async put(value) { checkpoints.set(`${value.sourceManifestSha256}:${value.key}`, value); },
  };
  const receipt = await runPostgresObjectTransferRehearsal({
    source,
    target,
    checkpoints: checkpointStore,
    options: {
      prefix,
      pageSize: 2,
      maxObjects: 10,
      maxTotalBytes: 1024,
      maxAttempts: 2,
      maxObjectsThisRun: 10,
    },
  });
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.metrics.retries, 1);
  assert.equal(sourceReads, 2);
  assert.equal(sessions, 2);
  assert.equal(cancellations, 1);
  assert.deepEqual(dataBodies, [payload]);
});

test("GCS cancels an incomplete resumable session when the source stream fails", async () => {
  const calls = [];
  const failure = Object.assign(new Error("synthetic source failure sentinel"), { code: "SOURCE_STREAM_FAILED" });
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      if (init.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { location: "https://storage.googleapis.com/upload/storage/v1/b/tibotattle-test-quarantine/o?upload_id=synthetic-failure" },
        });
      }
      if (init.method === "PUT") {
        if (calls.filter(call => call.init.method === "PUT").length === 1) {
          return new Response(null, {
            status: 308,
            headers: { range: `bytes=0-${OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX - 1}` },
          });
        }
        return jsonResponse(200, {
          name: key,
          size: String(OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX + 1),
          generation: "147",
        });
      }
      assert.equal(init.method, "DELETE");
      assert.equal(init.headers["content-length"], "0");
      return new Response(null, { status: 499 });
    },
  });
  async function* brokenBody() {
    yield* boundedChunks(new Uint8Array(OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX));
    yield new Uint8Array([1]);
    throw failure;
  }
  await assert.rejects(
    target.putIfAbsent({ key, metadata: metadata(), ifGenerationMatch: "0", body: brokenBody() }),
    error => error === failure,
  );
  assert.equal(calls.filter(call => call.init.method === "PUT").length, 1);
  assert.equal(calls.filter(call => call.init.method === "DELETE").length, 1);
  assert.equal(calls.some(call => call.init.method === "PUT"
    && call.init.headers["content-range"]?.endsWith(`/${OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX + 1}`)), false);
});

test("GCS finalizes an empty object with a single zero-length upload", async () => {
  let upload;
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (_input, init) => {
      if (init.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { location: "https://storage.googleapis.com/upload/storage/v1/b/tibotattle-test-quarantine/o?upload_id=synthetic-empty" },
        });
      }
      upload = init;
      return jsonResponse(201, {
        name: key,
        size: "0",
        generation: "148",
        contentType: metadata().contentType,
        metadata: metadata().customMetadata,
      });
    },
  });
  const result = await target.putIfAbsent({
    key,
    metadata: metadata(),
    ifGenerationMatch: "0",
    body: (async function* () {})(),
  });
  assert.equal(result, "148");
  assert.equal(upload.headers["content-length"], "0");
  assert.equal(upload.headers["content-range"], undefined);
});

test("GCS maps create-only conflicts without returning provider response bodies", async () => {
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (_input, init) => init.method === "POST"
      ? jsonResponse(412, { error: { message: "synthetic provider failure sentinel" } })
      : jsonResponse(500, null),
  });
  await assert.rejects(
    target.putIfAbsent({ key, metadata: metadata(), ifGenerationMatch: "0", body: (async function* () {})() }),
    error => error instanceof ObjectTransferTargetExistsError && !error.message.includes("synthetic provider"),
  );
});

test("unsafe resumable session locations are rejected before object bytes are sent", async () => {
  let putCount = 0;
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (_input, init) => {
      if (init.method === "POST") {
        return new Response(null, { status: 201, headers: { location: "https://attacker.example/session" } });
      }
      putCount += 1;
      return jsonResponse(200, null);
    },
  });
  await assert.rejects(
    target.putIfAbsent({ key, metadata: metadata(), ifGenerationMatch: "0", body: (async function* () { yield new Uint8Array([1]); })() }),
    error => error instanceof ObjectTransferProviderError && error.code === "OBJECT_TRANSFER_GCS_SESSION_INVALID",
  );
  assert.equal(putCount, 0);
});

test("provider adapters complete a synthetic inventory, transfer, readback, and checkpoint run", async () => {
  const payload = sourceBytes.subarray(0, 12_345);
  const sourceObject = fakeR2Object({ body: payload });
  const r2 = {
    async list(options) {
      assert.deepEqual(options.include, ["httpMetadata", "customMetadata"]);
      return { objects: [sourceObject], truncated: false };
    },
    async get(_requestedKey, options) {
      assert.equal(options.onlyIf.etagMatches, sourceObject.etag);
      return fakeR2Object({ body: payload });
    },
  };
  const source = createR2BindingObjectTransferSource(r2);
  const checkpoints = new Map();
  const stored = { data: null, generation: "9001", metadata: null };
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (init.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { location: "https://storage.googleapis.com/upload/storage/v1/b/tibotattle-test-quarantine/o?upload_id=synthetic-integration" },
        });
      }
      if (init.method === "PUT") {
        stored.data = new Uint8Array(init.body);
        stored.metadata = {
          contentType: "application/octet-stream",
          customMetadata: { retention: "quarantine" },
        };
        return jsonResponse(201, {
          name: key,
          size: String(stored.data.byteLength),
          generation: stored.generation,
          contentType: stored.metadata.contentType,
          metadata: stored.metadata.customMetadata,
        });
      }
      if (url.pathname.endsWith("/o")) {
        return jsonResponse(200, {
          items: stored.data === null ? [] : [{
            name: key,
            size: String(stored.data.byteLength),
            generation: stored.generation,
            contentType: stored.metadata.contentType,
            metadata: stored.metadata.customMetadata,
          }],
        });
      }
      if (init.method === "GET" && url.searchParams.get("alt") === "media") {
        assert.equal(url.searchParams.get("generation"), stored.generation);
        return new Response(readable([stored.data]), { status: 200 });
      }
      if (stored.data === null) return jsonResponse(404, { error: { message: "absent" } });
      return jsonResponse(200, {
        name: key,
        size: String(stored.data.byteLength),
        generation: stored.generation,
        contentType: stored.metadata.contentType,
        metadata: stored.metadata.customMetadata,
      });
    },
  });
  const checkpointStore = {
    async get({ sourceManifestSha256, key: checkpointKey }) {
      return checkpoints.get(`${sourceManifestSha256}:${checkpointKey}`) ?? null;
    },
    async put(value) {
      checkpoints.set(`${value.sourceManifestSha256}:${value.key}`, value);
    },
  };
  const receipt = await runPostgresObjectTransferRehearsal({
    source,
    target,
    checkpoints: checkpointStore,
    options: {
      prefix,
      pageSize: 2,
      maxObjects: 10,
      maxTotalBytes: 1024 * 1024,
      maxAttempts: 2,
      maxObjectsThisRun: 10,
    },
  });
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.sourceObjects, 1);
  assert.equal(receipt.sourceInventorySha256, receipt.targetInventorySha256);
  assert.deepEqual(stored.data, payload);
  assert.equal(checkpoints.size, 1);
});

test("provider constructor and methods reject invalid bounds before making requests", async () => {
  assert.throws(
    () => createGcsJsonApiObjectTransferTarget({ bucket: "bad bucket", accessToken: async () => "token" }),
    error => error instanceof ObjectTransferProviderError,
  );
  const target = createGcsJsonApiObjectTransferTarget({
    bucket: "tibotattle-test-quarantine",
    accessToken: async () => "synthetic-token",
    fetchImpl: async () => jsonResponse(200, { items: [] }),
  });
  await assert.rejects(
    target.listPage({ prefix, cursor: null, limit: OBJECT_TRANSFER_PROVIDER_PAGE_MAX + 1 }),
    error => error instanceof ObjectTransferProviderError && error.code === "OBJECT_TRANSFER_PAGE_LIMIT_INVALID",
  );
});
