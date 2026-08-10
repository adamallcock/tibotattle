import { ApiError, jsonResponse } from "./errors";
import { sha256, sha256Hex } from "./crypto";
import stableSparkleReleaseContract from "./sparkle-release-contract.json";

export interface SparkleAppcastGuardContract {
  readonly channel: string;
  readonly updateOrigin: string;
  readonly appcastObjectKey: string;
  readonly r2Bucket: string;
  readonly objectPrefix: string;
  readonly guardSchema: string;
  readonly guardRoute: string;
  readonly appcastContentType: string;
  readonly appcastCacheControl: string;
  readonly artifactContentType: string;
  readonly artifactCacheControl: string;
}

const sparkleReleaseContract: SparkleAppcastGuardContract =
  stableSparkleReleaseContract;

export const SPARKLE_APPCAST_GUARD_SCHEMA = sparkleReleaseContract.guardSchema;
export const SPARKLE_APPCAST_GUARD_ROUTE = sparkleReleaseContract.guardRoute;
export const SPARKLE_APPCAST_GUARD_CHANNEL = sparkleReleaseContract.channel;
export const SPARKLE_APPCAST_GUARD_BUCKET = sparkleReleaseContract.r2Bucket;
export const SPARKLE_APPCAST_GUARD_KEY = sparkleReleaseContract.appcastObjectKey;
export const SPARKLE_APPCAST_GUARD_UPDATE_ORIGIN = sparkleReleaseContract.updateOrigin;
export const SPARKLE_APPCAST_GUARD_OBJECT_PREFIX = sparkleReleaseContract.objectPrefix;
export const SPARKLE_APPCAST_GUARD_ARTIFACT_CONTENT_TYPE = sparkleReleaseContract.artifactContentType;
export const SPARKLE_APPCAST_GUARD_ARTIFACT_CACHE_CONTROL = sparkleReleaseContract.artifactCacheControl;
export const SPARKLE_APPCAST_GUARD_PUBLIC_KEY_ENV =
  "SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY";
export const SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV =
  "SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY_SHA256";
export const SPARKLE_APPCAST_GUARD_CONTENT_TYPE = sparkleReleaseContract.appcastContentType;
export const SPARKLE_APPCAST_GUARD_CACHE_CONTROL = sparkleReleaseContract.appcastCacheControl;
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
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.dmg$/u;
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
  readonly schemaVersion: string;
  readonly channel: string;
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string;
  readonly cacheControl: string;
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
  readonly nonceDatabase: D1Database | null;
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

function configuredNonceDatabase(env: Env): D1Database | null {
  const value = setting(env, "USAGE_MONITOR_DB");
  if (value === null || typeof value !== "object"
      || typeof Reflect.get(value, "prepare") !== "function") {
    return null;
  }
  return value as D1Database;
}

function disabledSparkleAppcastGuardConfiguration():
SparkleAppcastGuardConfiguration {
  return Object.freeze({
    enabled: false,
    token: null,
    bucket: null,
    nonceDatabase: null,
    publicEdKey: null,
    publicEdKeySha256: null,
  });
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
  contract: SparkleAppcastGuardContract = sparkleReleaseContract,
): SparkleAppcastGuardConfiguration {
  const mode = setting(env, "SPARKLE_APPCAST_GUARD_MODE");
  if (mode === undefined || mode === "disabled") {
    return disabledSparkleAppcastGuardConfiguration();
  }
  if (mode !== "enabled") configurationError();

  const expectedSettings: ReadonlyArray<readonly [string, string]> = [
    ["SPARKLE_APPCAST_GUARD_CHANNEL", contract.channel],
    ["SPARKLE_APPCAST_GUARD_BUCKET", contract.r2Bucket],
    ["SPARKLE_APPCAST_GUARD_APPCAST_KEY", contract.appcastObjectKey],
    ["SPARKLE_APPCAST_GUARD_ENDPOINT_PATH", contract.guardRoute],
    ["SPARKLE_APPCAST_GUARD_CONTENT_TYPE", contract.appcastContentType],
    ["SPARKLE_APPCAST_GUARD_CACHE_CONTROL", contract.appcastCacheControl],
    ["SPARKLE_APPCAST_GUARD_MAX_XML_BYTES", String(SPARKLE_APPCAST_GUARD_MAX_XML_BYTES)],
  ];
  for (const [name, expected] of expectedSettings) {
    if (setting(env, name) !== expected) configurationError();
  }
  // A partially bound enabled route must remain indistinguishable from an
  // absent route. The reviewed R2 bucket identity is checked statically by the
  // deployment gate; Workers cannot introspect an R2 binding's bucket name.
  const bucket = configuredBucket(env);
  const nonceDatabase = configuredNonceDatabase(env);
  if (bucket === null || nonceDatabase === null) {
    return disabledSparkleAppcastGuardConfiguration();
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
  return Object.freeze({
    enabled: true,
    token,
    bucket,
    nonceDatabase,
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

function parsePayload(
  body: Uint8Array,
  contract: SparkleAppcastGuardContract,
): GuardPayload {
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
  if (object.schemaVersion !== contract.guardSchema
      || object.channel !== contract.channel
      || object.bucket !== contract.r2Bucket
      || object.key !== contract.appcastObjectKey
      || object.contentType !== contract.appcastContentType
      || object.cacheControl !== contract.appcastCacheControl) {
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
    schemaVersion: contract.guardSchema,
    channel: contract.channel,
    bucket: contract.r2Bucket,
    key: contract.appcastObjectKey,
    contentType: contract.appcastContentType,
    cacheControl: contract.appcastCacheControl,
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
  readonly signedEnvelope: {
    readonly bytes: number;
    readonly signature: string;
  } | null;
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

function requireExactXmlAttributes(
  attributes: Map<string, string>,
  expected: readonly string[],
): void {
  if (attributes.size !== expected.length
      || expected.some((name) => !attributes.has(name))) {
    invalidCandidate();
  }
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

function parseSparkleArtifactURL(
  value: string,
  version: string,
  contract: SparkleAppcastGuardContract,
): {
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
  const prefixSegments = contract.objectPrefix.split("/");
  const versionIndex = prefixSegments.length;
  const sha256Index = versionIndex + 1;
  const fileNameIndex = versionIndex + 2;
  if (parsed.origin !== contract.updateOrigin
      || parsed.protocol !== "https:"
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.href !== value
      || segments.length !== prefixSegments.length + 3
      || segments.slice(0, versionIndex).join("/") !== contract.objectPrefix
      || segments[versionIndex] !== version
      || !SHA256_PATTERN.test(segments[sha256Index] ?? "")
      || !SAFE_ARTIFACT_FILE_NAME_PATTERN.test(
        segments[fileNameIndex] ?? "",
      )) {
    invalidCandidate();
  }
  return {
    key: segments.join("/"),
    sha256: segments[sha256Index] as string,
  };
}

function parseSparkleEnclosure(
  attributes: Map<string, string>,
  contract: SparkleAppcastGuardContract,
): SparkleAppcastEnclosure {
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
  const object = parseSparkleArtifactURL(url, version, contract);
  const deltaFrom = attributes.get("sparkle:deltaFrom");
  if (deltaFrom !== undefined) invalidCandidate();
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

/**
 * Sparkle 2.9's reviewed generate_appcast tool signs the complete XML prefix
 * and appends a small signature trailer. It also writes the bundle version as
 * an item child and emits an explicitly closed, empty enclosure. Keep this
 * parser deliberately narrow: it accepts the pinned tool's canonical full-DMG
 * shape, then the caller verifies both the signed XML prefix and the artifact.
 */
function parseOfficialSignedSparkleAppcast(
  text: string,
  contract: SparkleAppcastGuardContract,
): ParsedSparkleAppcast {
  const trailer = /<!-- sparkle-signatures:\nedSignature: ([A-Za-z0-9+/]+={0,2})\nlength: ([0-9]+)\n-->\n?$/u.exec(text);
  if (trailer === null || trailer.index <= 0) invalidCandidate();
  const signature = trailer[1];
  const declaredBytes = Number(trailer[2]);
  if (signature === undefined
      || canonicalBase64Bytes(signature)?.byteLength !== 64
      || !Number.isSafeInteger(declaredBytes)
      || declaredBytes < 1
      || declaredBytes !== encoder.encode(text.slice(0, trailer.index)).byteLength) {
    invalidCandidate();
  }
  const signedText = text.slice(0, trailer.index);
  const official = /^<\?xml version="1\.0" standalone="yes"\?><!-- sparkle-sign-warning:\n[^\u0000\r]*?--><rss xmlns:sparkle="http:\/\/www\.andymatuschak\.org\/xml-namespaces\/sparkle" version="2\.0">\s*<channel>\s*<title>([^<&\r\n]{1,128})<\/title>\s*<item>\s*<title>([^<&\r\n]{1,64})<\/title>\s*<pubDate>([^<&\r\n]{1,64})<\/pubDate>\s*<sparkle:version>([^<&\r\n]{1,32})<\/sparkle:version>\s*<sparkle:shortVersionString>([^<&\r\n]{1,32})<\/sparkle:shortVersionString>\s*<sparkle:minimumSystemVersion>([0-9]+(?:\.[0-9]+){1,2})<\/sparkle:minimumSystemVersion>\s*<sparkle:hardwareRequirements>arm64<\/sparkle:hardwareRequirements>\s*<enclosure\b([^>]*?)>\s*<\/enclosure\s*>\s*<\/item>\s*<\/channel>\s*<\/rss>$/u.exec(signedText);
  if (official === null || Number.isNaN(Date.parse(official[3] ?? ""))) {
    invalidCandidate();
  }
  const version = official[4];
  const shortVersion = official[5];
  const attributeSource = official[7];
  if (version === undefined
      || !BUNDLE_VERSION_PATTERN.test(version)
      || shortVersion === undefined
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(shortVersion)
      || attributeSource === undefined) {
    invalidCandidate();
  }
  const attributes = parseXmlAttributes(attributeSource);
  requireExactXmlAttributes(attributes, [
    "url",
    "length",
    "type",
    "sparkle:edSignature",
  ]);
  if (attributes.get("type") !== "application/octet-stream") {
    invalidCandidate();
  }
  attributes.set("sparkle:version", version);
  const latest = parseSparkleEnclosure(attributes, contract);
  return {
    enclosures: [latest],
    latest,
    signedEnvelope: { bytes: declaredBytes, signature },
  };
}

function parseSparkleAppcast(
  text: string,
  contract: SparkleAppcastGuardContract,
): ParsedSparkleAppcast {
  if (text.includes("<!-- sparkle-signatures:")) {
    return parseOfficialSignedSparkleAppcast(text, contract);
  }
  if (text.length === 0 || text.includes("<!") || text.includes("<!--")
      || text.includes("<![CDATA[") || text.includes("<?xml-stylesheet")) {
    invalidCandidate();
  }
  const stack: string[] = [];
  const enclosures: SparkleAppcastEnclosure[] = [];
  let index = 0;
  let rootSeen = false;
  let channelSeen = false;
  let itemCount = 0;
  while (index < text.length) {
    if (text[index] !== "<") {
      const next = text.indexOf("<", index);
      const content = text.slice(index, next === -1 ? text.length : next);
      if (!/^\s*$/u.test(content)) invalidCandidate();
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
    if (name !== "rss" && name !== "channel"
        && name !== "item" && name !== "enclosure") {
      invalidCandidate();
    }
    if (!rootSeen) {
      if (name !== "rss" || selfClosing
          || attributes.get("version") !== "2.0"
          || attributes.get("xmlns:sparkle") !== SPARKLE_XML_NAMESPACE) {
        invalidCandidate();
      }
      requireExactXmlAttributes(attributes, ["version", "xmlns:sparkle"]);
      rootSeen = true;
    } else if (stack.length === 0) {
      invalidCandidate();
    }
    if (name === "channel") {
      if (parent !== "rss" || selfClosing || channelSeen) invalidCandidate();
      requireExactXmlAttributes(attributes, []);
      channelSeen = true;
    }
    if (name === "item") {
      if (parent !== "channel" || selfClosing) invalidCandidate();
      requireExactXmlAttributes(attributes, []);
      itemCount += 1;
    }
    if (name === "enclosure") {
      if (parent !== "item" || !selfClosing) invalidCandidate();
      requireExactXmlAttributes(attributes, [
        "url",
        "length",
        "sparkle:version",
        "sparkle:edSignature",
      ]);
      enclosures.push(parseSparkleEnclosure(attributes, contract));
    } else if (!selfClosing) {
      stack.push(name);
    }
    index = end + 1;
  }
  if (!rootSeen || !channelSeen || itemCount !== 1 || stack.length !== 0
      || enclosures.length !== 1) invalidCandidate();
  const latest = enclosures[0];
  if (latest === undefined || latest.deltaFrom !== undefined) invalidCandidate();
  return { enclosures, latest, signedEnvelope: null };
}

function invalidCandidate(): never {
  throw new ApiError(422, "SPARKLE_APPCAST_GUARD_CANDIDATE_INVALID");
}

function storageUnavailable(
  phase:
    | "current_state"
    | "artifact_head"
    | "artifact_get"
    | "artifact_read"
    | "appcast_put",
): never {
  // This endpoint is owner-authenticated and release-only. Emit only the
  // bounded operation phase so an operator can distinguish an R2 outage from
  // a malformed candidate without logging object names, request data, or
  // credentials.
  console.error(JSON.stringify({
    event: "sparkle_appcast_guard_storage_unavailable",
    phase,
  }));
  throw new ApiError(503, "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE");
}

function canonicalRequest(
  timestamp: string,
  nonce: string,
  bodySha256: string,
  contract: SparkleAppcastGuardContract,
): Uint8Array {
  return encoder.encode(
    `${contract.guardSchema}\0POST\0${contract.guardRoute}`
    + `\0${timestamp}\0${nonce}\0${bodySha256}`,
  );
}

async function authenticateRequest(
  request: Request,
  body: Uint8Array,
  token: string,
  nowEpoch: number,
  contract: SparkleAppcastGuardContract,
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
      canonicalRequest(timestamp, nonce, bodySha256, contract),
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

function conflictResponse(
  reason: "current_state_conflict" | "r2_conditional_write_conflict",
  contract: SparkleAppcastGuardContract,
) {
  return jsonResponse({
    schemaVersion: contract.guardSchema,
    status: "conflict",
    reason,
  }, 409, { "cache-control": "no-store" });
}

async function currentStateMatches(
  bucket: R2Bucket,
  key: string,
  expected: ExpectedCurrentState,
  contract: SparkleAppcastGuardContract,
): Promise<{ bytes: Uint8Array | null; head: R2Object | null; matches: boolean }> {
  const head = await bucket.head(key);
  if (expected.state === "empty") {
    return { bytes: null, head, matches: head === null };
  }
  if (head === null || head.size !== expected.bytes
      || head.httpMetadata?.contentType
        !== contract.appcastContentType
      || head.httpMetadata?.cacheControl
        !== contract.appcastCacheControl
      || (expected.etag !== null
        && expected.etag !== head.etag
        && expected.etag !== head.httpEtag)) {
    return { bytes: null, head, matches: false };
  }
  const object = await bucket.get(key, { onlyIf: { etagMatches: head.etag } });
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

async function verifySignedAppcastEnvelope(
  bytes: Uint8Array,
  appcast: ParsedSparkleAppcast,
  publicKey: CryptoKey,
): Promise<void> {
  const envelope = appcast.signedEnvelope;
  if (envelope === null) return;
  const signature = canonicalBase64Bytes(envelope.signature);
  if (signature === null || signature.byteLength !== 64
      || envelope.bytes > bytes.byteLength) invalidCandidate();
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      signature,
      bytes.slice(0, envelope.bytes),
    );
  } catch {
    verified = false;
  }
  if (!verified) invalidCandidate();
}

async function verifyCandidateArtifact(
  bucket: R2Bucket,
  enclosure: SparkleAppcastEnclosure,
  publicKey: CryptoKey,
  contract: SparkleAppcastGuardContract,
): Promise<void> {
  if (!enclosure.objectKey.endsWith(".dmg")
      || enclosure.length > SPARKLE_APPCAST_GUARD_MAX_ARTIFACT_BYTES) {
    invalidCandidate();
  }
  let head: R2Object | null;
  try {
    head = await bucket.head(enclosure.objectKey);
  } catch {
    storageUnavailable("artifact_head");
  }
  if (head === null
      || head.size !== enclosure.length
      || head.httpMetadata?.contentType
        !== contract.artifactContentType
      || head.httpMetadata?.cacheControl
        !== contract.artifactCacheControl) {
    invalidCandidate();
  }
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await bucket.get(
      enclosure.objectKey,
      { onlyIf: { etagMatches: head.etag } },
    );
  } catch {
    storageUnavailable("artifact_get");
  }
  if (object === null || !("arrayBuffer" in object)) invalidCandidate();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    storageUnavailable("artifact_read");
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

export async function handleSparkleAppcastGuardForContract(
  request: Request,
  env: Env,
  contract: SparkleAppcastGuardContract,
  nowEpoch = Date.now(),
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== contract.guardRoute
      || requestUrl.search || requestUrl.hash) {
    throw new ApiError(404, "NOT_FOUND");
  }
  const configuration = readSparkleAppcastGuardConfiguration(env, contract);
  if (!configuration.enabled || configuration.bucket === null
      || configuration.nonceDatabase === null
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
    contract,
  );
  const db = configuration.nonceDatabase;
  try {
    await consumeSparkleAppcastGuardNonce(db, authentication.nonce, nowEpoch);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE");
  }
  const payload = parsePayload(body, contract);
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
  const candidateAppcast = parseSparkleAppcast(candidateText, contract);
  let current: Awaited<ReturnType<typeof currentStateMatches>>;
  try {
    current = await currentStateMatches(
      configuration.bucket,
      payload.key,
      payload.expectedCurrent,
      contract,
    );
  } catch {
    storageUnavailable("current_state");
  }
  if (!current.matches) return conflictResponse("current_state_conflict", contract);

  const publicKey = await configuredSparklePublicKey(configuration);
  await verifySignedAppcastEnvelope(candidateBytes, candidateAppcast, publicKey);
  if (current.bytes !== null) {
    let currentText: string;
    try {
      currentText = decoder.decode(current.bytes);
    } catch {
      invalidCandidate();
    }
    const currentAppcast = parseSparkleAppcast(currentText, contract);
    await verifySignedAppcastEnvelope(current.bytes, currentAppcast, publicKey);
    // A non-empty appcast is a trusted monotonic baseline only after its
    // canonical active artifact has independently passed the same R2 and
    // Sparkle signature checks as the candidate.
    for (const enclosure of currentAppcast.enclosures) {
      await verifyCandidateArtifact(
        configuration.bucket,
        enclosure,
        publicKey,
        contract,
      );
    }
    // A signed live feed must never be replaced by an unsigned one: installed
    // apps require signed feeds, and the guard refuses the downgrade even for
    // a caller holding the release token.
    if (currentAppcast.signedEnvelope !== null
        && candidateAppcast.signedEnvelope === null) {
      invalidCandidate();
    }
    const versionComparison = compareBundleVersions(
      candidateAppcast.latest.version,
      currentAppcast.latest.version,
    );
    // A same-version candidate is allowed only as a document-only
    // re-publication (for example re-signing the feed for Sparkle's signed
    // appcast validation): the live full enclosure must be retained
    // byte-for-byte so the immutable artifact state cannot drift under a
    // version installed clients have already observed.
    const documentOnlyReplacement = versionComparison === 0
      && candidateAppcast.latest.deltaFrom === undefined
      && currentAppcast.latest.deltaFrom === undefined
      && candidateAppcast.latest.url === currentAppcast.latest.url
      && candidateAppcast.latest.length === currentAppcast.latest.length
      && candidateAppcast.latest.signature === currentAppcast.latest.signature;
    if (versionComparison <= 0 && !documentOnlyReplacement) {
      invalidCandidate();
    }
  }
  for (const enclosure of candidateAppcast.enclosures) {
    await verifyCandidateArtifact(
      configuration.bucket,
      enclosure,
      publicKey,
      contract,
    );
  }

  const onlyIf = current.head === null
    ? { etagDoesNotMatch: "*" }
    : { etagMatches: current.head.etag };
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
    storageUnavailable("appcast_put");
  }
  if (committed === null) {
    return conflictResponse("r2_conditional_write_conflict", contract);
  }
  return jsonResponse({
    schemaVersion: contract.guardSchema,
    status: "committed",
    bytes: candidateBytes.byteLength,
    sha256: payload.candidate.sha256,
  }, 200, { "cache-control": "no-store" });
}

export async function handleSparkleAppcastGuard(
  request: Request,
  env: Env,
  nowEpoch = Date.now(),
): Promise<Response> {
  return handleSparkleAppcastGuardForContract(
    request,
    env,
    sparkleReleaseContract,
    nowEpoch,
  );
}
