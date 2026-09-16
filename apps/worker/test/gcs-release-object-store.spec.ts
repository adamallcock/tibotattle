import { describe, expect, it } from "vitest";

import {
  GCS_STORAGE_API_ORIGIN,
  GcsReleaseObjectStore,
} from "../src/gcs-release-object-store";
import {
  ReleaseObjectStorageUnavailableError,
} from "../src/release-object-store";

const BUCKET = "tibotattle-release-test";
const KEY = "nested/appcast.xml";
const TOKEN = "test-access-token";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FetchCall {
  readonly url: URL;
  readonly init: RequestInit;
}

type FetchStep =
  | Response
  | ((url: URL, init: RequestInit) => Response | Promise<Response>);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function objectMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bucket: BUCKET,
    name: KEY,
    generation: "1234567890123456789",
    size: "5",
    etag: "gcs-etag",
    contentType: "application/xml",
    cacheControl: "public, max-age=60",
    ...overrides,
  };
}

function mockFetch(...steps: FetchStep[]): {
  readonly fetchImpl: typeof fetch;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
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

function storageErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function bodyBytes(body: RequestInit["body"]): Promise<Uint8Array> {
  if (body === null || body === undefined) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function sha256(value: Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", value);
}

describe("GcsReleaseObjectStore", () => {
  it("reads current metadata through the fixed JSON API origin and preserves raw/quoted ETags", async () => {
    const mock = mockFetch(jsonResponse(objectMetadata()));
    const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    const metadata = await store.head(KEY);

    expect(metadata).toMatchObject({
      version: "1234567890123456789",
      size: 5,
      contentType: "application/xml",
      cacheControl: "public, max-age=60",
    });
    expect(metadata?.entityTags).toEqual(["gcs-etag", '"gcs-etag"']);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.url.origin).toBe(GCS_STORAGE_API_ORIGIN);
    expect(mock.calls[0]?.url.pathname).toBe(
      "/storage/v1/b/tibotattle-release-test/o/nested%2Fappcast.xml",
    );
    expect(mock.calls[0]?.init.redirect).toBe("manual");
    expect(mock.calls[0]?.init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
    });
  });

  it("returns null for a metadata 404 without parsing a response body", async () => {
    const mock = mockFetch(new Response("private details", { status: 404 }));
    const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    await expect(store.head(KEY)).resolves.toBeNull();
  });

  it("rejects malformed metadata instead of accepting numeric generations or missing identity", async () => {
    for (const malformed of [
      objectMetadata({ generation: 123 }),
      objectMetadata({ generation: "0" }),
      objectMetadata({ generation: "9223372036854775808" }),
      objectMetadata({ size: 5 }),
      objectMetadata({ name: "other.xml" }),
      objectMetadata({ bucket: "other-bucket" }),
      objectMetadata({ etag: null }),
      objectMetadata({ contentType: null }),
    ]) {
      const mock = mockFetch(jsonResponse(malformed));
      const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);
      await expect(store.head(KEY)).rejects.toBeInstanceOf(
        ReleaseObjectStorageUnavailableError,
      );
    }
  });

  it("gets media for the current live generation with ifGenerationMatch and no generation selector", async () => {
    const mock = mockFetch(new Response(encoder.encode("hello"), { status: 200 }));
    const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);
    const read = await store.get(KEY, "9007199254740993");

    expect(read.status).toBe("found");
    if (read.status === "found") {
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(encoder.encode("hello"));
    }
    const url = mock.calls[0]?.url;
    expect(url?.origin).toBe(GCS_STORAGE_API_ORIGIN);
    expect(url?.searchParams.get("alt")).toBe("media");
    expect(url?.searchParams.get("ifGenerationMatch")).toBe("9007199254740993");
    expect(url?.searchParams.has("generation")).toBe(false);
  });

  it("maps current-live missing and stale-generation reads to distinct statuses without retrying", async () => {
    const missing = mockFetch(new Response("", { status: 404 }));
    const missingStore = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, missing.fetchImpl);
    await expect(missingStore.get(KEY, "1")).resolves.toEqual({ status: "missing" });

    const conflict = mockFetch(new Response("", { status: 412 }));
    const conflictStore = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, conflict.fetchImpl);
    await expect(conflictStore.get(KEY, "1")).resolves.toEqual({ status: "conflict" });
    expect(conflict.calls).toHaveLength(1);
  });

  it("defers body reads while sanitizing a later body-stream failure", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("token=must-not-escape"));
      },
    });
    const mock = mockFetch(new Response(body, { status: 200 }));
    const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);
    const read = await store.get(KEY, "1");

    expect(read.status).toBe("found");
    if (read.status === "found") {
      await expect(read.arrayBuffer()).rejects.toBeInstanceOf(
        ReleaseObjectStorageUnavailableError,
      );
    }
  });

  it("bounds token acquisition, header fetch, and deferred body reads", async () => {
    let tokenCalls = 0;
    const tokenFetch = mockFetch(jsonResponse(objectMetadata()));
    const tokenStore = new GcsReleaseObjectStore(
      BUCKET,
      () => {
        tokenCalls += 1;
        return new Promise<string>(() => undefined);
      },
      tokenFetch.fetchImpl,
      1_024,
      20,
    );
    await expect(tokenStore.head(KEY)).rejects.toBeInstanceOf(
      ReleaseObjectStorageUnavailableError,
    );
    expect(tokenCalls).toBe(1);
    expect(tokenFetch.calls).toHaveLength(0);

    let headerSignal: AbortSignal | undefined;
    let header: string | null = null;
    const hangingFetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      headerSignal = init.signal as AbortSignal;
      header = new Headers(init.headers).get("authorization");
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const headerStore = new GcsReleaseObjectStore(
      BUCKET,
      async () => TOKEN,
      hangingFetch,
      1_024,
      20,
    );
    await expect(headerStore.head(KEY)).rejects.toBeInstanceOf(
      ReleaseObjectStorageUnavailableError,
    );
    expect(header).toBe(`Bearer ${TOKEN}`);
    expect(headerSignal?.aborted).toBe(true);

    let bodySignal: AbortSignal | undefined;
    const bodyFetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      bodySignal = init.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start() {
          // Leave the response open so arrayBuffer() cannot complete itself.
        },
      }), { status: 200 });
    }) as typeof fetch;
    const bodyStore = new GcsReleaseObjectStore(
      BUCKET,
      async () => TOKEN,
      bodyFetch,
      1_024,
      20,
    );
    const read = await bodyStore.get(KEY, "1");
    expect(read.status).toBe("found");
    if (read.status === "found") {
      await expect(read.arrayBuffer()).rejects.toBeInstanceOf(
        ReleaseObjectStorageUnavailableError,
      );
    }
    expect(bodySignal?.aborted).toBe(true);

    const lateFetch = mockFetch(new Response("ready", { status: 200 }));
    const lateStore = new GcsReleaseObjectStore(
      BUCKET,
      async () => TOKEN,
      lateFetch.fetchImpl,
      1_024,
      20,
    );
    const lateRead = await lateStore.get(KEY, "1");
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(lateRead.status).toBe("found");
    if (lateRead.status === "found") {
      await expect(lateRead.arrayBuffer()).rejects.toBeInstanceOf(
        ReleaseObjectStorageUnavailableError,
      );
    }
  });

  it("uploads multipart metadata and bytes atomically with create-if-absent", async () => {
    const bytes = encoder.encode("hello");
    const mock = mockFetch(jsonResponse(objectMetadata({ generation: "7", size: "5" })));
    const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    const result = await store.put(KEY, bytes, {
      condition: { kind: "absent" },
      sha256: new Uint8Array(await sha256(bytes)),
      contentType: "application/xml",
      cacheControl: "public, max-age=60",
    });

    expect(result.status).toBe("stored");
    const call = mock.calls[0];
    expect(call?.url.origin).toBe(GCS_STORAGE_API_ORIGIN);
    expect(call?.url.pathname).toBe("/upload/storage/v1/b/tibotattle-release-test/o");
    expect(call?.url.searchParams.get("uploadType")).toBe("multipart");
    expect(call?.url.searchParams.get("name")).toBe(KEY);
    expect(call?.url.searchParams.get("ifGenerationMatch")).toBe("0");
    expect(call?.url.searchParams.has("generation")).toBe(false);
    expect(call?.init.redirect).toBe("manual");
    const contentType = new Headers(call?.init.headers).get("content-type");
    expect(contentType).toMatch(/^multipart\/related; boundary=gcs-release-v1-[a-f0-9]{24}$/u);
    const body = decoder.decode(await bodyBytes(call?.init.body));
    expect(body).toContain('"name":"nested/appcast.xml"');
    expect(body).toContain('"contentType":"application/xml"');
    expect(body).toContain('"cacheControl":"public, max-age=60"');
    expect(body).toContain("hello");
  });

  it("replaces only the inspected generation and preserves large generation strings", async () => {
    const bytes = encoder.encode("hello");
    const mock = mockFetch(jsonResponse(objectMetadata({ generation: "8" })));
    const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    await store.put(KEY, bytes, {
      condition: { kind: "version", version: "9007199254740993" },
      sha256: await sha256(bytes),
      contentType: "application/xml",
      cacheControl: "public, max-age=60",
    });

    expect(mock.calls[0]?.url.searchParams.get("ifGenerationMatch")).toBe(
      "9007199254740993",
    );
  });

  it("captures the validated CAS condition before asynchronous hashing", async () => {
    const bytes = encoder.encode("hello");
    const mock = mockFetch(jsonResponse(objectMetadata({ generation: "8" })));
    const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);
    let conditionVersion = "7";
    const options = {
      get condition() {
        return { kind: "version" as const, version: conditionVersion };
      },
      sha256: await sha256(bytes),
      contentType: "application/xml",
      cacheControl: "public, max-age=60",
    };

    const write = store.put(KEY, bytes, options);
    conditionVersion = "8";
    await expect(write).resolves.toMatchObject({ status: "stored" });
    expect(mock.calls[0]?.url.searchParams.get("ifGenerationMatch")).toBe("7");
  });

  it("maps a write race at the provider to conflict without retrying", async () => {
    const bytes = encoder.encode("hello");
    const mock = mockFetch(
      jsonResponse(objectMetadata({ generation: "8" })),
      new Response("", { status: 412 }),
    );
    const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);
    const options = {
      condition: { kind: "version" as const, version: "7" },
      sha256: await sha256(bytes),
      contentType: "application/xml",
      cacheControl: "public, max-age=60",
    };

    await expect(store.put(KEY, bytes, options)).resolves.toMatchObject({ status: "stored" });
    await expect(store.put(KEY, bytes, options)).resolves.toEqual({ status: "conflict" });
    expect(mock.calls).toHaveLength(2);
  });

  it("checks SHA-256 locally and performs no request on mismatch", async () => {
    const bytes = encoder.encode("hello");
    const mock = mockFetch(jsonResponse(objectMetadata()));
    const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);

    await expect(store.put(KEY, bytes, {
      condition: { kind: "absent" },
      sha256: new ArrayBuffer(32),
      contentType: "application/xml",
      cacheControl: "public, max-age=60",
    })).rejects.toBeInstanceOf(ReleaseObjectStorageUnavailableError);
    expect(mock.calls).toHaveLength(0);
  });

  it("sanitizes token, transport, redirect, HTTP, and malformed-success failures", async () => {
    const bytes = encoder.encode("hello");
    const validOptions = {
      condition: { kind: "absent" as const },
      sha256: await sha256(bytes),
      contentType: "application/xml",
      cacheControl: "public, max-age=60",
    };
    const tokenProvider = mockFetch(jsonResponse(objectMetadata()));
    const transport = mockFetch(() => { throw new Error("https://token-secret"); });
    const httpFailure = mockFetch(new Response("Bearer token-secret", {
      status: 500,
      headers: { location: "https://token-secret" },
    }));
    const redirect = mockFetch(new Response("", {
      status: 302,
      headers: { location: "https://token-secret" },
    }));
    const malformed = mockFetch(jsonResponse({ bucket: BUCKET, name: KEY }));
    const cases: Array<{
      readonly store: GcsReleaseObjectStore;
      readonly calls: readonly FetchCall[];
      readonly expectedCalls: number;
    }> = [
      {
        store: new GcsReleaseObjectStore(
          BUCKET,
          async () => { throw new Error("secret token provider"); },
          tokenProvider.fetchImpl,
        ),
        calls: tokenProvider.calls,
        expectedCalls: 0,
      },
      {
        store: new GcsReleaseObjectStore(
          BUCKET,
          async () => TOKEN,
          transport.fetchImpl,
        ),
        calls: transport.calls,
        expectedCalls: 1,
      },
      {
        store: new GcsReleaseObjectStore(
          BUCKET,
          async () => TOKEN,
          httpFailure.fetchImpl,
        ),
        calls: httpFailure.calls,
        expectedCalls: 1,
      },
      {
        store: new GcsReleaseObjectStore(
          BUCKET,
          async () => TOKEN,
          redirect.fetchImpl,
        ),
        calls: redirect.calls,
        expectedCalls: 1,
      },
      {
        store: new GcsReleaseObjectStore(
          BUCKET,
          async () => TOKEN,
          malformed.fetchImpl,
        ),
        calls: malformed.calls,
        expectedCalls: 1,
      },
    ];
    for (const { store, calls, expectedCalls } of cases) {
      await expect(store.put(KEY, bytes, validOptions)).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ReleaseObjectStorageUnavailableError);
        expect(storageErrorMessage(error)).toBe("RELEASE_OBJECT_STORAGE_UNAVAILABLE");
        return true;
      });
      expect(calls).toHaveLength(expectedCalls);
    }
  });

  it.each([401, 403])("does not confuse authorization failure %s with absence or retry it", async (status) => {
    const bytes = encoder.encode("hello");
    for (const operation of ["head", "get", "put"] as const) {
      const mock = mockFetch(new Response("synthetic-private-provider-detail", { status }));
      const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);
      const pending = operation === "head" ? store.head(KEY)
        : operation === "get" ? store.get(KEY, "7")
        : store.put(KEY, bytes, {
          condition: { kind: "absent" }, sha256: await sha256(bytes),
          contentType: "application/xml", cacheControl: "public, max-age=60",
        });
      await expect(pending).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ReleaseObjectStorageUnavailableError);
        expect(storageErrorMessage(error)).toBe("RELEASE_OBJECT_STORAGE_UNAVAILABLE");
        return true;
      });
      expect(mock.calls).toHaveLength(1);
    }
  });

  it("rejects invalid bucket, object, generation, and header inputs", async () => {
    expect(() => new GcsReleaseObjectStore("../bucket", async () => TOKEN)).toThrow(
      "RELEASE_OBJECT_STORAGE_UNAVAILABLE",
    );
    const mock = mockFetch(jsonResponse(objectMetadata()));
    const store = new GcsReleaseObjectStore(BUCKET, async () => TOKEN, mock.fetchImpl);
    await expect(store.head("bad\nkey")).rejects.toBeInstanceOf(
      ReleaseObjectStorageUnavailableError,
    );
    await expect(store.get(KEY, "9007199254740993.0")).rejects.toBeInstanceOf(
      ReleaseObjectStorageUnavailableError,
    );
    await expect(store.put(KEY, encoder.encode("hello"), {
      condition: { kind: "absent" },
      sha256: await sha256(encoder.encode("hello")),
      contentType: "application/xml\r\nBearer secret",
      cacheControl: "public, max-age=60",
    })).rejects.toBeInstanceOf(ReleaseObjectStorageUnavailableError);
    expect(mock.calls).toHaveLength(0);
  });
});
