import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

export const CLAUDE_DESKTOP_PRICING_CACHE_VERSION =
  "claude-desktop-pricing-cache-v0.1";
export const CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER = "anthropic_claude_code";
export const CLAUDE_DESKTOP_PRICING_PROJECTION_SCHEMA_VERSION =
  "claude-desktop-pricing-projection-v0.1";
export const CLAUDE_DESKTOP_PRICING_SUMMARY_SCHEMA_VERSION =
  "claude-desktop-pricing-summary-v0.1";

const ACCOUNTING_VENDOR = "anthropic";
const CACHE_PUBLICATION_KEYS = Object.freeze([
  "provider",
  "publication_generation",
  "usage_projection_generation",
  "payload_sha256",
  "payload_json",
  "published_at_ms",
  "previous_payload_sha256",
]);
// The cache is deliberately a summary cache. Row-rich pricing projections
// are a debug/readability surface and must not become a durable publication
// format: a bounded summary keeps cache storage and validation independent of
// the retained transcript population.
const MAX_PROJECTION_ROWS = 10_000_000;
const MAX_PROJECTION_BYTES = 64 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,95}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const COVERAGE_STATUSES = new Set(["fully_priced", "partially_priced", "unpriced"]);
const SUMMARY_KEYS = Object.freeze([
  "schemaVersion",
  "provider",
  "productProvider",
  "accountingVendor",
  "usageProjectionGeneration",
  "eventCount",
  "totalUsd",
  "coverageStatus",
  "coverageCounts",
  "warningCodes",
  "pricingDigest",
]);
const FORBIDDEN_KEYS = new Set([
  "accountId",
  "account_id",
  "content",
  "prompt",
  "raw",
  "rawLabel",
  "raw_label",
  "response",
  "sessionId",
  "session_id",
  "sourcePath",
  "source_path",
  "thinking",
  "toolInput",
  "tool_input",
]);

export class ClaudeDesktopPricingCacheError extends Error {
  constructor(code) {
    super(`Claude Desktop pricing cache failed (${code})`);
    this.name = "ClaudeDesktopPricingCacheError";
    this.code = `claude_desktop_pricing_cache_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopPricingCacheError(code);
}

function safePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail("configuration");
  }
  const selected = resolve(path);
  if (selected !== path) fail("configuration");
  return selected;
}

function assertOwnerOnlyDirectory(path, { create = false } = {}) {
  if (create) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch {
      fail("storage_unavailable");
    }
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    fail("storage_unavailable");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("storage_unsafe");
  }
}

function assertOwnerOnlyDatabase(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    fail("storage_unavailable");
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("storage_unsafe");
  }
}

function createOwnerOnlyDatabase(path) {
  assertOwnerOnlyDirectory(dirname(path), { create: true });
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(descriptor);
  } catch (error) {
    if (error?.code !== "EEXIST") fail("storage_unavailable");
    assertOwnerOnlyDatabase(path);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    fail("storage_unavailable");
  }
  assertOwnerOnlyDatabase(path);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) fail("projection_shape");
  return serialized;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonSnapshot(value) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail("projection_shape");
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof ClaudeDesktopPricingCacheError) throw error;
    fail("projection_shape");
  }
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort().join("\0");
  if (actual !== [...expected].sort().join("\0")) fail(code);
}

function safeHash(value, code = "projection_shape") {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) fail(code);
  return value;
}

function safeCount(value, code = "projection_shape") {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function safePositiveCount(value, code = "projection_shape") {
  safeCount(value, code);
  if (value < 1) fail(code);
  return value;
}

function safeDecimal(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 128 || !DECIMAL_PATTERN.test(value)) {
    fail("projection_shape");
  }
  return value;
}

function safeCode(value) {
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) fail("projection_shape");
  return value;
}

// This cache only receives provider-generated, privacy-minimized summaries.
// Still reject path-like or control-bearing strings at the final boundary so
// an accidentally widened warning/metadata field cannot turn into a local
// path, account/session identifier, or arbitrary file content sink.
const PRIVATE_VALUE_PATTERN = /(?:^|[\\/])(?:Users|private|tmp|var|home|Library|Application Support)(?:[\\/]|$)|^(?:~|[\\/])|^[A-Za-z]:[\\/]/iu;

function validatePublicString(value, maximum = 8192) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
      || PRIVATE_VALUE_PATTERN.test(value)
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("projection_privacy");
  }
  return value;
}

function validateSafeTree(value, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > 2_000_000 || depth > 32) fail("projection_shape");
  if (typeof value === "string") {
    validatePublicString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateSafeTree(item, depth + 1, state);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail("projection_privacy");
    validateSafeTree(item, depth + 1, state);
  }
}

function validatePricingSummary(value) {
  exactKeys(value, SUMMARY_KEYS, "projection_shape");
  validateSafeTree(value);
  if (value.schemaVersion !== CLAUDE_DESKTOP_PRICING_SUMMARY_SCHEMA_VERSION
      || value.provider !== CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER
      || value.productProvider !== CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER
      || value.accountingVendor !== ACCOUNTING_VENDOR) fail("projection_identity");
  if (value.usageProjectionGeneration !== null) {
    safePositiveCount(value.usageProjectionGeneration);
  }
  safeCount(value.eventCount);
  if (value.eventCount > MAX_PROJECTION_ROWS) fail("projection_size");
  safeDecimal(value.totalUsd);
  if (!COVERAGE_STATUSES.has(value.coverageStatus)) fail("projection_shape");
  exactKeys(value.coverageCounts, ["fullyPriced", "partiallyPriced", "unpriced"], "projection_shape");
  const totalCoverage = ["fullyPriced", "partiallyPriced", "unpriced"]
    .map((key) => safeCount(value.coverageCounts[key]))
    .reduce((sum, count) => sum + count, 0);
  if (totalCoverage !== value.eventCount) fail("projection_shape");
  if (!Array.isArray(value.warningCodes) || value.warningCodes.length > 512) fail("projection_shape");
  for (let index = 0; index < value.warningCodes.length; index += 1) {
    safeCode(value.warningCodes[index]);
    if (index > 0 && value.warningCodes[index - 1].localeCompare(value.warningCodes[index]) >= 0) {
      fail("projection_shape");
    }
  }
  safeHash(value.pricingDigest);
}

function normalizeProjection(value) {
  const snapshot = jsonSnapshot(value);
  exactKeys(snapshot, [...SUMMARY_KEYS, "payloadSha256"], "projection_shape");
  const payloadSha256 = safeHash(snapshot.payloadSha256, "projection_digest");
  delete snapshot.payloadSha256;
  validatePricingSummary(snapshot);
  const payloadJson = stableJson(snapshot);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PROJECTION_BYTES) fail("projection_size");
  if (sha256(payloadJson) !== payloadSha256) fail("projection_digest");
  return { payload: snapshot, payloadJson, payloadSha256 };
}

function schemaColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name).sort();
}

function configure(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 0;
    CREATE TABLE IF NOT EXISTS cache_meta(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS pricing_publication(
      provider TEXT PRIMARY KEY CHECK(provider = 'anthropic_claude_code'),
      publication_generation INTEGER NOT NULL CHECK(publication_generation >= 1),
      usage_projection_generation INTEGER
        CHECK(usage_projection_generation IS NULL OR usage_projection_generation >= 1),
      payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
      payload_json TEXT NOT NULL,
      published_at_ms INTEGER NOT NULL CHECK(published_at_ms >= 0),
      previous_payload_sha256 TEXT
        CHECK(previous_payload_sha256 IS NULL OR length(previous_payload_sha256) = 64)
    ) STRICT, WITHOUT ROWID;
  `);
  if (schemaColumns(database, "cache_meta").join("\0") !== "key\0value"
      || schemaColumns(database, "pricing_publication").join("\0") !== [...CACHE_PUBLICATION_KEYS].sort().join("\0")) {
    fail("schema");
  }
  const schema = database.prepare("SELECT value FROM cache_meta WHERE key = 'schema_version'").get();
  if (schema && schema.value !== CLAUDE_DESKTOP_PRICING_CACHE_VERSION) fail("schema");
  database.prepare("INSERT OR IGNORE INTO cache_meta(key, value) VALUES ('schema_version', ?)")
    .run(CLAUDE_DESKTOP_PRICING_CACHE_VERSION);
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("timestamp");
  return value;
}

function projectionFromRow(row) {
  if (!row) {
    return {
      status: "empty",
      schemaVersion: CLAUDE_DESKTOP_PRICING_CACHE_VERSION,
      provider: CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER,
      publicationGeneration: null,
      usageProjectionGeneration: null,
      payloadSha256: null,
      publishedAtMs: null,
      previousPayloadSha256: null,
      projection: null,
    };
  }
  safePositiveCount(Number(row.publication_generation), "corrupt");
  const usageProjectionGeneration = row.usage_projection_generation === null
    ? null : Number(row.usage_projection_generation);
  if (usageProjectionGeneration !== null) safePositiveCount(usageProjectionGeneration, "corrupt");
  safeTimestamp(Number(row.published_at_ms));
  const payloadSha256 = safeHash(row.payload_sha256, "corrupt");
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    fail("corrupt");
  }
  let normalized;
  try {
    normalized = normalizeProjection({ ...payload, payloadSha256 });
  } catch {
    fail("corrupt");
  }
  if (normalized.payloadJson !== row.payload_json) fail("corrupt");
  const previousPayloadSha256 = row.previous_payload_sha256 === null
    ? null : safeHash(row.previous_payload_sha256, "corrupt");
  return {
    status: "available",
    schemaVersion: CLAUDE_DESKTOP_PRICING_CACHE_VERSION,
    provider: CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER,
    publicationGeneration: Number(row.publication_generation),
    usageProjectionGeneration,
    payloadSha256,
    publishedAtMs: Number(row.published_at_ms),
    previousPayloadSha256,
    projection: { ...normalized.payload, payloadSha256 },
  };
}

export function defaultClaudeDesktopPricingCachePath(dataDirectory = null) {
  const directory = dataDirectory === null
    ? resolve(process.cwd(), ".usage-monitor") : safePath(dataDirectory);
  return resolve(directory, "claude-desktop-pricing.sqlite");
}

export function claudeDesktopPricingProjectionPayloadSha256(value) {
  const snapshot = jsonSnapshot(value);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("projection_shape");
  delete snapshot.payloadSha256;
  return sha256(stableJson(snapshot));
}

export function openClaudeDesktopPricingCache(path) {
  const selectedPath = safePath(path);
  createOwnerOnlyDatabase(selectedPath);
  let database;
  try {
    database = new DatabaseSync(selectedPath, { timeout: 5_000 });
    configure(database);
  } catch (error) {
    database?.close();
    if (error instanceof ClaudeDesktopPricingCacheError) throw error;
    fail("storage_unavailable");
  }
  chmodSync(selectedPath, 0o600);
  assertOwnerOnlyDatabase(selectedPath);

  function transact(callback) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  return {
    publishProjection(projection, {
      publishedAtMs = Date.now(),
      failpoint = null,
    } = {}) {
      const normalized = normalizeProjection(projection);
      const timestamp = safeTimestamp(publishedAtMs);
      if (failpoint !== null && typeof failpoint !== "function") fail("configuration");
      return transact(() => {
        const current = database.prepare(`
          SELECT provider, publication_generation, usage_projection_generation,
                 payload_sha256, payload_json, published_at_ms, previous_payload_sha256
          FROM pricing_publication WHERE provider = ?
        `).get(CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER);
        if (current
            && current.payload_sha256 === normalized.payloadSha256
            && current.payload_json !== normalized.payloadJson) {
          fail("digest_collision");
        }
        if (current && current.payload_sha256 === normalized.payloadSha256) {
          if (failpoint) failpoint("replay_before_commit");
          return {
            status: "reused",
            reused: true,
            invalidated: false,
            publicationGeneration: Number(current.publication_generation),
            usageProjectionGeneration: current.usage_projection_generation === null
              ? null : Number(current.usage_projection_generation),
            payloadSha256: normalized.payloadSha256,
            previousPayloadSha256: current.previous_payload_sha256,
            publishedAtMs: Number(current.published_at_ms),
          };
        }
        const publicationGeneration = Number(current?.publication_generation ?? 0) + 1;
        const previousPayloadSha256 = current?.payload_sha256 ?? null;
        database.prepare(`
          INSERT INTO pricing_publication(
            provider, publication_generation, usage_projection_generation,
            payload_sha256, payload_json, published_at_ms, previous_payload_sha256
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider) DO UPDATE SET
            publication_generation = excluded.publication_generation,
            usage_projection_generation = excluded.usage_projection_generation,
            payload_sha256 = excluded.payload_sha256,
            payload_json = excluded.payload_json,
            published_at_ms = excluded.published_at_ms,
            previous_payload_sha256 = excluded.previous_payload_sha256
        `).run(
          CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER,
          publicationGeneration,
          normalized.payload.usageProjectionGeneration,
          normalized.payloadSha256,
          normalized.payloadJson,
          timestamp,
          previousPayloadSha256,
        );
        if (failpoint) failpoint("after_publication_write");
        return {
          status: "published",
          reused: false,
            invalidated: Boolean(current),
          publicationGeneration,
          usageProjectionGeneration: normalized.payload.usageProjectionGeneration,
          payloadSha256: normalized.payloadSha256,
          previousPayloadSha256,
          publishedAtMs: timestamp,
        };
      });
    },

    readProjection() {
      const row = database.prepare(`
        SELECT provider, publication_generation, usage_projection_generation,
               payload_sha256, payload_json, published_at_ms, previous_payload_sha256
        FROM pricing_publication WHERE provider = ?
      `).get(CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER);
      if (row && row.provider !== CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER) fail("corrupt");
      return projectionFromRow(row);
    },

    close() {
      if (database.isOpen) database.close();
    },
  };
}

export function readClaudeDesktopPricingCache(path) {
  const cache = openClaudeDesktopPricingCache(path);
  try {
    return cache.readProjection();
  } finally {
    cache.close();
  }
}
