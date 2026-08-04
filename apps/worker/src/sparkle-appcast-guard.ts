import { ApiError, jsonResponse } from "./errors";
import { sha256, sha256Hex } from "./crypto";

export const SPARKLE_APPCAST_GUARD_SCHEMA =
  "usage-monitor-sparkle-appcast-atomic-guard-v1";
export const SPARKLE_APPCAST_GUARD_ROUTE =
  "/api/v1/internal/release/appcast";
export const SPARKLE_APPCAST_GUARD_CHANNEL = "stable";
export const SPARKLE_APPCAST_GUARD_BUCKET = "tibotattle-updates";
export const SPARKLE_APPCAST_GUARD_KEY = "appcast.xml";
export const SPARKLE_APPCAST_GUARD_CONTENT_TYPE =
  "application/xml; charset=utf-8";
export const SPARKLE_APPCAST_GUARD_CACHE_CONTROL =
  "public, max-age=300, must-revalidate";
export const SPARKLE_APPCAST_GUARD_MAX_XML_BYTES = 1024 * 1024;
export const SPARKLE_APPCAST_GUARD_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const SPARKLE_APPCAST_GUARD_TIMESTAMP_SKEW_SECONDS = 300;
export const SPARKLE_APPCAST_GUARD_NONCE_RETENTION_SECONDS =
  SPARKLE_APPCAST_GUARD_TIMESTAMP_SKEW_SECONDS + 1;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/u;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const TOKEN_PATTERN = /^[^\u0000-\u001f\u007f]{32,256}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

interface ExpectedEmptyState {
  readonly state: "empty";
  readonly bytes: 0;
  readonly sha256: null;
  readonly etag: null;
}

interface ExpectedPresentState {
  readonly state: "present";
  readonly bytes: number;
  readonly sha256: string;
  readonly etag: string | null;
}

type ExpectedCurrentState = ExpectedEmptyState | ExpectedPresentState;

interface GuardPayload {
  readonly schemaVersion: typeof SPARKLE_APPCAST_GUARD_SCHEMA;
  readonly channel: typeof SPARKLE_APPCAST_GUARD_CHANNEL;
  readonly bucket: typeof SPARKLE_APPCAST_GUARD_BUCKET;
  readonly key: typeof SPARKLE_APPCAST_GUARD_KEY;
  readonly contentType: typeof SPARKLE_APPCAST_GUARD_CONTENT_TYPE;
  readonly cacheControl: typeof SPARKLE_APPCAST_GUARD_CACHE_CONTROL;
  readonly expectedCurrent: ExpectedCurrentState;
  readonly candidate: {
    readonly bytes: number;
    readonly sha256: string;
    readonly base64: string;
  };
}

export interface SparkleAppcastGuardConfiguration {
  readonly enabled: boolean;
  readonly token: string | null;
  readonly bucket: R2Bucket | null;
}

function setting(env: Env, name: string): unknown {
  return Reflect.get(env, name);
}

function configuredBucket(env: Env): R2Bucket | null {
  const value = setting(env, "SPARKLE_RELEASES");
  if (value === null || typeof value !== "object"
      || typeof Reflect.get(value, "head") !== "function"
      || typeof Reflect.get(value, "get") !== "function"
      || typeof Reflect.get(value, "put") !== "function") {
    return null;
  }
  return value as R2Bucket;
}

function configurationError(): never {
  throw new ApiError(503, "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID");
}

/**
 * The guard is deliberately absent unless the owner supplies every reviewed
 * setting and the separately provisioned SPARKLE_RELEASES binding. Keeping
 * this check in code means a copied endpoint, bucket, or channel cannot turn
 * the route into a general R2 write API.
 */
export function readSparkleAppcastGuardConfiguration(
  env: Env,
): SparkleAppcastGuardConfiguration {
  const mode = setting(env, "SPARKLE_APPCAST_GUARD_MODE");
  if (mode === undefined || mode === "disabled") {
    return Object.freeze({ enabled: false, token: null, bucket: null });
  }
  if (mode !== "enabled") configurationError();

  const expectedSettings: ReadonlyArray<readonly [string, string]> = [
    ["SPARKLE_APPCAST_GUARD_CHANNEL", SPARKLE_APPCAST_GUARD_CHANNEL],
    ["SPARKLE_APPCAST_GUARD_BUCKET", SPARKLE_APPCAST_GUARD_BUCKET],
    ["SPARKLE_APPCAST_GUARD_APPCAST_KEY", SPARKLE_APPCAST_GUARD_KEY],
    ["SPARKLE_APPCAST_GUARD_ENDPOINT_PATH", SPARKLE_APPCAST_GUARD_ROUTE],
    ["SPARKLE_APPCAST_GUARD_CONTENT_TYPE", SPARKLE_APPCAST_GUARD_CONTENT_TYPE],
    ["SPARKLE_APPCAST_GUARD_CACHE_CONTROL", SPARKLE_APPCAST_GUARD_CACHE_CONTROL],
    ["SPARKLE_APPCAST_GUARD_MAX_XML_BYTES", String(SPARKLE_APPCAST_GUARD_MAX_XML_BYTES)],
  ];
  for (const [name, expected] of expectedSettings) {
    if (setting(env, name) !== expected) configurationError();
  }
  const token = setting(env, "SPARKLE_APPCAST_GUARD_TOKEN");
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    configurationError();
  }
  const bucket = configuredBucket(env);
  if (bucket === null) configurationError();
  return Object.freeze({ enabled: true, token, bucket });
}

function invalidRequest(): never {
  throw new ApiError(400, "SPARKLE_APPCAST_GUARD_REQUEST_INVALID");
}

function invalidAuth(): never {
  throw new ApiError(401, "SPARKLE_APPCAST_GUARD_AUTH_INVALID");
}

function base64UrlDecode(value: string): Uint8Array {
  if (value.length === 0 || !BASE64_URL_PATTERN.test(value)
      || value.length % 4 === 1) invalidRequest();
  const standard = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(standard);
  } catch {
    invalidRequest();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const canonical = btoa(binary).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/u, "");
  if (canonical !== value) invalidRequest();
  return bytes;
}

async function readBoundedRequestBody(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") invalidRequest();
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0
        || length > SPARKLE_APPCAST_GUARD_MAX_REQUEST_BYTES) {
      throw new ApiError(413, "SPARKLE_APPCAST_GUARD_BODY_TOO_LARGE");
    }
  }
  if (!request.body) invalidRequest();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > SPARKLE_APPCAST_GUARD_MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "SPARKLE_APPCAST_GUARD_BODY_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidRequest();
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join("\0") !== keys.slice().sort().join("\0")) {
    invalidRequest();
  }
}

function parseExpectedCurrent(value: unknown): ExpectedCurrentState {
  const object = parseObject(value);
  assertExactKeys(object, ["bytes", "etag", "sha256", "state"]);
  const state = object.state;
  if (state === "empty") {
    if (object.bytes !== 0 || object.sha256 !== null || object.etag !== null) {
      invalidRequest();
    }
    return { state: "empty", bytes: 0, sha256: null, etag: null };
  }
  if (state !== "present"
      || !Number.isSafeInteger(object.bytes)
      || (object.bytes as number) < 1
      || (object.bytes as number) > SPARKLE_APPCAST_GUARD_MAX_XML_BYTES
      || typeof object.sha256 !== "string"
      || !SHA256_PATTERN.test(object.sha256)
      || (object.etag !== null && typeof object.etag !== "string")
      || (typeof object.etag === "string" && object.etag.length > 256)) {
    invalidRequest();
  }
  return {
    state: "present",
    bytes: object.bytes as number,
    sha256: object.sha256 as string,
    etag: object.etag as string | null,
  };
}

function parsePayload(body: Uint8Array): GuardPayload {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(body));
  } catch {
    invalidRequest();
  }
  const object = parseObject(value);
  assertExactKeys(object, [
    "cacheControl",
    "candidate",
    "channel",
    "contentType",
    "expectedCurrent",
    "key",
    "schemaVersion",
    "bucket",
  ]);
  if (object.schemaVersion !== SPARKLE_APPCAST_GUARD_SCHEMA
      || object.channel !== SPARKLE_APPCAST_GUARD_CHANNEL
      || object.bucket !== SPARKLE_APPCAST_GUARD_BUCKET
      || object.key !== SPARKLE_APPCAST_GUARD_KEY
      || object.contentType !== SPARKLE_APPCAST_GUARD_CONTENT_TYPE
      || object.cacheControl !== SPARKLE_APPCAST_GUARD_CACHE_CONTROL) {
    throw new ApiError(403, "SPARKLE_APPCAST_GUARD_TARGET_INVALID");
  }
  const candidate = parseObject(object.candidate);
  assertExactKeys(candidate, ["base64", "bytes", "sha256"]);
  if (typeof candidate.base64 !== "string"
      || !Number.isSafeInteger(candidate.bytes)
      || (candidate.bytes as number) < 1
      || (candidate.bytes as number) > SPARKLE_APPCAST_GUARD_MAX_XML_BYTES
      || typeof candidate.sha256 !== "string"
      || !SHA256_PATTERN.test(candidate.sha256)) {
    invalidRequest();
  }
  return {
    schemaVersion: SPARKLE_APPCAST_GUARD_SCHEMA,
    channel: SPARKLE_APPCAST_GUARD_CHANNEL,
    bucket: SPARKLE_APPCAST_GUARD_BUCKET,
    key: SPARKLE_APPCAST_GUARD_KEY,
    contentType: SPARKLE_APPCAST_GUARD_CONTENT_TYPE,
    cacheControl: SPARKLE_APPCAST_GUARD_CACHE_CONTROL,
    expectedCurrent: parseExpectedCurrent(object.expectedCurrent),
    candidate: {
      base64: candidate.base64,
      bytes: candidate.bytes as number,
      sha256: candidate.sha256,
    },
  };
}

function canonicalRequest(
  timestamp: string,
  nonce: string,
  bodySha256: string,
): Uint8Array {
  return encoder.encode(
    `${SPARKLE_APPCAST_GUARD_SCHEMA}\0POST\0${SPARKLE_APPCAST_GUARD_ROUTE}`
    + `\0${timestamp}\0${nonce}\0${bodySha256}`,
  );
}

async function authenticateRequest(
  request: Request,
  body: Uint8Array,
  token: string,
  nowEpoch: number,
): Promise<{ nonce: string }> {
  const timestamp = request.headers.get("x-usage-monitor-release-timestamp");
  const nonce = request.headers.get("x-usage-monitor-release-nonce");
  const signature = request.headers.get("x-usage-monitor-release-signature");
  if (timestamp === null || nonce === null || signature === null
      || !/^\d{1,12}$/u.test(timestamp)
      || !NONCE_PATTERN.test(nonce)) invalidAuth();
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)
      || Math.abs(Math.floor(nowEpoch / 1000) - timestampSeconds)
        > SPARKLE_APPCAST_GUARD_TIMESTAMP_SKEW_SECONDS) {
    throw new ApiError(401, "SPARKLE_APPCAST_GUARD_REPLAY_INVALID");
  }
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(signature);
  } catch {
    invalidAuth();
  }
  if (signatureBytes.byteLength !== 32) invalidAuth();
  const bodySha256 = await sha256Hex(body);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      canonicalRequest(timestamp, nonce, bodySha256),
    );
    if (!valid) invalidAuth();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    invalidAuth();
  }
  return { nonce };
}

/**
 * Consume the signed nonce before touching R2. D1's unique constraint makes
 * concurrent duplicate requests deterministic; the short TTL keeps this
 * coordination table bounded without introducing a global Durable Object. The
 * extra second retains a nonce through the exact accepted timestamp boundary.
 */
export async function consumeSparkleAppcastGuardNonce(
  db: D1Database,
  nonce: string,
  nowEpoch = Date.now(),
): Promise<void> {
  const nowSeconds = Math.floor(nowEpoch / 1000);
  await db.prepare(
    "DELETE FROM sparkle_appcast_guard_nonces WHERE expires_at <= ?",
  ).bind(nowSeconds).run();
  const result = await db.prepare(
    "INSERT OR IGNORE INTO sparkle_appcast_guard_nonces (nonce, expires_at) VALUES (?, ?)",
  ).bind(
    nonce,
    nowSeconds + SPARKLE_APPCAST_GUARD_NONCE_RETENTION_SECONDS,
  ).run();
  if (result.meta.changes !== 1) {
    throw new ApiError(401, "SPARKLE_APPCAST_GUARD_REPLAY_INVALID");
  }
}

function conflictResponse(reason: "current_state_conflict" | "r2_conditional_write_conflict") {
  return jsonResponse({
    schemaVersion: SPARKLE_APPCAST_GUARD_SCHEMA,
    status: "conflict",
    reason,
  }, 409, { "cache-control": "no-store" });
}

async function currentStateMatches(
  bucket: R2Bucket,
  key: string,
  expected: ExpectedCurrentState,
): Promise<{ head: R2Object | null; matches: boolean }> {
  const head = await bucket.head(key);
  if (expected.state === "empty") {
    return { head, matches: head === null };
  }
  if (head === null || head.size !== expected.bytes
      || (expected.etag !== null
        && expected.etag !== head.etag
        && expected.etag !== head.httpEtag)) {
    return { head, matches: false };
  }
  const object = await bucket.get(key, { onlyIf: { etagMatches: head.httpEtag } });
  if (object === null || !("arrayBuffer" in object)) {
    return { head, matches: false };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  return {
    head,
    matches: bytes.byteLength === expected.bytes
      && await sha256Hex(bytes) === expected.sha256,
  };
}

export async function handleSparkleAppcastGuard(
  request: Request,
  env: Env,
  nowEpoch = Date.now(),
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== SPARKLE_APPCAST_GUARD_ROUTE
      || requestUrl.search || requestUrl.hash) {
    throw new ApiError(404, "NOT_FOUND");
  }
  const configuration = readSparkleAppcastGuardConfiguration(env);
  if (!configuration.enabled || configuration.bucket === null
      || configuration.token === null) {
    // Keep a disabled route indistinguishable from an unregistered route.
    throw new ApiError(404, "NOT_FOUND");
  }
  if (request.method !== "POST") {
    throw new ApiError(405, "METHOD_NOT_ALLOWED", {
      responseHeaders: { allow: "POST" },
    });
  }
  const body = await readBoundedRequestBody(request);
  const authentication = await authenticateRequest(
    request,
    body,
    configuration.token,
    nowEpoch,
  );
  let db: D1Database;
  const database = Reflect.get(env, "USAGE_MONITOR_DB");
  if (database === null || typeof database !== "object"
      || typeof Reflect.get(database, "prepare") !== "function") {
    throw new ApiError(503, "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE");
  }
  db = database as D1Database;
  try {
    await consumeSparkleAppcastGuardNonce(db, authentication.nonce, nowEpoch);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE");
  }
  const payload = parsePayload(body);
  const candidateBytes = base64UrlDecode(payload.candidate.base64);
  if (candidateBytes.byteLength !== payload.candidate.bytes
      || candidateBytes.byteLength > SPARKLE_APPCAST_GUARD_MAX_XML_BYTES
      || await sha256Hex(candidateBytes) !== payload.candidate.sha256) {
    throw new ApiError(422, "SPARKLE_APPCAST_GUARD_CANDIDATE_INVALID");
  }
  try {
    decoder.decode(candidateBytes);
  } catch {
    throw new ApiError(422, "SPARKLE_APPCAST_GUARD_CANDIDATE_INVALID");
  }
  let current: Awaited<ReturnType<typeof currentStateMatches>>;
  try {
    current = await currentStateMatches(
      configuration.bucket,
      payload.key,
      payload.expectedCurrent,
    );
  } catch {
    throw new ApiError(503, "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE");
  }
  if (!current.matches) return conflictResponse("current_state_conflict");

  const onlyIf = current.head === null
    ? { etagDoesNotMatch: "*" }
    : { etagMatches: current.head.httpEtag };
  let committed: R2Object | null;
  try {
    committed = await configuration.bucket.put(
      payload.key,
      candidateBytes,
      {
        onlyIf,
        sha256: await sha256(candidateBytes),
        httpMetadata: {
          contentType: payload.contentType,
          cacheControl: payload.cacheControl,
        },
      },
    );
  } catch {
    throw new ApiError(503, "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE");
  }
  if (committed === null) return conflictResponse("r2_conditional_write_conflict");
  return jsonResponse({
    schemaVersion: SPARKLE_APPCAST_GUARD_SCHEMA,
    status: "committed",
    bytes: candidateBytes.byteLength,
    sha256: payload.candidate.sha256,
  }, 200, { "cache-control": "no-store" });
}
