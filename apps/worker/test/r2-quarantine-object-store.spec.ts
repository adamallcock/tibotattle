import { describe, expect, it, vi } from "vitest";

import {
  QUARANTINE_OBJECT_DELETE_BATCH_LIMIT,
  QuarantineObjectStorageUnavailableError,
} from "../src/quarantine-object-store";
import { createR2QuarantineObjectStore } from "../src/r2-quarantine-object-store";

function object(overrides: Partial<R2Object> = {}): R2Object {
  return {
    key: "test",
    version: "version-1",
    size: 4,
    etag: "etag-1",
    httpEtag: '"etag-1"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date(0),
    httpMetadata: {},
    storageClass: "Standard",
    writeHttpMetadata: () => {},
    ...overrides,
  } as R2Object;
}

function bucket(overrides: Partial<Pick<R2Bucket, "put" | "head" | "delete">> = {}) {
  return {
    put: vi.fn(async () => object()),
    head: vi.fn(async () => object()),
    delete: vi.fn(async () => undefined),
    ...overrides,
  } as Pick<R2Bucket, "put" | "head" | "delete">;
}

describe("R2 quarantine object adapter", () => {
  it("maps neutral writes and head metadata without changing bytes", async () => {
    const backend = bucket();
    const store = createR2QuarantineObjectStore(backend);
    const bytes = new Uint8Array([1, 2, 3]);

    await store.put("telemetry/test", bytes, {
      contentType: "application/json",
      customMetadata: { contributionId: "contribution:test" },
    });

    expect(backend.put).toHaveBeenCalledWith(
      "telemetry/test",
      bytes,
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { contributionId: "contribution:test" },
      },
    );
    await expect(store.head("telemetry/test")).resolves.toEqual({
      version: "etag-1",
      size: 4,
    });
  });

  it("preserves missing head as absence and uses one provider call per delete", async () => {
    const backend = bucket({
      head: vi.fn(async () => null),
    });
    const store = createR2QuarantineObjectStore(backend);

    await expect(store.head("telemetry/missing")).resolves.toBeNull();
    await store.delete("telemetry/one");
    await store.deleteMany(["telemetry/two", "telemetry/three"]);
    expect(backend.delete).toHaveBeenCalledTimes(2);
    expect(backend.delete).toHaveBeenNthCalledWith(1, "telemetry/one");
    expect(backend.delete).toHaveBeenNthCalledWith(2, [
      "telemetry/two",
      "telemetry/three",
    ]);
  });

  it("rejects oversized batches before provider access", async () => {
    const backend = bucket();
    const store = createR2QuarantineObjectStore(backend);
    const keys = Array.from(
      { length: QUARANTINE_OBJECT_DELETE_BATCH_LIMIT + 1 },
      (_, index) => `telemetry/${index}`,
    );

    await expect(store.deleteMany(keys)).rejects.toThrow(
      "invalid quarantine object delete batch",
    );
    expect(backend.delete).not.toHaveBeenCalled();
  });

  it("sanitizes provider failures and performs no retry", async () => {
    const backend = bucket({
      delete: vi.fn(async () => {
        throw new Error("bucket-name/private-key/provider detail");
      }),
    });
    const store = createR2QuarantineObjectStore(backend);

    await expect(store.deleteMany(["telemetry/failure"])).rejects.toEqual(
      expect.objectContaining({
        name: "QuarantineObjectStorageUnavailableError",
        message: "QUARANTINE_OBJECT_STORAGE_UNAVAILABLE",
      }),
    );
    expect(backend.delete).toHaveBeenCalledTimes(1);
    await expect(store.delete("telemetry/failure")).rejects.toBeInstanceOf(
      QuarantineObjectStorageUnavailableError,
    );
    expect(backend.delete).toHaveBeenCalledTimes(2);
  });

  it("does not claim a null put result was stored", async () => {
    const backend = bucket({
      put: vi.fn(async () => null) as unknown as R2Bucket["put"],
    });
    const store = createR2QuarantineObjectStore(backend);

    await expect(store.put("telemetry/conditional", "{}"))
      .rejects.toBeInstanceOf(QuarantineObjectStorageUnavailableError);
  });

  it.each(["put", "head", "delete"] as const)(
    "rejects a runtime binding missing %s",
    (missing) => {
      const backend = bucket();
      delete (backend as Record<string, unknown>)[missing];

      expect(() => createR2QuarantineObjectStore(
        backend as unknown as R2Bucket,
      )).toThrow(
        expect.objectContaining({
          name: "QuarantineObjectStorageUnavailableError",
          message: "QUARANTINE_OBJECT_STORAGE_UNAVAILABLE",
        }),
      );
    },
  );
});
