import { describe, expect, it } from "vitest";
import {
  createGcsErasureBucketHistoryProof,
  GcsErasureObjectStore,
} from "../src/gcs-erasure-object-store";

const bucket = "tibotattle-gcs-test-cleanup-20260925-smoke";
const bucketGeneration = "1790076862389741872";
const bucketMetageneration = "1";

function proof(overrides: Record<string, unknown> = {}) {
  return createGcsErasureBucketHistoryProof({
    bucket,
    bucketGeneration,
    bucketMetageneration,
    softDeleteRetentionDurationSeconds: "0",
    ...overrides,
  } as Parameters<typeof createGcsErasureBucketHistoryProof>[0]);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function disabledSoftDeleteError() {
  return {
    error: {
      code: 400,
      errors: [{ reason: "invalid", message: "Soft delete policy is disabled" }],
    },
  };
}

describe("GCS erasure bucket history proof", () => {
  it("preserves provider generations beyond JavaScript's safe integer range", () => {
    expect(proof().bucketGeneration).toBe(bucketGeneration);
    expect(proof().bucketMetageneration).toBe(bucketMetageneration);
    expect(Object.isFrozen(proof())).toBe(true);
    expect(() => createGcsErasureBucketHistoryProof({
      bucket,
      bucketGeneration: 1790076862389741872n as unknown as string,
      bucketMetageneration,
      softDeleteRetentionDurationSeconds: "0",
    })).toThrow();
  });

  it("uses a matching creation proof when GCS omits the disabled policy in metadata", async () => {
    const calls: string[] = [];
    const store = new GcsErasureObjectStore(
      bucket,
      async () => "synthetic-token",
      async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push(url.toString());
        if (url.pathname === `/storage/v1/b/${bucket}`) {
          return json({ generation: bucketGeneration, metageneration: bucketMetageneration });
        }
        if (url.searchParams.get("softDeleted") === "true") {
          return json(disabledSoftDeleteError(), 400);
        }
        expect(url.searchParams.get("versions")).toBe("true");
        return json({});
      },
      5_000,
      proof(),
    );

    await expect(store.assertNoRetainedVersions("synthetic/object-key")).resolves.toBeUndefined();
    expect(calls).toHaveLength(5);
    expect(calls[0]).toContain("fields=generation%2Cmetageneration%2CsoftDeletePolicy");
  });

  it("does not treat an omitted policy or the provider's 400 as proof without a creation receipt", async () => {
    let calls = 0;
    const store = new GcsErasureObjectStore(
      bucket,
      async () => "synthetic-token",
      async () => {
        calls += 1;
        return json(disabledSoftDeleteError(), 400);
      },
      5_000,
    );

    await expect(store.assertNoRetainedVersions("synthetic/object-key")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("stops before object listing if the bucket incarnation or metadata generation changed", async () => {
    let calls = 0;
    const store = new GcsErasureObjectStore(
      bucket,
      async () => "synthetic-token",
      async () => {
        calls += 1;
        return json({ generation: bucketGeneration, metageneration: "2" });
      },
      5_000,
      proof(),
    );

    await expect(store.assertNoRetainedVersions("synthetic/object-key")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("rejects a bucket that currently reports an enabled soft delete policy", async () => {
    let calls = 0;
    const store = new GcsErasureObjectStore(
      bucket,
      async () => "synthetic-token",
      async () => {
        calls += 1;
        return json({
          generation: bucketGeneration,
          metageneration: bucketMetageneration,
          softDeletePolicy: { retentionDurationSeconds: "604800" },
        });
      },
      5_000,
      proof(),
    );

    await expect(store.assertNoRetainedVersions("synthetic/object-key")).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
