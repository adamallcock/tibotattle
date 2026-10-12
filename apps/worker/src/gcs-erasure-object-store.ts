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
const GCS_BUCKET_HISTORY_PROOF_RETENTION_SECONDS = "0" as const;
const encoder = new TextEncoder();

export type GcsErasureAccessTokenProvider = () => Promise<string>;
export type GcsErasureFetch = typeof fetch;

/**
 * A provisioner-issued receipt for a bucket whose soft-deleted history was
 * empty when the bucket was created.  GCS returns HTTP 400 when
 * `softDeleted=true` is used against a bucket with soft delete disabled, so
 * an erasure worker cannot infer "there is no history" from that response.
 *
 * The receipt is therefore explicit and is pinned to the bucket incarnation
 * and metadata generation.  The erasure adapter verifies both values before
 * and after every key operation.  Callers must obtain this from a trusted
 * bucket-provisioning record; this module does not mint one from an ordinary
 * metadata read.
 */
export interface GcsErasureBucketHistoryProof {
  readonly bucket: string;
  readonly bucketGeneration: string;
  readonly bucketMetageneration: string;
  readonly softDeleteRetentionDurationSeconds: typeof GCS_BUCKET_HISTORY_PROOF_RETENTION_SECONDS;
}

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

/**
 * Parse and freeze a provisioner-issued history receipt without coercing
 * provider generation values through JavaScript Number.
 */
export function createGcsErasureBucketHistoryProof(
  value: GcsErasureBucketHistoryProof,
): GcsErasureBucketHistoryProof {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  bucketName(value.bucket);
  const bucketGeneration = generation(value.bucketGeneration);
  const bucketMetageneration = generation(value.bucketMetageneration);
  if (value.softDeleteRetentionDurationSeconds !== GCS_BUCKET_HISTORY_PROOF_RETENTION_SECONDS) {
    throw unavailable();
  }
  return Object.freeze({
    bucket: value.bucket,
    bucketGeneration,
    bucketMetageneration,
    softDeleteRetentionDurationSeconds: GCS_BUCKET_HISTORY_PROOF_RETENTION_SECONDS,
  });
}

function encoded(value: string): string {
  try { return encodeURIComponent(value); } catch { throw unavailable(); }
}

function objectPath(bucket: string, key: string): string {
  return `/storage/v1/b/${encoded(bucket)}/o/${encoded(key)}`;
}

function bucketPath(bucket: string): string {
  return `/storage/v1/b/${encoded(bucket)}`;
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

function isDisabledSoftDeleteInvalidArgument(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const error = value.error;
  if (!isRecord(error) || error.code !== 400) return false;
  const messageMatches = (candidate: unknown): boolean => typeof candidate === "string"
    && /soft.?delete/iu.test(candidate)
    && /(disabled|policy|retention)/iu.test(candidate);
  const entries = error.errors;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (!isRecord(entry)) return false;
    const reason = entry.reason;
    // The JSON API uses `invalidArgument` in some responses, while the live
    // storage endpoint currently returns the less-specific `invalid` reason
    // for this exact disabled-policy error.  Keep the message predicate
    // narrow so an unrelated 400 is never treated as an empty history.
    const invalidArgument = reason === "invalidArgument"
      || reason === "INVALID_ARGUMENT"
      || reason === "invalid";
    return invalidArgument && messageMatches(entry.message);
  });
}

interface RequestResult { readonly response: Response; readonly context: RequestContext }

export class GcsErasureObjectStore implements ParticipantErasureObjectStore {
  readonly bucket: string;
  private readonly accessToken: GcsErasureAccessTokenProvider;
  private readonly fetchImpl: GcsErasureFetch;
  private readonly timeoutMilliseconds: number;
  private readonly historyProof: GcsErasureBucketHistoryProof | undefined;

  constructor(
    bucket: string,
    accessToken: GcsErasureAccessTokenProvider,
    fetchImpl: GcsErasureFetch = (input, init) => fetch(input, init),
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
    if (historyProof !== undefined) {
      const parsedProof = createGcsErasureBucketHistoryProof(historyProof);
      if (parsedProof.bucket !== bucket) throw unavailable();
      this.historyProof = parsedProof;
    } else {
      this.historyProof = undefined;
    }
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

  private async listVersions(
    key: string,
    softDeleted: boolean,
    allowDisabledSoftDelete: boolean,
  ): Promise<string[]> {
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
      if (softDeleted && allowDisabledSoftDelete && response.status === 400) {
        // A disabled soft-delete policy makes this query invalid.  This is
        // safe only after a matching, trusted history proof was checked for
        // this operation, and only for the provider's closed
        // invalidArgument/disabled-policy response. An arbitrary 400 (for
        // example, malformed query or revoked permission) must still fail
        // closed below.
        const errorBody = await this.json(response, context);
        close(context, false);
        if (isDisabledSoftDeleteInvalidArgument(errorBody)) return [];
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

  private async readBucketHistoryState(): Promise<{
    readonly bucketGeneration: string;
    readonly bucketMetageneration: string;
    readonly softDeleteRetentionDurationSeconds: string;
  }> {
    const url = fixedUrl(bucketPath(this.bucket));
    url.searchParams.set(
      "fields",
      "generation,metageneration,softDeletePolicy(retentionDurationSeconds)",
    );
    const { response, context } = await this.request(url, {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      discard(response, context);
      throw unavailable();
    }
    const value = await this.json(response, context);
    close(context, false);
    if (!isRecord(value)) throw unavailable();
    const policy = value.softDeletePolicy;
    // Cloud Storage omits softDeletePolicy when it is disabled (the JSON
    // representation of retentionDurationSeconds=0). That absence is safe to
    // interpret only in conjunction with the separately pinned provisioning
    // proof checked by the caller. A present but malformed policy still fails
    // closed.
    if (policy !== undefined && !isRecord(policy)) throw unavailable();
    const retentionDurationSeconds = policy === undefined
      ? GCS_BUCKET_HISTORY_PROOF_RETENTION_SECONDS
      : policy.retentionDurationSeconds;
    if (typeof retentionDurationSeconds !== "string") throw unavailable();
    // Validate the two opaque counters with BigInt-backed generation(), but
    // retain their exact decimal strings for the proof comparison.
    return {
      bucketGeneration: generation(value.generation),
      bucketMetageneration: generation(value.metageneration),
      softDeleteRetentionDurationSeconds: retentionDurationSeconds,
    };
  }

  private async assertHistoryProof(): Promise<boolean> {
    const proof = this.historyProof;
    if (proof === undefined) return false;
    const state = await this.readBucketHistoryState();
    if (state.bucketGeneration !== proof.bucketGeneration
        || state.bucketMetageneration !== proof.bucketMetageneration
        || state.softDeleteRetentionDurationSeconds !== proof.softDeleteRetentionDurationSeconds) {
      throw unavailable();
    }
    return true;
  }

  private async assertNoSoftDeletedVersions(
    key: string,
    allowDisabledSoftDelete: boolean,
  ): Promise<void> {
    const softDeleted = await this.listVersions(key, true, allowDisabledSoftDelete);
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
    const allowDisabledSoftDelete = await this.assertHistoryProof();
    for (let pass = 0; pass < MAX_VERSION_PAGES; pass += 1) {
      await this.assertNoSoftDeletedVersions(key, allowDisabledSoftDelete);
      const versions = await this.listVersions(key, false, false);
      if (versions.length === 0) {
        // Close the list/delete race: a writer can create a soft-deleted
        // generation between the initial soft-delete listing and this empty
        // live-version response. A second listing is required before success.
        await this.assertNoSoftDeletedVersions(key, allowDisabledSoftDelete);
        if (allowDisabledSoftDelete) await this.assertHistoryProof();
        return;
      }
      for (const currentGeneration of versions) {
        await this.deleteGeneration(key, currentGeneration);
      }
      // A provider with soft delete enabled has now retained the deleted
      // generations. Refuse success instead of claiming permanent erasure.
      await this.assertNoSoftDeletedVersions(key, allowDisabledSoftDelete);
      if (allowDisabledSoftDelete) await this.assertHistoryProof();
    }
    throw unavailable();
  }

  /**
   * Prove that a key has no live or retained generations.  A live-object 404
   * alone is insufficient when a bucket can retain noncurrent or
   * soft-deleted generations; callers such as quarantine `head` use this
   * before returning null.
   */
  async assertNoRetainedVersions(key: string): Promise<void> {
    objectName(key);
    const allowDisabledSoftDelete = await this.assertHistoryProof();
    await this.assertNoSoftDeletedVersions(key, allowDisabledSoftDelete);
    const versions = await this.listVersions(key, false, false);
    if (versions.length > 0) throw unavailable();
    await this.assertNoSoftDeletedVersions(key, allowDisabledSoftDelete);
    if (allowDisabledSoftDelete) await this.assertHistoryProof();
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
