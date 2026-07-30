import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { syncDirectory } from "./storage.js";
import {
  TELEMETRY_CONTRIBUTION_VERSION,
} from "./telemetry-contribution-builder.js";
import {
  TELEMETRY_V01_REGISTRY_VERSION,
} from "./export-registries.js";

export const AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION =
  "automatic-contribution-settings-v0.3";
export const AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION =
  "automatic-contribution-status-v0.1";
export const AUTOMATIC_CONTRIBUTION_PRIVACY_CONTRACT_VERSION =
  "ongoing-privacy-safe-telemetry-v0.1";
export const AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS = 6;
export const AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS = 24;
export const AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS = 1;

const INTERVAL_MILLISECONDS =
  AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS * 60 * 60 * 1_000;
const DEFAULT_RUN_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;
const MAXIMUM_SETTINGS_BYTES = 64 * 1_024;
const MAXIMUM_INSTANCE_LOCK_BYTES = 4 * 1_024;
const INSTANCE_LOCK_SCHEMA_VERSION =
  "automatic-contribution-instance-lock-v0.1";
const INSTANCE_LOCK_KEYS = Object.freeze([
  "createdAt",
  "nonce",
  "pid",
  "schemaVersion",
]);
const SETTINGS_KEYS = Object.freeze([
  "acceptedThrough",
  "consent",
  "enabled",
  "intervalHours",
  "lastAttemptAt",
  "lastOutcome",
  "lastSuccessAt",
  "paused",
  "pendingContribution",
  "preparationClaim",
  "reviewBootstrap",
  "schemaVersion",
]);
const VERSION_TWO_SETTINGS_KEYS = Object.freeze([
  "acceptedThrough",
  "consent",
  "enabled",
  "intervalHours",
  "lastAttemptAt",
  "lastOutcome",
  "lastSuccessAt",
  "paused",
  "pendingContribution",
  "reviewBootstrap",
  "schemaVersion",
]);
const LEGACY_SETTINGS_KEYS = Object.freeze([
  "consent",
  "enabled",
  "intervalHours",
  "lastAttemptAt",
  "lastOutcome",
  "lastSuccessAt",
  "paused",
  "reviewBootstrap",
  "schemaVersion",
]);
const CONSENT_KEYS = Object.freeze([
  "consentedAt",
  "destinationOrigin",
  "fieldDictionaryVersion",
  "privacyContractVersion",
  "telemetrySchemaVersion",
]);
const REQUIRED_CONSENT_KEYS = Object.freeze([
  "destinationOrigin",
  "fieldDictionaryVersion",
  "privacyContractVersion",
  "telemetrySchemaVersion",
]);
const REVIEW_BOOTSTRAP_KEYS = Object.freeze([
  "acceptedAt",
  "destinationOrigin",
  "fieldDictionaryVersion",
  "privacyContractVersion",
  "preparedSetId",
  "telemetrySchemaVersion",
]);
const ACCEPTED_THROUGH_KEYS = Object.freeze([
  "acceptedAt",
  "coveredThroughAt",
  "destinationOrigin",
  "fieldDictionaryVersion",
  "privacyContractVersion",
  "telemetrySchemaVersion",
]);
const PENDING_CONTRIBUTION_KEYS = Object.freeze([
  "coveredEndAt",
  "coveredStartAt",
  "destinationOrigin",
  "fieldDictionaryVersion",
  "preparedAt",
  "preparedSetId",
  "privacyContractVersion",
  "telemetrySchemaVersion",
]);
const PREPARATION_CLAIM_KEYS = Object.freeze([
  "acceptedThroughAt",
  "claimedAt",
  "destinationOrigin",
  "fieldDictionaryVersion",
  "lookbackHours",
  "preparationId",
  "preparedSetId",
  "privacyContractVersion",
  "replayOverlapHours",
  "telemetrySchemaVersion",
]);
const PREPARED_SET_STATUS_KEYS = Object.freeze([
  "acceptedJobs",
  "completeAccepted",
  "coveredAt",
  "inFlightJobs",
  "pendingJobs",
  "preparedSetId",
  "rejectedJobs",
  "retryableJobs",
  "totalJobs",
]);
const COVERED_AT_KEYS = Object.freeze(["endAt", "startAt"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OUTCOME_KEYS = Object.freeze(["at", "code", "status"]);
const OUTCOME_CODES = Object.freeze({
  accepted: "succeeded",
  completed: "succeeded",
  no_new_evidence: "skipped",
  retry_scheduled: "failed",
  delivery_rejected: "failed",
  preparation_failed: "failed",
  publication_incomplete: "failed",
  upload_failed: "failed",
  run_timeout: "failed",
  queue_paused: "paused",
  privacy_verification_failed: "paused",
  identity_unavailable: "paused",
});

export class AutomaticContributionError extends Error {
  constructor(code) {
    super("Automatic contribution failed closed");
    this.name = "AutomaticContributionError";
    this.code = `automatic_contribution_${code}`;
  }
}

function fail(code) {
  throw new AutomaticContributionError(code);
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("configuration_invalid");
  return date.toISOString();
}

function nullableTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const normalized = new Date(milliseconds).toISOString();
  return normalized === value ? normalized : null;
}

function normalizedDestinationOrigin(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2_048) {
    fail("configuration_invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("configuration_invalid");
  }
  if (parsed.origin !== value
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== "") {
    fail("configuration_invalid");
  }
  const production = parsed.protocol === "https:"
    && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  const loopbackDevelopment = parsed.protocol === "http:"
    && parsed.hostname === "127.0.0.1"
    && parsed.port !== "";
  if (!production && !loopbackDevelopment) {
    fail("configuration_invalid");
  }
  return parsed.origin;
}

function requiredConsent(destinationOrigin) {
  return Object.freeze({
    telemetrySchemaVersion: TELEMETRY_CONTRIBUTION_VERSION,
    fieldDictionaryVersion: TELEMETRY_V01_REGISTRY_VERSION,
    privacyContractVersion:
      AUTOMATIC_CONTRIBUTION_PRIVACY_CONTRACT_VERSION,
    destinationOrigin,
  });
}

export function automaticContributionRequiredConsent({
  destinationOrigin = null,
} = {}) {
  return requiredConsent(normalizedDestinationOrigin(destinationOrigin));
}

function sameRequiredConsent(value, expected, { persisted = false } = {}) {
  return exactKeys(
    value,
    persisted ? CONSENT_KEYS : REQUIRED_CONSENT_KEYS,
  )
    && (!persisted || nullableTimestamp(value.consentedAt) !== null)
    && value.telemetrySchemaVersion === expected.telemetrySchemaVersion
    && value.fieldDictionaryVersion === expected.fieldDictionaryVersion
    && value.privacyContractVersion === expected.privacyContractVersion
    && value.destinationOrigin === expected.destinationOrigin;
}

function sameReviewBootstrap(value, expected) {
  return exactKeys(value, REVIEW_BOOTSTRAP_KEYS)
    && nullableTimestamp(value.acceptedAt) !== null
    && SHA256.test(value.preparedSetId ?? "")
    && value.telemetrySchemaVersion === expected.telemetrySchemaVersion
    && value.fieldDictionaryVersion === expected.fieldDictionaryVersion
    && value.privacyContractVersion === expected.privacyContractVersion
    && value.destinationOrigin === expected.destinationOrigin;
}

function sameAcceptedThrough(value, expected) {
  return exactKeys(value, ACCEPTED_THROUGH_KEYS)
    && nullableTimestamp(value.acceptedAt) !== null
    && nullableTimestamp(value.coveredThroughAt) !== null
    && value.telemetrySchemaVersion === expected.telemetrySchemaVersion
    && value.fieldDictionaryVersion === expected.fieldDictionaryVersion
    && value.privacyContractVersion === expected.privacyContractVersion
    && value.destinationOrigin === expected.destinationOrigin;
}

function samePendingContribution(value, expected) {
  return exactKeys(value, PENDING_CONTRIBUTION_KEYS)
    && nullableTimestamp(value.preparedAt) !== null
    && nullableTimestamp(value.coveredStartAt) !== null
    && nullableTimestamp(value.coveredEndAt) !== null
    && Date.parse(value.coveredStartAt) < Date.parse(value.coveredEndAt)
    && SHA256.test(value.preparedSetId ?? "")
    && value.telemetrySchemaVersion === expected.telemetrySchemaVersion
    && value.fieldDictionaryVersion === expected.fieldDictionaryVersion
    && value.privacyContractVersion === expected.privacyContractVersion
    && value.destinationOrigin === expected.destinationOrigin;
}

function samePreparationClaim(value, expected, acceptedThroughAt) {
  return exactKeys(value, PREPARATION_CLAIM_KEYS)
    && UUID_V4.test(value.preparationId ?? "")
    && (value.preparedSetId === null
      || SHA256.test(value.preparedSetId ?? ""))
    && nullableTimestamp(value.claimedAt) !== null
    && nullableTimestamp(value.acceptedThroughAt) !== null
    && value.acceptedThroughAt === acceptedThroughAt
    && value.lookbackHours === AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS
    && value.replayOverlapHours
      === AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS
    && value.telemetrySchemaVersion === expected.telemetrySchemaVersion
    && value.fieldDictionaryVersion === expected.fieldDictionaryVersion
    && value.privacyContractVersion === expected.privacyContractVersion
    && value.destinationOrigin === expected.destinationOrigin;
}

function validatedPreparedSetStatus(value, expectedPreparedSetId) {
  if (!exactKeys(value, PREPARED_SET_STATUS_KEYS)
      || value.preparedSetId !== expectedPreparedSetId
      || !SHA256.test(value.preparedSetId ?? "")
      || !exactKeys(value.coveredAt, COVERED_AT_KEYS)
      || nullableTimestamp(value.coveredAt.startAt) === null
      || nullableTimestamp(value.coveredAt.endAt) === null
      || Date.parse(value.coveredAt.startAt) >= Date.parse(value.coveredAt.endAt)
      || !Number.isSafeInteger(value.totalJobs)
      || value.totalJobs < 1
      || ![
        value.acceptedJobs,
        value.pendingJobs,
        value.retryableJobs,
        value.inFlightJobs,
        value.rejectedJobs,
      ].every((count) => Number.isSafeInteger(count) && count >= 0)
      || value.totalJobs !== value.acceptedJobs
        + value.pendingJobs
        + value.retryableJobs
        + value.inFlightJobs
        + value.rejectedJobs
      || typeof value.completeAccepted !== "boolean"
      || value.completeAccepted
        !== (value.acceptedJobs === value.totalJobs)) {
    return null;
  }
  return value;
}

function validOutcome(value) {
  if (value === null) return true;
  return exactKeys(value, OUTCOME_KEYS)
    && OUTCOME_CODES[value.code] === value.status
    && nullableTimestamp(value.at) !== null;
}

function emptySettings() {
  return {
    schemaVersion: AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
    enabled: false,
    paused: false,
    intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
    consent: null,
    acceptedThrough: null,
    pendingContribution: null,
    preparationClaim: null,
    reviewBootstrap: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastOutcome: null,
  };
}

function validatedSettings(value) {
  if (exactKeys(value, LEGACY_SETTINGS_KEYS)
      && value.schemaVersion === "automatic-contribution-settings-v0.1"
      && typeof value.enabled === "boolean"
      && typeof value.paused === "boolean"
      && value.intervalHours === AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS
      && nullableTimestamp(value.lastAttemptAt) === value.lastAttemptAt
      && nullableTimestamp(value.lastSuccessAt) === value.lastSuccessAt
      && validOutcome(value.lastOutcome)) {
    // v0.1 had no exact prepared-set identity or accepted-through watermark.
    // It cannot be resumed safely, so migrate in memory to an explicitly
    // disabled v0.2 state and require a fresh reviewed first contribution.
    return {
      ...emptySettings(),
      lastAttemptAt: value.lastAttemptAt,
      lastSuccessAt: value.lastSuccessAt,
      lastOutcome: value.lastOutcome === null
        ? null
        : { ...value.lastOutcome },
    };
  }
  if (exactKeys(value, VERSION_TWO_SETTINGS_KEYS)
      && value.schemaVersion === "automatic-contribution-settings-v0.2") {
    return validatedSettings({
      ...value,
      schemaVersion: AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
      preparationClaim: null,
    });
  }
  if (!exactKeys(value, SETTINGS_KEYS)
      || value.schemaVersion
        !== AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION
      || typeof value.enabled !== "boolean"
      || typeof value.paused !== "boolean"
      || value.intervalHours !== AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS
      || nullableTimestamp(value.lastAttemptAt) !== value.lastAttemptAt
      || nullableTimestamp(value.lastSuccessAt) !== value.lastSuccessAt
      || !validOutcome(value.lastOutcome)
      || (value.acceptedThrough !== null
        && (!exactKeys(value.acceptedThrough, ACCEPTED_THROUGH_KEYS)
          || nullableTimestamp(value.acceptedThrough.acceptedAt) === null
          || nullableTimestamp(
            value.acceptedThrough.coveredThroughAt,
          ) === null
          || typeof value.acceptedThrough.telemetrySchemaVersion !== "string"
          || typeof value.acceptedThrough.fieldDictionaryVersion !== "string"
          || typeof value.acceptedThrough.privacyContractVersion !== "string"
          || typeof value.acceptedThrough.destinationOrigin !== "string"))
      || (value.pendingContribution !== null
        && (!exactKeys(
          value.pendingContribution,
          PENDING_CONTRIBUTION_KEYS,
        )
          || nullableTimestamp(value.pendingContribution.preparedAt) === null
          || nullableTimestamp(
            value.pendingContribution.coveredStartAt,
          ) === null
          || nullableTimestamp(
            value.pendingContribution.coveredEndAt,
          ) === null
          || Date.parse(value.pendingContribution.coveredStartAt)
            >= Date.parse(value.pendingContribution.coveredEndAt)
          || !SHA256.test(value.pendingContribution.preparedSetId ?? "")
          || typeof value.pendingContribution.telemetrySchemaVersion
            !== "string"
          || typeof value.pendingContribution.fieldDictionaryVersion
            !== "string"
          || typeof value.pendingContribution.privacyContractVersion
            !== "string"
          || typeof value.pendingContribution.destinationOrigin !== "string"))
      || (value.preparationClaim !== null
        && (!exactKeys(value.preparationClaim, PREPARATION_CLAIM_KEYS)
          || !UUID_V4.test(value.preparationClaim.preparationId ?? "")
          || (value.preparationClaim.preparedSetId !== null
            && !SHA256.test(value.preparationClaim.preparedSetId ?? ""))
          || nullableTimestamp(value.preparationClaim.claimedAt) === null
          || nullableTimestamp(
            value.preparationClaim.acceptedThroughAt,
          ) === null
          || value.preparationClaim.lookbackHours
            !== AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS
          || value.preparationClaim.replayOverlapHours
            !== AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS
          || typeof value.preparationClaim.telemetrySchemaVersion
            !== "string"
          || typeof value.preparationClaim.fieldDictionaryVersion
            !== "string"
          || typeof value.preparationClaim.privacyContractVersion
            !== "string"
          || typeof value.preparationClaim.destinationOrigin !== "string"))
      || (value.reviewBootstrap !== null
        && (!exactKeys(value.reviewBootstrap, REVIEW_BOOTSTRAP_KEYS)
          || nullableTimestamp(value.reviewBootstrap.acceptedAt) === null
          || !SHA256.test(value.reviewBootstrap.preparedSetId ?? "")
          || typeof value.reviewBootstrap.telemetrySchemaVersion !== "string"
          || typeof value.reviewBootstrap.fieldDictionaryVersion !== "string"
          || typeof value.reviewBootstrap.privacyContractVersion !== "string"
          || typeof value.reviewBootstrap.destinationOrigin !== "string"))
      || (value.enabled && !exactKeys(value.consent, CONSENT_KEYS))
      || (!value.enabled && value.consent !== null)) {
    fail("settings_unavailable");
  }
  if (value.consent !== null
      && (nullableTimestamp(value.consent.consentedAt) === null
        || typeof value.consent.telemetrySchemaVersion !== "string"
        || typeof value.consent.fieldDictionaryVersion !== "string"
        || typeof value.consent.privacyContractVersion !== "string"
        || typeof value.consent.destinationOrigin !== "string")) {
    fail("settings_unavailable");
  }
  if (value.preparationClaim !== null) {
    if (value.acceptedThrough === null
        || value.preparationClaim.acceptedThroughAt
          !== value.acceptedThrough.coveredThroughAt
        || value.preparationClaim.telemetrySchemaVersion
          !== value.acceptedThrough.telemetrySchemaVersion
        || value.preparationClaim.fieldDictionaryVersion
          !== value.acceptedThrough.fieldDictionaryVersion
        || value.preparationClaim.privacyContractVersion
          !== value.acceptedThrough.privacyContractVersion
        || value.preparationClaim.destinationOrigin
          !== value.acceptedThrough.destinationOrigin) {
      fail("settings_unavailable");
    }
  }
  return {
    schemaVersion: value.schemaVersion,
    enabled: value.enabled,
    paused: value.paused,
    intervalHours: value.intervalHours,
    consent: value.consent === null ? null : { ...value.consent },
    acceptedThrough: value.acceptedThrough === null
      ? null
      : { ...value.acceptedThrough },
    pendingContribution: value.pendingContribution === null
      ? null
      : { ...value.pendingContribution },
    preparationClaim: value.preparationClaim === null
      ? null
      : { ...value.preparationClaim },
    reviewBootstrap: value.reviewBootstrap === null
      ? null
      : { ...value.reviewBootstrap },
    lastAttemptAt: value.lastAttemptAt,
    lastSuccessAt: value.lastSuccessAt,
    lastOutcome: value.lastOutcome === null ? null : { ...value.lastOutcome },
  };
}

function assertOwnerOnlyDirectory(stats) {
  if (!stats.isDirectory()
      || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("settings_unavailable");
  }
}

function assertOwnerOnlyFile(stats) {
  if (!stats.isFile()
      || stats.isSymbolicLink()
      || stats.nlink !== 1
      || stats.size < 1
      || stats.size > MAXIMUM_SETTINGS_BYTES
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("settings_unavailable");
  }
}

function assertOwnerOnlyInstanceLockFile(stats) {
  if (!stats.isFile()
      || stats.isSymbolicLink()
      || stats.nlink !== 1
      || stats.size < 1
      || stats.size > MAXIMUM_INSTANCE_LOCK_BYTES
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("instance_lock_unavailable");
  }
}

async function canonicalSettingsTarget(settingsFile) {
  if (typeof settingsFile !== "string" || settingsFile.length < 1) {
    fail("configuration_invalid");
  }
  const requested = resolve(settingsFile);
  const requestedParent = dirname(requested);
  try {
    await mkdir(requestedParent, { recursive: true, mode: 0o700 });
    const before = await lstat(requestedParent);
    assertOwnerOnlyDirectory(before);
    const canonicalParent = await realpath(requestedParent);
    const after = await lstat(canonicalParent);
    assertOwnerOnlyDirectory(after);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      fail("settings_unavailable");
    }
    return {
      parent: canonicalParent,
      file: join(canonicalParent, basename(requested)),
    };
  } catch (error) {
    if (error instanceof AutomaticContributionError) throw error;
    fail("settings_unavailable");
  }
}

async function loadSettings(settingsFile) {
  const target = await canonicalSettingsTarget(settingsFile);
  let handle;
  try {
    handle = await open(
      target.file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    assertOwnerOnlyFile(before);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertOwnerOnlyFile(after);
    if (before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || bytes.length !== after.size) {
      fail("settings_unavailable");
    }
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("settings_unavailable");
    }
    return validatedSettings(value);
  } catch (error) {
    if (error?.code === "ENOENT") return emptySettings();
    if (error instanceof AutomaticContributionError) throw error;
    fail("settings_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function persistSettings(settingsFile, value) {
  const settings = validatedSettings(value);
  const target = await canonicalSettingsTarget(settingsFile);
  try {
    const existing = await lstat(target.file);
    assertOwnerOnlyFile(existing);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof AutomaticContributionError) throw error;
      fail("settings_unavailable");
    }
  }
  const temporary = join(
    target.parent,
    `.${basename(target.file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const payload = Buffer.from(`${JSON.stringify(settings)}\n`, "utf8");
    if (payload.length > MAXIMUM_SETTINGS_BYTES) fail("settings_unavailable");
    await handle.writeFile(payload);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target.file);
    await chmod(target.file, 0o600);
    const finalStats = await lstat(target.file);
    assertOwnerOnlyFile(finalStats);
    await syncDirectory(target.parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (error instanceof AutomaticContributionError) throw error;
    fail("settings_unavailable");
  }
}

function defaultProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function validInstanceLockPayload(value) {
  return exactKeys(value, INSTANCE_LOCK_KEYS)
    && value.schemaVersion === INSTANCE_LOCK_SCHEMA_VERSION
    && Number.isSafeInteger(value.pid)
    && value.pid >= 1
    && value.pid <= 2_147_483_647
    && nullableTimestamp(value.createdAt) !== null
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value.nonce);
}

async function canonicalInstanceLockTarget(lockFile) {
  if (typeof lockFile !== "string" || lockFile.length < 1) {
    fail("configuration_invalid");
  }
  const requested = resolve(lockFile);
  const requestedParent = dirname(requested);
  try {
    await mkdir(requestedParent, { recursive: true, mode: 0o700 });
    const before = await lstat(requestedParent);
    assertOwnerOnlyDirectory(before);
    const canonicalParent = await realpath(requestedParent);
    const after = await lstat(canonicalParent);
    assertOwnerOnlyDirectory(after);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      fail("instance_lock_unavailable");
    }
    return {
      parent: canonicalParent,
      file: join(canonicalParent, basename(requested)),
    };
  } catch (error) {
    if (error instanceof AutomaticContributionError) {
      if (error.code === "automatic_contribution_settings_unavailable") {
        fail("instance_lock_unavailable");
      }
      throw error;
    }
    fail("instance_lock_unavailable");
  }
}

async function readInstanceLock(target) {
  let handle;
  try {
    handle = await open(
      target.file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    assertOwnerOnlyInstanceLockFile(before);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertOwnerOnlyInstanceLockFile(after);
    if (before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || bytes.length !== after.size) {
      fail("instance_lock_unavailable");
    }
    let payload;
    try {
      payload = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("instance_lock_unavailable");
    }
    if (!validInstanceLockPayload(payload)) fail("instance_lock_unavailable");
    return {
      payload,
      identity: { dev: after.dev, ino: after.ino },
    };
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    if (error instanceof AutomaticContributionError) throw error;
    fail("instance_lock_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function acquireAutomaticContributionInstanceLock({
  lockFile,
  pid = process.pid,
  now = () => new Date(),
  processIsAlive = defaultProcessIsAlive,
} = {}) {
  if (!Number.isSafeInteger(pid)
      || pid < 1
      || pid > 2_147_483_647
      || typeof now !== "function"
      || typeof processIsAlive !== "function") {
    fail("configuration_invalid");
  }
  const target = await canonicalInstanceLockTarget(lockFile);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = {
      schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION,
      pid,
      createdAt: timestamp(now()),
      nonce: randomUUID(),
    };
    let handle;
    let created = false;
    try {
      handle = await open(
        target.file,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      created = true;
      const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
      await handle.sync();
      const stats = await handle.stat();
      assertOwnerOnlyInstanceLockFile(stats);
      if (stats.size !== bytes.length) fail("instance_lock_unavailable");
      const identity = { dev: stats.dev, ino: stats.ino };
      await handle.close();
      handle = null;
      await syncDirectory(target.parent);
      let releasePromise = null;
      return Object.freeze({
        schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION,
        pid,
        createdAt: payload.createdAt,
        release() {
          if (releasePromise !== null) return releasePromise;
          releasePromise = (async () => {
            let current;
            try {
              current = await readInstanceLock(target);
            } catch (error) {
              try {
                await lstat(target.file);
              } catch (missing) {
                if (missing?.code === "ENOENT") return;
              }
              throw error;
            }
            if (current.identity.dev !== identity.dev
                || current.identity.ino !== identity.ino
                || current.payload.pid !== pid
                || current.payload.nonce !== payload.nonce) {
              fail("instance_lock_unavailable");
            }
            const pathStats = await lstat(target.file);
            if (pathStats.dev !== identity.dev
                || pathStats.ino !== identity.ino) {
              fail("instance_lock_unavailable");
            }
            await unlink(target.file);
            await syncDirectory(target.parent);
          })();
          releasePromise.catch(() => {
            releasePromise = null;
          });
          return releasePromise;
        },
      });
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created) {
        await unlink(target.file).catch(() => {});
        await syncDirectory(target.parent).catch(() => {});
      }
      if (error?.code !== "EEXIST") {
        if (error instanceof AutomaticContributionError) throw error;
        fail("instance_lock_unavailable");
      }
      let existing;
      try {
        existing = await readInstanceLock(target);
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      let active;
      try {
        active = await processIsAlive(existing.payload.pid);
      } catch {
        fail("instance_lock_unavailable");
      }
      if (active !== false) fail("instance_active");
      const pathStats = await lstat(target.file);
      if (pathStats.dev !== existing.identity.dev
          || pathStats.ino !== existing.identity.ino) {
        continue;
      }
      try {
        await unlink(target.file);
        await syncDirectory(target.parent);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") {
          fail("instance_lock_unavailable");
        }
      }
    }
  }
  fail("instance_lock_unavailable");
}

function outcome(code, at) {
  const status = OUTCOME_CODES[code];
  if (status === undefined) fail("configuration_invalid");
  return { status, code, at };
}

function projectedOutcome(value) {
  return value === null ? null : Object.freeze({ ...value });
}

function uploadOutcome(value, expectedPending) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { code: "upload_failed", pause: true, success: false };
  }
  const accepted = Number.isSafeInteger(value.accepted) && value.accepted >= 0
    ? value.accepted
    : null;
  const processed = Number.isSafeInteger(value.processed) && value.processed >= 0
    ? value.processed
    : null;
  const retryable = Number.isSafeInteger(value.retryable) && value.retryable >= 0
    ? value.retryable
    : null;
  const rejected = Number.isSafeInteger(value.rejected) && value.rejected >= 0
    ? value.rejected
    : null;
  if (!["completed", "paused", "interrupted"].includes(value.status)
      || [accepted, processed, retryable, rejected].includes(null)) {
    return { code: "upload_failed", pause: true, success: false };
  }
  if (value.status === "completed"
      && value.preparedSet === null
      && accepted === 0
      && processed === 0
      && retryable === 0
      && rejected === 0) {
    return {
      code: "publication_incomplete",
      pause: false,
      success: false,
      clearPending: true,
    };
  }
  const preparedSet = validatedPreparedSetStatus(
    value.preparedSet,
    expectedPending.preparedSetId,
  );
  if (preparedSet === null
      || preparedSet.coveredAt.startAt !== expectedPending.coveredStartAt
      || preparedSet.coveredAt.endAt !== expectedPending.coveredEndAt) {
    return { code: "upload_failed", pause: true, success: false };
  }
  if (value.status === "paused" || value.queue?.paused === true) {
    return { code: "queue_paused", pause: true, success: false };
  }
  if (preparedSet.completeAccepted) {
    return {
      code: "accepted",
      pause: false,
      success: true,
      preparedSet,
    };
  }
  if (preparedSet.rejectedJobs > 0 || rejected > 0) {
    return {
      code: "delivery_rejected",
      pause: true,
      success: false,
      preparedSet,
    };
  }
  if (preparedSet.pendingJobs > 0
      || preparedSet.retryableJobs > 0
      || preparedSet.inFlightJobs > 0
      || retryable > 0
      || value.status === "interrupted") {
    return {
      code: "retry_scheduled",
      pause: false,
      success: false,
      preparedSet,
    };
  }
  return { code: "upload_failed", pause: true, success: false };
}

function preparationFailure(error) {
  const code = typeof error?.code === "string"
    ? error.code.replace(/^local_contribution_/u, "")
    : "";
  if (code.endsWith("no_safe_records")) {
    return { code: "no_new_evidence", pause: false };
  }
  if (code.endsWith("identity_unavailable")) {
    return { code: "identity_unavailable", pause: true };
  }
  if (code.endsWith("privacy_verification_failed")) {
    return { code: "privacy_verification_failed", pause: true };
  }
  return { code: "preparation_failed", pause: true };
}

function pendingFromPreparation({
  prepared,
  requiredConsent,
  preparedAt,
  acceptedThroughAt,
}) {
  const coveredAt = prepared?.coveredAt;
  const preparedSetId = prepared?.prepared?.preparedSetId;
  if (prepared?.status !== "prepared"
      || prepared?.networkActivity !== false
      || !SHA256.test(preparedSetId ?? "")
      || !exactKeys(coveredAt, COVERED_AT_KEYS)
      || nullableTimestamp(coveredAt.startAt) === null
      || nullableTimestamp(coveredAt.endAt) === null
      || Date.parse(coveredAt.startAt) >= Date.parse(coveredAt.endAt)
      || (acceptedThroughAt !== null
        && Date.parse(coveredAt.endAt) <= Date.parse(acceptedThroughAt))) {
    return null;
  }
  return {
    ...requiredConsent,
    preparedSetId,
    preparedAt,
    coveredStartAt: coveredAt.startAt,
    coveredEndAt: coveredAt.endAt,
  };
}

export class AutomaticContributionController {
  #settingsFile;
  #destinationOrigin;
  #requiredConsent;
  #prepareRunner;
  #uploadRunner;
  #maintenanceRunner;
  #now;
  #setTimeout;
  #clearTimeout;
  #runTimeoutMilliseconds;
  #settings = emptySettings();
  #initialized = false;
  #settingsAvailable = true;
  #started = false;
  #timer = null;
  #running = false;
  #runAbortController = null;
  #activeRuns = new Set();
  #generation = 0;
  #operations = Promise.resolve();

  constructor({
    settingsFile,
    destinationOrigin = null,
    prepareRunner,
    uploadRunner,
    maintenanceRunner = async () => {},
    now = () => new Date(),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    runTimeoutMilliseconds = DEFAULT_RUN_TIMEOUT_MILLISECONDS,
  } = {}) {
    if (typeof settingsFile !== "string"
        || typeof prepareRunner !== "function"
        || typeof uploadRunner !== "function"
        || typeof maintenanceRunner !== "function"
        || typeof now !== "function"
        || typeof setTimeoutImpl !== "function"
        || typeof clearTimeoutImpl !== "function"
        || !Number.isSafeInteger(runTimeoutMilliseconds)
        || runTimeoutMilliseconds < 1_000
        || runTimeoutMilliseconds > 15 * 60 * 1_000) {
      fail("configuration_invalid");
    }
    this.#settingsFile = resolve(settingsFile);
    this.#destinationOrigin = normalizedDestinationOrigin(destinationOrigin);
    this.#requiredConsent = requiredConsent(this.#destinationOrigin);
    this.#prepareRunner = prepareRunner;
    this.#uploadRunner = uploadRunner;
    this.#maintenanceRunner = maintenanceRunner;
    this.#now = now;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#runTimeoutMilliseconds = runTimeoutMilliseconds;
  }

  #serialize(operation) {
    const pending = this.#operations.then(operation, operation);
    this.#operations = pending.catch(() => {});
    return pending;
  }

  #nowIso() {
    return timestamp(this.#now());
  }

  #consentCurrent() {
    return this.#destinationOrigin !== null
      && this.#settings.enabled
      && this.#settings.consent !== null
      && sameRequiredConsent(
        this.#settings.consent,
        this.#requiredConsent,
        { persisted: true },
      );
  }

  #firstReviewComplete() {
    return this.#destinationOrigin !== null
      && this.#settings.reviewBootstrap !== null
      && sameReviewBootstrap(
        this.#settings.reviewBootstrap,
        this.#requiredConsent,
      );
  }

  #acceptedThroughAt() {
    return this.#destinationOrigin !== null
      && this.#settings.acceptedThrough !== null
      && sameAcceptedThrough(
        this.#settings.acceptedThrough,
        this.#requiredConsent,
      )
      ? this.#settings.acceptedThrough.coveredThroughAt
      : null;
  }

  #pendingContribution() {
    return this.#destinationOrigin !== null
      && this.#settings.pendingContribution !== null
      && samePendingContribution(
        this.#settings.pendingContribution,
        this.#requiredConsent,
      )
      ? { ...this.#settings.pendingContribution }
      : null;
  }

  #preparationClaim() {
    const acceptedThroughAt = this.#acceptedThroughAt();
    return this.#destinationOrigin !== null
      && acceptedThroughAt !== null
      && this.#settings.preparationClaim !== null
      && samePreparationClaim(
        this.#settings.preparationClaim,
        this.#requiredConsent,
        acceptedThroughAt,
      )
      ? { ...this.#settings.preparationClaim }
      : null;
  }

  #protectedPreparedSetIds() {
    const protectedIds = new Set();
    if (this.#firstReviewComplete()) {
      protectedIds.add(this.#settings.reviewBootstrap.preparedSetId);
    }
    const pending = this.#pendingContribution();
    if (pending !== null) protectedIds.add(pending.preparedSetId);
    const preparationClaim = this.#preparationClaim();
    if (preparationClaim?.preparedSetId !== null) {
      protectedIds.add(preparationClaim.preparedSetId);
    }
    return [...protectedIds];
  }

  #nextAttemptAt() {
    if (!this.#consentCurrent() || this.#settings.paused) return null;
    const anchor = this.#settings.lastAttemptAt
      ?? this.#settings.consent?.consentedAt;
    const milliseconds = Date.parse(anchor);
    if (!Number.isFinite(milliseconds)) return null;
    return new Date(milliseconds + INTERVAL_MILLISECONDS).toISOString();
  }

  #clearScheduledTimer() {
    if (this.#timer === null) return;
    this.#clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule() {
    this.#clearScheduledTimer();
    if (!this.#started
        || !this.#settingsAvailable
        || !this.#firstReviewComplete()
        || !this.#consentCurrent()
        || this.#settings.paused
        || this.#running) {
      return;
    }
    const nextAttemptAt = this.#nextAttemptAt();
    if (nextAttemptAt === null) return;
    const delay = Math.max(
      0,
      Date.parse(nextAttemptAt) - Date.parse(this.#nowIso()),
    );
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.runDue().catch(() => {});
    }, delay);
    this.#timer?.unref?.();
  }

  async #persist() {
    try {
      await persistSettings(this.#settingsFile, this.#settings);
    } catch (error) {
      this.#settingsAvailable = false;
      this.#clearScheduledTimer();
      throw error;
    }
  }

  async initialize() {
    return this.#serialize(async () => {
      if (this.#initialized) return this.#project();
      try {
        this.#settings = await loadSettings(this.#settingsFile);
      } catch {
        this.#settings = emptySettings();
        this.#settingsAvailable = false;
        this.#settings.lastOutcome = outcome(
          "preparation_failed",
          this.#nowIso(),
        );
      }
      this.#initialized = true;
      return this.#project();
    });
  }

  async start() {
    await this.initialize();
    return this.#serialize(async () => {
      this.#started = true;
      this.#schedule();
      return this.#project();
    });
  }

  async stop() {
    this.#started = false;
    this.#generation += 1;
    this.#clearScheduledTimer();
    this.#runAbortController?.abort();
    await Promise.allSettled([...this.#activeRuns]);
    await this.#operations;
  }

  async inspect() {
    if (!this.#initialized) await this.initialize();
    return this.#serialize(async () => this.#project());
  }

  async enable({ intervalHours, consent } = {}) {
    if (!this.#initialized) await this.initialize();
    return this.#serialize(async () => {
      if (!this.#settingsAvailable) fail("settings_unavailable");
      if (this.#destinationOrigin === null) fail("not_configured");
      if (!this.#firstReviewComplete()) fail("first_review_required");
      if (intervalHours !== AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS
          || !sameRequiredConsent(consent, this.#requiredConsent)) {
        fail("consent_binding_mismatch");
      }
      this.#generation += 1;
      this.#runAbortController?.abort();
      this.#settings = {
        ...this.#settings,
        enabled: true,
        paused: false,
        intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
        consent: {
          ...this.#requiredConsent,
          consentedAt: this.#nowIso(),
        },
      };
      await this.#persist();
      this.#schedule();
      return this.#project();
    });
  }

  async recordReviewedManualAcceptance({
    status,
    accepted,
    preparedSet,
  } = {}) {
    if (!this.#initialized) await this.initialize();
    return this.#serialize(async () => {
      if (!this.#settingsAvailable) fail("settings_unavailable");
      if (this.#destinationOrigin === null) return this.#project();
      if (this.#firstReviewComplete()) return this.#project();
      const reviewedSet = validatedPreparedSetStatus(
        preparedSet,
        preparedSet?.preparedSetId,
      );
      if (status !== "completed"
          || !Number.isSafeInteger(accepted)
          || accepted < 1
          || reviewedSet === null
          || reviewedSet.acceptedJobs < accepted) {
        fail("review_acceptance_invalid");
      }
      const acceptedAt = this.#nowIso();
      const pendingContribution = reviewedSet.completeAccepted
        ? null
        : {
          ...this.#requiredConsent,
          preparedSetId: reviewedSet.preparedSetId,
          preparedAt: acceptedAt,
          coveredStartAt: reviewedSet.coveredAt.startAt,
          coveredEndAt: reviewedSet.coveredAt.endAt,
        };
      this.#settings = {
        ...this.#settings,
        reviewBootstrap: {
          ...this.#requiredConsent,
          preparedSetId: reviewedSet.preparedSetId,
          acceptedAt,
        },
        acceptedThrough: reviewedSet.completeAccepted
          ? {
            ...this.#requiredConsent,
            acceptedAt,
            coveredThroughAt: reviewedSet.coveredAt.endAt,
          }
          : null,
        pendingContribution,
        preparationClaim: null,
      };
      await this.#persist();
      this.#schedule();
      return this.#project();
    });
  }

  async disable() {
    if (!this.#initialized) await this.initialize();
    return this.#serialize(async () => {
      if (!this.#settingsAvailable) fail("settings_unavailable");
      this.#generation += 1;
      this.#clearScheduledTimer();
      this.#runAbortController?.abort();
      this.#settings = {
        ...this.#settings,
        enabled: false,
        paused: false,
        consent: null,
      };
      await this.#persist();
      return this.#project();
    });
  }

  async runDue() {
    const run = this.#runDueInternal();
    this.#activeRuns.add(run);
    try {
      return await run;
    } finally {
      this.#activeRuns.delete(run);
    }
  }

  async #runDueInternal() {
    if (!this.#initialized) await this.initialize();
    const claim = await this.#serialize(async () => {
      if (!this.#started
          || this.#running
          || !this.#settingsAvailable
          || !this.#firstReviewComplete()
          || !this.#consentCurrent()
          || this.#settings.paused) {
        return null;
      }
      const nextAttemptAt = this.#nextAttemptAt();
      if (nextAttemptAt === null
          || Date.parse(nextAttemptAt) > Date.parse(this.#nowIso())) {
        this.#schedule();
        return null;
      }
      this.#running = true;
      this.#clearScheduledTimer();
      const generation = this.#generation;
      const attemptedAt = this.#nowIso();
      const acceptedThroughAt = this.#acceptedThroughAt();
      const pendingContribution = this.#pendingContribution();
      let preparationClaim = this.#preparationClaim();
      if (pendingContribution === null) {
        if (acceptedThroughAt === null) {
          this.#running = false;
          this.#settings = {
            ...this.#settings,
            paused: true,
            lastOutcome: outcome("preparation_failed", attemptedAt),
          };
          await this.#persist();
          return null;
        }
        preparationClaim ??= {
          ...this.#requiredConsent,
          preparationId: randomUUID(),
          preparedSetId: null,
          claimedAt: attemptedAt,
          acceptedThroughAt,
          lookbackHours: AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS,
          replayOverlapHours:
            AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS,
        };
      }
      this.#settings = {
        ...this.#settings,
        lastAttemptAt: attemptedAt,
        preparationClaim,
      };
      try {
        await this.#persist();
      } catch (error) {
        this.#running = false;
        throw error;
      }
      return {
        generation,
        attemptedAt,
        acceptedThroughAt,
        pendingContribution,
        preparationClaim,
        protectedPreparedSetIds: this.#protectedPreparedSetIds(),
      };
    });
    if (claim === null) return this.inspect();

    const abortController = new AbortController();
    this.#runAbortController = abortController;
    let timedOut = false;
    const timeout = this.#setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.#runTimeoutMilliseconds);
    timeout?.unref?.();
    let selectedOutcome;
    let successful = false;
    let pendingContribution = claim.pendingContribution;
    try {
      try {
        await this.#maintenanceRunner({
          protectedPreparedSetIds: claim.protectedPreparedSetIds,
          signal: abortController.signal,
        });
      } catch {
        selectedOutcome = timedOut
          ? { code: "run_timeout", pause: true }
          : { code: "preparation_failed", pause: true };
      }
      if (selectedOutcome === undefined && pendingContribution === null) {
        if (claim.preparationClaim === null) {
          selectedOutcome = {
            code: "preparation_failed",
            pause: true,
          };
        }
        let prepared;
        let durablePendingContribution = null;
        try {
          if (selectedOutcome !== undefined) {
            throw new AutomaticContributionError("configuration_invalid");
          }
          prepared = await this.#prepareRunner({
            lookbackHours: claim.preparationClaim.lookbackHours,
            acceptedThroughAt: claim.acceptedThroughAt,
            replayOverlapHours: claim.preparationClaim.replayOverlapHours,
            preparationId: claim.preparationClaim.preparationId,
            protectedPreparedSetIds:
              claim.protectedPreparedSetIds,
            beforePreparedPublish: async ({
              preparedSetId,
              coveredAt,
            } = {}) => {
              const candidate = pendingFromPreparation({
                prepared: {
                  status: "prepared",
                  prepared: { preparedSetId },
                  coveredAt,
                  networkActivity: false,
                },
                requiredConsent: this.#requiredConsent,
                preparedAt: this.#nowIso(),
                acceptedThroughAt: claim.acceptedThroughAt,
              });
              if (candidate === null) {
                fail("configuration_invalid");
              }
              const remembered = await this.#serialize(async () => {
                if (this.#generation !== claim.generation
                    || !this.#settings.enabled
                    || this.#preparationClaim()?.preparationId
                      !== claim.preparationClaim.preparationId) {
                  return false;
                }
                const currentClaim = this.#preparationClaim();
                if (currentClaim.preparedSetId !== null
                    && currentClaim.preparedSetId
                      !== candidate.preparedSetId) {
                  return false;
                }
                this.#settings = {
                  ...this.#settings,
                  pendingContribution: candidate,
                  preparationClaim: {
                    ...currentClaim,
                    preparedSetId: candidate.preparedSetId,
                  },
                };
                await this.#persist();
                return true;
              });
              if (!remembered) {
                abortController.abort();
                fail("settings_unavailable");
              }
              durablePendingContribution = candidate;
            },
            signal: abortController.signal,
          });
        } catch (error) {
          selectedOutcome = timedOut
            ? { code: "run_timeout", pause: true }
            : preparationFailure(error);
        }
        if (selectedOutcome === undefined) {
          pendingContribution = pendingFromPreparation({
            prepared,
            requiredConsent: this.#requiredConsent,
            preparedAt: this.#nowIso(),
            acceptedThroughAt: claim.acceptedThroughAt,
          });
          if (pendingContribution === null
              || durablePendingContribution === null
              || pendingContribution.preparedSetId
                !== durablePendingContribution.preparedSetId
              || pendingContribution.coveredStartAt
                !== durablePendingContribution.coveredStartAt
              || pendingContribution.coveredEndAt
                !== durablePendingContribution.coveredEndAt) {
            selectedOutcome = {
              code: "preparation_failed",
              pause: true,
            };
          } else {
            pendingContribution = durablePendingContribution;
          }
        }
      }
      if (selectedOutcome === undefined) {
        if (abortController.signal.aborted) {
          selectedOutcome = {
            code: timedOut ? "run_timeout" : "upload_failed",
            pause: timedOut,
          };
        } else {
          try {
            const uploaded = await this.#uploadRunner({
              signal: abortController.signal,
              preparedSetId: pendingContribution.preparedSetId,
            });
            if (timedOut) {
              selectedOutcome = {
                code: "run_timeout",
                pause: true,
              };
            } else {
              selectedOutcome = uploadOutcome(
                uploaded,
                pendingContribution,
              );
              successful = selectedOutcome.success === true;
            }
          } catch (error) {
            selectedOutcome = {
              code: timedOut ? "run_timeout" : "upload_failed",
              pause: timedOut || error?.retryable !== true,
            };
          }
        }
      }
    } catch {
      selectedOutcome = {
        code: timedOut ? "run_timeout" : "preparation_failed",
        pause: true,
      };
    } finally {
      this.#clearTimeout(timeout);
      if (this.#runAbortController === abortController) {
        this.#runAbortController = null;
      }
    }

    return this.#serialize(async () => {
      this.#running = false;
      if (this.#generation !== claim.generation
          || !this.#settings.enabled) {
        this.#schedule();
        return this.#project();
      }
      const completedAt = this.#nowIso();
      const completedPreparedSet = successful
        ? selectedOutcome.preparedSet
        : null;
      this.#settings = {
        ...this.#settings,
        paused: selectedOutcome.pause === true,
        lastSuccessAt: successful
          ? completedAt
          : this.#settings.lastSuccessAt,
        lastOutcome: outcome(selectedOutcome.code, completedAt),
        pendingContribution: successful || selectedOutcome.clearPending === true
          ? null
          : this.#settings.pendingContribution,
        preparationClaim: successful
          ? null
          : this.#settings.preparationClaim,
        acceptedThrough: successful
          ? {
            ...this.#requiredConsent,
            acceptedAt: completedAt,
            coveredThroughAt: completedPreparedSet.coveredAt.endAt,
          }
          : this.#settings.acceptedThrough,
      };
      await this.#persist();
      this.#schedule();
      return this.#project();
    });
  }

  #project() {
    const consentCurrent = this.#consentCurrent();
    const firstReviewComplete = this.#firstReviewComplete();
    const configured = this.#destinationOrigin !== null;
    const status = !configured
      ? "not_configured"
      : !this.#settingsAvailable
        ? "failed"
        : !firstReviewComplete
          ? "first_review_required"
          : this.#settings.enabled && !consentCurrent
            ? "consent_required"
            : !this.#settings.enabled
              ? "disabled"
              : this.#running
                ? "running"
                : this.#settings.paused
                  ? "paused"
                  : "scheduled";
    return Object.freeze({
      schemaVersion: AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION,
      status,
      enabled: consentCurrent,
      intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
      consentCurrent,
      firstReviewComplete,
      firstReviewedAcceptedAt: firstReviewComplete
        ? this.#settings.reviewBootstrap.acceptedAt
        : null,
      requiredConsent: Object.freeze({ ...this.#requiredConsent }),
      consentedAt: consentCurrent
        ? this.#settings.consent.consentedAt
        : null,
      lastAttemptAt: this.#settings.lastAttemptAt,
      lastSuccessAt: this.#settings.lastSuccessAt,
      nextAttemptAt: status === "scheduled"
        ? this.#nextAttemptAt()
        : null,
      lastOutcome: projectedOutcome(this.#settings.lastOutcome),
      foregroundOnly: true,
      daemonInstalled: false,
      networkActivity: false,
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
      includesCredentials: false,
    });
  }
}

export function createAutomaticContributionController(options = {}) {
  return new AutomaticContributionController(options);
}

export const AUTOMATIC_CONTRIBUTION_LIMITS = Object.freeze({
  intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
  lookbackHours: AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS,
  replayOverlapHours: AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS,
  runTimeoutMilliseconds: DEFAULT_RUN_TIMEOUT_MILLISECONDS,
  maximumSettingsBytes: MAXIMUM_SETTINGS_BYTES,
});
