import { describe, expect, it } from "vitest";
import {
  GcsQuarantineObjectStore,
  createGcsQuarantineObjectStore,
  parseGcsQuarantineBucketHistoryProof,
  type GcsQuarantineBucketHistoryProof,
  type GcsQuarantineFetch,
} from "../src/gcs-quarantine-object-store";
import { QuarantineObjectStorageUnavailableError } from "../src/quarantine-object-store";

// Owner decision OD-2 (2026-10-02): the quarantine store requires the
// bucket's birth proof (GCS_QUARANTINE_BUCKET_HISTORY_PROOF). Every bucket,
// generation, key and token below is synthetic.
const bucket = "tibotattle-synthetic-quarantine-od2";
const otherBucket = "tibotattle-synthetic-quarantine-other";
const bucketGeneration = "1790076862389741872";
const bucketMetageneration = "1";
const key = "synthetic/quarantine/object-key";
const liveGeneration = "1790076862400000001";

function proofSetting(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    bucket,
    bucketGeneration,
    bucketMetageneration,
    softDeleteRetentionDurationSeconds: "0",
    ...overrides,
  });
}

function proof(overrides: Record<string, unknown> = {}): GcsQuarantineBucketHistoryProof {
  return parseGcsQuarantineBucketHistoryProof(
    proofSetting(overrides),
    typeof overrides.bucket === "string" ? overrides.bucket : bucket,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function disabledSoftDeleteError(): unknown {
  return {
    error: {
      code: 400,
      errors: [{ reason: "invalid", message: "Soft delete policy is disabled" }],
    },
  };
}

interface FakeBucket {
  /** The bucket metadata GCS reports on each read, in order; the last repeats. */
  readonly bucketStates: Array<Record<string, unknown>>;
  /** Live generations of `key`; a generation DELETE removes one. */
  readonly live: string[];
}

interface Call {
  readonly method: string;
  readonly kind: "bucket" | "soft-deleted-list" | "versions-list" | "object" | "other";
  readonly url: URL;
}

/**
 * A synthetic GCS JSON API for one bucket with soft delete disabled: the
 * bucket read omits softDeletePolicy, and the soft-deleted listing answers
 * with the provider's closed disabled-policy 400.
 */
function fakeGcs(state: FakeBucket): { fetch: GcsQuarantineFetch; calls: Call[] } {
  const calls: Call[] = [];
  let bucketReads = 0;
  const fetchImpl: GcsQuarantineFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    expect(url.origin).toBe("https://storage.googleapis.com");
    if (url.pathname === `/storage/v1/b/${bucket}`) {
      calls.push({ method, kind: "bucket", url });
      const index = Math.min(bucketReads, state.bucketStates.length - 1);
      bucketReads += 1;
      return json(state.bucketStates[index]);
    }
    if (url.pathname === `/storage/v1/b/${bucket}/o` && url.searchParams.get("softDeleted") === "true") {
      calls.push({ method, kind: "soft-deleted-list", url });
      return json(disabledSoftDeleteError(), 400);
    }
    if (url.pathname === `/storage/v1/b/${bucket}/o` && url.searchParams.get("versions") === "true") {
      calls.push({ method, kind: "versions-list", url });
      return json({ items: state.live.map((generation) => ({ name: key, generation })) });
    }
    if (url.pathname === `/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`) {
      calls.push({ method, kind: "object", url });
      if (method === "DELETE") {
        const index = state.live.indexOf(url.searchParams.get("generation") ?? "");
        if (index < 0) return new Response(null, { status: 404 });
        state.live.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      if (state.live.length === 0) return json({ error: { code: 404 } }, 404);
      return json({
        bucket,
        name: key,
        etag: "synthetic-etag",
        generation: state.live.at(-1),
        size: "12",
      });
    }
    calls.push({ method, kind: "other", url });
    return json({ error: { code: 404 } }, 404);
  };
  return { fetch: fetchImpl, calls };
}

const matchingBucket = { generation: bucketGeneration, metageneration: bucketMetageneration };

function store(fetchImpl: GcsQuarantineFetch, historyProof = proof()): GcsQuarantineObjectStore {
  return new GcsQuarantineObjectStore(bucket, async () => "synthetic-token", fetchImpl, 5_000, historyProof);
}

function kinds(calls: readonly Call[]): string[] {
  return calls.map((call) => `${call.method} ${call.kind}`);
}

describe("GCS quarantine store bucket birth proof (OD-2)", () => {
  const neverFetch: GcsQuarantineFetch = async () => {
    throw new Error("construction must not reach the provider");
  };

  it("refuses construction without a proof, with a null proof, or with a proof for another bucket", () => {
    const refusals: Array<() => unknown> = [
      () => new GcsQuarantineObjectStore(bucket, async () => "synthetic-token", neverFetch, 5_000,
        undefined as unknown as GcsQuarantineBucketHistoryProof),
      () => new GcsQuarantineObjectStore(bucket, async () => "synthetic-token", neverFetch, 5_000,
        null as unknown as GcsQuarantineBucketHistoryProof),
      () => new GcsQuarantineObjectStore(bucket, async () => "synthetic-token", neverFetch, 5_000,
        proof({ bucket: otherBucket })),
      () => createGcsQuarantineObjectStore(bucket, async () => "synthetic-token", neverFetch, 5_000,
        undefined as unknown as GcsQuarantineBucketHistoryProof),
      () => createGcsQuarantineObjectStore(bucket, async () => "synthetic-token", neverFetch, 5_000,
        proof({ bucket: otherBucket })),
    ];
    for (const refuse of refusals) {
      expect(refuse).toThrow(QuarantineObjectStorageUnavailableError);
    }
  });

  it("refuses a proof object that bypassed the setting parser", () => {
    const malformed: Array<Record<string, unknown>> = [
      { bucket, bucketGeneration, bucketMetageneration, softDeleteRetentionDurationSeconds: "604800" },
      { bucket, bucketGeneration: 1n, bucketMetageneration, softDeleteRetentionDurationSeconds: "0" },
      { bucket, bucketGeneration, bucketMetageneration: "0", softDeleteRetentionDurationSeconds: "0" },
      {},
    ];
    for (const value of malformed) {
      expect(() => new GcsQuarantineObjectStore(bucket, async () => "synthetic-token", neverFetch, 5_000,
        value as unknown as GcsQuarantineBucketHistoryProof)).toThrow(QuarantineObjectStorageUnavailableError);
    }
  });

  it("accepts a matching proof without contacting the provider", () => {
    const quarantine = createGcsQuarantineObjectStore(bucket, async () => "synthetic-token", neverFetch,
      undefined, proof());
    expect(quarantine).toBeInstanceOf(GcsQuarantineObjectStore);
  });

  it("returns null for a missing key on a bucket with soft delete disabled when the proof matches", async () => {
    const gcs = fakeGcs({ bucketStates: [matchingBucket], live: [] });
    await expect(store(gcs.fetch).head(key)).resolves.toBeNull();
    expect(kinds(gcs.calls)).toEqual([
      "GET object",
      "GET bucket",
      "GET soft-deleted-list",
      "GET versions-list",
      "GET soft-deleted-list",
      "GET bucket",
    ]);
  });

  it("fails head of a missing key closed when the live bucket generation or metageneration differs", async () => {
    for (const bucketState of [
      { generation: "1790076862389741873", metageneration: bucketMetageneration },
      { generation: bucketGeneration, metageneration: "2" },
      { ...matchingBucket, softDeletePolicy: { retentionDurationSeconds: "604800" } },
    ]) {
      const gcs = fakeGcs({ bucketStates: [bucketState], live: [] });
      await expect(store(gcs.fetch).head(key)).rejects.toThrow(QuarantineObjectStorageUnavailableError);
      // The proof check precedes every history listing.
      expect(kinds(gcs.calls)).toEqual(["GET object", "GET bucket"]);
    }
  });

  it("fails head of a missing key closed when the bucket changes during the history proof", async () => {
    const gcs = fakeGcs({
      bucketStates: [matchingBucket, { generation: bucketGeneration, metageneration: "2" }],
      live: [],
    });
    await expect(store(gcs.fetch).head(key)).rejects.toThrow(QuarantineObjectStorageUnavailableError);
    expect(kinds(gcs.calls).at(-1)).toBe("GET bucket");
  });

  it("deletes the exact live generation on a bucket with soft delete disabled when the proof matches", async () => {
    const live = [liveGeneration];
    const gcs = fakeGcs({ bucketStates: [matchingBucket], live });
    await expect(store(gcs.fetch).delete(key)).resolves.toBeUndefined();
    expect(live).toEqual([]);
    const deletes = gcs.calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url.searchParams.get("generation")).toBe(liveGeneration);
    expect(kinds(gcs.calls)).toEqual([
      "GET bucket",
      "GET soft-deleted-list",
      "GET versions-list",
      "DELETE object",
      "GET soft-deleted-list",
      "GET bucket",
      "GET soft-deleted-list",
      "GET versions-list",
      "GET soft-deleted-list",
      "GET bucket",
    ]);
  });

  it("deletes an already-absent key on a bucket with soft delete disabled when the proof matches", async () => {
    const gcs = fakeGcs({ bucketStates: [matchingBucket], live: [] });
    await expect(store(gcs.fetch).deleteMany([key, key])).resolves.toBeUndefined();
    expect(gcs.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("fails delete closed, before any listing or DELETE, when the live generation or metageneration differs", async () => {
    for (const bucketState of [
      { generation: "1790076862389741873", metageneration: bucketMetageneration },
      { generation: bucketGeneration, metageneration: "2" },
    ]) {
      const live = [liveGeneration];
      const gcs = fakeGcs({ bucketStates: [bucketState], live });
      // delete() surfaces the erasure adapter's content-free error; every
      // caller (reconciliation, admission rollback) wraps it.
      await expect(store(gcs.fetch).delete(key)).rejects.toThrow();
      expect(kinds(gcs.calls)).toEqual(["GET bucket"]);
      expect(live).toEqual([liveGeneration]);
    }
  });

  it("fails delete closed when the bucket changes after the generation DELETE", async () => {
    const gcs = fakeGcs({
      bucketStates: [matchingBucket, { generation: bucketGeneration, metageneration: "2" }],
      live: [liveGeneration],
    });
    await expect(store(gcs.fetch).delete(key)).rejects.toThrow();
    expect(kinds(gcs.calls)).toEqual([
      "GET bucket",
      "GET soft-deleted-list",
      "GET versions-list",
      "DELETE object",
      "GET soft-deleted-list",
      "GET bucket",
    ]);
  });
});
