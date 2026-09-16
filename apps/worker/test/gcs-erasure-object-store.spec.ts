import { describe, expect, it } from "vitest";

import {
  GCS_ERASURE_STORAGE_API_ORIGIN,
  GcsErasureObjectStore,
} from "../src/gcs-erasure-object-store";
import {
  ParticipantErasureObjectStorageUnavailableError,
} from "../src/erasure-object-store";

const BUCKET = "tibotattle-erasure-test";
const KEY = "participant/object.bin";
const TOKEN = "test-access-token";

type FetchStep = Response | ((url: URL, init: RequestInit) => Response | Promise<Response>);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(...steps: FetchStep[]): {
  readonly fetchImpl: typeof fetch;
  readonly calls: Array<{ readonly url: URL; readonly init: RequestInit }>;
} {
  const calls: Array<{ readonly url: URL; readonly init: RequestInit }> = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof URL
      ? new URL(input.href)
      : new URL(typeof input === "string" ? input : input.url);
    calls.push({ url, init });
    const step = steps[index];
    index += 1;
    if (step === undefined) throw new Error("unexpected fetch call");
    return typeof step === "function" ? step(url, init) : step;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function object(generation: string): {
  readonly source: "telemetry_v1";
  readonly id: string;
  readonly key: string;
  readonly createdAt: string;
  readonly version: string;
} {
  return {
    source: "telemetry_v1",
    id: "row-1",
    key: KEY,
    createdAt: "2026-09-15T12:00:00.000Z",
    version: generation,
  };
}

const emptySoftDeleted = () => jsonResponse({ items: [] });
const emptyCurrent = () => jsonResponse({ items: [] });

describe("GcsErasureObjectStore", () => {
  it("lists soft-deleted history, then deletes every live generation by exact generation", async () => {
    const mock = mockFetch(
      jsonResponse({ items: [] }),
      jsonResponse({ items: [{ name: KEY, generation: "11" }, { name: "other", generation: "12" }] }),
      new Response(null, { status: 204 }),
      emptySoftDeleted(),
      emptySoftDeleted(),
      emptyCurrent(),
      emptySoftDeleted(),
    );
    const store = new GcsErasureObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    await expect(store.deleteBatch([object("11")])).resolves.toBeUndefined();
    expect(mock.calls).toHaveLength(7);
    expect(mock.calls[0]?.url.origin).toBe(GCS_ERASURE_STORAGE_API_ORIGIN);
    expect(mock.calls[0]?.url.searchParams.get("softDeleted")).toBe("true");
    expect(mock.calls[0]?.url.searchParams.has("versions")).toBe(false);
    expect(mock.calls[1]?.url.searchParams.get("versions")).toBe("true");
    expect(mock.calls[2]?.url.pathname).toBe(
      "/storage/v1/b/tibotattle-erasure-test/o/participant%2Fobject.bin",
    );
    expect(mock.calls[2]?.url.searchParams.get("generation")).toBe("11");
    expect(mock.calls[2]?.init.method).toBe("DELETE");
  });

  it("fails closed when soft-deleted history is present instead of claiming permanent erasure", async () => {
    const mock = mockFetch(jsonResponse({
      items: [{ name: KEY, generation: "17", softDeleted: true }],
    }));
    const store = new GcsErasureObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    await expect(store.deleteBatch([object("17")])).rejects.toBeInstanceOf(
      ParticipantErasureObjectStorageUnavailableError,
    );
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.url.searchParams.get("softDeleted")).toBe("true");
  });

  it("does not interpret a current or bucket listing 404 as an empty object", async () => {
    const mock = mockFetch(new Response("provider detail", { status: 404 }));
    const store = new GcsErasureObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    await expect(store.deleteBatch([object("1")])).rejects.toBeInstanceOf(
      ParticipantErasureObjectStorageUnavailableError,
    );
    expect(mock.calls).toHaveLength(1);
  });

  it("fails closed when a successful listing contains a malformed object entry", async () => {
    const mock = mockFetch(jsonResponse({ items: [null] }));
    const store = new GcsErasureObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    await expect(store.deleteBatch([object("1")])).rejects.toBeInstanceOf(
      ParticipantErasureObjectStorageUnavailableError,
    );
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.init.method).toBe("GET");
    expect(mock.calls[0]?.url.searchParams.get("softDeleted")).toBe("true");
  });

  it("accepts an idempotent generation 404 only after proving no retained history", async () => {
    const mock = mockFetch(
      jsonResponse({ items: [] }),
      jsonResponse({ items: [{ name: KEY, generation: "21" }] }),
      new Response("", { status: 404 }),
      jsonResponse({ items: [] }),
      jsonResponse({ items: [] }),
      jsonResponse({ items: [] }),
      jsonResponse({ items: [] }),
    );
    const store = new GcsErasureObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    await expect(store.deleteBatch([object("21")])).resolves.toBeUndefined();
    expect(mock.calls.filter(call => call.init.method === "DELETE")).toHaveLength(1);
  });

  it("bounds JSON response reads before allocating an unbounded buffer and sanitizes failures", async () => {
    const huge = new Uint8Array(4 * 1024 * 1024 + 1);
    huge.fill(0x20);
    const mock = mockFetch(new Response(huge, { status: 200 }));
    const store = new GcsErasureObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    await expect(store.deleteBatch([object("1")])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ParticipantErasureObjectStorageUnavailableError);
      expect(error instanceof Error ? error.message : String(error)).toBe(
        "PARTICIPANT_ERASURE_OBJECT_STORAGE_UNAVAILABLE",
      );
      return true;
    });
  });

  it("cleans up the request timer for malformed tokens without making a provider call", async () => {
    const mock = mockFetch(jsonResponse({ items: [] }));
    const store = new GcsErasureObjectStore(BUCKET, async () => "token\nsecret", mock.fetchImpl);

    await expect(store.deleteBatch([object("1")])).rejects.toBeInstanceOf(
      ParticipantErasureObjectStorageUnavailableError,
    );
    expect(mock.calls).toHaveLength(0);
  });
});
