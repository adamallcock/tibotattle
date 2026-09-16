import {
  ParticipantErasureObjectStorageUnavailableError,
  PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT,
  type ParticipantErasureObjectRef,
  type ParticipantErasureObjectStore,
} from "./erasure-object-store";

/** Fixed origin: access tokens never follow a caller-controlled URL. */
export const GCS_ERASURE_STORAGE_API_ORIGIN = "https://storage.googleapis.com";
const MAX_BUCKET_NAME_BYTES = 222;
const MAX_OBJECT_NAME_BYTES = 1_024;
const MAX_TOKEN_BYTES = 4_096;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_VERSION_PAGES = 16;
const MAX_VERSIONS_PER_KEY = 4_096;
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MAX_TIMEOUT_MILLISECONDS = 300_000;
const MAX_GENERATION = 9_223_372_036_854_775_807n;
const encoder = new TextEncoder();

export type GcsErasureAccessTokenProvider = () => Promise<string>;
export type GcsErasureFetch = typeof fetch;

function unavailable(): ParticipantErasureObjectStorageUnavailableError {
  return new ParticipantErasureObjectStorageUnavailableError();
}

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function safeText(value: unknown, maximumBytes: number): asserts value is string {
  if (typeof value !== "string"
      || value.length === 0
      || utf8Length(value) > maximumBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw unavailable();
  }
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

function encoded(value: string): string {
  try { return encodeURIComponent(value); } catch { throw unavailable(); }
}

function objectPath(bucket: string, key: string): string {
  return `/storage/v1/b/${encoded(bucket)}/o/${encoded(key)}`;
}

function fixedUrl(path: string): URL {
  const url = new URL(`${GCS_ERASURE_STORAGE_API_ORIGIN}${path}`);
  if (url.origin !== GCS_ERASURE_STORAGE_API_ORIGIN) throw unavailable();
  return url;
}

interface RequestContext {
  readonly controller: AbortController;
  readonly timeout: Promise<"timeout">;
  readonly timer: ReturnType<typeof setTimeout>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RequestResult { readonly response: Response; readonly context: RequestContext }

export class GcsErasureObjectStore implements ParticipantErasureObjectStore {
  readonly bucket: string;
  private readonly accessToken: GcsErasureAccessTokenProvider;
  private readonly fetchImpl: GcsErasureFetch;
  private readonly timeoutMilliseconds: number;

  constructor(
    bucket: string,
    accessToken: GcsErasureAccessTokenProvider,
    fetchImpl: GcsErasureFetch = (input, init) => fetch(input, init),
    timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
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
    } catch {
      close(context, true);
      throw unavailable();
    }
    try {
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
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      if (reader !== undefined) void reader.cancel().catch(() => undefined);
      discard(response, context);
      throw unavailable();
    } finally {
      reader?.releaseLock();
    }
  }

  private async listVersions(key: string, softDeleted: boolean): Promise<string[]> {
    objectName(key);
    const generations: string[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_VERSION_PAGES; page += 1) {
      const url = fixedUrl(`/storage/v1/b/${encoded(this.bucket)}/o`);
      if (softDeleted) {
        // GCS does not include soft-deleted generations in versions=true.
        // This separate listing is required before claiming retained-data
        // erasure; such generations cannot be permanently removed early.
        url.searchParams.set("softDeleted", "true");
      } else {
        url.searchParams.set("versions", "true");
      }
      url.searchParams.set("prefix", key);
      url.searchParams.set("maxResults", "1000");
      // `softDeleted` is a list query parameter, not an object resource field.
      url.searchParams.set("fields", "items(name,generation),nextPageToken");
      if (pageToken !== null) url.searchParams.set("pageToken", pageToken);
      const { response, context } = await this.request(url, {
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (response.status === 404) {
        discard(response, context);
        throw unavailable();
      }
      if (!response.ok) {
        discard(response, context);
        throw unavailable();
      }
      const value = await this.json(response, context);
      close(context, false);
      if (!isRecord(value)) throw unavailable();
      const items = value.items;
      if (items !== undefined && !Array.isArray(items)) throw unavailable();
      for (const item of (items ?? [])) {
        if (!isRecord(item) || typeof item.name !== "string") throw unavailable();
        objectName(item.name);
        if (item.name !== key) continue;
        const current = generation(item.generation);
        if (!generations.includes(current)) generations.push(current);
        if (generations.length > MAX_VERSIONS_PER_KEY) throw unavailable();
      }
      const next = value.nextPageToken;
      if (next === undefined || next === null) return generations;
      safeText(next, 8_192);
      if (seenTokens.has(next)) throw unavailable();
      seenTokens.add(next);
      pageToken = next;
    }
    throw unavailable();
  }

  private async assertNoSoftDeletedVersions(key: string): Promise<void> {
    const softDeleted = await this.listVersions(key, true);
    if (softDeleted.length > 0) throw unavailable();
  }

  private async deleteGeneration(key: string, currentGeneration: string): Promise<void> {
    const url = fixedUrl(objectPath(this.bucket, key));
    // `generation` identifies the exact revision. A key-only DELETE would
    // silently target a replacement created after the erasure page was read.
    url.searchParams.set("generation", currentGeneration);
    const { response, context } = await this.request(url, {
      method: "DELETE",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status === 404) {
      discard(response, context);
      return;
    }
    if (!response.ok) {
      discard(response, context);
      throw unavailable();
    }
    discard(response, context);
  }

  private async deleteAllVersions(key: string): Promise<void> {
    // A concurrent writer can create a new generation between list and delete.
    // Re-list after every bounded pass; if the key never quiesces, fail closed.
    for (let pass = 0; pass < MAX_VERSION_PAGES; pass += 1) {
      await this.assertNoSoftDeletedVersions(key);
      const versions = await this.listVersions(key, false);
      if (versions.length === 0) {
        // Close the list/delete race: a writer can create a soft-deleted
        // generation between the initial soft-delete listing and this empty
        // live-version response. A second listing is required before success.
        await this.assertNoSoftDeletedVersions(key);
        return;
      }
      for (const currentGeneration of versions) {
        await this.deleteGeneration(key, currentGeneration);
      }
      // A provider with soft delete enabled has now retained the deleted
      // generations. Refuse success instead of claiming permanent erasure.
      await this.assertNoSoftDeletedVersions(key);
    }
    throw unavailable();
  }

  async deleteBatch(objects: readonly ParticipantErasureObjectRef[]): Promise<void> {
    if (!Array.isArray(objects)
        || objects.length > PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT) {
      throw new TypeError("invalid participant erasure object batch");
    }
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const object of objects) {
      if (object === null || typeof object !== "object") throw unavailable();
      objectName(object.key);
      if (object.version !== null) generation(object.version);
      if (!seen.has(object.key)) {
        seen.add(object.key);
        keys.push(object.key);
      }
    }
    for (const key of keys) await this.deleteAllVersions(key);
  }
}
