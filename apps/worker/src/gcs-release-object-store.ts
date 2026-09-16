import {
  ReleaseObjectStorageUnavailableError,
} from "./release-object-store";
import type {
  ReleaseObjectMetadata,
  ReleaseObjectRead,
  ReleaseObjectStore,
  ReleaseObjectWrite,
  ReleaseObjectWriteResult,
} from "./release-object-store";

/**
 * The JSON API is intentionally addressed through one fixed origin. The
 * adapter never accepts a caller-supplied URL, so a token cannot be sent to an
 * arbitrary redirect target or storage-compatible service by configuration.
 */
export const GCS_STORAGE_API_ORIGIN = "https://storage.googleapis.com";
const MAX_BUCKET_NAME_BYTES = 222;
const MAX_OBJECT_NAME_BYTES = 1_024;
const MAX_HEADER_VALUE_BYTES = 1_024;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 1 * 1024 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MAX_TIMEOUT_MILLISECONDS = 300_000;
const MAX_GENERATION = 9_223_372_036_854_775_807n;
const encoder = new TextEncoder();

export type GcsAccessTokenProvider = () => Promise<string>;
export type GcsFetch = typeof fetch;

function unavailable(): ReleaseObjectStorageUnavailableError {
  return new ReleaseObjectStorageUnavailableError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function assertSafeText(value: string, maximumBytes: number): void {
  if (typeof value !== "string"
      || value.length === 0 || utf8Length(value) > maximumBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw unavailable();
  }
}

function assertBucketName(bucket: string): void {
  assertSafeText(bucket, MAX_BUCKET_NAME_BYTES);
  if (bucket.length < 3 || bucket.length > MAX_BUCKET_NAME_BYTES
      || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(bucket)) {
    throw unavailable();
  }
}

function assertObjectName(name: string): void {
  assertSafeText(name, MAX_OBJECT_NAME_BYTES);
}

function assertHeaderValue(value: string): void {
  assertSafeText(value, MAX_HEADER_VALUE_BYTES);
}

function parseGeneration(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    throw unavailable();
  }
  let generation: bigint;
  try {
    generation = BigInt(value);
  } catch {
    throw unavailable();
  }
  if (generation < 1n || generation > MAX_GENERATION) throw unavailable();
  return value;
}

function parseConditionVersion(value: string): string {
  return parseGeneration(value);
}

function parseSize(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    throw unavailable();
  }
  let size: bigint;
  try {
    size = BigInt(value);
  } catch {
    throw unavailable();
  }
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
  return Number(size);
}

function parseOptionalMetadataText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw unavailable();
  assertHeaderValue(value);
  return value;
}

function parseObjectResource(
  value: unknown,
  bucket: string,
  key: string,
): ReleaseObjectMetadata {
  if (!isRecord(value)) throw unavailable();
  if (value.bucket !== bucket || value.name !== key) throw unavailable();
  if (typeof value.etag !== "string") throw unavailable();
  assertHeaderValue(value.etag);
  const generation = parseGeneration(value.generation);
  const size = parseSize(value.size);
  const contentType = parseOptionalMetadataText(value.contentType);
  const cacheControl = parseOptionalMetadataText(value.cacheControl);
  const quoted = value.etag.startsWith("\"") && value.etag.endsWith("\"")
    ? value.etag
    : `"${value.etag}"`;
  const raw = value.etag.startsWith("\"") && value.etag.endsWith("\"")
    ? value.etag.slice(1, -1)
    : value.etag;
  if (raw.length === 0) throw unavailable();
  return {
    version: generation,
    size,
    entityTags: [...new Set([value.etag, raw, quoted])],
    contentType,
    cacheControl,
  };
}

function encodedComponent(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    throw unavailable();
  }
}

function objectPath(bucket: string, key: string): string {
  return `/storage/v1/b/${encodedComponent(bucket)}/o/${encodedComponent(key)}`;
}

function uploadPath(bucket: string): string {
  return `/upload/storage/v1/b/${encodedComponent(bucket)}/o`;
}

function fixedUrl(path: string): URL {
  const url = new URL(`${GCS_STORAGE_API_ORIGIN}${path}`);
  if (url.origin !== GCS_STORAGE_API_ORIGIN) throw unavailable();
  return url;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
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

function arrayBufferOf(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function hexDigest(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function digestBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw unavailable();
}

function multipartBody(
  key: string,
  bytes: Uint8Array,
  contentType: string,
  cacheControl: string,
  digest: Uint8Array,
): { readonly boundary: string; readonly body: Uint8Array } {
  const boundary = `gcs-release-v1-${hexDigest(digest).slice(0, 24)}`;
  const metadata = JSON.stringify({
    name: key,
    contentType,
    cacheControl,
  });
  const prefix = encoder.encode(
    `--${boundary}\r\n`
    + "Content-Type: application/json; charset=UTF-8\r\n\r\n"
    + `${metadata}\r\n`
    + `--${boundary}\r\n`
    + `Content-Type: ${contentType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  return { boundary, body: concatBytes([prefix, bytes, suffix]) };
}

interface RequestContext {
  readonly controller: AbortController;
  readonly timeoutPromise: Promise<"timeout">;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RequestResult {
  readonly response: Response;
  readonly context: RequestContext;
}

function createRequestContext(timeoutMilliseconds: number): RequestContext {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMilliseconds);
  });
  return { controller, timeoutPromise, timer: timer! };
}

function closeRequestContext(
  context: RequestContext,
  abort: boolean,
): void {
  if (abort) context.controller.abort();
  clearTimeout(context.timer);
}

function releaseResponse(
  response: Response,
  context: RequestContext,
): void {
  closeRequestContext(context, true);
  // A caller must never wait for a provider cancellation path that may itself
  // be stalled. The request controller above remains the primary cancellation
  // mechanism for real fetch responses.
  void response.body?.cancel().catch(() => undefined);
}

export class GcsReleaseObjectStore implements ReleaseObjectStore {
  readonly bucket: string;
  private readonly accessToken: GcsAccessTokenProvider;
  private readonly fetchImpl: GcsFetch;
  private readonly maxUploadBytes: number;
  private readonly timeoutMilliseconds: number;

  constructor(
    bucket: string,
    accessToken: GcsAccessTokenProvider,
    fetchImpl: GcsFetch = (input, init) => fetch(input, init),
    maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
    timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
  ) {
    assertBucketName(bucket);
    if (typeof accessToken !== "function" || typeof fetchImpl !== "function"
        || !Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 0
        || maxUploadBytes > MAX_UPLOAD_BYTES
        || !Number.isSafeInteger(timeoutMilliseconds)
        || timeoutMilliseconds < 1
        || timeoutMilliseconds > MAX_TIMEOUT_MILLISECONDS) {
      throw unavailable();
    }
    this.bucket = bucket;
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
    this.maxUploadBytes = maxUploadBytes;
    this.timeoutMilliseconds = timeoutMilliseconds;
  }

  private async awaitWithinDeadline<T>(
    context: RequestContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (context.controller.signal.aborted) throw unavailable();
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(operation());
    } catch {
      throw unavailable();
    }
    const outcome = await Promise.race([
      promise.then((value) => ({ kind: "value" as const, value })),
      context.timeoutPromise.then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "timeout" || context.controller.signal.aborted) {
      throw unavailable();
    }
    return outcome.value;
  }

  private async request(url: URL, init: RequestInit): Promise<RequestResult> {
    const context = createRequestContext(this.timeoutMilliseconds);
    let token: string;
    try {
      token = await this.awaitWithinDeadline(context, () => this.accessToken());
    } catch {
      closeRequestContext(context, true);
      throw unavailable();
    }
    if (typeof token !== "string" || token.length === 0
        || /[\u0000-\u001f\u007f\s]/u.test(token)) {
      closeRequestContext(context, true);
      throw unavailable();
    }
    let response: Response;
    try {
      response = await this.awaitWithinDeadline(context, () => this.fetchImpl(url, {
          ...init,
          // Manual mode is supported by workerd as well as Node.
          // Every 3xx remains a rejected response; credentials never follow it.
          redirect: "manual",
          signal: context.controller.signal,
          headers: {
            ...(init.headers ?? {}),
            authorization: `Bearer ${token}`,
          },
        }));
    } catch {
      closeRequestContext(context, true);
      throw unavailable();
    }
    if (!(response instanceof Response)) {
      closeRequestContext(context, true);
      throw unavailable();
    }
    return { response, context };
  }

  private async metadataResponse(
    response: Response,
    key: string,
    context: RequestContext,
  ): Promise<ReleaseObjectMetadata> {
    try {
      const value = await this.awaitWithinDeadline(context, () => response.json());
      const metadata = parseObjectResource(value, this.bucket, key);
      closeRequestContext(context, false);
      return metadata;
    } catch {
      releaseResponse(response, context);
      throw unavailable();
    }
  }

  async head(key: string): Promise<ReleaseObjectMetadata | null> {
    assertObjectName(key);
    const { response, context } = await this.request(
      fixedUrl(objectPath(this.bucket, key)),
      {
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" },
      },
    );
    if (response.status === 404) {
      releaseResponse(response, context);
      return null;
    }
    if (!response.ok) {
      releaseResponse(response, context);
      throw unavailable();
    }
    return this.metadataResponse(response, key, context);
  }

  async get(key: string, version: string): Promise<ReleaseObjectRead> {
    assertObjectName(key);
    const generation = parseConditionVersion(version);
    const url = fixedUrl(objectPath(this.bucket, key));
    url.searchParams.set("alt", "media");
    // Do not add a generation selector: this verifies the live object is still
    // the generation inspected by head(), rather than reading an old revision.
    url.searchParams.set("ifGenerationMatch", generation);
    const { response, context } = await this.request(
      url,
      {
        method: "GET",
        cache: "no-store",
        headers: { accept: "*/*" },
      },
    );
    if (response.status === 404) {
      releaseResponse(response, context);
      return { status: "missing" };
    }
    if (response.status === 412) {
      releaseResponse(response, context);
      return { status: "conflict" };
    }
    if (!response.ok) {
      releaseResponse(response, context);
      throw unavailable();
    }
    return {
      status: "found",
      // Keep the body read deferred so the guard can preserve its separate
      // artifact_get and artifact_read failure phases.
      arrayBuffer: async () => {
        try {
          const body = await this.awaitWithinDeadline(context, () => response.arrayBuffer());
          closeRequestContext(context, false);
          return body;
        } catch {
          releaseResponse(response, context);
          throw unavailable();
        }
      },
    };
  }

  async put(
    key: string,
    bytes: Uint8Array,
    options: ReleaseObjectWrite,
  ): Promise<ReleaseObjectWriteResult> {
    assertObjectName(key);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.maxUploadBytes
        || typeof options !== "object" || options === null) {
      throw unavailable();
    }
    const contentType = options.contentType;
    const cacheControl = options.cacheControl;
    const suppliedCondition = options.condition;
    const suppliedSha256 = options.sha256;
    assertHeaderValue(contentType);
    assertHeaderValue(cacheControl);
    if (!isRecord(suppliedCondition) || typeof suppliedCondition.kind !== "string") {
      throw unavailable();
    }
    let generationPrecondition: string;
    if (suppliedCondition.kind === "version") {
      if (typeof suppliedCondition.version !== "string") throw unavailable();
      generationPrecondition = parseConditionVersion(suppliedCondition.version);
    } else {
      if (suppliedCondition.kind !== "absent") throw unavailable();
      generationPrecondition = "0";
    }
    let expectedDigest: Uint8Array;
    try {
      expectedDigest = digestBytes(suppliedSha256);
    } catch {
      throw unavailable();
    }
    if (expectedDigest.byteLength !== 32) throw unavailable();
    const payload = bytes.slice();
    let digest: Uint8Array;
    try {
      digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
    } catch {
      throw unavailable();
    }
    if (!sameBytes(digest, expectedDigest)) throw unavailable();
    const { boundary, body } = multipartBody(
      key,
      payload,
      contentType,
      cacheControl,
      digest,
    );
    const url = fixedUrl(uploadPath(this.bucket));
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("name", key);
    url.searchParams.set("ifGenerationMatch", generationPrecondition);
    const { response, context } = await this.request(
      url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": `multipart/related; boundary=${boundary}`,
        },
        body: arrayBufferOf(body),
      },
    );
    if (response.status === 412) {
      releaseResponse(response, context);
      return { status: "conflict" };
    }
    if (!response.ok) {
      releaseResponse(response, context);
      throw unavailable();
    }
    return {
      status: "stored",
      metadata: await this.metadataResponse(response, key, context),
    };
  }
}
