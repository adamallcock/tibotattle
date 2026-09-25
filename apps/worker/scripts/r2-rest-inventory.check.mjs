import assert from "node:assert/strict";
import test from "node:test";
import { scanR2RestInventory, R2RestInventoryError } from "./r2-rest-inventory.mjs";

const accountId = "a".repeat(32);
const bucketName = "synthetic-quarantine-test";
const token = "synthetic-secret-token";

function object(key, extras = {}) {
  return {
    key,
    size: 12,
    etag: "f".repeat(32),
    storage_class: "Standard",
    http_metadata: { contentType: "application/octet-stream" },
    custom_metadata: { retained: "synthetic" },
    ...extras,
  };
}

function page(result, cursor = null) {
  return {
    success: true,
    result,
    result_info: {
      is_truncated: cursor !== null,
      ...(cursor === null ? {} : { cursor }),
    },
  };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function input(fetchImpl, extra = {}) {
  return { accountId, bucketName, token, pageSize: 2, fetchImpl, ...extra };
}

test("bounded R2 REST inventory pages metadata without emitting keys or credentials", async () => {
  const calls = [];
  const pages = [
    page([object("synthetic/test-one"), object("telemetry/test-two")], "cursor-opaque"),
    page([object("misc/test-three", {
      etag: undefined,
      storage_class: "InfrequentAccess",
      http_metadata: { contentType: "application/octet-stream", cacheControl: "private" },
    })]),
  ];
  const fetchImpl = async (url, request) => {
    calls.push({ url: String(url), request });
    return response(pages[calls.length - 1]);
  };
  const receipt = await scanR2RestInventory(input(fetchImpl));
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("cursor"), "cursor-opaque");
  assert.ok(calls.every(call => call.request.method === "GET"));
  assert.ok(calls.every(call => call.request.redirect === "error"));
  assert.ok(calls.every(call => call.request.headers.authorization === `Bearer ${token}`));
  assert.equal(receipt.objects, 3);
  assert.equal(receipt.bytes, 36);
  assert.deepEqual(receipt.classes, {
    telemetry: { objects: 1, bytes: 12 },
    synthetic: { objects: 1, bytes: 12 },
    other: { objects: 1, bytes: 12 },
  });
  assert.equal(receipt.missingEtag, 1);
  assert.equal(receipt.unsupportedStorageClass, 1);
  assert.equal(receipt.unsupportedHttpMetadata, 1);
  assert.match(receipt.inventorySha256, /^[0-9a-f]{64}$/u);
  assert.equal(receipt.sourceVersionQualified, false);
  assert.equal(receipt.snapshotQualified, false);
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic-secret-token|test-one|test-two|test-three/u);
});

test("inventory refuses duplicate objects and a repeated cursor", async () => {
  let call = 0;
  const duplicate = async () => response(call++ === 0
    ? page([object("telemetry/a")], "cursor-one")
    : page([object("telemetry/a")]));
  await assert.rejects(scanR2RestInventory(input(duplicate)), {
    code: "R2_INVENTORY_DUPLICATE_KEY",
  });
  call = 0;
  const repeated = async () => response(call++ === 0
    ? page([object("telemetry/a")], "cursor-one")
    : page([object("telemetry/b")], "cursor-one"));
  await assert.rejects(scanR2RestInventory(input(repeated)), {
    code: "R2_INVENTORY_CURSOR_INVALID",
  });
});

test("inventory rejects malformed and oversized pages without leaking provider text", async () => {
  await assert.rejects(scanR2RestInventory(input(async () => response({
    success: false,
    errors: [{ message: `${token}:private-key` }],
  }))), error => {
    assert.equal(error.code, "R2_INVENTORY_RESPONSE_INVALID");
    assert.doesNotMatch(error.message, /private-key|synthetic-secret-token/u);
    return true;
  });
  await assert.rejects(scanR2RestInventory(input(async () => response(page([
    object("telemetry/a"), object("telemetry/b"), object("telemetry/c"),
  ])))), { code: "R2_INVENTORY_RESPONSE_INVALID" });
  await assert.rejects(scanR2RestInventory(input(async () => {
    throw new Error(`${token}:private-key`);
  })), { code: "R2_INVENTORY_REQUEST_FAILED" });
});

test("inventory rejects invalid target parameters before any provider request", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return response(page([]));
  };
  await assert.rejects(scanR2RestInventory(input(fetchImpl, { accountId: "../escape" })), {
    code: "R2_INVENTORY_ACCOUNT_INVALID",
  });
  await assert.rejects(scanR2RestInventory(input(fetchImpl, { bucketName: "https://foreign" })), {
    code: "R2_INVENTORY_BUCKET_INVALID",
  });
  assert.equal(called, false);
  assert.ok(R2RestInventoryError.prototype instanceof Error);
});
