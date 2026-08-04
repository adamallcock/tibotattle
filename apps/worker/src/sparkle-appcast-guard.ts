import { ApiError, jsonResponse } from "./errors";
import { sha256, sha256Hex } from "./crypto";

export const SPARKLE_APPCAST_GUARD_SCHEMA =
  "usage-monitor-sparkle-appcast-atomic-guard-v1";
export const SPARKLE_APPCAST_GUARD_ROUTE =
  "/api/v1/internal/release/appcast";
export const SPARKLE_APPCAST_GUARD_CHANNEL = "stable";
export const SPARKLE_APPCAST_GUARD_BUCKET = "tibotattle-updates";
export const SPARKLE_APPCAST_GUARD_KEY = "appcast.xml";
export const SPARKLE_APPCAST_GUARD_UPDATE_ORIGIN =
  "https://updates.tibotattle.com";
export const SPARKLE_APPCAST_GUARD_OBJECT_PREFIX = "releases";
export const SPARKLE_APPCAST_GUARD_ARTIFACT_CONTENT_TYPE =
  "application/x-apple-diskimage";
export const SPARKLE_APPCAST_GUARD_ARTIFACT_CACHE_CONTROL =
  "public, max-age=31536000, immutable";
export const SPARKLE_APPCAST_GUARD_PUBLIC_KEY_ENV =
  "SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY";
export const SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV =
  "SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY_SHA256";
export const SPARKLE_APPCAST_GUARD_CONTENT_TYPE =
  "application/xml; charset=utf-8";
export const SPARKLE_APPCAST_GUARD_CACHE_CONTROL =
  "public, max-age=300, must-revalidate";
export const SPARKLE_APPCAST_GUARD_MAX_XML_BYTES = 1024 * 1024;
export const SPARKLE_APPCAST_GUARD_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const SPARKLE_APPCAST_GUARD_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const SPARKLE_APPCAST_GUARD_TIMESTAMP_SKEW_SECONDS = 300;
export const SPARKLE_APPCAST_GUARD_NONCE_RETENTION_SECONDS =
  SPARKLE_APPCAST_GUARD_TIMESTAMP_SKEW_SECONDS + 1;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/u;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const ED25519_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;
const BUNDLE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,2}$/u;
const SAFE_ARTIFACT_FILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:dmg|delta)$/u;
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
  readonly publicEdKey: string | null;
  readonly publicEdKeySha256: string | null;
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

function canonicalBase64Bytes(value: string): Uint8Array | null {
  if (!BASE64_PATTERN.test(value) || value.length % 4 !== 0) return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const canonical = btoa(binary);
  return canonical === value ? bytes : null;
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
    return Object.freeze({
      enabled: false,
      token: null,
      bucket: null,
      publicEdKey: null,
      publicEdKeySha256: null,
    });
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
  const publicEdKey = setting(env, SPARKLE_APPCAST_GUARD_PUBLIC_KEY_ENV);
  const publicEdKeySha256 = setting(
    env,
    SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV,
  );
  if (typeof publicEdKey !== "string"
      || !ED25519_PUBLIC_KEY_PATTERN.test(publicEdKey)
      || canonicalBase64Bytes(publicEdKey)?.byteLength !== 32
      || typeof publicEdKeySha256 !== "string"
      || !SHA256_PATTERN.test(publicEdKeySha256)) {
    configurationError();
  }
  const bucket = configuredBucket(env);
  if (bucket === null) configurationError();
  return Object.freeze({
    enabled: true,
    token,
    bucket,
    publicEdKey,
    publicEdKeySha256,
  });
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

interface SparkleAppcastEnclosure {
  readonly deltaFrom: string | undefined;
  readonly length: number;
  readonly objectKey: string;
  readonly objectSha256: string;
  readonly signature: string;
  readonly url: string;
  readonly version: string;
}

interface ParsedSparkleAppcast {
  readonly enclosures: readonly SparkleAppcastEnclosure[];
  readonly latest: SparkleAppcastEnclosure;
}

const SPARKLE_XML_NAMESPACE =
  "http://www.andymatuschak.org/xml-namespaces/sparkle";

function parseXmlAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /\s+([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*("[^"]*"|'[^']*')/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const key = match[1];
    const quotedValue = match[2];
    if (key === undefined || quotedValue === undefined
        || attributes.has(key)) invalidCandidate();
    const value = quotedValue.slice(1, -1);
    if (value.includes("<") || value.includes(">")
        || /&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]+|x[0-9A-Fa-f]+);)/u.test(value)) {
      invalidCandidate();
    }
    attributes.set(key, value);
  }
  if (!/^\s*$/u.test(source.replace(pattern, ""))) invalidCandidate();
  return attributes;
}

function findXmlTagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "<") {
      invalidCandidate();
    } else if (character === ">") {
      return index;
    }
  }
  invalidCandidate();
}

function compareBundleVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number).concat([0, 0]).slice(0, 3);
  const rightParts = right.split(".").map(Number).concat([0, 0]).slice(0, 3);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function parseSparkleArtifactURL(value: string, version: string): {
  readonly key: string;
  readonly sha256: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalidCandidate();
  }
  const segments = parsed.pathname.slice(1).split("/");
  if (parsed.origin !== SPARKLE_APPCAST_GUARD_UPDATE_ORIGIN
      || parsed.protocol !== "https:"
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.href !== value
      || segments.length !== 4
      || segments[0] !== SPARKLE_APPCAST_GUARD_OBJECT_PREFIX
      || segments[1] !== version
      || !SHA256_PATTERN.test(segments[2] ?? "")
      || !SAFE_ARTIFACT_FILE_NAME_PATTERN.test(segments[3] ?? "")) {
    invalidCandidate();
  }
  return {
    key: segments.join("/"),
    sha256: segments[2] as string,
  };
}

function parseSparkleEnclosure(attributes: Map<string, string>): SparkleAppcastEnclosure {
  const url = attributes.get("url");
  const length = attributes.get("length");
  const version = attributes.get("sparkle:version");
  const signature = attributes.get("sparkle:edSignature");
  if (url === undefined || length === undefined || version === undefined
      || signature === undefined
      || !/^(?:0|[1-9][0-9]*)$/u.test(length)
      || !Number.isSafeInteger(Number(length))
      || Number(length) < 1
      || Number(length) > SPARKLE_APPCAST_GUARD_MAX_ARTIFACT_BYTES
      || !BUNDLE_VERSION_PATTERN.test(version)
      || !ED25519_SIGNATURE_PATTERN.test(signature)
      || canonicalBase64Bytes(signature)?.byteLength !== 64) {
    invalidCandidate();
  }
  const object = parseSparkleArtifactURL(url, version);
  const deltaFrom = attributes.get("sparkle:deltaFrom");
  if (deltaFrom !== undefined
      && (!BUNDLE_VERSION_PATTERN.test(deltaFrom)
        || compareBundleVersions(deltaFrom, version) >= 0)) {
    invalidCandidate();
  }
  return {
    deltaFrom,
    length: Number(length),
    objectKey: object.key,
    objectSha256: object.sha256,
    signature,
    url,
    version,
  };
}

function parseSparkleAppcast(text: string): ParsedSparkleAppcast {
  if (text.length === 0 || text.includes("<!") || text.includes("<!--")
      || text.includes("<![CDATA[") || text.includes("<?xml-stylesheet")) {
    invalidCandidate();
  }
  const stack: string[] = [];
  const enclosures: SparkleAppcastEnclosure[] = [];
  let index = 0;
  let rootSeen = false;
  let channelSeen = false;
  let itemSeen = false;
  while (index < text.length) {
    if (text[index] !== "<") {
      const next = text.indexOf("<", index);
      const content = text.slice(index, next === -1 ? text.length : next);
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]+|x[0-9A-Fa-f]+);)/u.test(content)) {
        invalidCandidate();
      }
      index = next === -1 ? text.length : next;
      continue;
    }
    const end = findXmlTagEnd(text, index);
    const raw = text.slice(index, end + 1);
    if (raw.startsWith("<?xml")) {
      if (index !== 0
          || !/^<\?xml\s+version\s*=\s*["']1\.0["']\s+encoding\s*=\s*["']utf-8["']\s*\?>$/u.test(raw)) {
        invalidCandidate();
      }
      index = end + 1;
      continue;
    }
    if (raw.startsWith("<?") || raw.startsWith("<!")) invalidCandidate();
    const closing = /^<\/([A-Za-z_:][A-Za-z0-9:._-]*)\s*>$/u.exec(raw);
    if (closing !== null) {
      const name = closing[1];
      if (name === undefined || stack.pop() !== name) invalidCandidate();
      index = end + 1;
      continue;
    }
    const opening = /^<([A-Za-z_:][A-Za-z0-9:._-]*)([\s\S]*?)>$/u.exec(raw);
    if (opening === null) invalidCandidate();
    const name = opening[1];
    let attributeSource = opening[2] ?? "";
    const selfClosing = /\/\s*$/u.test(attributeSource);
    if (selfClosing) attributeSource = attributeSource.replace(/\/\s*$/u, "");
    if (name === undefined) invalidCandidate();
    const attributes = parseXmlAttributes(attributeSource);
    const parent = stack[stack.length - 1];
    if (!rootSeen) {
      if (name !== "rss" || selfClosing
          || attributes.get("version") !== "2.0"
          || attributes.get("xmlns:sparkle") !== SPARKLE_XML_NAMESPACE) {
        invalidCandidate();
      }
      rootSeen = true;
    } else if (stack.length === 0) {
      invalidCandidate();
    }
    if (name === "channel") {
      if (parent !== "rss" || selfClosing || channelSeen) invalidCandidate();
      channelSeen = true;
    }
    if (name === "item") {
      if (parent !== "channel" || selfClosing) invalidCandidate();
      itemSeen = true;
    }
    if (name === "enclosure") {
      if (parent !== "item" || !selfClosing) invalidCandidate();
      enclosures.push(parseSparkleEnclosure(attributes));
    } else if (!selfClosing) {
      stack.push(name);
    }
    index = end + 1;
  }
  if (!rootSeen || !channelSeen || !itemSeen || stack.length !== 0
      || enclosures.length === 0) invalidCandidate();
  let latestVersion = enclosures[0]?.version;
  if (latestVersion === undefined) invalidCandidate();
  for (const enclosure of enclosures) {
    if (compareBundleVersions(enclosure.version, latestVersion) > 0) {
      latestVersion = enclosure.version;
    }
  }
  const latest = enclosures.filter(
    (enclosure) => enclosure.version === latestVersion,
  );
  if (latest.length !== 1 || latest[0] === undefined
      || latest[0].deltaFrom !== undefined) invalidCandidate();
  return { enclosures, latest: latest[0] };
}

function invalidCandidate(): never {
  throw new ApiError(422, "SPARKLE_APPCAST_GUARD_CANDIDATE_INVALID");
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
): Promise<{ bytes: Uint8Array | null; head: R2Object | null; matches: boolean }> {
  const head = await bucket.head(key);
  if (expected.state === "empty") {
    return { bytes: null, head, matches: head === null };
  }
  if (head === null || head.size !== expected.bytes
      || (expected.etag !== null
        && expected.etag !== head.etag
        && expected.etag !== head.httpEtag)) {
    return { bytes: null, head, matches: false };
  }
  const object = await bucket.get(key, { onlyIf: { etagMatches: head.httpEtag } });
  if (object === null || !("arrayBuffer" in object)) {
    return { bytes: null, head, matches: false };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  return {
    bytes,
    head,
    matches: bytes.byteLength === expected.bytes
      && await sha256Hex(bytes) === expected.sha256,
  };
}

async function configuredSparklePublicKey(
  configuration: SparkleAppcastGuardConfiguration,
): Promise<CryptoKey> {
  const encoded = configuration.publicEdKey;
  const expectedSha256 = configuration.publicEdKeySha256;
  if (encoded === null || expectedSha256 === null) configurationError();
  const raw = canonicalBase64Bytes(encoded);
  if (raw === null || raw.byteLength !== 32
      || await sha256Hex(raw) !== expectedSha256) {
    configurationError();
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    configurationError();
  }
}

async function verifyCandidateArtifact(
  bucket: R2Bucket,
  enclosure: SparkleAppcastEnclosure,
  publicKey: CryptoKey,
): Promise<void> {
  if (!enclosure.objectKey.endsWith(".dmg")
      || enclosure.length > SPARKLE_APPCAST_GUARD_MAX_ARTIFACT_BYTES) {
    invalidCandidate();
  }
  let head: R2Object | null;
  try {
    head = await bucket.head(enclosure.objectKey);
  } catch {
    throw new ApiError(503, "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE");
  }
  if (head === null
      || head.size !== enclosure.length
      || head.httpMetadata?.contentType
        !== SPARKLE_APPCAST_GUARD_ARTIFACT_CONTENT_TYPE
      || head.httpMetadata?.cacheControl
        !== SPARKLE_APPCAST_GUARD_ARTIFACT_CACHE_CONTROL) {
    invalidCandidate();
  }
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await bucket.get(
      enclosure.objectKey,
      { onlyIf: { etagMatches: head.httpEtag } },
    );
  } catch {
    throw new ApiError(503, "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE");
  }
  if (object === null || !("arrayBuffer" in object)) invalidCandidate();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    throw new ApiError(503, "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE");
  }
  if (bytes.byteLength !== enclosure.length
      || await sha256Hex(bytes) !== enclosure.objectSha256) {
    invalidCandidate();
  }
  const signature = canonicalBase64Bytes(enclosure.signature);
  if (signature === null || signature.byteLength !== 64) invalidCandidate();
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      signature,
      bytes,
    );
  } catch {
    verified = false;
  }
  if (!verified) invalidCandidate();
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
  let candidateText: string;
  try {
    candidateText = decoder.decode(candidateBytes);
  } catch {
    invalidCandidate();
  }
  const candidateAppcast = parseSparkleAppcast(candidateText);
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

  if (current.bytes !== null) {
    let currentText: string;
    try {
      currentText = decoder.decode(current.bytes);
    } catch {
      invalidCandidate();
    }
    const currentAppcast = parseSparkleAppcast(currentText);
    if (compareBundleVersions(
      candidateAppcast.latest.version,
      currentAppcast.latest.version,
    ) <= 0) {
      invalidCandidate();
    }
  }
  const publicKey = await configuredSparklePublicKey(configuration);
  await verifyCandidateArtifact(
    configuration.bucket,
    candidateAppcast.latest,
    publicKey,
  );

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
