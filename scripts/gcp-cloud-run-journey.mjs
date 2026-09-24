#!/usr/bin/env node

/**
 * Content-free HTTP qualification for the private PostgreSQL Worker host.
 *
 * This is intentionally a separate process from the Node host.  It receives
 * the owner fixture only for the duration of the test, derives the ordinary
 * application cookie/CSRF pair in memory, and emits phase/status metadata
 * without response bodies, bearer tokens, cookies, or fixture secrets.
 */

import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  telemetryV11RequiredConsent,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import {
  APP_OFFICIAL_PRICE_CARDS,
  priceUsageEvent,
} from "@app-usagemonitor/accounting";
import {
  createTelemetryV11Day,
  createTelemetryV12Day,
  deriveTelemetryAccountTrackIdV2,
  runTelemetryV11Sync,
  runTelemetryV12Sync,
} from "../src/contribution/index.js";

const FIXTURE_SCHEMA = "gcp-test-owner-fixture-v1";
const HEX64 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const PARTICIPANT_ID = /^participant:[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;
// Storage analysis is explicitly bounded to a 128-day source window. Keep
// the qualification retry budget finite, but large enough to converge when a
// provider advances only a bounded checkpoint group per maintenance call.
const ANALYTICS_HISTORY_WINDOW_DAYS = 128;
const MAX_MAINTENANCE_ATTEMPTS = integerEnv(
  "JOURNEY_MAX_MAINTENANCE_ATTEMPTS",
  16,
  1,
  ANALYTICS_HISTORY_WINDOW_DAYS,
);
const RETRYABLE_MAINTENANCE_CODES = new Set([
  "ANALYTICS_REBUILD_DEFERRED",
  "ANALYTICS_CACHES_REFRESHED",
]);
const SAFE_SYNC_FAILURE_CODES = new Set([
  "admission_exhausted",
  "consent_rejected",
  "device_unavailable",
  "index_unavailable",
  "interrupted",
  "local_index_changed",
  "response_invalid",
  "revision_conflict",
  "service_unavailable",
]);
const RETRYABLE_SYNC_FAILURE_CODES = new Set(["admission_exhausted", "service_unavailable"]);
// The hosted qualification bucket is a one-minute window.  A runner retry is
// deliberately bounded to one additional pass: it can recover a transient
// bucket response without turning an admission failure into an unbounded loop.
const MAX_SYNC_RETRY_DELAY_MS = 60_000;
const DEFAULT_SYNC_RETRY_DELAY_MS = 60_000;
const MAX_SYNC_RETRY_ATTEMPTS = 2;
const MAX_FIXTURE_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const OWNER_SESSION_TTL_MILLISECONDS = 30 * 60 * 1_000;
const STATE_SCHEMA = "gcp-http-journey-state-v1";
const JOURNEY_RICH_RECORD_COUNT = 40;
const JOURNEY_RICH_START_SLOT = 1;
const JOURNEY_RICH_STEP_SLOTS = 2;
const JOURNEY_RICH_LAST_SLOT = (JOURNEY_RICH_RECORD_COUNT - 1) * JOURNEY_RICH_STEP_SLOTS;
const JOURNEY_RICH_SUCCESSOR_LAST_SLOT = JOURNEY_RICH_RECORD_COUNT * JOURNEY_RICH_STEP_SLOTS;
// Cleanup must be able to recover a seed interrupted before the cadence was
// widened to the current 20-hour window. This is intentionally a
// cleanup-only reader compatibility rule; new seed/check/erase/verify state
// must use JOURNEY_RICH_STEP_SLOTS above.
const LEGACY_JOURNEY_RICH_LAST_SLOT = JOURNEY_RICH_RECORD_COUNT;
const JOURNEY_RICH_MINUTE_GUARD = 20 * 60;
// This synthetic journey has one explicit source-owned account track for the
// successor v1.1/v1.2 streams. The legacy v1 row remains account-unattributed
// and is retained only for transport/export coverage.
// The contribution builders intentionally derive this value from captured
// account evidence. Supplying a wire-shaped attribution directly to a source
// record is not sufficient: the reviewed projection must prove that the
// account scope and destination-bound enrollment match. Keep these synthetic
// inputs local to the fixture; none are copied into the contribution.
const JOURNEY_ACCOUNT_OBSERVATION_SECRET = Buffer.alloc(32, 85);
const JOURNEY_ACCOUNT_BINDING = Object.freeze({
  destinationOrigin: "https://community.example.test",
  enrollmentNamespace: "synthetic_enrollment_0001",
});
const JOURNEY_ACCOUNT_SCOPE = Object.freeze({
  status: "available",
  reason: null,
  version: "openai-account-v1",
  scopeId: `openai-account:v1:${Buffer.alloc(32, 82).toString("base64url")}`,
  planType: "pro",
});
const EFFECTIVE_ACCOUNT_TRACK_ID = deriveTelemetryAccountTrackIdV2({
  accountScope: JOURNEY_ACCOUNT_SCOPE,
  accountObservationSecret: JOURNEY_ACCOUNT_OBSERVATION_SECRET,
  destinationOrigin: JOURNEY_ACCOUNT_BINDING.destinationOrigin,
  enrollmentNamespace: JOURNEY_ACCOUNT_BINDING.enrollmentNamespace,
});
const execFile = promisify(execFileCallback);
const encoder = new TextEncoder();

function effectiveJourneyAttribution() {
  return {
    accountBasis: "same_source",
    accountTrackId: EFFECTIVE_ACCOUNT_TRACK_ID,
    planBasis: "same_source_occurrence",
    planType: "pro",
    planEraId: null,
  };
}

function effectiveJourneyAttributionEvidence() {
  return {
    accountBasis: "same_source",
    accountScope: JOURNEY_ACCOUNT_SCOPE,
    observationBinding: JOURNEY_ACCOUNT_BINDING,
    planBasis: "same_source_occurrence",
    planType: "pro",
  };
}

const PHASE_GROUPS = Object.freeze({
  seed: Object.freeze(new Set([
    "ready-before", "owner-controls", "workload-enroll", "workload-session",
    "pair-device", "claim-device", "v1-sync-state-before", "envelope-key",
    "v1-upload", "v1-replay", "v1-sync-state-after", "v11-consent",
    "v11-capabilities", "v11-upload-and-activation", "v12-consent", "v12-capabilities",
    "v12-upload-and-activation", "owner-scheduler", "owner-allowance-preview", "public-results",
  ])),
  check: Object.freeze(new Set([
    "workload-session", "v1-sync-state-after", "public-results",
    "owner-allowance-preview", "owner-negative-auth", "participant-export",
  ])),
  erase: Object.freeze(new Set([
    "owner-erasure", "owner-survives-erasure", "ready-after",
  ])),
  verify: Object.freeze(new Set(["restored-owner-admission"])),
  cleanup: Object.freeze(new Set(["owner-erasure", "owner-survives-erasure", "ready-after"])),
});
const SEED_PHASE_NAMES = Object.freeze([...PHASE_GROUPS.seed]);
const RESUME_SEED_PHASE_NAMES = Object.freeze(new Set([
  "owner-scheduler", "owner-allowance-preview", "public-results",
]));
const RESUME_SEED_CHECKPOINTS = Object.freeze(new Set([
  "owner-scheduler", "owner-allowance-preview", "public-results",
]));
const PHASE_STATE = Object.freeze({ seed: "seeded", check: "checked", erase: "erased", verify: "verified", cleanup: "cleaned" });
const PHASE_ORDER = Object.freeze(["seeded", "checked", "erased", "verified", "cleaned"]);
const STATE_PHASES = Object.freeze([...PHASE_ORDER, "seed-progress"]);

class JourneyError extends Error {
  constructor(code, status = undefined, details = undefined) {
    super(code);
    this.name = "JourneyError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, status = undefined, details = undefined) {
  throw new JourneyError(code, status, details);
}

function syncOutcomeDiagnostics(value, stream = "v1.1") {
  const boundedCount = (candidate) => Number.isSafeInteger(candidate)
    && candidate >= 0 && candidate <= 2_000 ? candidate : null;
  const status = value?.status === "complete" || value?.status === "failed" || value?.status === "partial"
    ? value.status : "invalid";
  const failureCode = SAFE_SYNC_FAILURE_CODES.has(value?.failure?.code)
    ? value.failure.code : null;
  const retryAfterMilliseconds = Number.isSafeInteger(value?.failure?.retryAfterMilliseconds)
    && value.failure.retryAfterMilliseconds >= 0
    && value.failure.retryAfterMilliseconds <= MAX_SYNC_RETRY_DELAY_MS
    ? value.failure.retryAfterMilliseconds : null;
  return Object.freeze({
    stream: stream === "v1.2" ? "v1.2" : "v1.1",
    status,
    chunksUploaded: boundedCount(value?.chunksUploaded),
    chunksSkipped: boundedCount(value?.chunksSkipped),
    stagedDays: boundedCount(value?.stagedDays),
    failureCode,
    retryAfterMilliseconds,
    networkActivity: value?.networkActivity === true,
  });
}

/**
 * Retry one foreground pass after a provider admission/service response.
 * The sync client already parses and bounds Retry-After; this wrapper adds a
 * qualification-level cap and a conservative one-minute fallback for hosts
 * that omit the header.  No authorization, consent, or revision failure is
 * retried, and a provider delay above the host's one-minute bucket is surfaced
 * unchanged instead of being shortened.
 */
async function runSyncWithBoundedRetry(sync, options) {
  let outcome;
  for (let attempt = 0; attempt < MAX_SYNC_RETRY_ATTEMPTS; attempt += 1) {
    outcome = await sync(options);
    const failure = outcome?.failure;
    if (outcome?.status === "complete"
        || failure?.retryable !== true
        || !RETRYABLE_SYNC_FAILURE_CODES.has(failure.code)) return outcome;
    const requestedDelay = failure.retryAfterMilliseconds;
    if (requestedDelay !== null && requestedDelay !== undefined
        && (!Number.isSafeInteger(requestedDelay) || requestedDelay < 0
          || requestedDelay > MAX_SYNC_RETRY_DELAY_MS)) return outcome;
    if (attempt + 1 >= MAX_SYNC_RETRY_ATTEMPTS) return outcome;
    const delay = requestedDelay ?? DEFAULT_SYNC_RETRY_DELAY_MS;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
  return outcome;
}

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) fail(`${name}_MISSING`);
  return value;
}

function optional(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function booleanEnv(name, fallback) {
  const value = optional(name);
  if (value === undefined) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  fail(`${name}_INVALID`);
}

function integerEnv(name, fallback, minimum, maximum) {
  const raw = optional(name, String(fallback));
  if (!/^\d+$/u.test(raw)) fail(`${name}_INVALID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name}_INVALID`);
  }
  return value;
}

function parseCommandLine(argv = process.argv.slice(2)) {
  const values = {
    phase: optional("JOURNEY_PHASE", "all"),
    stateDir: optional("JOURNEY_STATE_DIR"),
    fixtureFile: optional("ADMIN_OWNER_FIXTURE_FILE"),
    idTokenFile: optional("JOURNEY_ID_TOKEN_FILE"),
    gcloudIamToken: booleanEnv("JOURNEY_GCLOUD_IAM_TOKEN", false),
    help: false,
  };
  const withValue = new Set(["--phase", "--state-dir", "--fixture-file", "--id-token-file"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    if (argument === "--gcloud-iam-token") {
      values.gcloudIamToken = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (!withValue.has(name)) fail("JOURNEY_ARGUMENT_INVALID");
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail("JOURNEY_ARGUMENT_INVALID");
    }
    if (name === "--phase") values.phase = value;
    else if (name === "--state-dir") values.stateDir = value;
    else if (name === "--fixture-file") values.fixtureFile = value;
    else values.idTokenFile = value;
  }
  if (values.help) return Object.freeze(values);
  if (!["all", ...Object.keys(PHASE_GROUPS), "resume-seed"].includes(values.phase)) {
    fail("JOURNEY_PHASE_INVALID");
  }
  if (values.stateDir !== undefined && values.stateDir.length > 4_096) {
    fail("JOURNEY_STATE_DIR_INVALID");
  }
  return Object.freeze(values);
}

function journeyUsage() {
  return [
    "Usage: node scripts/gcp-cloud-run-journey.mjs [--phase all|seed|resume-seed|check|erase|verify|cleanup] [--state-dir DIR]",
    "       [--fixture-file FILE] [--id-token-file FILE] [--gcloud-iam-token]",
    "Phased runs require a 0700 state directory and preserve only synthetic journey state.",
  ].join("\n");
}

async function secureRegularFile(path, code, maximumBytes) {
  const absolute = resolve(path);
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    fail(code);
  }
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600 || stats.nlink !== 1
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || stats.size > maximumBytes) {
    fail(code);
  }
  try {
    return await readFile(absolute, "utf8");
  } catch {
    fail(code);
  }
}

async function secureStateDirectory(path) {
  const absolute = resolve(path);
  try {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
  } catch {
    fail("JOURNEY_STATE_DIR_INVALID");
  }
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    fail("JOURNEY_STATE_DIR_INVALID");
  }
  if (!stats.isDirectory() || (stats.mode & 0o777) !== 0o700
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
    fail("JOURNEY_STATE_DIR_PERMISSIONS");
  }
  return absolute;
}

function statePath(stateDir) {
  return join(stateDir, "journey-state-v1.json");
}

async function readJourneyState(stateDir, { allowLegacyPartialCleanup = false } = {}) {
  const path = statePath(stateDir);
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    fail("JOURNEY_STATE_MISSING");
  }
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600 || stats.nlink !== 1
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || stats.size > MAX_STATE_BYTES) {
    fail("JOURNEY_STATE_INVALID");
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("JOURNEY_STATE_INVALID");
  }
  const legacyPartialCleanup = allowLegacyPartialCleanup
    && validLegacyPartialCleanupState(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== STATE_SCHEMA
      || !STATE_PHASES.includes(value.phase)
      || typeof value.baseOrigin !== "string"
      || (!validSeedFixture(value.seedFixture) && !legacyPartialCleanup)
      || (value.phase === "seed-progress"
        && (typeof value.progress !== "string" || !SEED_PHASE_NAMES.includes(value.progress)))
      || (value.workload !== null && (typeof value.workload !== "object" || Array.isArray(value.workload)))
      || (value.device !== null && (typeof value.device !== "object" || Array.isArray(value.device)))
      || (value.deviceV12 !== null && (typeof value.deviceV12 !== "object" || Array.isArray(value.deviceV12)))
      || (value.ownerCreatedAt !== null && (typeof value.ownerCreatedAt !== "string" || !validJourneyInstant(value.ownerCreatedAt)))
      || (value.v1 !== null && (typeof value.v1 !== "object" || Array.isArray(value.v1)))
      || (value.v11 !== null && (typeof value.v11 !== "object" || Array.isArray(value.v11)
        || !Array.isArray(value.v11.chunks) || !Array.isArray(value.v11.receipts)
        || value.v11.sync === null || typeof value.v11.sync !== "object" || Array.isArray(value.v11.sync)))
      || (value.v12 !== null && (typeof value.v12 !== "object" || Array.isArray(value.v12)
        || !Array.isArray(value.v12.chunks) || !Array.isArray(value.v12.receipts)
        || value.v12.fixture === null || typeof value.v12.fixture !== "object" || Array.isArray(value.v12.fixture)
        || value.v12.first === null || typeof value.v12.first !== "object" || Array.isArray(value.v12.first)
        || value.v12.replay === null || typeof value.v12.replay !== "object" || Array.isArray(value.v12.replay)))
      || (value.erasureAt !== null && (typeof value.erasureAt !== "string" || !validJourneyInstant(value.erasureAt)))
      || (value.uploadAuthorization !== null && value.uploadAuthorization !== undefined
        && (typeof value.uploadAuthorization !== "object" || Array.isArray(value.uploadAuthorization)))) {
    fail("JOURNEY_STATE_INVALID");
  }
  if (value.phase !== "seed-progress"
      && (value.workload === null || value.device === null || value.deviceV12 === null
        || value.ownerCreatedAt === null
        || value.v1 === null || value.v11 === null || value.v12 === null)) {
    fail("JOURNEY_STATE_INVALID");
  }
  if (value.phase !== "seed-progress"
      && (!validJourneyInstant(value.workload.expiresAt)
        || !validJourneyInstant(value.device.expiresAt)
        || !validJourneyInstant(value.deviceV12.expiresAt))) {
    fail("JOURNEY_STATE_INVALID");
  }
  return value;
}

async function writeJourneyState(stateDir, value) {
  const raw = JSON.stringify(value);
  if (raw.length > MAX_STATE_BYTES) fail("JOURNEY_STATE_TOO_LARGE");
  const path = statePath(stateDir);
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || (!existing.isFile()) || existing.nlink !== 1
        || (existing.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && existing.uid !== process.getuid())) {
      fail("JOURNEY_STATE_INVALID");
    }
  } catch (error) {
    if (error instanceof JourneyError) throw error;
    // ENOENT is the expected first write. Other errors are closed below.
    if (error?.code !== "ENOENT") fail("JOURNEY_STATE_INVALID");
  }
  const temporary = join(stateDir, `.journey-state-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(raw, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(stateDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    try { await handle?.close(); } catch { /* preserve the closed error */ }
    try { await unlink(temporary); } catch { /* preserve the closed error */ }
    fail("JOURNEY_STATE_WRITE_FAILED");
  }
}

function journeyStateSnapshot({ phase, progress = undefined, baseOrigin, seedFixture, ownerCreatedAt = null, workload, device, deviceV12, v1, v11, v12, erasureAt = null, uploadAuthorization = null }) {
  return {
    schemaVersion: STATE_SCHEMA,
    phase,
    ...(progress === undefined ? {} : { progress }),
    baseOrigin,
    seedFixture: {
      capturedAt: seedFixture.capturedAt,
      day: seedFixture.day,
      baseSlot: seedFixture.baseSlot,
    },
    ownerCreatedAt,
    updatedAt: new Date().toISOString(),
    workload: workload === null ? null : {
      participantId: workload.participantId,
      cookie: workload.cookie,
      csrfToken: workload.csrfToken,
      ...(workload.participantCreatedAt === undefined ? {} : { participantCreatedAt: workload.participantCreatedAt }),
      ...(workload.expiresAt === undefined ? {} : { expiresAt: workload.expiresAt }),
      ...(workload.consentVersion === undefined ? {} : { consentVersion: workload.consentVersion }),
    },
    device: device === null ? null : {
      id: device.id,
      secret: device.secret,
      pairingCode: device.pairingCode,
      authorization: device.authorization,
      ...(device.expiresAt === undefined ? {} : { expiresAt: device.expiresAt }),
    },
    deviceV12: deviceV12 === null ? null : {
      id: deviceV12.id,
      secret: deviceV12.secret,
      pairingCode: deviceV12.pairingCode,
      authorization: deviceV12.authorization,
      ...(deviceV12.expiresAt === undefined ? {} : { expiresAt: deviceV12.expiresAt }),
    },
    v1: v1 === null ? null : {
      day: v1.day,
      chunk: v1.chunk,
      raw: v1.raw,
      first: v1.first,
    },
    v11: v11 === null ? null : {
      chunks: v11.chunks,
      receipts: v11.receipts,
      sync: v11.sync,
    },
    v12: v12 === null ? null : {
      fixture: v12.fixture,
      chunks: v12.chunks,
      receipts: v12.receipts,
      raw: v12.raw,
      first: v12.first,
      replay: v12.replay,
      // The resume gate needs the completed fresh/resume/same-day/additive
      // evidence from the durable journal.  Keep this alongside the v11 sync
      // summary; omitting it makes a successfully uploaded v1.2 phase look
      // incomplete after a process restart.
      sync: v12.sync,
    },
    erasureAt,
    uploadAuthorization: uploadAuthorization === null ? null : {
      token: uploadAuthorization.token,
      schemaVersion: uploadAuthorization.schemaVersion,
      envelopeDigest: uploadAuthorization.envelopeDigest,
    },
  };
}

function origin(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { fail(`${name}_INVALID`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") fail(`${name}_INVALID`);
  if (parsed.username || parsed.password || parsed.pathname !== "/"
      || parsed.search || parsed.hash) fail(`${name}_INVALID`);
  return parsed.origin;
}

function field(value, name, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${name}_INVALID`);
  return value;
}

function instant(value, name) {
  const raw = field(value, name, /^\d{4}-\d{2}-\d{2}T[^\s]+Z$/u);
  const epoch = Date.parse(raw);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== raw) fail(`${name}_INVALID`);
  return { raw, epoch };
}

function validJourneyInstant(value) {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function copyNullableRecord(value) {
  return value === null ? null : Object.freeze({ ...value });
}

function parseFixture(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 16_384) {
    fail("ADMIN_OWNER_FIXTURE_JSON_INVALID");
  }
  let value;
  try { value = JSON.parse(raw); } catch { fail("ADMIN_OWNER_FIXTURE_JSON_INVALID"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== FIXTURE_SCHEMA) {
    fail("ADMIN_OWNER_FIXTURE_JSON_INVALID");
  }
  const issuedAt = instant(value.issuedAt, "issuedAt");
  const expiresAt = instant(value.expiresAt, "expiresAt");
  if (expiresAt.epoch <= issuedAt.epoch
      || expiresAt.epoch - issuedAt.epoch !== OWNER_SESSION_TTL_MILLISECONDS
      || expiresAt.epoch <= Date.now()) {
    fail("SESSION_EXPIRY_INVALID");
  }
  return Object.freeze({
    schemaVersion: FIXTURE_SCHEMA,
    ownerLabel: value.ownerLabel === undefined
      ? "synthetic-admin"
      : field(value.ownerLabel, "ownerLabel", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    participantId: field(value.participantId, "participantId", PARTICIPANT_ID),
    identityLinkKey: field(value.identityLinkKey, "identityLinkKey", HEX64),
    ownerDigest: field(value.ownerDigest, "ownerDigest", HEX64),
    attributionNamespace: field(value.attributionNamespace, "attributionNamespace", HEX64),
    accessTokenId: field(value.accessTokenId, "accessTokenId", TOKEN_ID),
    accessTokenSecret: field(value.accessTokenSecret, "accessTokenSecret", SECRET),
    recoveryTokenId: field(value.recoveryTokenId, "recoveryTokenId", TOKEN_ID),
    recoveryTokenSecret: field(value.recoveryTokenSecret, "recoveryTokenSecret", SECRET),
    sessionId: field(value.sessionId, "sessionId", UUID),
    sessionSecret: field(value.sessionSecret, "sessionSecret", SECRET),
    issuedAt: issuedAt.raw,
    expiresAt: expiresAt.raw,
    consentVersion: field(value.consentVersion, "consentVersion", VERSION),
  });
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function hashCapability(capability, id, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/${capability}/v1\0${id}\0${secret}`)
    .digest();
}

function ownerSession(fixture) {
  const csrfToken = `um_csrf_${base64Url(hashCapability("csrf", fixture.sessionId, fixture.sessionSecret))}`;
  return Object.freeze({
    participantId: fixture.participantId,
    cookie: `__Host-usage_monitor_session=um_session_${fixture.sessionId}.${fixture.sessionSecret}`,
    csrfToken,
  });
}

function deviceHash(id, secret) {
  const decoded = Buffer.from(secret, "base64url");
  if (decoded.byteLength !== 32 || base64Url(decoded) !== secret) fail("DEVICE_SECRET_INVALID");
  return createHash("sha256")
    .update(Buffer.concat([
      Buffer.from(`app-usagemonitor/device/v1\0${id}\0`, "utf8"),
      decoded,
    ]))
    .digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const scalar = JSON.stringify(value);
    if (scalar === undefined) fail("CANONICAL_JSON_INVALID");
    return scalar;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readBounded(response) {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail("RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

function responseCode(result) {
  const bodyCode = result.body?.error?.code;
  return typeof bodyCode === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(bodyCode)
    ? bodyCode : `HTTP_${result.status}`;
}

function expectStatus(result, expected, code = "HTTP_STATUS_UNEXPECTED") {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(result.status)) fail(code, result.status);
  return result;
}

function collectionControlsAlreadyEnabled(healthBody) {
  const controls = healthBody?.collectionControls;
  return healthBody?.status === "ok"
    && healthBody?.provider === "postgres"
    && controls?.state === "operational"
    && controls.enrollment === true
    && controls.uploadRegistration === true
    && controls.processing === true
    && controls.publication === true;
}

function expectExactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
  return value;
}

function expectCapabilityRefusal(result, code) {
  expectStatus(result, [401, 403, 404], code);
  const body = result.body;
  if (body !== null && typeof body === "object" && !Array.isArray(body)
      && typeof body.schemaVersion === "string"
      && body.schemaVersion.startsWith("device-sync-capabilities-")) {
    fail(code, result.status);
  }
  return result;
}

function expectPostgresReady(result, code = "POSTGRES_READY_INVALID") {
  expectStatus(result, 200, code);
  const body = expectObject(result.body, `${code}_BODY`);
  expectExactKeys(body, ["status", "provider", "checks"], `${code}_SCHEMA`);
  const checks = expectExactKeys(
    expectObject(body.checks, `${code}_BODY`),
    ["schema", "primary", "independentLedger"],
    `${code}_CHECKS_SCHEMA`,
  );
  if (body.status !== "ready"
      || body.provider !== "postgres"
      || checks.schema !== "compatible"
      || checks.primary !== "reachable"
      || checks.independentLedger !== "reconciled") {
    fail(`${code}_BODY`, result.status);
  }
  return body;
}

function expectPostgresHealth(result, code = "POSTGRES_HEALTH_INVALID") {
  expectStatus(result, 200, code);
  const body = expectObject(result.body, `${code}_BODY`);
  const checks = expectExactKeys(
    expectObject(body.checks, `${code}_BODY`),
    [
      "database", "deletionLedger", "encryptedObjectStore", "lifecycle",
      "schema", "independentLedger", "quarantineRetentionComplete", "restoreReplayComplete",
    ],
    `${code}_CHECKS_SCHEMA`,
  );
  if (body.status !== "ok"
      || body.provider !== "postgres"
      || checks.database !== "ok"
      || checks.deletionLedger !== "ok"
      || checks.encryptedObjectStore !== "reachable"
      || checks.lifecycle !== "completed"
      || checks.schema !== "compatible"
      || checks.independentLedger !== "reconciled"
      || checks.quarantineRetentionComplete !== true
      || checks.restoreReplayComplete !== true) {
    fail(`${code}_BODY`, result.status);
  }
  return body;
}

function expectObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function expectDigest(value, code) {
  if (typeof value !== "string" || !HEX64.test(value)) fail(code);
  return value;
}

function expectRecordCounts(value, code, expected = 1) {
  const counts = expectObject(value, code);
  const declared = counts.declared;
  const accepted = counts.accepted;
  if (!Number.isSafeInteger(expected) || expected < 1
      || !Number.isSafeInteger(declared) || declared !== expected
      || !Number.isSafeInteger(accepted) || accepted !== expected) fail(code);
  return counts;
}

function expectSession(response, expected, code, { futureAt = undefined } = {}) {
  const body = expectObject(response.body, code);
  if (typeof body.participantId !== "string"
      || body.participantId !== expected?.participantId
      || !validJourneyInstant(body.createdAt)
      || !validJourneyInstant(body.expiresAt)
      || typeof body.consentVersion !== "string") {
    fail(code, response.status);
  }
  if (expected?.participantCreatedAt !== undefined && body.createdAt !== expected.participantCreatedAt) {
    fail(code, response.status);
  }
  if (expected?.expiresAt !== undefined && body.expiresAt !== expected.expiresAt) {
    fail(code, response.status);
  }
  if (expected?.consentVersion !== undefined && body.consentVersion !== expected.consentVersion) {
    fail(code, response.status);
  }
  if (futureAt !== undefined && Date.parse(body.expiresAt) <= futureAt) {
    fail(`${code}_NATURALLY_EXPIRED`, response.status);
  }
  return body;
}

function schedulerResultComplete(result) {
  return result.code === "ANALYTICS_REBUILD_PUBLISHED"
    && result.aggregateRebuildComplete === true
    && result.aggregateRebuildDelegated !== true
    && result.publicationEnabled === true;
}

function expectSchedulerResult(response, { allowIncomplete = false } = {}) {
  const body = expectObject(response.body, "OWNER_SCHEDULER_RESPONSE_INVALID");
  if (body.schemaVersion !== "admin-action-v0.1" || body.action !== "run_maintenance") {
    fail("OWNER_SCHEDULER_RESPONSE_INVALID", response.status);
  }
  const result = expectObject(body.result, "OWNER_SCHEDULER_RESPONSE_INVALID");
  if (typeof result.code !== "string"
      || typeof result.aggregateRebuildComplete !== "boolean"
      || (result.aggregateRebuildDelegated !== undefined
        && typeof result.aggregateRebuildDelegated !== "boolean")
      || (result.publicationEnabled !== true && result.publicationEnabled !== false
        && result.publicationEnabled !== null)) {
    fail("OWNER_SCHEDULER_INCOMPLETE", response.status);
  }
  // A delegated/deferred analytics pass is not a completed journey. The
  // aggregate bit is the public gate, while this optional witness keeps a
  // provider that exposes the bounded scheduler status from qualifying a
  // result that was only handed off for a later invocation. Incomplete
  // responses are admitted only to the bounded retry loop below.
  if (!allowIncomplete && !schedulerResultComplete(result)) {
    fail("OWNER_SCHEDULER_INCOMPLETE", response.status);
  }
  return result;
}

function expectEmptySchedulerResult(response, code = "OWNER_EMPTY_SCHEDULER_INVALID") {
  expectStatus(response, 200, code);
  const body = expectObject(response.body, `${code}_BODY`);
  const result = expectObject(body.result, `${code}_BODY`);
  if (body.schemaVersion !== "admin-action-v0.1"
      || body.action !== "run_maintenance"
      || result.code !== "ANALYTICS_REBUILD_EMPTY"
      || result.aggregateRebuildComplete !== true
      || result.aggregateRebuildDelegated !== false
      || result.publicationEnabled !== true
      || result.lifecycleComplete !== true
      || result.quarantineRetentionComplete !== true
      || result.restoreReplayComplete !== true
      || result.quarantineReconciliationComplete !== true) {
    fail(`${code}_BODY`, response.status);
  }
  return result;
}

function progressTimestamp(value, code) {
  if (value !== null && !validJourneyInstant(value)) fail(code);
  return value;
}

// The endpoint is an owner-only, content-free checkpoint census. Validate the
// full available shape before using it as a retry witness; a missing or
// malformed census must fail closed instead of turning repeated maintenance
// calls into an unbounded best-effort loop.
function expectReconstructionProgress(response) {
  const body = expectObject(response.body, "OWNER_SCHEDULER_PROGRESS_INVALID");
  if (body.schemaVersion !== "admin-reconstruction-progress-v0.1"
      || !validJourneyInstant(body.observedAt)
      || !["resumable", "synchronous", "paused", "unknown"].includes(body.mode)
      || (body.status !== "available" && body.status !== "unavailable")) {
    fail("OWNER_SCHEDULER_PROGRESS_INVALID", response.status);
  }
  if (body.status === "unavailable") {
    return Object.freeze({ status: "unavailable" });
  }
  const lookup = expectObject(body.lookup, "OWNER_SCHEDULER_PROGRESS_INVALID");
  const calculations = expectObject(body.calculations, "OWNER_SCHEDULER_PROGRESS_INVALID");
  const maintenance = expectObject(body.maintenance, "OWNER_SCHEDULER_PROGRESS_INVALID");
  const publication = expectObject(body.publication, "OWNER_SCHEDULER_PROGRESS_INVALID");
  if (typeof lookup.complete !== "boolean"
      || !Number.isSafeInteger(lookup.lastRecordId) || lookup.lastRecordId < 0
      || !Number.isSafeInteger(lookup.throughRecordId) || lookup.throughRecordId < 0
      || lookup.lastRecordId > lookup.throughRecordId
      || !Number.isSafeInteger(calculations.trackedAccounts) || calculations.trackedAccounts < 0
      || !Number.isSafeInteger(calculations.completedAccounts) || calculations.completedAccounts < 0
      || !Number.isSafeInteger(calculations.preparingAccounts) || calculations.preparingAccounts < 0
      || !Number.isSafeInteger(calculations.scanningAccounts) || calculations.scanningAccounts < 0
      || !Number.isSafeInteger(calculations.finalizingAccounts) || calculations.finalizingAccounts < 0
      || !Number.isSafeInteger(calculations.sourceChangedAccounts) || calculations.sourceChangedAccounts < 0
      || !Number.isSafeInteger(calculations.checkpointsWritten) || calculations.checkpointsWritten < 0
      || typeof calculations.bounded !== "boolean"
      || typeof maintenance.running !== "boolean"
      || !["ready", "updating", "unknown"].includes(publication.state)
      || !Number.isSafeInteger(publication.pendingDays) || publication.pendingDays < 0
      || typeof publication.pendingDaysBounded !== "boolean"
      || !Number.isSafeInteger(publication.publishedDays) || publication.publishedDays < 0
      || !Number.isSafeInteger(publication.pricedDays) || publication.pricedDays < 0) {
    fail("OWNER_SCHEDULER_PROGRESS_INVALID", response.status);
  }
  progressTimestamp(calculations.newestResultAt, "OWNER_SCHEDULER_PROGRESS_INVALID");
  progressTimestamp(maintenance.lastRunAt, "OWNER_SCHEDULER_PROGRESS_INVALID");
  progressTimestamp(maintenance.leaseExpiresAt, "OWNER_SCHEDULER_PROGRESS_INVALID");
  progressTimestamp(publication.latestPublishedAt, "OWNER_SCHEDULER_PROGRESS_INVALID");
  return Object.freeze({
    status: "available",
    lookup: Object.freeze({
      complete: lookup.complete,
      lastRecordId: lookup.lastRecordId,
      throughRecordId: lookup.throughRecordId,
    }),
    calculations: Object.freeze({
      trackedAccounts: calculations.trackedAccounts,
      completedAccounts: calculations.completedAccounts,
      preparingAccounts: calculations.preparingAccounts,
      scanningAccounts: calculations.scanningAccounts,
      finalizingAccounts: calculations.finalizingAccounts,
      sourceChangedAccounts: calculations.sourceChangedAccounts,
      checkpointsWritten: calculations.checkpointsWritten,
      bounded: calculations.bounded,
      newestResultAt: calculations.newestResultAt,
    }),
    maintenance: Object.freeze({
      running: maintenance.running,
      lastRunAt: maintenance.lastRunAt,
    }),
    publication: Object.freeze({
      state: publication.state,
      pendingDays: publication.pendingDays,
      pendingDaysBounded: publication.pendingDaysBounded,
      publishedDays: publication.publishedDays,
      pricedDays: publication.pricedDays,
      latestPublishedAt: publication.latestPublishedAt,
    }),
  });
}

function reconstructionProgressKey(progress) {
  return canonicalJson(progress);
}

async function runMaintenanceUntilPublished(caller, owner, {
  maxAttempts = MAX_MAINTENANCE_ATTEMPTS,
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1
      || maxAttempts > ANALYTICS_HISTORY_WINDOW_DAYS) {
    fail("OWNER_SCHEDULER_ATTEMPTS_INVALID");
  }
  const attempts = [];
  let previousProgressKey = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await caller("/api/v1/admin/action", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { action: "run_maintenance" },
    });
    expectStatus(response, 200, "OWNER_SCHEDULER_FAILED");
    const result = expectSchedulerResult(response, { allowIncomplete: true });
    attempts.push({
      attempt,
      code: result.code,
      aggregateRebuildComplete: result.aggregateRebuildComplete,
      aggregateRebuildDelegated: result.aggregateRebuildDelegated ?? false,
    });
    if (schedulerResultComplete(result)) {
      return { status: response.status, metadata: { attempts } };
    }
    if (result.publicationEnabled !== true
        || !RETRYABLE_MAINTENANCE_CODES.has(result.code)) {
      fail("OWNER_SCHEDULER_INCOMPLETE", response.status);
    }
    const progressResponse = await caller("/api/v1/admin/reconstruction-progress", {
      cookie: owner.cookie,
    });
    expectStatus(progressResponse, 200, "OWNER_SCHEDULER_PROGRESS_FAILED");
    const progress = expectReconstructionProgress(progressResponse);
    if (progress.status !== "available") {
      fail("OWNER_SCHEDULER_PROGRESS_UNAVAILABLE", progressResponse.status);
    }
    const progressKey = reconstructionProgressKey(progress);
    const attemptMetadata = attempts.at(-1);
    attemptMetadata.progress = progress;
    if (previousProgressKey !== null && previousProgressKey === progressKey) {
      fail("OWNER_SCHEDULER_NO_PROGRESS", progressResponse.status);
    }
    previousProgressKey = progressKey;
  }
  fail("OWNER_SCHEDULER_HISTORY_INCOMPLETE");
}

function expectAllowancePreview(response, targetDay) {
  const body = expectObject(response.body, "OWNER_ALLOWANCE_PREVIEW_RESPONSE_INVALID");
  const models = expectObject(body.models, "OWNER_ALLOWANCE_PREVIEW_RESPONSE_INVALID");
  if (body.schemaVersion !== "admin-community-allowance-preview-v0.3"
      || models.basis !== "seven_day_codex_pro20x_equivalent_per_model_composition"
      || models.gate !== "shared_composition_kernel_identification"
      || !Array.isArray(models.days)
      || !Array.isArray(body.days)
      || !DAY.test(body.from ?? "") || !DAY.test(body.to ?? "")
      || !validJourneyInstant(body.generatedAt)
      || body.generatedAt.slice(0, 10) !== body.to
      || !Number.isFinite(Date.parse(`${body.from}T00:00:00.000Z`))
      || !Number.isFinite(Date.parse(`${body.to}T00:00:00.000Z`))
      || Date.parse(`${body.from}T00:00:00.000Z`) > Date.parse(`${body.to}T00:00:00.000Z`)
      || Date.parse(`${body.to}T00:00:00.000Z`) < Date.parse(`${targetDay}T00:00:00.000Z`)) {
    fail("OWNER_ALLOWANCE_PREVIEW_RESPONSE_INVALID", response.status);
  }
  const populated = models.days.filter((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)
        || !DAY.test(candidate.day) || !Array.isArray(candidate.values)
        || candidate.values.length === 0) return false;
    if (typeof candidate.catalogVersion !== "string" || candidate.catalogVersion.length === 0
        || !Number.isSafeInteger(candidate.fittedParticipantCount)
        || candidate.fittedParticipantCount < 1
        || !Number.isSafeInteger(candidate.unstableParticipantCount)
        || candidate.unstableParticipantCount < 0
        || !Number.isSafeInteger(candidate.staleParticipantCount)
        || candidate.staleParticipantCount < 0
        || !Number.isSafeInteger(candidate.refusedParticipantCount)
        || candidate.refusedParticipantCount < 0
        || !Number.isSafeInteger(candidate.v1ParticipantCount)
        || candidate.v1ParticipantCount < candidate.fittedParticipantCount
        || candidate.fittedParticipantCount + candidate.unstableParticipantCount
          + candidate.staleParticipantCount + candidate.refusedParticipantCount
          !== candidate.v1ParticipantCount
        || !Number.isSafeInteger(candidate.unsupportedSourceParticipantCount)
        || candidate.unsupportedSourceParticipantCount < 0) return false;
    // The first two seeded days are warmup history and may be explicit
    // no-fit rows. A structurally valid terminal/no-fit row is still
    // insufficient evidence for the allowance calculation qualification.
    return candidate.values.every((value) => Array.isArray(value)
      && value.length === 3
      && typeof value[0] === "string" && value[0].length > 0
      && typeof value[1] === "number" && Number.isFinite(value[1]) && value[1] > 0
      && Number.isSafeInteger(value[2]) && value[2] > 0
      && value[2] <= candidate.fittedParticipantCount);
  });
  // The final three seeded days have enough history for a positive model fit.
  // The two earlier seeded days remain warmup evidence. A provider may also
  // publish a current-day model row after the seeded window, so apply the
  // warmup exclusion only inside the five-day fixture window.
  const expectedDays = journeyPositiveFitDays(targetDay);
  const seededDays = new Set(journeyHistoryDays(targetDay));
  if (populated.length === 0) fail("OWNER_ALLOWANCE_MODEL_EMPTY", response.status);
  const byDay = new Map(populated.map((candidate) => [candidate.day, candidate]));
  const expectedDaySet = new Set(expectedDays);
  if (populated.some((candidate) => seededDays.has(candidate.day)
      && !expectedDaySet.has(candidate.day))) {
    fail("OWNER_ALLOWANCE_WARMUP_MODEL_FIT_UNEXPECTED", response.status);
  }
  for (const day of expectedDays) {
    const candidate = byDay.get(day);
    if (candidate === undefined) fail("OWNER_ALLOWANCE_HISTORICAL_MODEL_MISSING", response.status);
  }
  const coverage = expectObject(body.coverage, "OWNER_ALLOWANCE_PREVIEW_RESPONSE_INVALID");
  const coverageKeys = [
    "uploadingParticipantCount",
    "cachedParticipantCount",
    "recentFittedParticipantCount",
    "mergeEligibleParticipantCount",
    "noQualifyingFitParticipantCount",
    "noRecentFitParticipantCount",
    "unsupportedPlanParticipantCount",
  ];
  if (Object.keys(coverage).some((key) => !coverageKeys.includes(key))
      || coverageKeys.some((key) => !Number.isSafeInteger(coverage[key]) || coverage[key] < 0)
      || coverage.recentFittedParticipantCount < 1
      || coverage.mergeEligibleParticipantCount < 1) {
    fail("OWNER_ALLOWANCE_SCALAR_FIT_UNAVAILABLE", response.status);
  }
  const positiveSummary = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)
        || !Number.isSafeInteger(value.fitCount) || value.fitCount < 1
        || !Number.isSafeInteger(value.participantCount) || value.participantCount < 1
        || value.participantCount > value.fitCount
        || typeof value.centralUsd !== "number" || !Number.isFinite(value.centralUsd)
        || value.centralUsd <= 0) return false;
    if (value.band80Usd === null) return true;
    return value.band80Usd !== null
      && typeof value.band80Usd === "object"
      && !Array.isArray(value.band80Usd)
      && typeof value.band80Usd.lowerUsd === "number"
      && Number.isFinite(value.band80Usd.lowerUsd)
      && value.band80Usd.lowerUsd > 0
      && typeof value.band80Usd.upperUsd === "number"
      && Number.isFinite(value.band80Usd.upperUsd)
      && value.band80Usd.upperUsd >= value.band80Usd.lowerUsd
      && value.band80Usd.lowerUsd <= value.centralUsd
      && value.centralUsd <= value.band80Usd.upperUsd;
  };
  const positiveScalarDays = [];
  for (const candidate of body.days) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    if (!DAY.test(candidate.day)) {
      fail("OWNER_ALLOWANCE_PREVIEW_RESPONSE_INVALID", response.status);
    }
    const byPlanType = candidate.byPlanType;
    const planSummaries = byPlanType !== null
      && typeof byPlanType === "object" && !Array.isArray(byPlanType)
      ? Object.entries(byPlanType) : [];
    const planPositive = planSummaries.filter(([, summary]) => positiveSummary(summary));
    const combinedPositive = positiveSummary(candidate.combined);
    if (planPositive.length > 0 || combinedPositive) {
      const proPositive = positiveSummary(byPlanType?.pro);
      if (!combinedPositive || !proPositive || planPositive.some(([plan]) => plan !== "pro")) {
        fail("OWNER_ALLOWANCE_SCALAR_FIT_UNAVAILABLE", response.status);
      }
      positiveScalarDays.push(candidate.day);
    }
  }
  const positiveDaySet = new Set(positiveScalarDays);
  const sortedPositiveDays = [...positiveScalarDays].sort();
  for (let index = 1; index < sortedPositiveDays.length; index += 1) {
    if (Date.parse(`${sortedPositiveDays[index]}T00:00:00.000Z`)
        - Date.parse(`${sortedPositiveDays[index - 1]}T00:00:00.000Z`) !== 86_400_000) {
      fail("OWNER_ALLOWANCE_SCALAR_FIT_UNAVAILABLE", response.status);
    }
  }
  if (sortedPositiveDays.at(-1) !== body.to
      || !positiveDaySet.has(targetDay)
      || !positiveDaySet.has(body.to)
      || !sortedPositiveDays.some((day) => day !== body.to)) {
    // The selected fit's lastObservedAt is intentionally private. These
    // checks prove its public projection instead: the seeded target day and
    // the current preview day are positive, with a contiguous eligible
    // historical suffix and no inferred values for missing days.
    fail("OWNER_ALLOWANCE_SCALAR_FIT_UNAVAILABLE", response.status);
  }
  const previewFromMs = Date.parse(`${body.from}T00:00:00.000Z`);
  const previewToMs = Date.parse(`${body.to}T00:00:00.000Z`);
  if (sortedPositiveDays.some((day) => {
    const at = Date.parse(`${day}T00:00:00.000Z`);
    return at < previewFromMs || at > previewToMs;
  })) {
    fail("OWNER_ALLOWANCE_SCALAR_FIT_UNAVAILABLE", response.status);
  }
  return {
    modelDays: populated.length,
    modelValues: populated.reduce((total, candidate) => total + candidate.values.length, 0),
    expectedDays,
    scalarDays: positiveScalarDays.length,
    scalarPositiveDays: Object.freeze(sortedPositiveDays),
    targetDayModelValues: byDay.get(targetDay)?.values.length ?? 0,
  };
}

function expectErasedAllowancePreview(response, targetDay, cacheProof = undefined) {
  if (response.status === 503) {
    const body = expectObject(response.body, "OWNER_ERASURE_ALLOWANCE_RESPONSE_INVALID");
    const error = expectObject(body.error, "OWNER_ERASURE_ALLOWANCE_RESPONSE_INVALID");
    if (error.code === "ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE") {
      fail("OWNER_ERASURE_ALLOWANCE_STORAGE_UNAVAILABLE", response.status);
    }
    if (error.code !== "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE"
        || cacheProof?.backendHealthy !== true
        || cacheProof.cacheAbsent !== true
        || cacheProof.cohortEmpty !== true
        || cacheProof.progressComplete !== true
        || cacheProof.emptyMaintenance !== true) {
      fail("OWNER_ERASURE_ALLOWANCE_CACHE_PROOF_MISSING", response.status);
    }
    if (typeof error.code !== "string") {
      fail("OWNER_ERASURE_ALLOWANCE_RESPONSE_INVALID", response.status);
    }
    return {
      status: "unavailable",
      code: error.code,
      suppression: "empty_cohort_cache_absent",
    };
  }
  expectStatus(response, 200, "OWNER_ERASURE_ALLOWANCE_FAILED");
  const body = expectObject(response.body, "OWNER_ERASURE_ALLOWANCE_RESPONSE_INVALID");
  const models = expectObject(body.models, "OWNER_ERASURE_ALLOWANCE_RESPONSE_INVALID");
  if (body.schemaVersion !== "admin-community-allowance-preview-v0.3"
      || models.basis !== "seven_day_codex_pro20x_equivalent_per_model_composition"
      || models.gate !== "shared_composition_kernel_identification"
      || !Array.isArray(models.days) || !Array.isArray(body.days)) {
    fail("OWNER_ERASURE_ALLOWANCE_RESPONSE_INVALID", response.status);
  }
  const expectedDays = journeyHistoryDays(targetDay);
  const modelByDay = new Map(models.days.map((candidate) => [candidate?.day, candidate]));
  const scalarByDay = new Map(body.days.map((candidate) => [candidate?.day, candidate]));
  const nonzero = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
  const positiveModel = (candidate) => {
    if (candidate === undefined || candidate === null) return false;
    if (typeof candidate !== "object" || Array.isArray(candidate)
        || !DAY.test(candidate.day) || !Array.isArray(candidate.values)) {
      fail("OWNER_ERASURE_ALLOWANCE_RESPONSE_INVALID", response.status);
    }
    if (candidate.values.some((value) => Array.isArray(value)
      && (nonzero(value[1]) || nonzero(value[2])))) return true;
    return [candidate.fittedParticipantCount, candidate.v1ParticipantCount,
      candidate.unstableParticipantCount, candidate.staleParticipantCount,
      candidate.refusedParticipantCount, candidate.unsupportedSourceParticipantCount]
      .some(nonzero);
  };
  const positiveScalar = (candidate) => {
    if (candidate === undefined || candidate === null) return false;
    if (typeof candidate !== "object" || Array.isArray(candidate) || !DAY.test(candidate.day)) {
      fail("OWNER_ERASURE_ALLOWANCE_RESPONSE_INVALID", response.status);
    }
    const summaries = [candidate.combined, ...(candidate.byPlanType !== null
      && typeof candidate.byPlanType === "object" && !Array.isArray(candidate.byPlanType)
      ? Object.values(candidate.byPlanType) : [])];
    return summaries.some((summary) => summary !== null && typeof summary === "object"
      && !Array.isArray(summary)
      && [summary.fitCount, summary.participantCount, summary.centralUsd,
        summary.band80Usd?.lowerUsd, summary.band80Usd?.upperUsd].some(nonzero));
  };
  for (const day of expectedDays) {
    if (positiveModel(modelByDay.get(day)) || positiveScalar(scalarByDay.get(day))) {
      fail("OWNER_ERASURE_ALLOWANCE_REMAINS", response.status);
    }
  }
  if (body.coverage !== undefined) {
    const coverage = expectObject(body.coverage, "OWNER_ERASURE_ALLOWANCE_RESPONSE_INVALID");
    if (Object.values(coverage).some(nonzero)) fail("OWNER_ERASURE_ALLOWANCE_REMAINS", response.status);
  }
  return { status: "empty", expectedDays };
}

async function readErasedAllowanceCacheProof(caller, owner) {
  const health = await caller("/api/health");
  expectPostgresHealth(health, "OWNER_ERASURE_HEALTH_INVALID");
  const maintenance = await caller("/api/v1/admin/action", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrfToken,
    body: { action: "run_maintenance" },
  });
  expectEmptySchedulerResult(maintenance, "OWNER_ERASURE_EMPTY_SCHEDULER_INVALID");
  const overview = await caller("/api/v1/admin/overview", { cookie: owner.cookie });
  expectStatus(overview, 200, "OWNER_ERASURE_OVERVIEW_FAILED");
  const overviewBody = expectObject(overview.body, "OWNER_ERASURE_OVERVIEW_INVALID");
  const contributions = expectObject(overviewBody.contributions, "OWNER_ERASURE_OVERVIEW_INVALID");
  const accounts = expectObject(contributions.contributingAccounts, "OWNER_ERASURE_OVERVIEW_INVALID");
  const historical = expectObject(overviewBody.historicalPublication, "OWNER_ERASURE_OVERVIEW_INVALID");
  if (!Number.isSafeInteger(accounts.total) || accounts.total !== 0
      || historical.previewState !== "not_published") {
    fail("OWNER_ERASURE_ALLOWANCE_CACHE_PROOF_INVALID", overview.status);
  }
  const progressResponse = await caller("/api/v1/admin/reconstruction-progress", {
    cookie: owner.cookie,
  });
  expectStatus(progressResponse, 200, "OWNER_ERASURE_PROGRESS_FAILED");
  const progress = expectReconstructionProgress(progressResponse);
  if (progress.status !== "available"
      || progress.calculations.trackedAccounts !== 0
      || progress.publication.pendingDays !== 0) {
    fail("OWNER_ERASURE_ALLOWANCE_PROGRESS_NOT_EMPTY", progressResponse.status);
  }
  return Object.freeze({
    backendHealthy: true,
    cacheAbsent: true,
    cohortEmpty: true,
    progressComplete: true,
    emptyMaintenance: true,
  });
}

function expectPublicDaily(
  response,
  days,
  erased = false,
  workload = null,
  v1 = null,
  v12 = null,
  v11 = null,
) {
  if (!Array.isArray(days) || days.length !== JOURNEY_HISTORY_DAY_COUNT
      || days.some((day) => !DAY.test(day))) {
    fail("PUBLIC_RESULTS_EXPECTATION_INVALID", response.status);
  }
  const firstDay = days[0];
  const lastDay = days.at(-1);
  const body = expectObject(response.body, "PUBLIC_RESULTS_RESPONSE_INVALID");
  if (body.schemaVersion !== "community-daily-read-v1.0"
      || body.from !== firstDay || body.to !== lastDay
      || (!erased && body.allowanceState !== "ready")
      || (erased && body.allowanceState !== "ready" && body.allowanceState !== "updating")
      || !Array.isArray(body.days)) fail("PUBLIC_RESULTS_RESPONSE_INVALID", response.status);
  const rowsByDay = new Map(body.days.map((candidate) => [candidate?.day, candidate]));
  if (new Set(body.days.map((candidate) => candidate?.day)).size !== body.days.length
      || body.days.some((candidate) => !days.includes(candidate?.day))) {
    fail("PUBLIC_RESULTS_UNEXPECTED_DAY", response.status);
  }
  const encoded = JSON.stringify(body);
  if (erased) {
    const forbidden = [
      workload?.participantId,
      v1?.first?.contributionId,
      v1?.chunk?.chunkDigest,
      v1?.chunk?.records?.[0]?.eventId,
      v12?.first?.contributionId,
      v12?.fixture?.chunk?.chunkDigest,
      v12?.fixture?.chunk?.records?.[0]?.eventId,
      v12?.fixture?.manifest?.manifestDigest,
      ...(v12?.chunks ?? []).flatMap((chunk) => [
        chunk.chunkId,
        chunk.chunkDigest,
        chunk.manifestDigest,
      ]),
      ...(v12?.receipts ?? []).flatMap((receipt) => [
        receipt.contributionId,
        receipt.manifestId,
        receipt.chunkId,
      ]),
      ...(v11?.chunks ?? []).flatMap((chunk) => [
        chunk.chunkId,
        chunk.chunkDigest,
        chunk.manifestDigest,
      ]),
      ...(v11?.receipts ?? []).flatMap((receipt) => [
        receipt.contributionId,
        receipt.manifestId,
        receipt.chunkId,
      ]),
    ].filter((value) => typeof value === "string");
    if (forbidden.some((value) => encoded.includes(value))) fail("ERASED_DATA_PUBLICLY_VISIBLE", response.status);
    for (const day of days) {
      const row = rowsByDay.get(day);
      // Erasure may withdraw a published row completely. If a row remains
      // during the bounded rebuild window, it must already be an empty public
      // result; either outcome is checked for every seeded day in the range.
      if (row !== undefined) {
        const payload = expectObject(row.payload, "ERASED_DATA_PUBLICLY_VISIBLE");
        const totals = expectObject(payload.totals, "ERASED_DATA_PUBLICLY_VISIBLE");
        if (totals.usageEvents !== 0 || totals.quotaObservations !== 0) {
          fail("ERASED_DATA_PUBLICLY_VISIBLE", response.status);
        }
        if (!Array.isArray(payload.cells) || payload.cells.some((cell) => {
          if (cell === null || typeof cell !== "object" || Array.isArray(cell)) return true;
          return Number(cell.usageEvents) !== 0 || Number(cell.outputCombinedTokens) !== 0;
        })) {
          fail("ERASED_DATA_PUBLICLY_VISIBLE", response.status);
        }
      }
    }
    return body;
  }
  if (body.days.length !== days.length) fail("PUBLIC_RESULTS_EMPTY", response.status);
  for (const day of days) {
    const row = rowsByDay.get(day);
    if (row === undefined || !Number.isSafeInteger(row.revision) || row.revision < 1
        || typeof row.releasedAt !== "string") fail("PUBLIC_RESULTS_EMPTY", response.status);
    const payload = expectObject(row.payload, "PUBLIC_RESULTS_PAYLOAD_INVALID");
    if (payload.schemaVersion !== "community-daily-aggregate-v1.0") {
      fail("PUBLIC_RESULTS_PAYLOAD_INVALID", response.status);
    }
    const totals = expectObject(payload.totals, "PUBLIC_RESULTS_PAYLOAD_INVALID");
    // v1 is present only on the target day. The v1.2 same-day successor adds
    // one unique usage/quota observation after carrying the old target rows.
    const expectedUsage = day === lastDay ? 42 : 40;
    const expectedQuota = day === lastDay ? 41 : 40;
    if (totals.usageEvents !== expectedUsage || totals.quotaObservations !== expectedQuota) {
      fail("PUBLIC_RESULTS_USAGE_EMPTY", response.status);
    }
    if (!Array.isArray(payload.cells) || payload.cells.length < 2
        || payload.cells.some((cell) => !expectObject(cell, "PUBLIC_RESULTS_MODEL_EMPTY")
          || typeof cell.modelId !== "string" || cell.modelId.length === 0
          || !Number.isSafeInteger(cell.usageEvents) || cell.usageEvents < 1
          || !Number.isSafeInteger(cell.outputCombinedTokens) || cell.outputCombinedTokens < 1)
        || payload.cells.reduce((total, cell) => total + cell.usageEvents, 0) !== expectedUsage) {
      fail("PUBLIC_RESULTS_MODEL_EMPTY", response.status);
    }
  }
  return body;
}

function expectExport(response, workload, v1, v11, v12) {
  const body = expectObject(response.body, "PARTICIPANT_EXPORT_RESPONSE_INVALID");
  if (body.schemaVersion !== "participant-export-v0.2"
      || body.participant?.participantId !== workload?.participantId
      || !Array.isArray(body.contributions)
      || body.contributions.length === 0
      || !Array.isArray(body.attributionTransport)) {
    fail("PARTICIPANT_EXPORT_EMPTY", response.status);
  }
  const expected = [
    { id: v1?.first?.contributionId, digest: v1?.chunk?.chunkDigest },
  ];
  for (const item of expected) {
    if (typeof item.id !== "string" || !HEX64.test(item.digest ?? "")) {
      fail("PARTICIPANT_EXPORT_EXPECTATION_INVALID", response.status);
    }
    const contribution = body.contributions.find((row) => row?.contributionId === item.id);
    if (contribution === undefined) {
      fail("PARTICIPANT_EXPORT_MISSING_UPLOAD", response.status);
    }
    if (!Array.isArray(contribution.records) || contribution.records.length === 0) {
      fail("PARTICIPANT_EXPORT_EMPTY_CONTRIBUTION", response.status);
    }
    if (contribution.schemaVersion !== "telemetry-contribution-v1.0"
        && contribution.transportSchemaVersion !== "telemetry-contribution-v1.0") {
      fail("PARTICIPANT_EXPORT_LEGACY_SCHEMA_MISMATCH", response.status);
    }
    // v1 is the retained legacy stream. Its export entry is intentionally
    // content-bearing but unattributed; only v1.1/v1.2 are represented in
    // attributionTransport. Do not require a modern provenance row for v1.
    if (JSON.stringify(contribution).includes(EFFECTIVE_ACCOUNT_TRACK_ID)) {
      fail("PARTICIPANT_EXPORT_LEGACY_ATTRIBUTED", response.status);
    }
  }
  const modernChunks = [
    ...(v11?.receipts ?? []).map((receipt) => ({ ...receipt, format: "v1.1" })),
    ...(v12?.receipts ?? []).map((receipt) => ({ ...receipt, format: "v1.2" })),
  ];
  if (modernChunks.length === 0) fail("PARTICIPANT_EXPORT_MODERN_PROVENANCE_MISSING", response.status);
  const modernAttribution = body.attributionTransport.filter((entry) => (
    entry?.kind === "chunk" && (entry.schemaVersion === "telemetry-contribution-v1.1"
      || entry.schemaVersion === "telemetry-contribution-v1.2")
  ));
  if (modernAttribution.length !== modernChunks.length) {
    fail("PARTICIPANT_EXPORT_MODERN_PROVENANCE_MISMATCH", response.status);
  }
  for (const expectedChunk of modernChunks) {
    const matches = modernAttribution.filter((entry) => (
      entry.contributionId === expectedChunk.contributionId
        && entry.schemaVersion === `telemetry-contribution-${expectedChunk.format}`
        && entry.manifestId === expectedChunk.manifestId
        && entry.manifestDigest === expectedChunk.manifestDigest
        && entry.chunkId === expectedChunk.chunkId
        && entry.chunkDigest === expectedChunk.chunkDigest
        && entry.recordCount === expectedChunk.recordCount
    ));
    if (matches.length !== 1) {
      fail("PARTICIPANT_EXPORT_MODERN_PROVENANCE_MISMATCH", response.status);
    }
    const contribution = body.contributions.find((row) => row?.contributionId === expectedChunk.contributionId);
    if (contribution !== undefined) fail("PARTICIPANT_EXPORT_MODERN_IN_RETAINED_ROWS", response.status);
  }
  return body;
}

async function encryptEnvelope(keyBody, plaintext, schemaVersion) {
  if (keyBody === null || typeof keyBody !== "object"
      || keyBody.publicJwk === null || typeof keyBody.publicJwk !== "object"
      || typeof keyBody.keyId !== "string") fail("ENVELOPE_KEY_INVALID");
  const publicKey = await webcrypto.subtle.importKey(
    "jwk",
    keyBody.publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const dataKey = await webcrypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const rawKey = await webcrypto.subtle.exportKey("raw", dataKey);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dataKey,
    encoder.encode(canonicalJson(plaintext)),
  );
  const wrappedKey = await webcrypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawKey,
  );
  return canonicalJson({
    schemaVersion,
    synthetic: false,
    keyId: keyBody.keyId,
    wrappedKey: base64Url(new Uint8Array(wrappedKey)),
    iv: base64Url(iv),
    ciphertext: base64Url(new Uint8Array(ciphertext)),
  });
}

// The foreground sync clients accept the validated envelope object and own
// its canonical JSON serialization.  The ordinary v1 upload path accepts raw
// JSON text, so keep that path unchanged and decode only at this boundary.
async function encryptEnvelopeForSync(keyBody, plaintext, schemaVersion) {
  const raw = await encryptEnvelope(keyBody, plaintext, schemaVersion);
  try {
    return expectObject(JSON.parse(raw), "ENVELOPE_ENCODING_INVALID");
  } catch (error) {
    if (error instanceof JourneyError) throw error;
    fail("ENVELOPE_ENCODING_INVALID");
  }
}

function v1Chunk(day) {
  if (!DAY.test(day)) fail("V1_FIXTURE_DAY_INVALID");
  const record = {
    schemaVersion: "usage-event-v1.0",
    eventId: `event:gcp-journey:${randomBytes(24).toString("hex")}`,
    eventTime: `${day}T12:00:00.000Z`,
    sessionUuid: randomUUID(),
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "standard",
    surface: "api",
    billingSurface: "api",
    reasoningEffort: "none",
    agentScope: "local",
    outcome: "success",
    totalInputContextTokens: 1,
    components: {
      inputUncachedTokens: 1,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTextTokens: 1,
      outputReasoningTokens: 0,
      outputCombinedTokens: 1,
    },
  };
  const chunk = {
    schemaVersion: "telemetry-contribution-v1.0",
    chunkId: `usage:${day}:0`,
    chunkRevision: 1,
    chunkDigest: sha256Hex(canonicalJson([record])),
    parserVersion: "gcp-cloud-run-journey-v1",
    consent: {
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    records: [record],
  };
  return { day, chunk };
}

function successorUsageRecord(legacyUsageRecord, day, successorSchemaVersion) {
  if (legacyUsageRecord === null || typeof legacyUsageRecord !== "object"
      || Array.isArray(legacyUsageRecord)
      || legacyUsageRecord.schemaVersion !== "usage-event-v1.0"
      || typeof legacyUsageRecord.eventTime !== "string"
      || legacyUsageRecord.eventTime.slice(0, 10) !== day
      || !["usage-event-v1.1", "usage-event-v1.2"].includes(successorSchemaVersion)) {
    fail("LEGACY_SUCCESSOR_RECORD_INVALID");
  }
  // The v1.1/v1.2 builders copy only their reviewed base fields and derive
  // attribution/continuity locally. Keep the source v1 bytes otherwise
  // identical so the server can prove the legacy occurrence was preserved.
  const { schemaVersion: _schemaVersion, accountPlanAttribution: _attribution, ...base } = legacyUsageRecord;
  return Object.freeze(base);
}

function addDays(day, delta) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000)
    .toISOString().slice(0, 10);
}

const JOURNEY_HISTORY_DAY_COUNT = 5;
const JOURNEY_POSITIVE_FIT_DAY_COUNT = 3;

function journeyHistoryDays(targetDay) {
  return Object.freeze(Array.from(
    { length: JOURNEY_HISTORY_DAY_COUNT },
    (_, index) => addDays(targetDay, -(JOURNEY_HISTORY_DAY_COUNT - 1 - index)),
  ));
}

// The hosted predecessor can legitimately extend through the current UTC day
// even when this fixture's five rich historical days end yesterday.  Provide
// explicit empty coverage for that tail so the local sync reader can prove
// the day exists without inventing future observations.  A stale fixture may
// span more than one empty day; include each intervening day through today.
function journeyTrailingCurrentDays(targetDay, nowEpoch = Date.now()) {
  if (!DAY.test(targetDay) || !Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    fail("JOURNEY_TRAILING_DAY_INPUT_INVALID");
  }
  const currentDay = new Date(nowEpoch).toISOString().slice(0, 10);
  const currentEpoch = Date.parse(`${currentDay}T00:00:00.000Z`);
  const targetEpoch = Date.parse(`${targetDay}T00:00:00.000Z`);
  if (!Number.isFinite(currentEpoch) || !Number.isFinite(targetEpoch)) {
    fail("JOURNEY_TRAILING_DAY_INPUT_INVALID");
  }
  if (currentEpoch <= targetEpoch) return Object.freeze([]);
  const count = Math.floor((currentEpoch - targetEpoch) / 86_400_000);
  if (!Number.isSafeInteger(count) || count > ANALYTICS_HISTORY_WINDOW_DAYS) {
    fail("JOURNEY_TRAILING_DAY_WINDOW_INVALID");
  }
  return Object.freeze(Array.from({ length: count }, (_, index) => addDays(targetDay, index + 1)));
}

function journeyPositiveFitDays(targetDay) {
  return Object.freeze(Array.from(
    { length: JOURNEY_POSITIVE_FIT_DAY_COUNT },
    (_, index) => addDays(targetDay, -(JOURNEY_POSITIVE_FIT_DAY_COUNT - 1 - index)),
  ));
}

function journeyTargetDay(nowEpoch = Date.now()) {
  const current = new Date(nowEpoch);
  const day = current.toISOString().slice(0, 10);
  // The approved 20 half-hour slots per device span twenty hours when the
  // v1.1 even and v1.2 odd streams are combined. If the job starts before
  // that window fits in today's UTC day, use yesterday rather than inventing
  // future observations.
  return current.getUTCHours() * 60 + current.getUTCMinutes() >= JOURNEY_RICH_MINUTE_GUARD
    ? day : addDays(day, -1);
}

function targetBaseSlot(day, nowEpoch = Date.now()) {
  const current = new Date(nowEpoch);
  if (day !== current.toISOString().slice(0, 10)) return JOURNEY_RICH_START_SLOT;
  // Slots are quarter-hours. Each format owns alternate points on the
  // half-hour grid, and the same-day successor adds one point at the next
  // half-hour. Pin the start so even that successor point is never future
  // relative to the captured clock.
  return Math.max(0, current.getUTCHours() * 4
    + Math.floor(current.getUTCMinutes() / 15) - JOURNEY_RICH_SUCCESSOR_LAST_SLOT);
}

function legacyPartialCleanupSeedFixtureFromNow(nowEpoch = Date.now()) {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) fail("SEED_FIXTURE_CLOCK_INVALID");
  const day = journeyTargetDay(nowEpoch);
  const current = new Date(nowEpoch);
  const baseSlot = day !== current.toISOString().slice(0, 10)
    ? JOURNEY_RICH_START_SLOT
    : Math.max(0, current.getUTCHours() * 4
      + Math.floor(current.getUTCMinutes() / 15) - LEGACY_JOURNEY_RICH_LAST_SLOT);
  return Object.freeze({
    capturedAt: new Date(nowEpoch).toISOString(),
    day,
    baseSlot,
  });
}

function seedFixtureFromNow(nowEpoch = Date.now()) {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) fail("SEED_FIXTURE_CLOCK_INVALID");
  const day = journeyTargetDay(nowEpoch);
  const baseSlot = targetBaseSlot(day, nowEpoch);
  return Object.freeze({
    capturedAt: new Date(nowEpoch).toISOString(),
    day,
    baseSlot,
  });
}

function validSeedFixture(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || typeof value.capturedAt !== "string" || !DAY.test(value.day)
      || !Number.isSafeInteger(value.baseSlot) || value.baseSlot < 0 || value.baseSlot > 55) {
    return false;
  }
  const capturedMs = Date.parse(value.capturedAt);
  if (!Number.isFinite(capturedMs)
      || new Date(capturedMs).toISOString() !== value.capturedAt) return false;
  return value.day === journeyTargetDay(capturedMs)
    && value.baseSlot === targetBaseSlot(value.day, capturedMs);
}

function validLegacyPartialCleanupSeedFixture(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || typeof value.capturedAt !== "string" || !DAY.test(value.day)
      || !Number.isSafeInteger(value.baseSlot) || value.baseSlot < 0 || value.baseSlot > 55) {
    return false;
  }
  const capturedMs = Date.parse(value.capturedAt);
  if (!Number.isFinite(capturedMs)
      || new Date(capturedMs).toISOString() !== value.capturedAt) return false;
  const expected = legacyPartialCleanupSeedFixtureFromNow(capturedMs);
  return value.day === expected.day && value.baseSlot === expected.baseSlot;
}

const LEGACY_PARTIAL_CLEANUP_PROGRESS = new Set([
  "v11-consent",
  "v11-capabilities",
  "v11-upload-and-activation",
]);

function validLegacyPartialCleanupState(value) {
  const record = (candidate) => candidate !== null
    && typeof candidate === "object" && !Array.isArray(candidate);
  return record(value)
    && value.phase === "seed-progress"
    && LEGACY_PARTIAL_CLEANUP_PROGRESS.has(value.progress)
    && validLegacyPartialCleanupSeedFixture(value.seedFixture)
    && record(value.workload)
    && record(value.v1)
    && value.deviceV12 === null
    && value.v11 === null
    && value.v12 === null
    && value.erasureAt === null;
}

function validResumeDeviceRecord(value, nowEpoch) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || !UUID.test(value.id ?? "") || !SECRET.test(value.secret ?? "")
      || value.authorization !== `Device um_device_${value.id}.${value.secret}`
      || !validJourneyInstant(value.expiresAt)
      || Date.parse(value.expiresAt) <= nowEpoch) return false;
  return true;
}

function validResumeReceiptArchive(chunks, receipts, format) {
  if (!Array.isArray(chunks) || chunks.length === 0
      || !Array.isArray(receipts) || receipts.length !== chunks.length) return false;
  const refs = new Map();
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)
        || chunk.schemaVersion !== `telemetry-contribution-${format}`
        || typeof chunk.chunkId !== "string" || chunk.chunkId.length < 3
        || !HEX64.test(chunk.chunkDigest ?? "") || !HEX64.test(chunk.manifestDigest ?? "")
        || !Number.isSafeInteger(chunk.recordCount) || chunk.recordCount < 1 || chunk.recordCount > 200) {
      return false;
    }
    const key = `${chunk.chunkId}\u0000${chunk.recordCount}`;
    refs.set(key, (refs.get(key) ?? 0) + 1);
  }
  const seen = new Set();
  for (const receipt of receipts) {
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)
        || typeof receipt.contributionId !== "string" || receipt.contributionId.length === 0
        || receipt.contributionId.length > 128 || !UUID.test(receipt.manifestId ?? "")
        || typeof receipt.chunkId !== "string"
        || !Number.isSafeInteger(receipt.recordCount) || receipt.recordCount < 1
        || receipt.recordCount > 200) return false;
    const key = `${receipt.chunkId}\u0000${receipt.recordCount}`;
    if (!refs.has(key)) return false;
    const receiptKey = `${receipt.manifestId}\u0000${receipt.chunkId}`;
    if (seen.has(receiptKey)) return false;
    seen.add(receiptKey);
  }
  return true;
}

/**
 * Validate the durable checkpoint accepted by --phase=resume-seed.  This is
 * intentionally stricter than the general state reader: resume may reuse
 * authenticated credentials and export provenance, but it must never invent
 * a missing upload or silently bind a journal to another workload.
 */
function assertResumeSeedJournal(state, fixture, nowEpoch = Date.now()) {
  if (state === null || typeof state !== "object" || Array.isArray(state)
      || state.phase !== "seed-progress"
      || !RESUME_SEED_CHECKPOINTS.has(state.progress)) {
    fail("JOURNEY_RESUME_CHECKPOINT_INVALID");
  }
  if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)
      || !PARTICIPANT_ID.test(fixture.participantId ?? "")
      || state.erasureAt !== null || !validJourneyInstant(state.ownerCreatedAt)
      || !validJourneyInstant(state.workload?.expiresAt)
      || Date.parse(state.workload.expiresAt) <= nowEpoch
      || !PARTICIPANT_ID.test(state.workload?.participantId ?? "")
      || typeof state.workload.cookie !== "string"
      || !state.workload.cookie.startsWith("__Host-usage_monitor_session=um_session_")
      || typeof state.workload.csrfToken !== "string"
      || !state.workload.csrfToken.startsWith("um_csrf_")) {
    fail("JOURNEY_RESUME_IDENTITY_INVALID");
  }
  if (!validResumeDeviceRecord(state.device, nowEpoch)
      || !validResumeDeviceRecord(state.deviceV12, nowEpoch)) {
    fail("JOURNEY_RESUME_DEVICE_INVALID");
  }
  const legacy = state.v1;
  if (legacy === null || typeof legacy !== "object" || Array.isArray(legacy)
      || legacy.day !== state.seedFixture?.day
      || typeof legacy.raw !== "string" || legacy.raw.length === 0
      || legacy.chunk === null || typeof legacy.chunk !== "object"
      || !HEX64.test(legacy.chunk.chunkDigest ?? "")
      || !Array.isArray(legacy.chunk.records) || legacy.chunk.records.length === 0
      || legacy.first === null || typeof legacy.first !== "object"
      || typeof legacy.first.contributionId !== "string" || legacy.first.contributionId.length === 0) {
    fail("JOURNEY_RESUME_V1_RECEIPT_INVALID");
  }
  if (!validResumeReceiptArchive(state.v11?.chunks, state.v11?.receipts, "v1.1")
      || state.v11?.sync === null || typeof state.v11?.sync !== "object"
      || state.v11.sync.resumedStatus !== "complete"
      || !Number.isSafeInteger(state.v11.sync.daysSynced) || state.v11.sync.daysSynced < 1
      || !validResumeReceiptArchive(state.v12?.chunks, state.v12?.receipts, "v1.2")
      || state.v12?.sync === null || typeof state.v12?.sync !== "object"
      || state.v12.sync.resumedStatus !== "complete"
      || state.v12.sync.sameDayStatus !== "complete"
      || state.v12.sync.additiveStatus !== "complete"
      || !Number.isSafeInteger(state.v12.sync.additiveDaysSynced)
      || state.v12.sync.additiveDaysSynced < 1
      || state.v12?.fixture === null || typeof state.v12?.fixture !== "object"
      || state.v12.fixture.day !== state.seedFixture?.day
      || state.v12.fixture.chunk === null || typeof state.v12.fixture.chunk !== "object"
      || !Array.isArray(state.v12.fixture.chunk.records)
      || state.v12.first === null || typeof state.v12.first !== "object"
      || state.v12.replay === null || typeof state.v12.replay !== "object") {
    fail("JOURNEY_RESUME_RECEIPTS_INCOMPLETE");
  }
  return true;
}

const JOURNEY_MODEL_PATTERN = Object.freeze([
  Object.freeze(["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-terra"]),
  Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-terra"]),
  Object.freeze(["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-terra"]),
  Object.freeze(["gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-sol"]),
]);
const JOURNEY_QUOTA_CAPACITY_BY_MODEL = Object.freeze({
  "gpt-5.6-sol": 2_500,
  "gpt-5.6-terra": 900,
});

function journeyModelId(globalIndex) {
  return JOURNEY_MODEL_PATTERN[Math.floor(globalIndex / 4) % JOURNEY_MODEL_PATTERN.length]
    [globalIndex % 4];
}

function journeyOutputTextTokens(globalIndex) {
  return 700 + ((globalIndex * 97) % 1_000);
}

function journeyTimeAt(day, baseSlot, globalIndex, seconds = "00") {
  // A quarter-hour slot step of two gives a 30-minute combined cadence. The
  // two formats own alternate points, so each device remains hourly while the
  // source bridge sees one point every half hour across the 20-hour window.
  const slot = baseSlot + globalIndex * JOURNEY_RICH_STEP_SLOTS;
  const hour = Math.floor(slot / 4);
  const minute = (slot % 4) * 15;
  return `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${seconds}.000Z`;
}

function journeyUsageComponents(globalIndex) {
  const outputTextTokens = journeyOutputTextTokens(globalIndex);
  return {
    inputUncachedTokens: 1_000,
    inputCacheReadTokens: 9_000,
    inputCacheWriteTokens: 0,
    outputTextTokens,
    outputReasoningTokens: 0,
    outputCombinedTokens: outputTextTokens,
  };
}

function journeyUsagePriceUsd(day, baseSlot, globalIndex) {
  const priced = priceUsageEvent({
    provider: "openai",
    model: journeyModelId(globalIndex),
    surface: "openai.responses",
    apiTier: "standard",
    pricedAt: journeyTimeAt(day, baseSlot, globalIndex),
    totalInputContextTokens: 10_000,
    // The Worker server-pricing adapter removes a redundant aggregate output
    // component before calling this same accounting package. Keep the fixture
    // calculation faithful to that adapter's input projection.
    components: (() => {
      const { outputCombinedTokens: _outputCombinedTokens, ...components } =
        journeyUsageComponents(globalIndex);
      return components;
    })(),
  }, {
    priceCards: APP_OFFICIAL_PRICE_CARDS,
    pricingContext: { priceEpochBasis: "event_time_when_registry_has_effective_evidence" },
  });
  if (priced.coverageStatus !== "fully_priced" || typeof priced.totalUsd !== "string") {
    fail("GCP_RICH_FIXTURE_PRICING_INVALID");
  }
  const costUsd = Number(priced.totalUsd);
  if (!Number.isFinite(costUsd) || costUsd < 0) fail("GCP_RICH_FIXTURE_PRICING_INVALID");
  return costUsd;
}

function journeyQuotaUsedPercentByIndex(day, baseSlot) {
  const pricePercentByBin = Array.from({ length: JOURNEY_RICH_RECORD_COUNT / 4 }, () => 0);
  for (let globalIndex = 0; globalIndex < JOURNEY_RICH_RECORD_COUNT; globalIndex += 1) {
    const model = journeyModelId(globalIndex);
    const capacity = JOURNEY_QUOTA_CAPACITY_BY_MODEL[model];
    pricePercentByBin[Math.floor(globalIndex / 4)] +=
      journeyUsagePriceUsd(day, baseSlot, globalIndex) * 100 / capacity;
  }
  const totalPricePercent = pricePercentByBin.reduce((sum, value) => sum + value, 0);
  if (!(totalPricePercent > 0) || !Number.isFinite(totalPricePercent)) {
    fail("GCP_RICH_FIXTURE_QUOTA_CURVE_INVALID");
  }
  const scale = 60 / totalPricePercent;
  let usedPercent = 0;
  return Object.freeze(Array.from({ length: JOURNEY_RICH_RECORD_COUNT }, (_, globalIndex) => {
    usedPercent += pricePercentByBin[Math.floor(globalIndex / 4)] * scale / 4;
    return usedPercent;
  }));
}

function journeyUsageRecord(schemaVersion, day, baseSlot, globalIndex) {
  return {
    schemaVersion,
    eventId: `event:gcp-journey-mixed:${day}:${globalIndex}`,
    eventTime: journeyTimeAt(day, baseSlot, globalIndex),
    sessionUuid: `session:gcp-journey-mixed:${day}`,
    provider: "openai_codex",
    modelId: journeyModelId(globalIndex),
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 10_000,
    components: journeyUsageComponents(globalIndex),
    accountPlanAttribution: {
      ...effectiveJourneyAttribution(),
    },
    ...(schemaVersion === "usage-event-v1.2"
      ? { boundaryFlags: null, tieOrder: null, cacheWriteTtl: null } : {}),
  };
}

/**
 * Build the approved mixed-format model fixture through the same public
 * contribution projection used by the local client. The two devices share a
 * 40-point half-hour grid across twenty hours: v1.1 owns the even points and
 * v1.2 the odd points, so each device contributes 20 usage and 20 quota
 * observations at hourly intervals. Two preceding days provide retained
 * history for the rolling calculation window.
 */
function richV12Day(day, {
  additional = false,
  baseSlot = JOURNEY_RICH_START_SLOT,
  resetDay = addDays(day, 7),
  legacyUsageRecord = null,
} = {}) {
  const globalIndexes = additional
    // Index 40 is outside the original even/odd grid.  It is a genuinely
    // additive occurrence rather than a v1.1 overlap at index 0, while the
    // original odd records remain byte-for-byte unchanged for successor
    // closure.
    ? [JOURNEY_RICH_RECORD_COUNT, ...Array.from({ length: 20 }, (_, index) => index * 2 + 1)]
    : Array.from({ length: 20 }, (_, index) => index * 2 + 1);
  const quotaUsedPercentByIndex = journeyQuotaUsedPercentByIndex(day, baseSlot);
  const usage = globalIndexes.map((globalIndex) => journeyUsageRecord(
    "usage-event-v1.2", day, baseSlot, globalIndex,
  ));
  if (legacyUsageRecord !== null) {
    usage.push(successorUsageRecord(legacyUsageRecord, day, "usage-event-v1.2"));
  }
  const quota = globalIndexes.map((globalIndex) => {
    return {
      schemaVersion: "quota-observation-v1.2",
      observationId: `observation:gcp-journey-mixed:${day}:${globalIndex}`,
      observedTime: journeyTimeAt(day, baseSlot, globalIndex),
      provider: "openai_codex",
      planType: "pro",
      planVariant: "standard",
      limitId: "codex",
      slot: "seven_day",
      // Keep the predecessor's forty-point curve immutable.  The successor
      // point is a finite new observation after the old curve, not a rescaled
      // rewrite of any prior quota record.
      usedPercent: quotaUsedPercentByIndex[globalIndex]
        ?? (quotaUsedPercentByIndex.at(-1) + 1),
      windowDurationMinutes: 10_080,
      resetsAt: `${resetDay}T00:00:00.000Z`,
      accountPlanAttribution: {
        ...effectiveJourneyAttribution(),
      },
    };
  });
  const session = [{
    schemaVersion: "session-dimension-v1.2",
    sessionUuid: `session:gcp-journey-v12:${day}`,
    firstEventTime: `${day}T00:00:00.000Z`,
    provider: "openai_codex",
    // The additive successor adds a usage observation only.  Its session
    // dimension must remain byte-identical to the admitted predecessor.
    toolClassCounts: { analysis: JOURNEY_RICH_RECORD_COUNT / 2 },
  }];
  return createTelemetryV12Day({
    day,
    parserVersion: "gcp-cloud-run-journey-v12",
    recordsByStream: { quota, session, usage },
    accountObservationSecret: JOURNEY_ACCOUNT_OBSERVATION_SECRET,
    binding: JOURNEY_ACCOUNT_BINDING,
    attributionForRecord: () => ({ ...effectiveJourneyAttributionEvidence() }),
  });
}

function emptyV11Day(day) {
  return createTelemetryV11Day({
    day,
    parserVersion: "gcp-cloud-run-journey-v11",
    recordsByStream: { quota: [], session: [], usage: [] },
  });
}

function emptyV12Day(day) {
  return createTelemetryV12Day({
    day,
    parserVersion: "gcp-cloud-run-journey-v12",
    recordsByStream: { quota: [], session: [], usage: [] },
  });
}

function richV11Day(day, {
  baseSlot = JOURNEY_RICH_START_SLOT,
  resetDay = addDays(day, 7),
  legacyUsageRecord = null,
} = {}) {
  const globalIndexes = Array.from({ length: 20 }, (_, index) => index * 2);
  const quotaUsedPercentByIndex = journeyQuotaUsedPercentByIndex(day, baseSlot);
  const usage = globalIndexes.map((globalIndex) => journeyUsageRecord(
    "usage-event-v1.1", day, baseSlot, globalIndex,
  ));
  if (legacyUsageRecord !== null) {
    usage.push(successorUsageRecord(legacyUsageRecord, day, "usage-event-v1.1"));
  }
  const quota = globalIndexes.map((globalIndex) => {
    return {
      schemaVersion: "quota-observation-v1.1",
      observationId: `observation:gcp-journey-mixed:${day}:${globalIndex}`,
      observedTime: journeyTimeAt(day, baseSlot, globalIndex),
      provider: "openai_codex",
      planType: "pro",
      planVariant: "standard",
      limitId: "codex",
      slot: "seven_day",
      usedPercent: quotaUsedPercentByIndex[globalIndex],
      windowDurationMinutes: 10_080,
      resetsAt: `${resetDay}T00:00:00.000Z`,
      accountPlanAttribution: {
        ...effectiveJourneyAttribution(),
      },
    };
  });
  const session = [{
    schemaVersion: "session-dimension-v1.1",
    sessionUuid: `session:gcp-journey-v11:${day}`,
    firstEventTime: `${day}T00:00:00.000Z`,
    provider: "openai_codex",
    toolClassCounts: { analysis: globalIndexes.length },
  }];
  return createTelemetryV11Day({
    day,
    parserVersion: "gcp-cloud-run-journey-v11",
    recordsByStream: { quota, session, usage },
    accountObservationSecret: JOURNEY_ACCOUNT_OBSERVATION_SECRET,
    binding: JOURNEY_ACCOUNT_BINDING,
    attributionForRecord: () => ({ ...effectiveJourneyAttributionEvidence() }),
  });
}

function assertModernAttribution(day, schemaVersion) {
  const expected = effectiveJourneyAttribution();
  for (const chunk of day.chunks) {
    for (const record of chunk.records) {
      if (record.schemaVersion !== "usage-event-" + schemaVersion
          && record.schemaVersion !== "quota-observation-" + schemaVersion) continue;
      const attribution = record.accountPlanAttribution;
      if (attribution === null || typeof attribution !== "object"
          || attribution.accountBasis !== expected.accountBasis
          || attribution.accountTrackId !== expected.accountTrackId
          || attribution.planBasis !== expected.planBasis
          || attribution.planType !== expected.planType
          || attribution.planEraId !== expected.planEraId) {
        fail(schemaVersion.toUpperCase().replace(".", "") + "_MODERN_ATTRIBUTION_INVALID");
      }
    }
  }
}

function assertSevenDayResetFit(day, resetDay, schemaVersion) {
  if (!DAY.test(resetDay)) fail(schemaVersion.toUpperCase().replace(".", "") + "_RESET_DAY_INVALID");
  const expected = `${resetDay}T00:00:00.000Z`;
  const quotaChunk = day.chunks.find((chunk) => chunk.chunkId.startsWith("quota:"));
  if (quotaChunk === undefined || quotaChunk.records.length !== 20
      || quotaChunk.records.some((record) => (
        record.windowDurationMinutes !== 10_080 || record.resetsAt !== expected
      ))) {
    fail(schemaVersion.toUpperCase().replace(".", "") + "_RESET_FIT_INVALID");
  }
}

function assertLegacyV1Unattributed(chunk) {
  const record = chunk.records?.[0];
  if (record === null || typeof record !== "object"
      || Object.hasOwn(record, "accountPlanAttribution")) {
    fail("V1_LEGACY_ATTRIBUTION_UNEXPECTED");
  }
}

function expectedChunkRefs(days, schemaVersion) {
  return days.flatMap((day) => day.chunks.map((chunk) => ({
    schemaVersion: "telemetry-contribution-" + schemaVersion,
    chunkId: chunk.chunkId,
    chunkDigest: chunk.chunkDigest,
    recordCount: chunk.records.length,
    manifestDigest: chunk.manifestDigest,
  })));
}

function recordIdentity(record) {
  if (record?.schemaVersion?.startsWith("usage-event-")) return record.eventId;
  if (record?.schemaVersion?.startsWith("quota-observation-")) return record.observationId;
  if (record?.schemaVersion?.startsWith("session-dimension-")) return record.sessionUuid;
  return null;
}

/**
 * Validate the client-side half of the same-day successor contract before the
 * server's bounded SQL overlap proof runs.  The successor may add records,
 * but every predecessor stream/occurrence must retain exact canonical bytes.
 */
function assertAdditiveSuccessorPreserves(predecessor, successor) {
  const prior = new Map();
  for (const chunk of predecessor?.chunks ?? []) {
    for (const record of chunk.records ?? []) {
      const identity = recordIdentity(record);
      if (identity === null) fail("V12_SUCCESSOR_PREDECESSOR_RECORD_INVALID");
      prior.set(`${chunk.chunkId.slice(0, chunk.chunkId.indexOf(":"))}:${identity}`, canonicalJson(record));
    }
  }
  const next = new Map();
  for (const chunk of successor?.chunks ?? []) {
    for (const record of chunk.records ?? []) {
      const identity = recordIdentity(record);
      if (identity === null) fail("V12_SUCCESSOR_RECORD_INVALID");
      next.set(`${chunk.chunkId.slice(0, chunk.chunkId.indexOf(":"))}:${identity}`, canonicalJson(record));
    }
  }
  for (const [identity, encoded] of prior) {
    if (next.get(identity) !== encoded) fail("V12_SUCCESSOR_OVERLAP_REWRITTEN");
  }
  return Object.freeze({ predecessorRecords: prior.size, successorRecords: next.size });
}

function captureContributionReceipt(stores, value) {
  const schemaVersion = value?.schemaVersion;
  const format = schemaVersion === "telemetry-chunk-receipt-v1.1"
    ? "v1.1"
    : schemaVersion === "telemetry-chunk-receipt-v1.2"
      ? "v1.2" : null;
  if (format === null || typeof value.contributionId !== "string"
      || typeof value.chunkId !== "string" || typeof value.manifestId !== "string"
      || !Number.isSafeInteger(value.recordCounts?.accepted)
      || value.recordCounts.accepted < 1) return;
  const store = stores[format];
  const previous = store.get(value.chunkId) ?? [];
  if (!previous.some((entry) => entry.contributionId === value.contributionId)) {
    previous.push(Object.freeze({
      contributionId: value.contributionId,
      manifestId: value.manifestId,
      chunkId: value.chunkId,
      recordCount: value.recordCounts.accepted,
    }));
    store.set(value.chunkId, previous);
  }
}

function bindChunkReceipts(stores, refs, format, { preferLatest = false } = {}) {
  return refs.map((ref) => {
    const captured = stores[format].get(ref.chunkId) ?? [];
    const selected = preferLatest ? captured.at(-1) : captured.length === 1 ? captured[0] : undefined;
    if (selected === undefined || selected.recordCount !== ref.recordCount
        || selected.manifestId.length === 0) {
      fail(format.toUpperCase().replace(".", "") + "_EXPORT_PROVENANCE_UNPROVEN");
    }
    return Object.freeze({
      ...ref,
      contributionId: selected.contributionId,
      manifestId: selected.manifestId,
    });
  });
}

function createCaller(baseOrigin, audience, {
  explicitToken = undefined,
  useGcloudIamToken = false,
  gcloudProject = "tibotattle",
  onContributionReceipt = undefined,
} = {}) {
  let gcloudTokenPromise;
  let gcloudTokenExpiresAt = 0;
  const getIamHeader = async () => {
    const explicit = explicitToken ?? optional("JOURNEY_ID_TOKEN");
    if (explicit !== undefined) return `Bearer ${explicit}`;
    if (useGcloudIamToken) {
      if (gcloudTokenPromise !== undefined && Date.now() < gcloudTokenExpiresAt - 60_000) {
        return `Bearer ${await gcloudTokenPromise}`;
      }
      gcloudTokenPromise = (async () => {
        let stdout;
        try {
          // User-account gcloud credentials cannot mint an arbitrary audience
          // claim. Cloud Run accepts the project-scoped user ID token here;
          // service-account callers can still provide --id-token-file or ADC.
          ({ stdout } = await execFile(
            "gcloud",
            ["auth", "print-identity-token", `--project=${gcloudProject}`],
            { timeout: REQUEST_TIMEOUT_MS, maxBuffer: 128 * 1024, windowsHide: true },
          ));
        } catch {
          fail("CLOUD_RUN_IAM_TOKEN_UNAVAILABLE");
        }
        const token = typeof stdout === "string" ? stdout.trim() : "";
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
          fail("CLOUD_RUN_IAM_TOKEN_UNAVAILABLE");
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        } catch {
          fail("CLOUD_RUN_IAM_TOKEN_UNAVAILABLE");
        }
        if (payload === null || typeof payload !== "object"
            || !Number.isSafeInteger(payload.exp)
            || payload.exp * 1_000 <= Date.now()) {
          fail("CLOUD_RUN_IAM_TOKEN_UNAVAILABLE");
        }
        gcloudTokenExpiresAt = payload.exp * 1_000;
        return token;
      })();
      const token = await gcloudTokenPromise;
      return `Bearer ${token}`;
    }
    // The operations runner intentionally has no ADC dependency. Use the
    // explicit 0600 token file or the cached user-account gcloud mode above;
    // an application runtime must never silently broaden its identity path.
    fail("CLOUD_RUN_IAM_TOKEN_UNAVAILABLE");
  };

  const call = async function call(path, {
    method = "GET",
    body = undefined,
    cookie = undefined,
    csrf = undefined,
    authorization = undefined,
    contentType = "application/json",
  } = {}) {
    const url = new URL(path, baseOrigin);
    if (url.origin !== baseOrigin) fail("JOURNEY_URL_INVALID");
    const headers = new Headers({
      accept: "application/json",
      origin: baseOrigin,
      "x-serverless-authorization": await getIamHeader(),
    });
    if (cookie !== undefined) headers.set("cookie", cookie);
    if (csrf !== undefined) headers.set("x-usage-monitor-csrf", csrf);
    if (authorization !== undefined) headers.set("authorization", authorization);
    let payload;
    if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      headers.set("content-type", contentType);
    }
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail("JOURNEY_REQUEST_FAILED");
    }
    if (response.status >= 300 && response.status < 400) {
      fail("JOURNEY_REDIRECT_REFUSED", response.status);
    }
    const raw = await readBounded(response);
    let parsed = null;
    if (raw.length > 0) {
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
    }
    return Object.freeze({ status: response.status, headers: response.headers, body: parsed });
  };
  // The public contribution sync client needs the original Response so it can
  // enforce its own no-store/content-type/size contract. Keep the same pinned
  // origin, IAM header, redirect refusal, and timeout boundary as call().
  call.fetch = async (input, init = {}) => {
    const candidate = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input?.url ?? input?.href;
    const url = new URL(candidate, baseOrigin);
    if (url.origin !== baseOrigin) fail("JOURNEY_URL_INVALID");
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("origin", baseOrigin);
    headers.set("x-serverless-authorization", await getIamHeader());
    let response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail("JOURNEY_REQUEST_FAILED");
    }
    if (response.status >= 300 && response.status < 400) {
      fail("JOURNEY_REDIRECT_REFUSED", response.status);
    }
    if (typeof onContributionReceipt === "function"
        && url.pathname === "/api/v1/contributions"
        && String(init.method ?? "GET").toUpperCase() === "POST") {
      try {
        const value = await response.clone().json();
        onContributionReceipt(value);
      } catch {
        // The sync client owns response validation; malformed receipts are
        // rejected there without retaining response content in the runner.
      }
    }
    return response;
  };
  return call;
}

function sessionCookie(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const value = values.find((candidate) => candidate.startsWith("__Host-usage_monitor_session="));
  if (typeof value !== "string") fail("SESSION_COOKIE_MISSING");
  return value.split(";", 1)[0];
}

async function run() {
  const args = parseCommandLine();
  if (args.help) return { help: true };
  if (args.phase !== "all" && args.stateDir === undefined) fail("JOURNEY_STATE_DIR_MISSING");
  const baseOrigin = origin(required("JOURNEY_BASE_URL"), "JOURNEY_BASE_URL");
  const audience = origin(optional("JOURNEY_IAM_AUDIENCE", baseOrigin), "JOURNEY_IAM_AUDIENCE");
  const gcloudProject = optional("JOURNEY_GCLOUD_PROJECT", "tibotattle");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(gcloudProject)) {
    fail("JOURNEY_GCLOUD_PROJECT_INVALID");
  }
  const fixtureRaw = args.fixtureFile === undefined
    ? required("ADMIN_OWNER_FIXTURE_JSON")
    : await secureRegularFile(args.fixtureFile, "ADMIN_OWNER_FIXTURE_FILE_INVALID", MAX_FIXTURE_BYTES);
  const fixture = parseFixture(fixtureRaw);
  const owner = ownerSession(fixture);
  const allowIncomplete = booleanEnv("JOURNEY_ALLOW_INCOMPLETE", false);
  const continueOnFailure = booleanEnv("JOURNEY_CONTINUE_ON_FAILURE", false);
  const stopAfter = optional("JOURNEY_STOP_AFTER");
  const controlRevision = integerEnv("JOURNEY_CONTROL_REVISION", 1, 1, 1_000_000_000);
  // A one-shot all run is a complete qualification attempt. It must not
  // report success when the restore destination was omitted.
  const requireRestore = args.phase === "all"
    || args.phase === "verify"
    || booleanEnv("JOURNEY_REQUIRE_RESTORE", false);
  const selectedNames = args.phase === "all"
    ? null
    : args.phase === "resume-seed" ? RESUME_SEED_PHASE_NAMES : PHASE_GROUPS[args.phase];
  const stateDir = args.stateDir === undefined
    ? undefined
    : await secureStateDirectory(args.stateDir);
  let priorState = null;
  if (stateDir !== undefined && args.phase === "seed") {
    try {
      await readJourneyState(stateDir);
      fail("JOURNEY_STATE_ALREADY_EXISTS");
    } catch (error) {
      if (!(error instanceof JourneyError) || error.code !== "JOURNEY_STATE_MISSING") throw error;
    }
  } else if (stateDir !== undefined && args.phase !== "all") {
    priorState = await readJourneyState(stateDir, {
      allowLegacyPartialCleanup: args.phase === "cleanup",
    });
    if (priorState.baseOrigin !== baseOrigin) fail("JOURNEY_STATE_ORIGIN_MISMATCH");
    const requiredPrevious = {
      check: "seeded",
      erase: "checked",
      verify: "erased",
      cleanup: "seed-progress",
      "resume-seed": "seed-progress",
    }[args.phase];
    if (priorState.phase !== requiredPrevious) fail("JOURNEY_STATE_PHASE_INVALID");
    if (args.phase === "cleanup" && priorState.workload === null) {
      fail("JOURNEY_CLEANUP_WORKLOAD_MISSING");
    }
    if (args.phase === "resume-seed") {
      assertResumeSeedJournal(priorState, fixture);
    }
  }
  const seedFixture = priorState?.seedFixture === undefined
    ? seedFixtureFromNow()
    : Object.freeze({ ...priorState.seedFixture });
  const explicitToken = args.idTokenFile === undefined
    ? optional("JOURNEY_ID_TOKEN")
    : (await secureRegularFile(args.idTokenFile, "JOURNEY_ID_TOKEN_FILE_INVALID", 16 * 1024)).trim();
  if (explicitToken !== undefined
      && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(explicitToken)) {
    fail("JOURNEY_ID_TOKEN_INVALID");
  }
  const phases = [];
  let failure = null;
  let ownerCreatedAt = priorState?.ownerCreatedAt ?? null;
  let workload = priorState === null ? null : copyNullableRecord(priorState.workload);
  let device = priorState === null ? null : copyNullableRecord(priorState.device);
  let deviceV12 = priorState === null ? null : copyNullableRecord(priorState.deviceV12);
  let v1 = priorState === null ? null : copyNullableRecord(priorState.v1);
  let v11 = priorState === null ? null : copyNullableRecord(priorState.v11);
  let v12 = priorState === null ? null : copyNullableRecord(priorState.v12);
  let erasureAt = priorState?.erasureAt ?? null;
  const capturedReceipts = {
    "v1.1": new Map(),
    "v1.2": new Map(),
  };
  let lastUploadAuthorization = priorState?.uploadAuthorization === undefined
    ? null : Object.freeze({ ...priorState.uploadAuthorization });
  const caller = createCaller(baseOrigin, audience, {
    explicitToken,
    useGcloudIamToken: args.gcloudIamToken,
    gcloudProject,
    onContributionReceipt: (value) => captureContributionReceipt(capturedReceipts, value),
  });

  async function phase(name, operation) {
    if (selectedNames !== null && !selectedNames.has(name)) return null;
    if (failure !== null && !(allowIncomplete && continueOnFailure)) {
      phases.push({ name, status: "skipped", code: "PREREQUISITE_FAILED" });
      return null;
    }
    try {
      const value = await operation();
      phases.push({
        name,
        status: value?.phaseStatus ?? "passed",
        ...(value?.status === undefined ? {} : { httpStatus: value.status }),
        ...(value?.metadata === undefined ? {} : { metadata: value.metadata }),
      });
      if (stateDir !== undefined && ["seed", "resume-seed"].includes(args.phase)) {
        await writeJourneyState(stateDir, journeyStateSnapshot({
          phase: "seed-progress",
          progress: name,
          baseOrigin,
          seedFixture,
          ownerCreatedAt,
          workload,
          device,
          deviceV12,
          v1,
          v11,
          v12,
          erasureAt,
          uploadAuthorization: lastUploadAuthorization,
        }));
      }
      if (stopAfter === name) {
        failure = new JourneyError("JOURNEY_STOPPED", 0);
      }
      return value;
    } catch (error) {
      const code = error instanceof JourneyError && typeof error.code === "string"
        ? error.code : "JOURNEY_PHASE_FAILED";
      const diagnostic = error instanceof JourneyError ? error.details : undefined;
      phases.push({ name, status: "failed", code,
        ...(error?.status === undefined ? {} : { httpStatus: error.status }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      });
      failure = error instanceof JourneyError ? error : new JourneyError(code);
      if (stateDir !== undefined && ["seed", "resume-seed"].includes(args.phase)) {
        await writeJourneyState(stateDir, journeyStateSnapshot({
          phase: "seed-progress",
          progress: name,
          baseOrigin,
          seedFixture,
          ownerCreatedAt,
          workload,
          device,
          deviceV12,
          v1,
          v11,
          v12,
          erasureAt,
          uploadAuthorization: lastUploadAuthorization,
        }));
      }
      if (!allowIncomplete && !continueOnFailure) throw failure;
      return null;
    }
  }

  await phase("ready-before", async () => {
    const response = await caller("/api/ready");
    expectPostgresReady(response, "READY_NOT_READY");
    return response;
  });

  await phase("owner-controls", async () => {
    const health = await caller("/api/health");
    expectStatus(health, 200, "OWNER_CONTROL_STATE_UNAVAILABLE");
    const alreadyEnabled = collectionControlsAlreadyEnabled(health.body);
    let response = health;
    if (!alreadyEnabled) {
      response = await caller("/api/v1/admin/action", {
        method: "POST",
        cookie: owner.cookie,
        csrf: owner.csrfToken,
        body: {
          action: "set_collection_controls",
          enrollment: true,
          uploadRegistration: true,
          processing: true,
          publication: true,
          reasonCode: "maintenance",
          expectedRevision: controlRevision,
        },
      });
      expectStatus(response, 200, "OWNER_CONTROL_UPDATE_FAILED");
    }
    const session = await caller("/api/v1/session", { cookie: owner.cookie });
    expectStatus(session, 200, "OWNER_SESSION_IDENTITY_INVALID");
    const ownerBody = expectSession(session, {
      participantId: fixture.participantId,
      expiresAt: fixture.expiresAt,
      consentVersion: fixture.consentVersion,
    }, "OWNER_SESSION_IDENTITY_INVALID", { futureAt: Date.now() });
    if (ownerCreatedAt !== null && ownerBody.createdAt !== ownerCreatedAt) {
      fail("OWNER_SESSION_PARTICIPANT_IDENTITY_CHANGED", response.status);
    }
    ownerCreatedAt = ownerBody.createdAt;
    return {
      status: response.status,
      metadata: {
        controlUpdate: alreadyEnabled ? "skipped_already_enabled" : "applied",
      },
    };
  });

  await phase("workload-enroll", async () => {
    const response = await caller("/api/v1/enroll", {
      method: "POST",
      body: { consentVersion: "privacy-safe-telemetry-v0.1", syntheticOnly: false },
    });
    expectStatus(response, 201, "WORKLOAD_ENROLL_FAILED");
    const participantId = response.body?.participantId;
    const csrfToken = response.body?.csrfToken;
    if (!PARTICIPANT_ID.test(participantId) || typeof csrfToken !== "string") fail("WORKLOAD_ENROLL_RESPONSE_INVALID", response.status);
    workload = Object.freeze({ participantId, cookie: sessionCookie(response), csrfToken });
    return response;
  });

  await phase("workload-session", async () => {
    const response = await caller("/api/v1/session", { cookie: workload?.cookie });
    expectStatus(response, 200, "WORKLOAD_SESSION_FAILED");
    const session = expectSession(response, { participantId: workload?.participantId },
      "WORKLOAD_SESSION_RESPONSE_INVALID", { futureAt: Date.now() });
    workload = Object.freeze({
      ...workload,
      participantCreatedAt: session.createdAt,
      expiresAt: session.expiresAt,
      consentVersion: session.consentVersion,
    });
    return response;
  });

  await phase("pair-device", async () => {
    const response = await caller("/api/v1/me/device-pairings", {
      method: "POST",
      cookie: workload?.cookie,
      csrf: workload?.csrfToken,
      body: { ongoingUpload: true, consentVersion: "ongoing-privacy-safe-telemetry-v1.0" },
    });
    expectStatus(response, 201, "DEVICE_PAIRING_FAILED");
    const pairingCode = response.body?.pairingCode;
    if (typeof pairingCode !== "string" || pairingCode.length < 16) fail("DEVICE_PAIRING_RESPONSE_INVALID", response.status);
    device = { pairingCode, id: randomUUID(), secret: randomBytes(32).toString("base64url") };
    return response;
  });

  await phase("claim-device", async () => {
    const response = await caller("/api/v1/device-pairings/claim", {
      method: "POST",
      authorization: `Pairing ${device?.pairingCode}`,
      body: {
        deviceId: device?.id,
        deviceSecretHash: device === null ? undefined : deviceHash(device.id, device.secret),
      },
    });
    expectStatus(response, 201, "DEVICE_CLAIM_FAILED");
    const expiresAt = response.body?.expiresAt;
    if (!validJourneyInstant(expiresAt) || Date.parse(expiresAt) <= Date.now()) {
      fail("DEVICE_CLAIM_EXPIRY_INVALID", response.status);
    }
    device = Object.freeze({
      ...device,
      authorization: `Device um_device_${device.id}.${device.secret}`,
      expiresAt,
    });
    return response;
  });

  await phase("v1-sync-state-before", async () => {
    const response = await caller("/api/v1/device/sync/state", {
      authorization: device?.authorization,
    });
    return expectStatus(response, 200, "V1_SYNC_STATE_FAILED");
  });

  await phase("envelope-key", async () => {
    const response = await caller("/api/v1/envelope-key");
    expectStatus(response, 200, "ENVELOPE_KEY_FAILED");
    if (response.body?.algorithm !== "RSA-OAEP-256") fail("ENVELOPE_KEY_RESPONSE_INVALID", response.status);
    v1 = { key: response.body };
    return response;
  });

  async function authorizeAndUpload(raw, schemaVersion, deviceValue = device) {
    const authorization = await caller("/api/v1/device/upload-authorizations", {
      method: "POST",
      authorization: deviceValue?.authorization,
      body: {
        envelopeDigest: sha256Hex(raw),
        contentLengthBytes: encoder.encode(raw).byteLength,
        contentType: "application/json",
        telemetrySchemaVersion: schemaVersion,
      },
    });
    expectStatus(authorization, 201, "UPLOAD_AUTHORIZATION_FAILED");
    const uploadAuthorization = authorization.body?.uploadAuthorization;
    if (typeof uploadAuthorization !== "string" || uploadAuthorization.length < 16) {
      fail("UPLOAD_AUTHORIZATION_RESPONSE_INVALID", authorization.status);
    }
    lastUploadAuthorization = Object.freeze({
      token: uploadAuthorization,
      schemaVersion,
      envelopeDigest: sha256Hex(raw),
    });
    const upload = await caller("/api/v1/contributions", {
      method: "POST",
      authorization: `Upload ${uploadAuthorization}`,
      body: raw,
    });
    expectStatus(upload, 202, "CONTRIBUTION_UPLOAD_FAILED");
    return { authorization, upload };
  }

  await phase("v1-upload", async () => {
    const chunk = v1Chunk(seedFixture.day);
    assertLegacyV1Unattributed(chunk.chunk);
    const raw = await encryptEnvelope(v1?.key, chunk.chunk, "telemetry-envelope-v1.0");
    v1 = Object.freeze({ ...v1, ...chunk, raw, first: null });
    const result = await authorizeAndUpload(raw, "telemetry-contribution-v1.0");
    const body = expectObject(result.upload.body, "V1_UPLOAD_RESPONSE_INVALID");
    if (body.schemaVersion !== "telemetry-chunk-receipt-v1.0"
        || body.status !== "accepted"
        || body.chunkId !== chunk.chunk.chunkId
        || body.chunkRevision !== chunk.chunk.chunkRevision
        || typeof body.contributionId !== "string") {
      fail("V1_UPLOAD_RESPONSE_INVALID", result.upload.status);
    }
    expectRecordCounts(body.recordCounts, "V1_UPLOAD_RESPONSE_INVALID");
    v1 = Object.freeze({ ...v1, first: result.upload.body });
    return result.upload;
  });

  await phase("v1-replay", async () => {
    const result = await authorizeAndUpload(v1?.raw, "telemetry-contribution-v1.0");
    const body = expectObject(result.upload.body, "V1_REPLAY_RESPONSE_INVALID");
    if (body.schemaVersion !== "telemetry-chunk-receipt-v1.0"
        || body.replayed !== true
        || body.contributionId !== v1?.first?.contributionId
        || body.chunkId !== v1?.chunk?.chunkId
        || body.chunkRevision !== v1?.chunk?.chunkRevision) {
      fail("V1_REPLAY_RESPONSE_INVALID", result.upload.status);
    }
    expectRecordCounts(body.recordCounts, "V1_REPLAY_RESPONSE_INVALID");
    return result.upload;
  });

  await phase("v1-sync-state-after", async () => {
    const response = await caller("/api/v1/device/sync/state", {
      authorization: device?.authorization,
    });
    return expectStatus(response, 200, "V1_SYNC_STATE_AFTER_FAILED");
  });

  await phase("v11-consent", async () => {
    const response = await caller("/api/v1/me/device-telemetry-consents", {
      method: "POST",
      cookie: workload?.cookie,
      csrf: workload?.csrfToken,
      body: {
        deviceId: device?.id,
        ongoingUpload: true,
        consent: {
          telemetrySchemaVersion: "telemetry-contribution-v1.1",
          fieldDictionaryVersion: "telemetry-v1.1-registry-2026-08-31.1",
          privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.1",
        },
      },
    });
    return expectStatus(response, 201, "V11_CONSENT_FAILED");
  });

  await phase("v11-capabilities", async () => {
    const response = await caller("/api/v1/device/sync-capabilities?schemaVersion=telemetry-contribution-v1.1", {
      authorization: device?.authorization,
    });
    expectStatus(response, 200, "V11_CAPABILITIES_FAILED");
    if (response.body?.schemaVersion !== "device-sync-capabilities-v1.1") {
      fail("V11_CAPABILITIES_RESPONSE_INVALID", response.status);
    }
    return response;
  });

  await phase("v11-upload-and-activation", async () => {
    if (device === null) fail("V11_DEVICE_MISSING");
    const targetDay = seedFixture.day;
    const targetSlot = seedFixture.baseSlot;
    const resetDay = addDays(targetDay, 7);
    const days = journeyHistoryDays(targetDay);
    const legacyUsageRecord = v1?.chunk?.records?.[0] ?? null;
    if (legacyUsageRecord === null) fail("V11_LEGACY_SOURCE_MISSING");
    const preparedDays = days.map((day) => richV11Day(day, {
      baseSlot: day === targetDay ? targetSlot : JOURNEY_RICH_START_SLOT, resetDay,
      legacyUsageRecord: day === targetDay ? legacyUsageRecord : null,
    }));
    if (days.length !== JOURNEY_HISTORY_DAY_COUNT) fail("V11_HISTORICAL_DAY_WINDOW_INVALID");
    for (const day of preparedDays) {
      assertModernAttribution(day, "v1.1");
      assertSevenDayResetFit(day, resetDay, "v1.1");
    }
    const trailingDays = journeyTrailingCurrentDays(targetDay);
    const preparedByDay = new Map([
      ...preparedDays.map((day) => [day.manifest.day, day]),
      ...trailingDays.map((day) => [day, emptyV11Day(day)]),
    ]);
    const expectedSyncDayCount = days.length + trailingDays.length;
    const chunkRefs = expectedChunkRefs(preparedDays, "v1.1");
    const progress = { value: null };
    const publication = {
      fingerprint: "gcp-journey-v11-mixed",
      parserVersion: "gcp-cloud-run-journey-v11",
    };
    const syncOptions = {
      serverBaseUrl: `${baseOrigin}/`,
      deviceAuthorization: device.authorization,
      consent: telemetryV11RequiredConsent(),
      days,
      readDay: async (day) => preparedByDay.get(day) ?? fail("V11_FIXTURE_DAY_MISSING"),
      createEnvelope: async (chunk) => encryptEnvelopeForSync(v1?.key, chunk, "telemetry-envelope-v1.1"),
      fetchImpl: caller.fetch,
      progressStore: {
        async read() { return progress.value; },
        async write(value) { progress.value = value; },
      },
      sourcePublication: publication,
      maxDurationMs: 180_000,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    };
    const fresh = await runSyncWithBoundedRetry(runTelemetryV11Sync, { ...syncOptions, maxChunks: 1 });
    if (fresh.status !== "partial" || fresh.chunksUploaded !== 1) {
      fail("V11_CLIENT_FRESH_NOT_PARTIAL", undefined, syncOutcomeDiagnostics(fresh, "v1.1"));
    }
    const resumed = await runSyncWithBoundedRetry(runTelemetryV11Sync, syncOptions);
    if (resumed.status !== "complete" || resumed.daysSynced !== expectedSyncDayCount
        || resumed.chunksSkipped < 1 || progress.value !== null) {
      fail("V11_CLIENT_RESUME_FAILED", undefined, syncOutcomeDiagnostics(resumed, "v1.1"));
    }
    const receipts = bindChunkReceipts(capturedReceipts, chunkRefs, "v1.1");
    const v11SyncSummary = Object.freeze({
      freshStatus: fresh.status,
      resumedStatus: resumed.status,
      retainedDays: days.length - 1,
      daysSynced: resumed.daysSynced,
      chunksUploaded: resumed.chunksUploaded,
      recordsUploaded: resumed.recordsUploaded,
    });
    v11 = Object.freeze({ chunks: chunkRefs, receipts, sync: v11SyncSummary });
    return { status: 201, metadata: v11SyncSummary };
  });

  await phase("v12-consent", async () => {
    if (deviceV12 === null) {
      const pairingResponse = await caller("/api/v1/me/device-pairings", {
        method: "POST",
        cookie: workload?.cookie,
        csrf: workload?.csrfToken,
        body: { ongoingUpload: true, consentVersion: "ongoing-privacy-safe-telemetry-v1.0" },
      });
      expectStatus(pairingResponse, 201, "V12_DEVICE_PAIRING_FAILED");
      const pairingCode = pairingResponse.body?.pairingCode;
      if (typeof pairingCode !== "string" || pairingCode.length < 16) {
        fail("V12_DEVICE_PAIRING_RESPONSE_INVALID", pairingResponse.status);
      }
      const candidate = { pairingCode, id: randomUUID(), secret: randomBytes(32).toString("base64url") };
      const claimResponse = await caller("/api/v1/device-pairings/claim", {
        method: "POST",
        authorization: `Pairing ${candidate.pairingCode}`,
        body: { deviceId: candidate.id, deviceSecretHash: deviceHash(candidate.id, candidate.secret) },
      });
      expectStatus(claimResponse, 201, "V12_DEVICE_CLAIM_FAILED");
      const expiresAt = claimResponse.body?.expiresAt;
      if (!validJourneyInstant(expiresAt) || Date.parse(expiresAt) <= Date.now()) {
        fail("V12_DEVICE_CLAIM_EXPIRY_INVALID", claimResponse.status);
      }
      deviceV12 = Object.freeze({
        ...candidate,
        authorization: `Device um_device_${candidate.id}.${candidate.secret}`,
        expiresAt,
      });
    }
    const response = await caller("/api/v1/me/device-telemetry-consents", {
      method: "POST",
      cookie: workload?.cookie,
      csrf: workload?.csrfToken,
      body: { deviceId: deviceV12?.id, ongoingUpload: true, consent: telemetryV12RequiredConsent() },
    });
    return expectStatus(response, 201, "V12_CONSENT_FAILED");
  });

  await phase("v12-capabilities", async () => {
    const response = await caller("/api/v1/device/sync-capabilities-v1.2?schemaVersion=telemetry-contribution-v1.2", {
      authorization: deviceV12?.authorization,
    });
    expectStatus(response, 200, "V12_CAPABILITIES_FAILED");
    if (response.body?.schemaVersion !== "device-sync-capabilities-v1.2") {
      fail("V12_CAPABILITIES_RESPONSE_INVALID", response.status);
    }
    return response;
  });

  await phase("v12-upload-and-activation", async () => {
    if (deviceV12 === null) fail("V12_DEVICE_MISSING");
    const targetDay = seedFixture.day;
    const targetSlot = seedFixture.baseSlot;
    const resetDay = addDays(targetDay, 7);
    const days = journeyHistoryDays(targetDay);
    const legacyUsageRecord = v1?.chunk?.records?.[0] ?? null;
    if (legacyUsageRecord === null) fail("V12_LEGACY_SOURCE_MISSING");
    const preparedDays = days.map((day) => richV12Day(day, {
      baseSlot: day === targetDay ? targetSlot : JOURNEY_RICH_START_SLOT, resetDay,
      legacyUsageRecord: day === targetDay ? legacyUsageRecord : null,
    }));
    if (days.length !== JOURNEY_HISTORY_DAY_COUNT) fail("V12_HISTORICAL_DAY_WINDOW_INVALID");
    for (const day of preparedDays) {
      assertModernAttribution(day, "v1.2");
      assertSevenDayResetFit(day, resetDay, "v1.2");
    }
    const trailingDays = journeyTrailingCurrentDays(targetDay);
    const preparedByDay = new Map([
      ...preparedDays.map((day) => [day.manifest.day, day]),
      ...trailingDays.map((day) => [day, emptyV12Day(day)]),
    ]);
    const expectedSyncDayCount = days.length + trailingDays.length;
    const chunkRefs = expectedChunkRefs(preparedDays, "v1.2");
    const target = preparedByDay.get(targetDay);
    if (target === undefined) fail("V12_FIXTURE_DAY_MISSING");
    const targetChunk = target.chunks.find((chunk) => chunk.chunkId.startsWith("usage:"));
    if (!targetChunk || target.chunks.find((chunk) => chunk.chunkId.startsWith("quota:"))?.records.length !== 20
        || targetChunk.records.length !== JOURNEY_RICH_RECORD_COUNT / 2 + 1
        || target.chunks.find((chunk) => chunk.chunkId.startsWith("session:"))?.records.length !== 1) {
      fail("V12_RICH_FIXTURE_INVALID");
    }
    const progress = { value: null };
    const publication = {
      fingerprint: "gcp-journey-v12-rich-mixed",
      parserVersion: "gcp-cloud-run-journey-v12",
    };
    const readDay = async (day) => preparedByDay.get(day) ?? fail("V12_FIXTURE_DAY_MISSING");
    const createEnvelope = async (chunk) => encryptEnvelopeForSync(
      v1?.key,
      chunk,
      "telemetry-envelope-v1.2",
    );
    const syncOptions = {
      serverBaseUrl: `${baseOrigin}/`,
      deviceAuthorization: deviceV12.authorization,
      consent: telemetryV12RequiredConsent(),
      days,
      readDay,
      createEnvelope,
      fetchImpl: caller.fetch,
      progressStore: {
        async read() { return progress.value; },
        async write(value) { progress.value = value; },
      },
      sourcePublication: publication,
      maxDurationMs: 180_000,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    };
    const fresh = await runSyncWithBoundedRetry(runTelemetryV12Sync, { ...syncOptions, maxChunks: 1 });
    if (fresh.status !== "partial" || fresh.chunksUploaded !== 1) {
      fail("V12_CLIENT_FRESH_NOT_PARTIAL", undefined, syncOutcomeDiagnostics(fresh, "v1.2"));
    }
    const resumed = await runSyncWithBoundedRetry(runTelemetryV12Sync, syncOptions);
    if (resumed.status !== "complete" || resumed.daysSynced !== expectedSyncDayCount
        || resumed.chunksSkipped < 1 || progress.value !== null) {
      fail("V12_CLIENT_RESUME_FAILED", undefined, syncOutcomeDiagnostics(resumed, "v1.2"));
    }
    const sameDay = await runSyncWithBoundedRetry(runTelemetryV12Sync, {
      ...syncOptions, progressStore: null,
    });
    if (sameDay.status !== "complete" || sameDay.daysSynced !== expectedSyncDayCount) {
      fail("V12_CLIENT_SAME_DAY_FAILED", undefined, syncOutcomeDiagnostics(sameDay, "v1.2"));
    }
    const raw = await encryptEnvelope(v1?.key, targetChunk, "telemetry-envelope-v1.2");
    const replay = await authorizeAndUpload(raw, "telemetry-contribution-v1.2", deviceV12);
    const replayBody = expectObject(replay.upload.body, "V12_REPLAY_RESPONSE_INVALID");
    if (replayBody.schemaVersion !== "telemetry-chunk-receipt-v1.2"
        || replayBody.replayed !== true
        || typeof replayBody.contributionId !== "string"
        || replayBody.chunkId !== targetChunk.chunkId) {
      fail("V12_REPLAY_RESPONSE_INVALID", replay.upload.status);
    }
    expectRecordCounts(replayBody.recordCounts, "V12_REPLAY_RESPONSE_INVALID", targetChunk.records.length);
    captureContributionReceipt(capturedReceipts, replayBody);
    // Bind the original generation before its same-day successor creates a
    // second receipt for the same chunk IDs.  The export contract includes
    // both immutable generations, while the effective fixture below points at
    // the new target generation.
    const initialReceipts = bindChunkReceipts(capturedReceipts, chunkRefs, "v1.2");

    const successorTarget = richV12Day(targetDay, {
      additional: true,
      baseSlot: targetSlot,
      resetDay,
      legacyUsageRecord,
    });
    assertModernAttribution(successorTarget, "v1.2");
    const successorTargetChunk = successorTarget.chunks.find((chunk) => chunk.chunkId.startsWith("usage:"));
    const successorTargetQuota = successorTarget.chunks.find((chunk) => chunk.chunkId.startsWith("quota:"));
    const successorTargetSession = successorTarget.chunks.find((chunk) => chunk.chunkId.startsWith("session:"));
    if (!successorTargetChunk || successorTargetChunk.records.length !== JOURNEY_RICH_RECORD_COUNT / 2 + 2
        || successorTargetQuota?.records.length !== JOURNEY_RICH_RECORD_COUNT / 2 + 1
        || successorTargetSession?.records.length !== 1) {
      fail("V12_SUCCESSOR_FIXTURE_INVALID");
    }
    const successorPreservation = assertAdditiveSuccessorPreserves(target, successorTarget);
    const successorByDay = new Map(preparedByDay);
    successorByDay.set(targetDay, successorTarget);
    const successorReadDay = async (day) => (
      successorByDay.get(day) ?? fail("V12_SUCCESSOR_FIXTURE_DAY_MISSING")
    );
    // The active predecessor spans the five rich days and any explicit empty
    // current-day tail. Supplying only the target day asks the local client to
    // expand that predecessor range; the reader returns unchanged historical
    // days, empty tail coverage, and this new target candidate.
    const additive = await runSyncWithBoundedRetry(runTelemetryV12Sync, {
      ...syncOptions,
      days: [targetDay],
      readDay: successorReadDay,
      progressStore: null,
    });
    const retainedChunkCount = chunkRefs.length - target.chunks.length;
    if (additive.status !== "complete" || additive.daysSynced !== expectedSyncDayCount
        || additive.chunksUploaded < successorTarget.chunks.length
        || additive.chunksSkipped < retainedChunkCount) {
      fail("V12_CLIENT_ADDITIVE_SUCCESSOR_FAILED", undefined, syncOutcomeDiagnostics(additive, "v1.2"));
    }

    const successorRaw = await encryptEnvelope(v1?.key, successorTargetChunk, "telemetry-envelope-v1.2");
    const successorReplay = await authorizeAndUpload(
      successorRaw, "telemetry-contribution-v1.2", deviceV12,
    );
    const successorReplayBody = expectObject(successorReplay.upload.body, "V12_SUCCESSOR_REPLAY_INVALID");
    if (successorReplayBody.schemaVersion !== "telemetry-chunk-receipt-v1.2"
        || successorReplayBody.replayed !== true
        || typeof successorReplayBody.contributionId !== "string"
        || successorReplayBody.chunkId !== successorTargetChunk.chunkId) {
      fail("V12_SUCCESSOR_REPLAY_INVALID", successorReplay.upload.status);
    }
    expectRecordCounts(
      successorReplayBody.recordCounts,
      "V12_SUCCESSOR_REPLAY_INVALID",
      successorTargetChunk.records.length,
    );
    captureContributionReceipt(capturedReceipts, successorReplayBody);
    const successorChunkRefs = expectedChunkRefs([successorTarget], "v1.2");
    const successorReceipts = bindChunkReceipts(
      capturedReceipts,
      successorChunkRefs,
      "v1.2",
      { preferLatest: true },
    );
    const receipts = [...initialReceipts, ...successorReceipts];
    const allChunkRefs = [...chunkRefs, ...successorChunkRefs];
    const v12SyncSummary = Object.freeze({
      targetUsageRecords: successorTargetChunk.records.length,
      targetQuotaRecords: successorTargetQuota.records.length,
      retainedDays: days.length - 1,
      daysSynced: resumed.daysSynced,
      freshStatus: fresh.status,
      resumedStatus: resumed.status,
      sameDayStatus: sameDay.status,
      additiveStatus: additive.status,
      additiveDaysSynced: additive.daysSynced,
      additiveChunksUploaded: additive.chunksUploaded,
      additiveChunksSkipped: additive.chunksSkipped,
      successorPreservedRecords: successorPreservation.predecessorRecords,
      successorRecords: successorPreservation.successorRecords,
    });
    v12 = Object.freeze({
      fixture: { day: targetDay, chunk: successorTargetChunk, manifest: successorTarget.manifest },
      chunks: allChunkRefs,
      receipts,
      raw: successorRaw,
      first: successorReplayBody,
      replay: successorReplayBody,
      sync: v12SyncSummary,
    });
    return { status: successorReplay.upload.status, metadata: v12.sync };
  });

  await phase("owner-scheduler", async () => {
    return runMaintenanceUntilPublished(caller, owner);
  });

  await phase("owner-allowance-preview", async () => {
    const day = seedFixture.day;
    const response = await caller("/api/v1/admin/community/allowance-preview", {
      cookie: owner.cookie,
    });
    expectStatus(response, 200, "OWNER_ALLOWANCE_PREVIEW_FAILED");
    const metadata = expectAllowancePreview(response, day);
    return { status: response.status, metadata };
  });

  await phase("public-results", async () => {
    const day = seedFixture.day;
    if (!DAY.test(day)) fail("PUBLIC_DAY_INVALID");
    const days = journeyHistoryDays(day);
    const response = await caller(`/api/v1/community/daily?from=${days[0]}&to=${days.at(-1)}`);
    expectStatus(response, 200, "PUBLIC_RESULTS_FAILED");
    expectPublicDaily(response, days, false, workload, v1, v12, v11);
    return response;
  });

  await phase("owner-negative-auth", async () => {
    const ordinary = await caller("/api/v1/admin/action", {
      method: "POST",
      cookie: workload?.cookie,
      csrf: workload?.csrfToken,
      body: { action: "run_maintenance" },
    });
    expectStatus(ordinary, 403, "ORDINARY_ADMIN_ALLOWED");
    const missingCsrf = await caller("/api/v1/admin/action", {
      method: "POST",
      cookie: owner.cookie,
      body: { action: "run_maintenance" },
    });
    return expectStatus(missingCsrf, 403, "OWNER_CSRF_NOT_REQUIRED");
  });

  await phase("participant-export", async () => {
    const response = await caller("/api/v1/me/export", { cookie: workload?.cookie });
    expectStatus(response, 200, "PARTICIPANT_EXPORT_FAILED");
    expectExport(response, workload, v1, v11, v12);
    return response;
  });

  await phase("owner-erasure", async () => {
    const erasureStartedAt = Date.now();
    // A cleanup phase may be recovering a seed that stopped before the
    // successor consent/capability phases. The owner fixture is still
    // required to be live by parseFixture(), so owner-only erasure remains
    // authorized; absent successor credentials are simply not part of this
    // partial cleanup. The full erase/all qualification keeps the stricter
    // natural-expiry proof below.
    const partialCleanup = args.phase === "cleanup";
    if (!partialCleanup && (workload?.expiresAt === undefined
        || !validJourneyInstant(workload.expiresAt)
        || Date.parse(workload.expiresAt) <= erasureStartedAt
        || device?.expiresAt === undefined
        || !validJourneyInstant(device.expiresAt)
        || Date.parse(device.expiresAt) <= erasureStartedAt
        || deviceV12?.expiresAt === undefined
        || !validJourneyInstant(deviceV12.expiresAt)
        || Date.parse(deviceV12.expiresAt) <= erasureStartedAt)) {
      fail("WORKLOAD_CREDENTIAL_NATURALLY_EXPIRED");
    }
    // Persist the observation before the destructive request so a restored
    // refusal can be distinguished from a session that simply aged out.
    erasureAt = new Date(erasureStartedAt).toISOString();
    const response = await caller("/api/v1/admin/action", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: {
        action: "run_maintenance",
        participantErasure: {
          participantId: workload?.participantId,
          confirmation: "erase_hosted_participant",
        },
      },
    });
    expectStatus(response, 200, "OWNER_ERASURE_FAILED");
    const body = expectObject(response.body, "OWNER_ERASURE_RESPONSE_INVALID");
    const result = expectObject(body.result, "OWNER_ERASURE_RESPONSE_INVALID");
    if (body.schemaVersion !== "admin-action-v0.1"
        || body.action !== "run_maintenance"
        || result.task !== "participant_erasure"
        || typeof result.operationId !== "string"
        || result.deleted !== true
        || (result.alreadyDeleted !== true && result.alreadyDeleted !== false)
        || (result.contributionsDeleted !== null
          && !Number.isSafeInteger(result.contributionsDeleted))) {
      fail("OWNER_ERASURE_RESPONSE_INVALID", response.status);
    }
    const repeat = await caller("/api/v1/admin/action", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: {
        action: "run_maintenance",
        participantErasure: {
          participantId: workload?.participantId,
          confirmation: "erase_hosted_participant",
        },
      },
    });
    expectStatus(repeat, 200, "OWNER_ERASURE_REPLAY_FAILED");
    const repeatResult = expectObject(repeat.body?.result, "OWNER_ERASURE_REPLAY_INVALID");
    if (repeatResult.task !== "participant_erasure" || repeatResult.alreadyDeleted !== true) {
      fail("OWNER_ERASURE_REPLAY_INVALID", repeat.status);
    }
    const workloadSession = await caller("/api/v1/session", { cookie: workload?.cookie });
    expectStatus(workloadSession, [401, 403, 404], "ERASED_WORKLOAD_SESSION_ALLOWED");
    if (device !== null) {
      const workloadDevice = await caller("/api/v1/device/sync/state", {
        authorization: device.authorization,
      });
      expectStatus(workloadDevice, [401, 403, 404], "ERASED_WORKLOAD_DEVICE_ALLOWED");
    }
    if (device !== null && v11 !== null) {
      const workloadDeviceV11 = await caller(
        "/api/v1/device/sync-capabilities?schemaVersion=telemetry-contribution-v1.1",
        { authorization: device.authorization },
      );
      expectCapabilityRefusal(workloadDeviceV11, "ERASED_WORKLOAD_V11_DEVICE_ALLOWED");
    }
    if (deviceV12 !== null && v12 !== null) {
      const workloadDeviceV12 = await caller(
        "/api/v1/device/sync-capabilities-v1.2?schemaVersion=telemetry-contribution-v1.2",
        { authorization: deviceV12.authorization },
      );
      expectStatus(workloadDeviceV12, [401, 403, 404], "ERASED_WORKLOAD_V12_DEVICE_ALLOWED");
    }
    const workloadExport = await caller("/api/v1/me/export", { cookie: workload?.cookie });
    expectStatus(workloadExport, [401, 403, 404], "ERASED_WORKLOAD_EXPORT_ALLOWED");
    const day = seedFixture.day;
    const days = journeyHistoryDays(day);
    if (days.some((candidate) => !DAY.test(candidate))) fail("ERASED_DAY_INVALID");
    const publicResults = await caller(`/api/v1/community/daily?from=${days[0]}&to=${days.at(-1)}`);
    expectStatus(publicResults, 200, "ERASED_PUBLIC_RESULTS_FAILED");
    expectPublicDaily(publicResults, days, true, workload, v1, v12, v11);
    const allowancePreview = await caller("/api/v1/admin/community/allowance-preview", {
      cookie: owner.cookie,
    });
    const allowanceProof = allowancePreview.status === 503
      && allowancePreview.body?.error?.code === "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE"
      ? await readErasedAllowanceCacheProof(caller, owner)
      : undefined;
    const allowanceMetadata = expectErasedAllowancePreview(allowancePreview, day, allowanceProof);
    return { response, allowanceMetadata };
  });

  await phase("owner-survives-erasure", async () => {
    const response = await caller("/api/v1/session", { cookie: owner.cookie });
    expectStatus(response, 200, "OWNER_ERASURE_STRANDED_OWNER");
    expectSession(response, {
      participantId: fixture.participantId,
      participantCreatedAt: ownerCreatedAt,
      expiresAt: fixture.expiresAt,
      consentVersion: fixture.consentVersion,
    }, "OWNER_ERASURE_STRANDED_OWNER", { futureAt: Date.now() });
    return response;
  });

  await phase("ready-after", async () => {
    const response = await caller("/api/ready");
    expectPostgresReady(response, "READY_AFTER_FAILED");
    return response;
  });

  const restoredBase = optional("JOURNEY_RESTORED_BASE_URL");
  if (restoredBase === undefined) {
    if (requireRestore) fail("JOURNEY_RESTORE_BASE_URL_MISSING");
    if (selectedNames === null || selectedNames.has("restored-owner-admission")) {
      phases.push({ name: "restored-owner-admission", status: "skipped", code: "RESTORE_BASE_URL_MISSING" });
    }
  } else {
    await phase("restored-owner-admission", async () => {
      const restoredOrigin = origin(restoredBase, "JOURNEY_RESTORED_BASE_URL");
      const restoredCaller = createCaller(
        restoredOrigin,
        origin(optional("JOURNEY_RESTORED_IAM_AUDIENCE", restoredOrigin), "JOURNEY_RESTORED_IAM_AUDIENCE"),
        { explicitToken, useGcloudIamToken: args.gcloudIamToken, gcloudProject },
      );
      const ready = await restoredCaller("/api/ready");
      expectPostgresReady(ready, "RESTORED_READY_FAILED");
      const health = await restoredCaller("/api/health");
      expectPostgresHealth(health, "RESTORED_HEALTH_FAILED");
      const session = await restoredCaller("/api/v1/session", { cookie: owner.cookie });
      expectStatus(session, 200, "RESTORED_OWNER_SUPPRESSED");
      expectSession(session, {
        participantId: fixture.participantId,
        participantCreatedAt: ownerCreatedAt,
        expiresAt: fixture.expiresAt,
        consentVersion: fixture.consentVersion,
      }, "RESTORED_OWNER_IDENTITY_INVALID", { futureAt: Date.now() });
      if (erasureAt === null || !validJourneyInstant(erasureAt)
          || workload?.expiresAt === undefined
          || !validJourneyInstant(workload.expiresAt)
          || Date.parse(workload.expiresAt) <= Date.parse(erasureAt)
          || device?.expiresAt === undefined
          || !validJourneyInstant(device.expiresAt)
          || Date.parse(device.expiresAt) <= Date.parse(erasureAt)
          || deviceV12?.expiresAt === undefined
          || !validJourneyInstant(deviceV12.expiresAt)
          || Date.parse(deviceV12.expiresAt) <= Date.parse(erasureAt)) {
        fail("RESTORE_REVOCATION_PROOF_INVALID");
      }
      const restoredAt = Date.now();
      const credentialExpiries = [workload.expiresAt, device.expiresAt, deviceV12.expiresAt];
      if (credentialExpiries.some((value) => !validJourneyInstant(value) || Date.parse(value) <= restoredAt)) {
        return {
          phaseStatus: "inconclusive",
          metadata: { credentialNaturallyExpired: true },
        };
      }
      const workloadSession = await restoredCaller("/api/v1/session", { cookie: workload?.cookie });
      expectStatus(workloadSession, [401, 403, 404], "RESTORED_WORKLOAD_SESSION_ALLOWED");
      const workloadDevice = await restoredCaller("/api/v1/device/sync/state", {
        authorization: device?.authorization,
      });
      expectStatus(workloadDevice, [401, 403, 404], "RESTORED_WORKLOAD_DEVICE_ALLOWED");
      const workloadDeviceV11 = await restoredCaller(
        "/api/v1/device/sync-capabilities?schemaVersion=telemetry-contribution-v1.1",
        { authorization: device?.authorization },
      );
      expectCapabilityRefusal(workloadDeviceV11, "RESTORED_WORKLOAD_V11_DEVICE_ALLOWED");
      const workloadDeviceV12 = await restoredCaller(
        "/api/v1/device/sync-capabilities-v1.2?schemaVersion=telemetry-contribution-v1.2",
        { authorization: deviceV12?.authorization },
      );
      expectStatus(workloadDeviceV12, [401, 403, 404], "RESTORED_WORKLOAD_V12_DEVICE_ALLOWED");
      const workloadExport = await restoredCaller("/api/v1/me/export", { cookie: workload?.cookie });
      expectStatus(workloadExport, [401, 403, 404], "RESTORED_WORKLOAD_EXPORT_ALLOWED");
      const day = seedFixture.day;
      const days = journeyHistoryDays(day);
      if (days.some((candidate) => !DAY.test(candidate))) fail("RESTORED_DAY_INVALID");
      const publicResults = await restoredCaller(`/api/v1/community/daily?from=${days[0]}&to=${days.at(-1)}`);
      expectStatus(publicResults, 200, "RESTORED_PUBLIC_RESULTS_FAILED");
      expectPublicDaily(publicResults, days, true, workload, v1, v12, v11);
      const allowancePreview = await restoredCaller("/api/v1/admin/community/allowance-preview", {
        cookie: owner.cookie,
      });
      const allowanceProof = allowancePreview.status === 503
        && allowancePreview.body?.error?.code === "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE"
        ? await readErasedAllowanceCacheProof(restoredCaller, owner)
        : undefined;
      const allowanceMetadata = expectErasedAllowancePreview(allowancePreview, day, allowanceProof);
      return { session, allowanceMetadata };
    });
  }

  const inconclusive = phases.some((phase) => phase.status === "inconclusive");
  if (stateDir !== undefined && args.phase !== "all" && failure === null && !inconclusive) {
    await writeJourneyState(stateDir, journeyStateSnapshot({
      // A resume is a state transition only after every remaining seed read
      // check passes.  Failures remain seed-progress journals above.
      phase: args.phase === "resume-seed" ? "seeded" : PHASE_STATE[args.phase],
      baseOrigin,
      seedFixture,
      ownerCreatedAt,
      workload,
      device,
      deviceV12,
      v1,
      v11,
      v12,
      erasureAt,
      uploadAuthorization: lastUploadAuthorization,
    }));
  }

  return {
    baseOrigin, phases, owner, workload, device, deviceV12, v1, v11, v12, failure,
    inconclusive, phase: args.phase,
  };
}

export {
  assertModernAttribution,
  assertSevenDayResetFit,
  expectAllowancePreview,
  expectErasedAllowancePreview,
  legacyPartialCleanupSeedFixtureFromNow,
  journeyTargetDay,
  journeyTrailingCurrentDays,
  seedFixtureFromNow,
  targetBaseSlot,
  emptyV11Day,
  emptyV12Day,
  richV11Day,
  richV12Day,
  assertAdditiveSuccessorPreserves,
  assertResumeSeedJournal,
  journeyStateSnapshot,
  runMaintenanceUntilPublished,
  encryptEnvelopeForSync,
  runSyncWithBoundedRetry,
  syncOutcomeDiagnostics,
  collectionControlsAlreadyEnabled,
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = await run();
    if (result?.help === true) {
      console.log(journeyUsage());
      process.exitCode = 0;
    } else {
    const status = result.failure === null
      ? result.inconclusive === true ? "inconclusive" : "ok"
      : result.failure.code === "JOURNEY_STOPPED" ? "stopped" : "partial";
    const restorePassed = result.phases.some((phase) => (
      phase.name === "restored-owner-admission" && phase.status === "passed"
    ));
    const qualified = result.failure === null
      && (result.phase === "all" || result.phase === "verify")
      && restorePassed;
    console.log(JSON.stringify({
      status,
      mode: result.phase === "cleanup" ? "gcp-http-journey-cleanup" : "gcp-http-journey",
      qualified,
      phase: result.phase,
      phaseCount: result.phases.length,
      phases: result.phases,
      workloadEnrolled: result.workload !== null,
      deviceClaimed: result.device !== null && result.failure === null,
    }));
    if ((status === "partial" || status === "inconclusive")
        && !booleanEnv("JOURNEY_ALLOW_INCOMPLETE", false)) process.exitCode = 1;
    }
  } catch (error) {
    const code = error instanceof JourneyError && typeof error.code === "string"
      ? error.code : "JOURNEY_FAILED";
    const diagnostic = error instanceof JourneyError ? error.details : undefined;
    console.log(JSON.stringify({ status: "error", mode: "gcp-http-journey", qualified: false, code,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    }));
    process.exitCode = 1;
  }
}
