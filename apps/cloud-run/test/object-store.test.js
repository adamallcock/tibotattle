import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createGcsObjectStore,
  createMemoryObjectStore,
  ObjectStoreError,
  objectKeyForDigest,
} from "../src/object-store.js";

function payload(value = "encrypted-envelope") {
  const body = Buffer.from(value);
  const digest = createHash("sha256").update(body).digest("hex");
  return { body, digest };
}

test("memory store is conditional, idempotent, and generation-safe", async () => {
  const store = createMemoryObjectStore();
  const selected = payload();
  const first = await store.putIfAbsent(selected);
  const replay = await store.putIfAbsent(selected);
  assert.deepEqual(replay, first);
  assert.equal(
    first.key,
    objectKeyForDigest("quarantine/v1", selected.digest),
  );
  assert.deepEqual(await store.metadata(first.key), first);
  assert.equal(await store.delete({
    key: first.key,
    generation: String(Number(first.generation) + 1),
  }), false);
  assert.notEqual(await store.metadata(first.key), null);
  assert.equal(await store.delete(first), true);
  assert.equal(await store.delete(first), true);
  assert.equal(await store.metadata(first.key), null);
});

test("GCS adapter uses conditional multipart writes and generation deletion", async () => {
  const selected = payload();
  const key = objectKeyForDigest("quarantine/v1", selected.digest);
  const calls = [];
  const store = createGcsObjectStore({
    bucketName: "private-usage-monitor-bucket",
    request: async (options) => {
      calls.push(options);
      if (options.url.includes("/upload/")) {
        assert.equal(options.method, "POST");
        assert.equal(options.params.ifGenerationMatch, 0);
        assert.equal(options.params.uploadType, "multipart");
        assert.ok(Buffer.isBuffer(options.data));
        assert.match(
          options.headers["Content-Type"],
          /^multipart\/related; boundary=usage-monitor-[a-f0-9]{32}$/u,
        );
        return {
          data: {
            name: key,
            generation: "7",
            size: String(selected.body.byteLength),
            metadata: { payloadSha256: selected.digest },
          },
        };
      }
      if (options.method === "DELETE") return { data: null };
      if (options.url.endsWith(encodeURIComponent("operations/readiness-v1"))) {
        return { data: { generation: "1" } };
      }
      throw new Error("unexpected request");
    },
  });
  const stored = await store.putIfAbsent(selected);
  assert.equal(stored.key, key);
  assert.equal(stored.generation, "7");
  assert.equal(await store.delete(stored), true);
  assert.equal(await store.probe(), true);
  assert.equal(calls[1].params.ifGenerationMatch, "7");
});

test("GCS replay verifies existing metadata and bounds list output", async () => {
  const selected = payload("replayed-envelope");
  const key = objectKeyForDigest("quarantine/v1", selected.digest);
  let uploadAttempted = false;
  const store = createGcsObjectStore({
    bucketName: "private-usage-monitor-bucket",
    request: async (options) => {
      if (options.url.includes("/upload/")) {
        uploadAttempted = true;
        const error = new Error("precondition");
        error.code = 412;
        throw error;
      }
      if (options.url.includes("/o?") || options.url.endsWith("/o")) {
        return {
          data: {
            items: [
              { name: key },
              { name: "../not-ours" },
              { name: "x".repeat(300) },
            ],
            nextPageToken: "next-page",
          },
        };
      }
      return {
        data: {
          name: key,
          generation: "8",
          size: String(selected.body.byteLength),
          metadata: { payloadSha256: selected.digest },
        },
      };
    },
  });
  assert.equal((await store.putIfAbsent(selected)).generation, "8");
  assert.equal(uploadAttempted, true);
  const listed = await store.list();
  assert.deepEqual(listed.items, [key]);
  assert.equal(listed.cursor, "next-page");
});

test("GCS replay safely retries a create collision followed by deletion", async () => {
  const selected = payload("collision-then-delete");
  const key = objectKeyForDigest("quarantine/v1", selected.digest);
  let uploads = 0;
  let metadataReads = 0;
  const store = createGcsObjectStore({
    bucketName: "private-usage-monitor-bucket",
    request: async (options) => {
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.timeout, 15_000);
      if (options.url.includes("/upload/")) {
        uploads += 1;
        if (uploads === 1) {
          const error = new Error("precondition");
          error.status = 412;
          throw error;
        }
        return {
          data: {
            name: key,
            generation: "9",
            size: String(selected.body.byteLength),
            metadata: { payloadSha256: selected.digest },
          },
        };
      }
      metadataReads += 1;
      const error = new Error("deleted after collision");
      error.response = { status: 404 };
      throw error;
    },
  });
  assert.equal((await store.putIfAbsent(selected)).generation, "9");
  assert.equal(uploads, 2);
  assert.equal(metadataReads, 1);
});

test("GCS readiness has a bounded deadline even when transport never settles", async () => {
  const store = createGcsObjectStore({
    bucketName: "private-usage-monitor-bucket",
    request: async (options) => {
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.timeout, 750);
      return new Promise(() => {});
    },
  });
  const startedAt = Date.now();
  assert.equal(await store.probe(), false);
  const duration = Date.now() - startedAt;
  assert.ok(duration >= 650, `deadline returned too early: ${duration}ms`);
  assert.ok(duration < 2_000, `deadline exceeded bound: ${duration}ms`);
});

test("GCS list output remains bounded when an upstream over-returns", async () => {
  const selected = payload("bounded-list");
  const key = objectKeyForDigest("quarantine/v1", selected.digest);
  const store = createGcsObjectStore({
    bucketName: "private-usage-monitor-bucket",
    request: async () => ({
      data: {
        items: Array.from({ length: 25 }, () => ({ name: key })),
      },
    }),
  });
  assert.equal((await store.list({ limit: 3 })).items.length, 3);
});

test("memory store bounds objects, prefixes, digests, and list sizes", async () => {
  assert.throws(
    () => createMemoryObjectStore({ prefix: "../private" }),
    ObjectStoreError,
  );
  const store = createMemoryObjectStore();
  await assert.rejects(
    store.putIfAbsent({ body: Buffer.from("x"), digest: "a".repeat(64) }),
    (error) => error.code === "object_invalid",
  );
  await assert.rejects(
    store.putIfAbsent({
      body: Buffer.alloc(2 * 1024 * 1024 + 1),
      digest: "a".repeat(64),
    }),
    (error) => error.code === "object_invalid",
  );
  await assert.rejects(
    store.list({ limit: 101 }),
    (error) => error.code === "object_invalid",
  );
});
