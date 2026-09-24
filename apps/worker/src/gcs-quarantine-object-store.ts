import {
  GcsErasureObjectStore,
  type GcsErasureAccessTokenProvider,
  type GcsErasureBucketHistoryProof,
  type GcsErasureFetch,
} from "./gcs-erasure-object-store";
import {
  QuarantineObjectStorageUnavailableError,
  assertQuarantineObjectDeleteBatch,
  assertQuarantineObjectKey,
  type QuarantineObjectHead,
  type QuarantineObjectPutOptions,
  type QuarantineObjectStore,
} from "./quarantine-object-store";
import { MAX_REQUEST_BYTES } from "./constants";

/** Fixed origin: tokens never follow caller-controlled redirects. */
export const GCS_QUARANTINE_STORAGE_API_ORIGIN = "https://storage.googleapis.com";
const MAX_BUCKET_NAME_BYTES = 222;
const MAX_OBJECT_NAME_BYTES = 1_024;
const MAX_TOKEN_BYTES = 4_096;
const MAX_HEADER_VALUE_BYTES = 1_024;
const MAX_METADATA_BYTES = 64 * 1_024;
/** Quarantine receives the same bounded request payload accepted by Worker ingress. */
const MAX_UPLOAD_BYTES = MAX_REQUEST_BYTES;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_DELETE_MANY_KEYS = 50;
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MAX_TIMEOUT_MILLISECONDS = 300_000;
const MAX_GENERATION = 9_223_372_036_854_775_807n;
const encoder = new TextEncoder();

export type GcsQuarantineAccessTokenProvider = GcsErasureAccessTokenProvider;
export type GcsQuarantineFetch = GcsErasureFetch;

function unavailable(): QuarantineObjectStorageUnavailableError {
  return new QuarantineObjectStorageUnavailableError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function safeText(value: unknown, maximumBytes: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0
      || utf8Length(value) > maximumBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) throw unavailable();
}

function bucketName(value: string): void {
  safeText(value, MAX_BUCKET_NAME_BYTES);
  if (value.length < 3 || value.length > MAX_BUCKET_NAME_BYTES
      || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value)) throw unavailable();
}

function objectName(value: string): void {
  safeText(value, MAX_OBJECT_NAME_BYTES);
}

function generation(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) throw unavailable();
  let parsed: bigint;
  try { parsed = BigInt(value); } catch { throw unavailable(); }
  if (parsed < 1n || parsed > MAX_GENERATION) throw unavailable();
  return value;
}

function size(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) throw unavailable();
  let parsed: bigint;
  try { parsed = BigInt(value); } catch { throw unavailable(); }
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
  return Number(parsed);
}

function encoded(value: string): string {
  try { return encodeURIComponent(value); } catch { throw unavailable(); }
}

function fixedUrl(path: string): URL {
  const url = new URL(`${GCS_QUARANTINE_STORAGE_API_ORIGIN}${path}`);
  if (url.origin !== GCS_QUARANTINE_STORAGE_API_ORIGIN) throw unavailable();
  return url;
}

function objectPath(bucket: string, key: string): string {
  return `/storage/v1/b/${encoded(bucket)}/o/${encoded(key)}`;
}

function uploadPath(bucket: string): string {
  return `/upload/storage/v1/b/${encoded(bucket)}/o`;
}

function bytes(value: string | Uint8Array): Uint8Array {
  const result = typeof value === "string" ? encoder.encode(value) : value;
  if (!(result instanceof Uint8Array) || result.byteLength > MAX_UPLOAD_BYTES) throw unavailable();
  return result.slice();
}

interface QuarantinePutOptionsSnapshot {
  readonly contentType: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

function snapshotPutOptions(options: QuarantineObjectPutOptions | undefined): QuarantinePutOptionsSnapshot {
  const contentType = options?.contentType ?? "application/octet-stream";
  safeText(contentType, MAX_HEADER_VALUE_BYTES);
  const customMetadata = options?.customMetadata;
  if (customMetadata === undefined) return Object.freeze({ contentType });
  if (customMetadata === null || typeof customMetadata !== "object" || Array.isArray(customMetadata)) {
    throw unavailable();
  }
  const copy: Record<string, string> = {};
  for (const [name, item] of Object.entries(customMetadata)) {
    safeText(name, MAX_HEADER_VALUE_BYTES);
    safeText(item, MAX_HEADER_VALUE_BYTES);
    copy[name] = item;
  }
  return Object.freeze({ contentType, customMetadata: Object.freeze(copy) });
}

function containsAscii(value: Uint8Array, needle: string): boolean {
  const encodedNeedle = encoder.encode(needle);
  if (encodedNeedle.byteLength > value.byteLength) return false;
  outer: for (let start = 0; start <= value.byteLength - encodedNeedle.byteLength; start += 1) {
    for (let index = 0; index < encodedNeedle.byteLength; index += 1) {
      if (value[start + index] !== encodedNeedle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function randomMultipartBoundary(payload: Uint8Array): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const random = new Uint8Array(18);
    try {
      crypto.getRandomValues(random);
    } catch {
      throw unavailable();
    }
    const suffix = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const boundary = `gcs-quarantine-v1-${suffix}`;
    if (!containsAscii(payload, boundary)) return boundary;
  }
  throw unavailable();
}

function arrayBufferOf(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  if (!Number.isSafeInteger(total)) throw unavailable();
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function objectMetadata(value: unknown, bucket: string, key: string): QuarantineObjectHead {
  if (!isRecord(value) || value.bucket !== bucket || value.name !== key
      || typeof value.etag !== "string") throw unavailable();
  safeText(value.etag, MAX_HEADER_VALUE_BYTES);
  const version = generation(value.generation);
  const objectSize = size(value.size);
  if (objectSize > MAX_UPLOAD_BYTES) throw unavailable();
  return { version, size: objectSize };
}

function multipartBody(
  key: string,
  value: Uint8Array,
  options: QuarantinePutOptionsSnapshot,
  boundary: string,
): Uint8Array {
  const { contentType, customMetadata } = options;
  const metadata: Record<string, unknown> = { name: key, contentType };
  if (customMetadata !== undefined) metadata.metadata = { ...customMetadata };
  const metadataJson = JSON.stringify(metadata);
  if (utf8Length(metadataJson) > MAX_METADATA_BYTES) throw unavailable();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
      + `${metadataJson}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  return concat([prefix, value, suffix]);
}

interface RequestContext {
  readonly controller: AbortController;
  readonly timeout: Promise<"timeout">;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RequestResult {
  readonly response: Response;
  readonly context: RequestContext;
}

function requestContext(milliseconds: number): RequestContext {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, milliseconds);
  });
  return { controller, timeout, timer: timer! };
}

function close(context: RequestContext, abort: boolean): void {
  if (abort) context.controller.abort();
  clearTimeout(context.timer);
}

function discard(response: Response, context: RequestContext): void {
  close(context, true);
  void response.body?.cancel().catch(() => undefined);
}

export class GcsQuarantineObjectStore implements QuarantineObjectStore {
  readonly bucket: string;
  private readonly accessToken: GcsQuarantineAccessTokenProvider;
  private readonly fetchImpl: GcsQuarantineFetch;
  private readonly timeoutMilliseconds: number;
  private readonly erasure: GcsErasureObjectStore;

  constructor(
    bucket: string,
    accessToken: GcsQuarantineAccessTokenProvider,
    fetchImpl: GcsQuarantineFetch = (input, init) => fetch(input, init),
    timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
    historyProof?: GcsErasureBucketHistoryProof,
  ) {
    bucketName(bucket);
    if (typeof accessToken !== "function" || typeof fetchImpl !== "function"
        || !Number.isSafeInteger(timeoutMilliseconds)
        || timeoutMilliseconds < 1 || timeoutMilliseconds > MAX_TIMEOUT_MILLISECONDS) {
      throw unavailable();
    }
    this.bucket = bucket;
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMilliseconds = timeoutMilliseconds;
    // The quarantine contract requires retained-data-safe deletion. Reuse the
    // reviewed generation/history erasure path rather than silently issuing a
    // key-only DELETE against a bucket whose retention policy is unknown.
    this.erasure = new GcsErasureObjectStore(
      bucket,
      accessToken,
      fetchImpl,
      timeoutMilliseconds,
      historyProof,
    );
  }

  private async within<T>(context: RequestContext, operation: () => Promise<T>): Promise<T> {
    if (context.controller.signal.aborted) throw unavailable();
    let promise: Promise<T>;
    try { promise = Promise.resolve(operation()); } catch { throw unavailable(); }
    const outcome = await Promise.race([
      promise.then((value) => ({ kind: "value" as const, value })),
      context.timeout.then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "timeout" || context.controller.signal.aborted) throw unavailable();
    return outcome.value;
  }

  private async request(url: URL, init: RequestInit): Promise<RequestResult> {
    const context = requestContext(this.timeoutMilliseconds);
    let token: string;
    try {
      token = await this.within(context, () => this.accessToken());
      safeText(token, MAX_TOKEN_BYTES);
      if (/\s/u.test(token)) throw unavailable();
    } catch {
      close(context, true);
      throw unavailable();
    }
    let response: Response;
    try {
      response = await this.within(context, () => this.fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: context.controller.signal,
        headers: {
          ...(init.headers ?? {}),
          authorization: `Bearer ${token}`,
        },
      }));
    } catch {
      close(context, true);
      throw unavailable();
    }
    if (!(response instanceof Response)) {
      close(context, true);
      throw unavailable();
    }
    return { response, context };
  }

  private async json(response: Response, context: RequestContext): Promise<unknown> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = response.body?.getReader();
      if (reader === undefined) throw unavailable();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const step = await this.within(context, () => reader!.read());
        if (step.done) break;
        if (!(step.value instanceof Uint8Array)) throw unavailable();
        total += step.value.byteLength;
        if (total > MAX_JSON_BYTES) throw unavailable();
        chunks.push(step.value);
      }
      const joined = concat(chunks);
      return JSON.parse(new TextDecoder().decode(joined)) as unknown;
    } catch {
      if (reader !== undefined) void reader.cancel().catch(() => undefined);
      discard(response, context);
      throw unavailable();
    } finally {
      reader?.releaseLock();
    }
  }

  async put(key: string, value: string | Uint8Array, options?: QuarantineObjectPutOptions): Promise<void> {
    assertQuarantineObjectKey(key);
    objectName(key);
    const payload = bytes(value);
    // Snapshot caller-owned options before the first await.  The payload has
    // already been copied by bytes(), so a concurrent caller mutation cannot
    // alter either metadata or the multipart body after validation.
    const optionsSnapshot = snapshotPutOptions(options);
    const boundary = randomMultipartBoundary(payload);
    const body = multipartBody(key, payload, optionsSnapshot, boundary);
    const url = fixedUrl(uploadPath(this.bucket));
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("name", key);
    const { response, context } = await this.request(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      body: arrayBufferOf(body),
    });
    if (!response.ok) {
      discard(response, context);
      throw unavailable();
    }
    try {
      objectMetadata(await this.json(response, context), this.bucket, key);
      close(context, false);
    } catch {
      // `json` already closes/discards on parse failure. The extra close is
      // harmless for malformed metadata returned after a successful upload.
      close(context, true);
      throw unavailable();
    }
  }

  async head(key: string): Promise<QuarantineObjectHead | null> {
    assertQuarantineObjectKey(key);
    objectName(key);
    const { response, context } = await this.request(fixedUrl(objectPath(this.bucket, key)), {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status === 404) {
      discard(response, context);
      // A missing live generation does not prove the key is absent: GCS may
      // still expose noncurrent or soft-deleted generations.  Reuse the
      // erasure adapter's bounded history proof before exposing null.
      try {
        await this.erasure.assertNoRetainedVersions(key);
      } catch {
        throw unavailable();
      }
      return null;
    }
    if (!response.ok) {
      discard(response, context);
      throw unavailable();
    }
    try {
      const metadata = objectMetadata(await this.json(response, context), this.bucket, key);
      close(context, false);
      return metadata;
    } catch {
      close(context, true);
      throw unavailable();
    }
  }

  async delete(key: string): Promise<void> {
    assertQuarantineObjectKey(key);
    objectName(key);
    await this.erasure.deleteBatch([{
      source: "telemetry",
      id: key,
      key,
      createdAt: new Date(0).toISOString(),
      version: null,
    }]);
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    assertQuarantineObjectDeleteBatch(keys);
    const unique = [...new Set(keys)];
    if (unique.length > MAX_DELETE_MANY_KEYS) throw unavailable();
    for (const key of unique) await this.delete(key);
  }
}

/** Factory kept parallel to the R2 adapter for composition roots. */
export function createGcsQuarantineObjectStore(
  bucket: string,
  accessToken: GcsQuarantineAccessTokenProvider,
  fetchImpl?: GcsQuarantineFetch,
  timeoutMilliseconds?: number,
  historyProof?: GcsErasureBucketHistoryProof,
): QuarantineObjectStore {
  return new GcsQuarantineObjectStore(
    bucket,
    accessToken,
    fetchImpl,
    timeoutMilliseconds,
    historyProof,
  );
}
