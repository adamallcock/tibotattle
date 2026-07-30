import assert from "node:assert/strict";
import test from "node:test";
import {
  configurationFromEnvironment,
  startContainedService,
} from "../src/server.js";
import { createMemoryObjectStore } from "../src/object-store.js";

test("configuration keeps collection disabled and memory local-only", () => {
  assert.equal(configurationFromEnvironment({
    ENVIRONMENT: "local-test",
    COLLECTION_MODE: "disabled",
    OBJECT_STORE_MODE: "memory",
    PORT: "0",
  }).port, 0);
  assert.throws(() => configurationFromEnvironment({
    ENVIRONMENT: "production",
    COLLECTION_MODE: "disabled",
    OBJECT_STORE_MODE: "memory",
  }), /configuration failed/);
  assert.throws(() => configurationFromEnvironment({
    ENVIRONMENT: "contained-staging",
    COLLECTION_MODE: "enabled",
    OBJECT_STORE_MODE: "gcs",
    GCS_BUCKET: "bucket-name",
  }), /configuration failed/);
});

test("liveness, readiness, and contained API remain distinct", async (context) => {
  const app = await startContainedService({
    environment: {
      ENVIRONMENT: "local-test",
      COLLECTION_MODE: "disabled",
      OBJECT_STORE_MODE: "memory",
      PORT: "0",
    },
    objectStore: createMemoryObjectStore(),
  });
  context.after(() => app.close());
  const origin = `http://127.0.0.1:${app.port}`;
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).collectionMode, "disabled");
  const ready = await fetch(`${origin}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).checks.metadataStore, "not_implemented");
  const contribution = await fetch(`${origin}/api/v1/contributions`, {
    method: "POST",
  });
  assert.equal(contribution.status, 503);
  assert.equal(
    (await contribution.json()).error.code,
    "collection_disabled",
  );
});

test("unavailable storage makes readiness fail without killing liveness", async (context) => {
  const app = await startContainedService({
    environment: {
      ENVIRONMENT: "local-test",
      COLLECTION_MODE: "disabled",
      OBJECT_STORE_MODE: "memory",
      PORT: "0",
    },
    objectStore: createMemoryObjectStore({ readiness: false }),
  });
  context.after(() => app.close());
  const origin = `http://127.0.0.1:${app.port}`;
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${origin}/readyz`)).status, 503);
});

test("draining blocks readiness while liveness remains available", async (context) => {
  const app = await startContainedService({
    environment: {
      ENVIRONMENT: "local-test",
      COLLECTION_MODE: "disabled",
      OBJECT_STORE_MODE: "memory",
      PORT: "0",
    },
    objectStore: createMemoryObjectStore(),
  });
  context.after(() => app.close());
  const origin = `http://127.0.0.1:${app.port}`;
  app.setDraining(true);
  const readiness = await fetch(`${origin}/readyz`);
  assert.equal(readiness.status, 503);
  assert.deepEqual((await readiness.json()).checks, {
    draining: "blocked",
    objectStore: "unavailable",
    metadataStore: "not_implemented",
    collection: "disabled",
  });
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
});
