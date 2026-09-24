import assert from "node:assert/strict";
import test from "node:test";
import {
  ObjectTransferRehearsalError,
  createSyntheticR2GcsTransferFixture,
  runPostgresObjectTransferRehearsal,
} from "./postgres-object-transfer-rehearsal.mjs";

function options(fixture, overrides = {}) {
  return {
    prefix: fixture.prefix,
    pageSize: 2,
    maxObjects: 100,
    maxTotalBytes: 8 * 1024 * 1024,
    maxAttempts: 3,
    maxObjectsThisRun: 2,
    ...overrides,
  };
}

test("synthetic object transfer streams bounded bytes, resumes checkpoints, retries, and verifies the destination", async () => {
  const fixture = createSyntheticR2GcsTransferFixture({
    objectCount: 6,
    bytesPerObject: 192 * 1024,
    streamChunkBytes: 16 * 1024,
    pageSize: 2,
    failBeforeCommitOnceFor: "synthetic-quarantine/object-0002.bin",
    commitThenFailOnceFor: "synthetic-quarantine/object-0004.bin",
  });
  const runOptions = options(fixture);
  const receipts = [];
  let receipt = await runPostgresObjectTransferRehearsal({ ...fixture, options: runOptions });
  receipts.push(receipt);
  for (let attempt = 0; receipt.status !== "complete" && attempt < 10; attempt += 1) {
    receipt = await runPostgresObjectTransferRehearsal({ ...fixture, options: runOptions });
    receipts.push(receipt);
  }

  assert.equal(receipt.status, "complete");
  assert.equal(receipt.sourceObjects, 6);
  assert.equal(receipt.sourceInventorySha256, receipt.targetInventorySha256);
  assert.equal(fixture.checkpointCount(), 6);
  assert.equal(fixture.targetObjectCount(), 6);
  assert.ok(receipts.some(item => item.status === "checkpointed"));
  assert.ok(receipts.some(item => item.metrics.resumed > 0));
  assert.ok(receipts.some(item => item.metrics.retries > 0));
  assert.ok(receipts.some(item => item.metrics.adopted > 0));
  assert.equal(fixture.state.maxObservedSourceChunkBytes, 16 * 1024);
  assert.equal(fixture.state.maxObservedTargetChunkBytes, 16 * 1024);
  assert.equal(fixture.state.maxActiveWrites, 1);
  assert.ok(fixture.state.targetReadbacks >= 6);
  assert.ok(receipts.every(item => !Object.hasOwn(item, "keys")));
});

test("checkpointed object replacement is detected by its immutable target generation", async () => {
  const fixture = createSyntheticR2GcsTransferFixture({
    objectCount: 2,
    bytesPerObject: 32 * 1024,
    streamChunkBytes: 8 * 1024,
    pageSize: 2,
  });
  const runOptions = options(fixture, { maxObjectsThisRun: 10 });
  const complete = await runPostgresObjectTransferRehearsal({ ...fixture, options: runOptions });
  assert.equal(complete.status, "complete");
  const object = fixture.targetObjects.get("synthetic-quarantine/object-0000.bin");
  assert.ok(object?.chunks[0]?.byteLength);
  // A changed generation represents replacement of immutable target content.
  object.generation = "replacement-generation";
  const writesBefore = fixture.state.targetWrites;

  await assert.rejects(
    runPostgresObjectTransferRehearsal({ ...fixture, options: runOptions }),
    error => error instanceof ObjectTransferRehearsalError
      && error.code === "OBJECT_TRANSFER_CHECKPOINT_TARGET_MISMATCH",
  );
  assert.equal(fixture.state.targetWrites, writesBefore);
});

test("custom metadata preserves a literal __proto__ key", async () => {
  const fixture = createSyntheticR2GcsTransferFixture({
    objectCount: 1,
    bytesPerObject: 16 * 1024,
    streamChunkBytes: 4 * 1024,
    pageSize: 1,
  });
  const sourceMetadata = JSON.parse('{"__proto__":"literal-metadata-value"}');
  const source = Object.freeze({
    listPage: async request => {
      const result = await fixture.source.listPage(request);
      return {
        ...result,
        objects: result.objects.map(item => ({
          ...item,
          metadata: { contentType: item.metadata.contentType, customMetadata: sourceMetadata },
        })),
      };
    },
    openRead: fixture.source.openRead.bind(fixture.source),
  });

  const result = await runPostgresObjectTransferRehearsal({
    ...fixture,
    source,
    options: options(fixture, { maxObjectsThisRun: 10 }),
  });

  assert.equal(result.status, "complete");
  const stored = fixture.targetObjects.get("synthetic-quarantine/object-0000.bin");
  assert.equal(Object.hasOwn(stored.metadata.customMetadata, "__proto__"), true);
  assert.equal(stored.metadata.customMetadata.__proto__, "literal-metadata-value");
});

test("a short source stream aborts its staged destination write before commit", async () => {
  const fixture = createSyntheticR2GcsTransferFixture({
    objectCount: 1,
    bytesPerObject: 32 * 1024,
    streamChunkBytes: 8 * 1024,
    pageSize: 1,
  });
  const source = Object.freeze({
    listPage: fixture.source.listPage.bind(fixture.source),
    async openRead(request) {
      const opened = await fixture.source.openRead(request);
      return {
        version: opened.version,
        body: (async function* () {
          let previous = null;
          for await (const chunk of opened.body) {
            if (previous) yield previous;
            previous = chunk;
          }
          // Simulate a transport that closes cleanly after returning too few bytes.
        }()),
      };
    },
  });

  await assert.rejects(
    runPostgresObjectTransferRehearsal({
      ...fixture,
      source,
      options: options(fixture, { maxObjectsThisRun: 10 }),
    }),
    error => error instanceof ObjectTransferRehearsalError
      && error.code === "OBJECT_TRANSFER_SOURCE_SIZE_MISMATCH",
  );
  assert.equal(fixture.targetObjectCount(), 0);
  assert.equal(fixture.checkpointCount(), 0);
});

test("source inventory drift is detected before an early checkpointed receipt", async () => {
  const fixture = createSyntheticR2GcsTransferFixture({
    objectCount: 4,
    bytesPerObject: 16 * 1024,
    streamChunkBytes: 4 * 1024,
    pageSize: 2,
  });
  let listCalls = 0;
  const source = Object.freeze({
    async listPage(request) {
      listCalls += 1;
      const result = await fixture.source.listPage(request);
      if (listCalls < 4) return result;
      return {
        ...result,
        objects: result.objects.map((item, index) => index === 0
          ? {
            ...item,
            metadata: {
              ...item.metadata,
              customMetadata: { ...item.metadata.customMetadata, drift: "same-size-change" },
            },
          }
          : item),
      };
    },
    openRead: fixture.source.openRead.bind(fixture.source),
  });

  await assert.rejects(
    runPostgresObjectTransferRehearsal({
      ...fixture,
      source,
      options: options(fixture, { maxObjectsThisRun: 1 }),
    }),
    error => error instanceof ObjectTransferRehearsalError
      && error.code === "OBJECT_TRANSFER_SOURCE_INVENTORY_CHANGED",
  );
  assert.ok(listCalls >= 4);
  assert.equal(fixture.targetObjectCount(), 1);
});

test("checkpoint resume trusts the immutable target generation without rehashing its bytes", async () => {
  const fixture = createSyntheticR2GcsTransferFixture({
    objectCount: 2,
    bytesPerObject: 16 * 1024,
    streamChunkBytes: 4 * 1024,
    pageSize: 1,
  });
  const runOptions = options(fixture, { maxObjectsThisRun: 1 });
  const first = await runPostgresObjectTransferRehearsal({ ...fixture, options: runOptions });
  assert.equal(first.status, "checkpointed");
  const readbacksAfterFirst = fixture.state.targetReadbacks;

  const second = await runPostgresObjectTransferRehearsal({ ...fixture, options: runOptions });

  assert.equal(second.status, "complete");
  assert.equal(fixture.state.targetReadbacks, readbacksAfterFirst + 1);
});
