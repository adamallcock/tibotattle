import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import {
  configuredR2ReleaseObjectStore,
  createR2ReleaseObjectStore,
} from "../src/r2-release-object-store";
import {
  ReleaseObjectStorageUnavailableError,
} from "../src/release-object-store";
import type {
  ReleaseObjectCondition,
  ReleaseObjectStore,
  ReleaseObjectWrite,
} from "../src/release-object-store";

const encoder = new TextEncoder();
const runtimeBucket = (env as Env).QUARANTINE;
const keysToDelete: string[] = [];

async function sha256(bytes: Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", bytes);
}

function key(): string {
  const value = `release-object-store-contract/${crypto.randomUUID()}`;
  keysToDelete.push(value);
  return value;
}

async function options(
  condition: ReleaseObjectCondition,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
  cacheControl = "no-store",
): Promise<ReleaseObjectWrite> {
  return {
    condition,
    sha256: await sha256(bytes),
    contentType,
    cacheControl,
  };
}

function realStore(): ReleaseObjectStore {
  return createR2ReleaseObjectStore(runtimeBucket);
}

function minimalR2Object(overrides: Record<string, unknown> = {}): R2Object {
  return {
    key: "fault",
    version: "r2-version",
    size: 0,
    etag: "r2-version",
    httpEtag: '"r2-version"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date(0),
    httpMetadata: {},
    storageClass: "Standard",
    writeHttpMetadata: () => {},
    ...overrides,
  } as R2Object;
}

function faultBucket({
  head = async () => null,
  get = async () => null,
  put = async () => null,
}: {
  head?: (...args: never[]) => Promise<unknown>;
  get?: (...args: never[]) => Promise<unknown>;
  put?: (...args: never[]) => Promise<unknown>;
} = {}): Pick<R2Bucket, "head" | "get" | "put"> {
  return {
    head: head as Pick<R2Bucket, "head">["head"],
    get: get as Pick<R2Bucket, "get">["get"],
    put: put as Pick<R2Bucket, "put">["put"],
  };
}

afterEach(async () => {
  const keys = keysToDelete.splice(0);
  await Promise.all(keys.map((objectKey) => runtimeBucket.delete(objectKey)));
});

describe("R2 release object-store adapter", () => {
  it("round-trips through the actual Miniflare R2 binding with flat metadata and checksum", async () => {
    const store = realStore();
    const objectKey = key();
    const bytes = encoder.encode("release object bytes");
    const contentType = "application/xml; charset=utf-8";
    const cacheControl = "public, max-age=300, must-revalidate";

    const written = await store.put(
      objectKey,
      bytes,
      await options({ kind: "absent" }, bytes, contentType, cacheControl),
    );
    expect(written.status).toBe("stored");
    if (written.status !== "stored") throw new Error("expected stored result");
    expect(written.metadata).toMatchObject({
      size: bytes.byteLength,
      contentType,
      cacheControl,
    });
    expect(written.metadata.version).toEqual(expect.any(String));
    expect(written.metadata.entityTags).toEqual([
      written.metadata.version,
      expect.any(String),
    ]);

    const headed = await store.head(objectKey);
    expect(headed).toEqual(written.metadata);

    const read = await store.get(objectKey, written.metadata.version);
    expect(read.status).toBe("found");
    if (read.status !== "found") throw new Error("expected found result");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);

    const raw = await runtimeBucket.head(objectKey);
    expect(raw?.checksums?.sha256).toEqual(await sha256(bytes));
  });

  it("does not commit bytes when the provider rejects a mismatched checksum", async () => {
    const store = realStore();
    const objectKey = key();
    const bytes = encoder.encode("checksum-protected release");
    const wrongDigest = await sha256(encoder.encode("different bytes"));

    await expect(store.put(
      objectKey,
      bytes,
      {
        ...(await options({ kind: "absent" }, bytes)),
        sha256: wrongDigest,
      },
    )).rejects.toBeInstanceOf(ReleaseObjectStorageUnavailableError);
    expect(await store.head(objectKey)).toBeNull();
    expect(await runtimeBucket.head(objectKey)).toBeNull();
  });

  it("turns absent and stale conditional writes into conflicts without overwriting", async () => {
    const store = realStore();
    const objectKey = key();
    const firstBytes = encoder.encode("first release");
    const secondBytes = encoder.encode("second release");
    const first = await store.put(
      objectKey,
      firstBytes,
      await options({ kind: "absent" }, firstBytes),
    );
    expect(first.status).toBe("stored");
    if (first.status !== "stored") throw new Error("expected first stored result");

    await expect(store.put(
      objectKey,
      secondBytes,
      await options({ kind: "absent" }, secondBytes),
    )).resolves.toEqual({ status: "conflict" });
    await expect(store.put(
      objectKey,
      secondBytes,
      await options({ kind: "version", version: "stale-version" }, secondBytes),
    )).resolves.toEqual({ status: "conflict" });

    const headed = await store.head(objectKey);
    expect(headed?.version).toBe(first.metadata.version);
    const read = await store.get(objectKey, first.metadata.version);
    expect(read.status).toBe("found");
    if (read.status !== "found") throw new Error("expected original object");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(firstBytes);
  });

  it("allows only one concurrent writer using the same stale version", async () => {
    const store = realStore();
    const objectKey = key();
    const initialBytes = encoder.encode("initial release");
    const firstCandidate = encoder.encode("candidate one");
    const secondCandidate = encoder.encode("candidate two");
    const initial = await store.put(
      objectKey,
      initialBytes,
      await options({ kind: "absent" }, initialBytes),
    );
    expect(initial.status).toBe("stored");
    if (initial.status !== "stored") throw new Error("expected initial stored result");
    const firstOptions = await options(
      { kind: "version", version: initial.metadata.version },
      firstCandidate,
    );
    const secondOptions = await options(
      { kind: "version", version: initial.metadata.version },
      secondCandidate,
    );

    const [first, second] = await Promise.all([
      store.put(objectKey, firstCandidate, firstOptions),
      store.put(objectKey, secondCandidate, secondOptions),
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.status === "stored")).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(1);
    const winner = results.find((result) => result.status === "stored");
    if (winner === undefined || winner.status !== "stored") throw new Error("expected one winner");

    const headed = await store.head(objectKey);
    expect(headed?.version).toBe(winner.metadata.version);
    const read = await store.get(objectKey, winner.metadata.version);
    expect(read.status).toBe("found");
  });

  it("maps missing and metadata-only conditional reads distinctly", async () => {
    const missing = createR2ReleaseObjectStore(faultBucket({
      get: async () => null,
    }));
    await expect(missing.get("missing", "version"))
      .resolves.toEqual({ status: "missing" });

    const metadataOnly = createR2ReleaseObjectStore(faultBucket({
      get: async () => minimalR2Object(),
    }));
    await expect(metadataOnly.get("conditional", "version"))
      .resolves.toEqual({ status: "conflict" });
  });

  it("sanitizes provider and deferred body failures", async () => {
    const providerFailure = new Error("provider account and bucket details");
    const throwing = createR2ReleaseObjectStore(faultBucket({
      head: async () => { throw providerFailure; },
      get: async () => { throw providerFailure; },
      put: async () => { throw providerFailure; },
    }));
    for (const operation of [
      throwing.head("head"),
      throwing.get("get", "version"),
      throwing.put("put", encoder.encode("bytes"), await options({ kind: "absent" }, encoder.encode("bytes"))),
    ]) {
      await expect(operation)
        .rejects.toBeInstanceOf(ReleaseObjectStorageUnavailableError);
      await expect(operation).rejects.not.toThrow("provider account");
    }

    const bodyFailure = createR2ReleaseObjectStore(faultBucket({
      get: async () => ({
        ...minimalR2Object(),
        arrayBuffer: async () => {
          throw new Error("private body detail");
        },
      } as unknown as R2ObjectBody),
    }));
    const read = await bodyFailure.get("body", "version");
    expect(read.status).toBe("found");
    if (read.status !== "found") throw new Error("expected deferred body");
    await expect(read.arrayBuffer())
      .rejects.toBeInstanceOf(ReleaseObjectStorageUnavailableError);
    await expect(read.arrayBuffer()).rejects.not.toThrow("private body");
  });

  it("rejects malformed conditions and versions before calling the provider", async () => {
    let calls = 0;
    const bucket = faultBucket({
      get: async () => {
        calls += 1;
        return null;
      },
      put: async () => {
        calls += 1;
        return null;
      },
    });
    const store = createR2ReleaseObjectStore(bucket);
    const malformed = { kind: "unknown", version: "" } as unknown as ReleaseObjectCondition;
    const bytes = encoder.encode("bytes");
    await expect(store.put("malformed", bytes, await options(malformed, bytes)))
      .rejects.toBeInstanceOf(ReleaseObjectStorageUnavailableError);
    await expect(store.get("malformed", ""))
      .rejects.toBeInstanceOf(ReleaseObjectStorageUnavailableError);
    const validWrite = await options({ kind: "absent" }, bytes);
    const invalidDigests: unknown[] = [
      undefined,
      "not-a-digest",
      new Uint8Array(31),
      new Uint8Array(33),
      new DataView(new ArrayBuffer(32)),
    ];
    for (const [index, invalidDigest] of invalidDigests.entries()) {
      await expect(store.put(
        `malformed-digest-${index}`,
        bytes,
        { ...validWrite, sha256: invalidDigest } as unknown as ReleaseObjectWrite,
      )).rejects.toBeInstanceOf(ReleaseObjectStorageUnavailableError);
    }
    expect(calls).toBe(0);
  });

  it("returns null for malformed bindings while accepting the three R2 methods", async () => {
    expect(configuredR2ReleaseObjectStore(null)).toBeNull();
    expect(configuredR2ReleaseObjectStore({})).toBeNull();
    expect(configuredR2ReleaseObjectStore({
      head: async () => null,
      get: async () => null,
    })).toBeNull();

    const throwingGetter = {};
    Object.defineProperty(throwingGetter, "head", {
      get: () => { throw new Error("malformed binding"); },
    });
    expect(configuredR2ReleaseObjectStore(throwingGetter)).toBeNull();

    const configured = configuredR2ReleaseObjectStore(faultBucket());
    expect(configured).not.toBeNull();
  });
});
