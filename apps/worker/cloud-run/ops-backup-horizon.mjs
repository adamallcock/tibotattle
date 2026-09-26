/**
 * Backup-horizon policy and audit core for the Google Cloud copies of the
 * hosted PostgreSQL stores (OPS-1).
 *
 * Why this exists: restore replay suppresses an erased participant after a
 * restore only while that participant's deletion tombstone still exists, and
 * tombstones live 400 days (src/retention.ts DELETION_TOMBSTONE_RETENTION_MILLISECONDS
 * for the Worker, src/postgres-ledger-authority.ts TOMBSTONE_RETENTION_MILLISECONDS
 * for the PostgreSQL ledger writer). A backup taken at time T holds only
 * participants erased after T, so every copy that can still be restored must be
 * younger than the tombstone horizon. The operational horizons below keep every
 * Cloud SQL copy under a 365-day ceiling, 35 days inside that horizon, with a
 * 7-day restore slack on top of each operational horizon.
 *
 * Scope: the Cloud SQL primary and ledger instances only, and within them only
 * the per-instance backup runs (`sql backups list --instance`, the Admin API
 * backupRuns collection). Project-level backups that outlive an instance
 * (final backups of deleted instances, backups retained after deletion) are
 * not listed there, so every receipt states BACKUP_HORIZON_COVERAGE and must
 * never be read as proof about the whole project. retainBackupsOnDelete=true
 * on an audited instance is itself a breach.
 *
 * Runtime-neutral: no process, filesystem, network or child-process access.
 * Callers pass Cloud SQL Admin API resources (the same objects
 * `gcloud ... --format=json` prints) and receive a closed, frozen and
 * content-free receipt. Backup descriptions never leave this module except as
 * the parsed purpose and expiry date.
 *
 * Evidence rules:
 * - Unknown or unparseable backup fields are BACKUP_SETTINGS_UNRECOGNIZED
 *   (breach). Nothing is assumed compliant.
 * - An absent boolean proves only "not true" (the Admin API always serialises
 *   true), so an absent `enabled` is BACKUP_DISABLED and an absent
 *   `retainBackupsOnDelete` is off. An absent number proves nothing, so an
 *   absent retention count or PITR log retention is unrecognized.
 * - When any backup run of a role cannot be read, that role's run evidence is
 *   unavailable: its counts, ages and on-demand list are null (never 0 or
 *   empty) and AUTOMATED_BACKUP_STALE, an inference from absence, is not
 *   raised. Codes proven by the runs that were read still stand.
 * - With a manifest region, every restorable copy must be stored in exactly
 *   that region; a copy with no stated location is unrecognized.
 * - A labelled on-demand backup is due only once its expires-on UTC date has
 *   fully passed, so it is kept for at least the requested number of days.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../src/canonical-json.ts";

export const BACKUP_HORIZON_AUDIT_SCHEMA = "tibotattle-backup-horizon-audit-v1";
/** What an audit receipt covers: per-instance backup runs only, never project-level backups. */
export const BACKUP_HORIZON_COVERAGE = "instance-backup-runs-only";

export const RESTORE_SUPPRESSION_TOMBSTONE_DAYS = 400;
export const BACKUP_HORIZON_MAX_DAYS = 365;
export const HORIZON_MARGIN_DAYS = 35;
export const RESTORE_SLACK_DAYS = 7;
/** Retention unit COUNT: one automated backup per day, so 30 backups span 30 days. */
export const AUTOMATED_RETAINED_BACKUPS = 30;
export const PITR_LOG_RETENTION_DAYS = 7;
export const ON_DEMAND_MAX_DAYS = 90;
export const ON_DEMAND_CRITICAL_DAYS = 300;
export const FINAL_BACKUP_MAX_DAYS = 30;
export const LAST_AUTOMATED_SUCCESS_MAX_HOURS = 36;

export const ON_DEMAND_PURPOSES = Object.freeze([
  "pre-migration",
  "pre-cutover",
  "pre-restore",
  "rehearsal",
]);

/** The only accepted on-demand label; anything else, including a suffix, is unlabelled. */
export const DESCRIPTION_PATTERN = Object.freeze(
  /^tibotattle-expires-on=(\d{4}-\d{2}-\d{2});purpose=(pre-migration|pre-cutover|pre-restore|rehearsal)$/u,
);

export const BACKUP_HORIZON_CONSTANTS = Object.freeze({
  RESTORE_SUPPRESSION_TOMBSTONE_DAYS,
  BACKUP_HORIZON_MAX_DAYS,
  HORIZON_MARGIN_DAYS,
  RESTORE_SLACK_DAYS,
  AUTOMATED_RETAINED_BACKUPS,
  PITR_LOG_RETENTION_DAYS,
  ON_DEMAND_MAX_DAYS,
  ON_DEMAND_CRITICAL_DAYS,
  FINAL_BACKUP_MAX_DAYS,
  LAST_AUTOMATED_SUCCESS_MAX_HOURS,
});

export const BACKUP_HORIZON_ENVIRONMENTS = Object.freeze(["production", "staging"]);
export const BACKUP_HORIZON_ROLES = Object.freeze(["primary", "ledger"]);
export const BACKUP_HORIZON_VERDICTS = Object.freeze(["ok", "warn", "breach"]);
export const ON_DEMAND_STATUSES = Object.freeze(["ok", "due", "overdue", "critical", "unlabelled"]);
/** Receipt statuses a receipt-bound prune may act on. */
export const PRUNABLE_ON_DEMAND_STATUSES = Object.freeze(["due", "overdue", "critical"]);

/** Closed code enum, in report order. */
export const BACKUP_HORIZON_CODES = Object.freeze([
  "BACKUP_DISABLED",
  "PITR_DISABLED",
  "PITR_RETENTION_EXCEEDED",
  "AUTOMATED_RETENTION_EXCEEDED",
  "FINAL_BACKUP_RETENTION_EXCEEDED",
  "BACKUP_LOCATION_MISMATCH",
  "AUTOMATED_BACKUP_STALE",
  "ON_DEMAND_UNLABELLED",
  "ON_DEMAND_DUE",
  "ON_DEMAND_OVERDUE",
  "ON_DEMAND_CRITICAL",
  "BACKUP_OLDER_THAN_HORIZON",
  "BACKUP_SETTINGS_UNRECOGNIZED",
]);

export const BACKUP_HORIZON_BREACH_CODES = Object.freeze([
  "BACKUP_DISABLED",
  "PITR_RETENTION_EXCEEDED",
  "AUTOMATED_RETENTION_EXCEEDED",
  "FINAL_BACKUP_RETENTION_EXCEEDED",
  "BACKUP_LOCATION_MISMATCH",
  "BACKUP_OLDER_THAN_HORIZON",
  "BACKUP_SETTINGS_UNRECOGNIZED",
]);

/** Cloud SQL identifiers accepted in receipts (bare instance ids, never connection names). */
export const CLOUD_SQL_INSTANCE_ID_PATTERN = Object.freeze(/^[a-z](?:[a-z0-9-]{0,96}[a-z0-9])?$/u);
export const GCP_PROJECT_ID_PATTERN = Object.freeze(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
export const GCP_REGION_PATTERN = Object.freeze(/^[a-z]+-[a-z]+[0-9]{1,2}$/u);
export const BACKUP_RUN_ID_PATTERN = Object.freeze(/^[1-9][0-9]{0,18}$/u);

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
/** Server timestamps may lead the local clock slightly; beyond this they are unrecognized. */
const FUTURE_TIMESTAMP_TOLERANCE_MS = HOUR_MS;
const CODE_ORDER = new Map(BACKUP_HORIZON_CODES.map((code, index) => [code, index]));
const BREACH_CODES = new Set(BACKUP_HORIZON_BREACH_CODES);
const PURPOSES = new Set(ON_DEMAND_PURPOSES);
const STATUSES = new Set(ON_DEMAND_STATUSES);

// Field allowlists follow the Cloud SQL Admin API v1beta4 messages that
// `gcloud sql` renders. managementConfig is deliberately absent: a Backup and
// DR managed retention is outside the evidence this audit can verify.
const BACKUP_CONFIGURATION_FIELDS = new Set([
  "backupRetentionSettings",
  "backupTier",
  "binaryLogEnabled",
  "enabled",
  "kind",
  "location",
  "pointInTimeRecoveryEnabled",
  "replicationLogArchivingEnabled",
  "startTime",
  "transactionLogRetentionDays",
  "transactionalLogStorageState",
]);
const BACKUP_RETENTION_FIELDS = new Set(["retainedBackups", "retentionUnit"]);
const FINAL_BACKUP_CONFIG_FIELDS = new Set(["enabled", "retentionDays"]);
const TRANSACTIONAL_LOG_STORAGE_STATES = new Set([
  "TRANSACTIONAL_LOG_STORAGE_STATE_UNSPECIFIED",
  "DISK",
  "SWITCHING_TO_CLOUD_STORAGE",
  "SWITCHED_TO_CLOUD_STORAGE",
  "CLOUD_STORAGE",
]);
const BACKUP_RUN_FIELDS = new Set([
  "backupDatabaseInstalledVersion",
  "backupKind",
  "databaseVersion",
  "description",
  "diskEncryptionConfiguration",
  "diskEncryptionStatus",
  "endTime",
  "enqueuedTime",
  "error",
  "id",
  "instance",
  "kind",
  "location",
  "maxChargeableBytes",
  "selfLink",
  "startTime",
  "status",
  "timeZone",
  "type",
  "windowStartTime",
]);
const BACKUP_RUN_TYPES = new Set(["AUTOMATED", "ON_DEMAND", "FINAL"]);
const BACKUP_RUN_STATUSES = new Set([
  "ENQUEUED",
  "OVERDUE",
  "RUNNING",
  "FAILED",
  "SUCCESSFUL",
  "SKIPPED",
  "DELETION_PENDING",
  "DELETION_FAILED",
  "DELETED",
]);
/** A copy may still be restorable unless its status proves otherwise. */
const RESTORABLE_RUN_STATUSES = new Set(["SUCCESSFUL", "DELETION_PENDING", "DELETION_FAILED"]);
/** Present, restorable and not already being deleted: the on-demand entries a prune can act on. */
const LISTED_ON_DEMAND_RUN_STATUSES = new Set(["SUCCESSFUL", "DELETION_FAILED"]);

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const START_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const LOCATION = /^[a-z][a-z0-9-]{0,62}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

export class BackupHorizonError extends Error {
  constructor(code) {
    super(code);
    this.name = "BackupHorizonError";
    this.code = code;
  }
}

function fail(code) {
  throw new BackupHorizonError(code);
}

function deepFreeze(value) {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sortCodes(codes) {
  return [...new Set(codes)].sort((left, right) => CODE_ORDER.get(left) - CODE_ORDER.get(right));
}

function verdictFor(codes) {
  if (codes.some((code) => BREACH_CODES.has(code))) return "breach";
  return codes.length > 0 ? "warn" : "ok";
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Throws BACKUP_HORIZON_INVARIANT_BROKEN unless every operational horizon plus
 * the restore slack fits under the ceiling, the critical threshold sits below
 * the ceiling (and above the overdue threshold), and the ceiling plus margin
 * fits inside the tombstone horizon. The ceiling is not an operational horizon.
 */
export function assertBackupHorizonInvariant({ constants = BACKUP_HORIZON_CONSTANTS } = {}) {
  if (!isPlainObject(constants)
      || !Object.keys(BACKUP_HORIZON_CONSTANTS).every((key) => isPositiveSafeInteger(constants[key]))) {
    fail("BACKUP_HORIZON_INVARIANT_BROKEN");
  }
  const ceiling = constants.BACKUP_HORIZON_MAX_DAYS;
  const operationalHorizonDays = [
    constants.AUTOMATED_RETAINED_BACKUPS,
    constants.PITR_LOG_RETENTION_DAYS,
    constants.ON_DEMAND_MAX_DAYS,
    constants.FINAL_BACKUP_MAX_DAYS,
  ];
  if (operationalHorizonDays.some((days) => days + constants.RESTORE_SLACK_DAYS > ceiling)
      || !(constants.ON_DEMAND_CRITICAL_DAYS < ceiling)
      || !(constants.ON_DEMAND_MAX_DAYS < constants.ON_DEMAND_CRITICAL_DAYS)
      || ceiling + constants.HORIZON_MARGIN_DAYS > constants.RESTORE_SUPPRESSION_TOMBSTONE_DAYS) {
    fail("BACKUP_HORIZON_INVARIANT_BROKEN");
  }
  return true;
}

assertBackupHorizonInvariant();

/** Parse an RFC 3339 timestamp to epoch milliseconds, or null. */
function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = RFC3339.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  const dayStart = parseCalendarDate(`${year}-${month}-${day}`);
  if (dayStart === null || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRest = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetRest > 59) return null;
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (offsetHours * 60 + offsetRest);
  }
  const milliseconds = Number(`${fraction}000`.slice(0, 3));
  return dayStart
    + Number(hour) * HOUR_MS + Number(minute) * 60_000 + Number(second) * 1_000
    + milliseconds - offsetMinutes * 60_000;
}

/** Parse a YYYY-MM-DD calendar date to its UTC midnight, or null. */
function parseCalendarDate(value) {
  if (typeof value !== "string") return null;
  const match = CALENDAR_DATE.exec(value);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1970 || month < 1 || month > 12 || day < 1) return null;
  const epoch = Date.UTC(year, month - 1, day);
  const check = new Date(epoch);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return epoch;
}

/** The on-demand label for a backup that expires on the given UTC date. */
export function formatOnDemandDescription({ expiresOn, purpose }) {
  if (parseCalendarDate(expiresOn) === null || !PURPOSES.has(purpose)) {
    fail("BACKUP_ON_DEMAND_LABEL_INVALID");
  }
  return `tibotattle-expires-on=${expiresOn};purpose=${purpose}`;
}

/** Returns {expiresOn, purpose} for an exact label, or null (unlabelled). */
export function parseOnDemandDescription(description) {
  if (typeof description !== "string") return null;
  const match = DESCRIPTION_PATTERN.exec(description);
  if (match === null || parseCalendarDate(match[1]) === null) return null;
  return Object.freeze({ expiresOn: match[1], purpose: match[2] });
}

/** UTC calendar date `expiresInDays` days after `nowMs`. */
export function onDemandExpiresOn(nowMs, expiresInDays) {
  if (!isNonNegativeSafeInteger(nowMs) || !Number.isSafeInteger(expiresInDays)
      || expiresInDays < 1 || expiresInDays > ON_DEMAND_MAX_DAYS) {
    fail("BACKUP_ON_DEMAND_EXPIRY_INVALID");
  }
  return new Date(nowMs + expiresInDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * BackupRun ids are int64: the Admin API sends decimal strings and gcloud may
 * print numbers. Returns the decimal string, or null when the id is not a
 * positive integer that survived JSON parsing exactly.
 */
export function normalizeBackupRunId(value) {
  if (typeof value === "string" && BACKUP_RUN_ID_PATTERN.test(value)) return value;
  if (isPositiveSafeInteger(value)) return String(value);
  return null;
}

/**
 * Critical past ON_DEMAND_CRITICAL_DAYS, overdue past ON_DEMAND_MAX_DAYS (both
 * strictly greater), then due from the UTC midnight that ends the expires-on
 * date. onDemandExpiresOn drops the time of day, so ending the date (rather
 * than starting it) keeps every labelled backup for at least the days asked.
 */
function onDemandStatusFor({ ageMs, label, nowMs }) {
  if (ageMs > ON_DEMAND_CRITICAL_DAYS * DAY_MS) return "critical";
  if (ageMs > ON_DEMAND_MAX_DAYS * DAY_MS) return "overdue";
  if (label !== null && nowMs >= parseCalendarDate(label.expiresOn) + DAY_MS) return "due";
  return label === null ? "unlabelled" : "ok";
}

/**
 * Classify one backup run (a `gcloud sql backups list --format=json` item or a
 * Cloud SQL Admin API BackupRun) at `nowMs`. Returns {recognized:false} for
 * anything this policy cannot read with certainty. The description is reduced
 * to its parsed label and never returned.
 */
export function classifyBackupRun(run, { instance, nowMs }) {
  const unrecognized = Object.freeze({ recognized: false });
  if (!isPlainObject(run) || !hasOnlyKeys(run, BACKUP_RUN_FIELDS)) return unrecognized;
  if (run.kind !== undefined && run.kind !== "sql#backupRun") return unrecognized;
  if (run.instance !== undefined && run.instance !== instance) return unrecognized;
  if (run.description !== undefined && typeof run.description !== "string") return unrecognized;
  if (run.location !== undefined && (typeof run.location !== "string" || !LOCATION.test(run.location))) {
    return unrecognized;
  }
  const id = normalizeBackupRunId(run.id);
  if (id === null || !BACKUP_RUN_TYPES.has(run.type) || !BACKUP_RUN_STATUSES.has(run.status)) {
    return unrecognized;
  }
  const restorable = RESTORABLE_RUN_STATUSES.has(run.status);
  let windowStartMs = null;
  if (run.windowStartTime !== undefined || restorable) {
    windowStartMs = parseTimestamp(run.windowStartTime);
    if (windowStartMs === null || windowStartMs > nowMs + FUTURE_TIMESTAMP_TOLERANCE_MS) return unrecognized;
  }
  const ageMs = windowStartMs === null ? null : Math.max(0, nowMs - windowStartMs);
  const label = run.type === "ON_DEMAND" ? parseOnDemandDescription(run.description) : null;
  const listedOnDemand = run.type === "ON_DEMAND" && LISTED_ON_DEMAND_RUN_STATUSES.has(run.status);
  return Object.freeze({
    recognized: true,
    id,
    type: run.type,
    status: run.status,
    restorable,
    location: run.location ?? null,
    windowStartTime: windowStartMs === null ? null : new Date(windowStartMs).toISOString(),
    ageMs,
    label,
    onDemandStatus: listedOnDemand ? onDemandStatusFor({ ageMs, label, nowMs }) : null,
  });
}

function assessSettings(describe, { instance, region }) {
  const codes = [];
  const flags = {
    recognized: true,
    backupsEnabled: false,
    pointInTimeRecoveryEnabled: false,
    automatedRetentionCompliant: false,
    transactionLogRetentionCompliant: false,
    finalBackupCompliant: false,
    finalBackupConfigReported: false,
    locationCompliant: region === null ? null : false,
  };
  const unrecognized = () => {
    flags.recognized = false;
    codes.push("BACKUP_SETTINGS_UNRECOGNIZED");
  };
  if (!isPlainObject(describe) || !isPlainObject(describe.settings)) {
    unrecognized();
    return { flags, codes };
  }
  if (describe.name !== instance) unrecognized();

  const config = describe.settings.backupConfiguration;
  if (!isPlainObject(config)) {
    unrecognized();
  } else {
    if (!hasOnlyKeys(config, BACKUP_CONFIGURATION_FIELDS)) unrecognized();
    if ((config.kind !== undefined && config.kind !== "sql#backupConfiguration")
        || (config.backupTier !== undefined && config.backupTier !== "STANDARD")
        || (config.binaryLogEnabled !== undefined && typeof config.binaryLogEnabled !== "boolean")
        || (config.replicationLogArchivingEnabled !== undefined
          && typeof config.replicationLogArchivingEnabled !== "boolean")
        || (config.transactionalLogStorageState !== undefined
          && !TRANSACTIONAL_LOG_STORAGE_STATES.has(config.transactionalLogStorageState))
        || (config.startTime !== undefined
          && (typeof config.startTime !== "string" || !START_TIME.test(config.startTime)))) {
      unrecognized();
    }

    if (config.enabled === true) flags.backupsEnabled = true;
    else if (config.enabled === false || config.enabled === undefined) codes.push("BACKUP_DISABLED");
    else unrecognized();

    if (config.pointInTimeRecoveryEnabled === true) flags.pointInTimeRecoveryEnabled = true;
    else if (config.pointInTimeRecoveryEnabled === false || config.pointInTimeRecoveryEnabled === undefined) {
      codes.push("PITR_DISABLED");
    } else {
      unrecognized();
    }

    const retention = config.backupRetentionSettings;
    if (!isPlainObject(retention) || !hasOnlyKeys(retention, BACKUP_RETENTION_FIELDS)) {
      unrecognized();
    } else if (retention.retentionUnit === "COUNT") {
      if (!isPositiveSafeInteger(retention.retainedBackups)) unrecognized();
      else if (retention.retainedBackups > AUTOMATED_RETAINED_BACKUPS) codes.push("AUTOMATED_RETENTION_EXCEEDED");
      else flags.automatedRetentionCompliant = true;
    } else if (retention.retentionUnit === "RETENTION_UNIT_UNSPECIFIED") {
      codes.push("AUTOMATED_RETENTION_EXCEEDED");
    } else {
      unrecognized();
    }

    const logDays = config.transactionLogRetentionDays;
    if (logDays === undefined) {
      // Enterprise Plus defaults to 14 days, so an absent value cannot be read as 7.
      if (config.pointInTimeRecoveryEnabled === false || config.pointInTimeRecoveryEnabled === undefined) {
        flags.transactionLogRetentionCompliant = true;
      } else {
        unrecognized();
      }
    } else if (!isPositiveSafeInteger(logDays)) {
      unrecognized();
    } else if (logDays > PITR_LOG_RETENTION_DAYS) {
      codes.push("PITR_RETENTION_EXCEEDED");
    } else {
      flags.transactionLogRetentionCompliant = true;
    }

    if (config.location !== undefined
        && (typeof config.location !== "string" || !LOCATION.test(config.location))) {
      unrecognized();
    } else if (region !== null) {
      // An absent location means the default multi-region, which is not the region.
      if (config.location === region) flags.locationCompliant = true;
      else codes.push("BACKUP_LOCATION_MISMATCH");
    }
  }

  let finalCompliant = true;
  const finalConfig = describe.settings.finalBackupConfig;
  if (finalConfig !== undefined) {
    flags.finalBackupConfigReported = true;
    if (!isPlainObject(finalConfig) || !hasOnlyKeys(finalConfig, FINAL_BACKUP_CONFIG_FIELDS)
        || (finalConfig.retentionDays !== undefined && !isPositiveSafeInteger(finalConfig.retentionDays))) {
      unrecognized();
      finalCompliant = false;
    } else if (finalConfig.enabled === true) {
      if (finalConfig.retentionDays === undefined) {
        unrecognized();
        finalCompliant = false;
      } else if (finalConfig.retentionDays > FINAL_BACKUP_MAX_DAYS) {
        codes.push("FINAL_BACKUP_RETENTION_EXCEEDED");
        finalCompliant = false;
      }
    } else if (finalConfig.enabled !== false && finalConfig.enabled !== undefined) {
      unrecognized();
      finalCompliant = false;
    }
  }
  const retainOnDelete = describe.settings.retainBackupsOnDelete;
  if (retainOnDelete === true) {
    // Retained on-demand backups outlive the instance until someone deletes them.
    codes.push("FINAL_BACKUP_RETENTION_EXCEEDED");
    finalCompliant = false;
  } else if (retainOnDelete !== false && retainOnDelete !== undefined) {
    unrecognized();
    finalCompliant = false;
  }
  flags.finalBackupCompliant = finalCompliant;
  return { flags, codes };
}

function compareDecimalIds(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Oldest first (canonical ISO instants sort lexically), then by numeric id. */
export function compareOnDemandEntries(left, right) {
  if (left.windowStartTime !== right.windowStartTime) {
    return left.windowStartTime < right.windowStartTime ? -1 : 1;
  }
  return compareDecimalIds(left.id, right.id);
}

/**
 * `settings.recognized` is false whenever any backup evidence for the role
 * (describe or run list) could not be read. When the run list itself cannot
 * be read completely, the run-derived fields are null: unavailable, not zero.
 */
function assessRole({ instance, settings, backupRuns }, { nowMs, region }) {
  const { flags, codes } = assessSettings(settings, { instance, region });
  const unrecognized = () => {
    flags.recognized = false;
    codes.push("BACKUP_SETTINGS_UNRECOGNIZED");
  };
  let runsReadable = Array.isArray(backupRuns);
  let automatedCount = 0;
  let oldestAutomatedAgeMs = null;
  let newestAutomatedAgeMs = null;
  const onDemand = [];
  if (!runsReadable) {
    unrecognized();
  } else {
    const seen = new Set();
    for (const run of backupRuns) {
      const classified = classifyBackupRun(run, { instance, nowMs });
      if (!classified.recognized || seen.has(classified.id)) {
        runsReadable = false;
        unrecognized();
        continue;
      }
      seen.add(classified.id);
      if (classified.restorable && classified.ageMs > BACKUP_HORIZON_MAX_DAYS * DAY_MS) {
        codes.push("BACKUP_OLDER_THAN_HORIZON");
      }
      if (classified.restorable && region !== null && classified.location !== region) {
        flags.locationCompliant = false;
        // A copy with no stated location cannot be shown to be in the region.
        if (classified.location === null) unrecognized();
        else codes.push("BACKUP_LOCATION_MISMATCH");
      }
      if (classified.type === "FINAL" && classified.restorable
          && classified.ageMs > FINAL_BACKUP_MAX_DAYS * DAY_MS) {
        codes.push("FINAL_BACKUP_RETENTION_EXCEEDED");
      }
      if (classified.type === "AUTOMATED" && classified.status === "SUCCESSFUL") {
        automatedCount += 1;
        oldestAutomatedAgeMs = Math.max(oldestAutomatedAgeMs ?? 0, classified.ageMs);
        newestAutomatedAgeMs = Math.min(newestAutomatedAgeMs ?? Infinity, classified.ageMs);
      }
      if (classified.onDemandStatus !== null) {
        if (classified.label === null) codes.push("ON_DEMAND_UNLABELLED");
        if (classified.onDemandStatus === "due") codes.push("ON_DEMAND_DUE");
        if (classified.onDemandStatus === "overdue") codes.push("ON_DEMAND_OVERDUE");
        if (classified.onDemandStatus === "critical") codes.push("ON_DEMAND_CRITICAL");
        onDemand.push({
          id: classified.id,
          windowStartTime: classified.windowStartTime,
          ageDays: Math.floor(classified.ageMs / DAY_MS),
          expiresOn: classified.label?.expiresOn ?? null,
          purpose: classified.label?.purpose ?? null,
          status: classified.onDemandStatus,
        });
      }
    }
  }
  if (!runsReadable) {
    return {
      instance,
      settings: flags,
      automatedCount: null,
      oldestAutomatedAgeDays: null,
      lastSuccessfulAutomatedAgeHours: null,
      onDemand: null,
      codes: sortCodes(codes),
    };
  }
  if (newestAutomatedAgeMs === null || newestAutomatedAgeMs > LAST_AUTOMATED_SUCCESS_MAX_HOURS * HOUR_MS) {
    codes.push("AUTOMATED_BACKUP_STALE");
  }
  onDemand.sort(compareOnDemandEntries);
  return {
    instance,
    settings: flags,
    automatedCount,
    oldestAutomatedAgeDays: oldestAutomatedAgeMs === null ? null : Math.floor(oldestAutomatedAgeMs / DAY_MS),
    lastSuccessfulAutomatedAgeHours: newestAutomatedAgeMs === null
      ? null
      : Math.floor(newestAutomatedAgeMs / HOUR_MS),
    onDemand,
    codes: sortCodes(codes),
  };
}

function validateAssessmentInput({ environment, nowMs, project, region, instances }) {
  if (!BACKUP_HORIZON_ENVIRONMENTS.includes(environment)
      || !isNonNegativeSafeInteger(nowMs)
      || typeof project !== "string" || !GCP_PROJECT_ID_PATTERN.test(project)
      || (region !== null && (typeof region !== "string" || !GCP_REGION_PATTERN.test(region)))
      || !Array.isArray(instances) || instances.length !== BACKUP_HORIZON_ROLES.length) {
    fail("BACKUP_HORIZON_INPUT_INVALID");
  }
  const byRole = new Map();
  for (const entry of instances) {
    if (!isPlainObject(entry) || !BACKUP_HORIZON_ROLES.includes(entry.role) || byRole.has(entry.role)
        || typeof entry.instance !== "string" || !CLOUD_SQL_INSTANCE_ID_PATTERN.test(entry.instance)) {
      fail("BACKUP_HORIZON_INPUT_INVALID");
    }
    byRole.set(entry.role, entry);
  }
  if (byRole.get("primary").instance === byRole.get("ledger").instance) fail("BACKUP_HORIZON_INPUT_INVALID");
  return byRole;
}

/** sha256 of the canonical (sorted-key) JSON of a receipt body without its digest. */
export function backupHorizonReceiptDigest(body) {
  const { digest: _ignored, ...rest } = body;
  return sha256Hex(canonicalJson(rest));
}

/**
 * Assess both Cloud SQL instances against the backup-horizon policy.
 *
 * @param {object} input
 * @param {"production"|"staging"} input.environment
 * @param {number} input.nowMs epoch milliseconds
 * @param {string} input.project GCP project id the instances live in
 * @param {string|null} [input.region] manifest region; when supplied the
 *   configured backup location and every restorable copy's location must equal it
 * @param {Array<{role:"primary"|"ledger", instance:string, settings:object, backupRuns:unknown}>} input.instances
 *   `settings` is the `gcloud sql instances describe --format=json` object
 *   (Admin API DatabaseInstance); `backupRuns` the `gcloud sql backups list
 *   --instance=<name> --format=json` array (Admin API BackupRun items).
 * @returns a deep-frozen 'tibotattle-backup-horizon-audit-v1' receipt whose
 *   `coverage` is BACKUP_HORIZON_COVERAGE: an ok verdict speaks for the
 *   instances' listed backup runs, not for project-level backups.
 */
export function assessBackupRuns({ environment, nowMs, project, region = null, instances } = {}) {
  const byRole = validateAssessmentInput({ environment, nowMs, project, region, instances });
  const roles = {};
  for (const role of BACKUP_HORIZON_ROLES) roles[role] = assessRole(byRole.get(role), { nowMs, region });
  const codes = sortCodes([...roles.primary.codes, ...roles.ledger.codes]);
  const body = {
    schema: BACKUP_HORIZON_AUDIT_SCHEMA,
    coverage: BACKUP_HORIZON_COVERAGE,
    environment,
    project,
    region,
    generatedAt: new Date(nowMs).toISOString(),
    roles,
    verdict: verdictFor(codes),
    codes,
  };
  return deepFreeze({ ...body, digest: backupHorizonReceiptDigest(body) });
}

const RECEIPT_KEYS = [
  "schema",
  "coverage",
  "environment",
  "project",
  "region",
  "generatedAt",
  "roles",
  "verdict",
  "codes",
  "digest",
];
const ROLE_KEYS = [
  "instance",
  "settings",
  "automatedCount",
  "oldestAutomatedAgeDays",
  "lastSuccessfulAutomatedAgeHours",
  "onDemand",
  "codes",
];
const SETTINGS_BOOLEAN_KEYS = [
  "recognized",
  "backupsEnabled",
  "pointInTimeRecoveryEnabled",
  "automatedRetentionCompliant",
  "transactionLogRetentionCompliant",
  "finalBackupCompliant",
  "finalBackupConfigReported",
];
const ON_DEMAND_KEYS = ["id", "windowStartTime", "ageDays", "expiresOn", "purpose", "status"];

function isCanonicalInstant(value) {
  if (typeof value !== "string") return false;
  const epoch = parseTimestamp(value);
  return epoch !== null && new Date(epoch).toISOString() === value;
}

function validCodeList(codes) {
  return Array.isArray(codes)
    && codes.every((code) => CODE_ORDER.has(code))
    && canonicalJson(sortCodes(codes)) === canonicalJson(codes);
}

const ON_DEMAND_STATUS_CODES = Object.freeze({
  due: "ON_DEMAND_DUE",
  overdue: "ON_DEMAND_OVERDUE",
  critical: "ON_DEMAND_CRITICAL",
});
const ON_DEMAND_CODES = new Set(["ON_DEMAND_UNLABELLED", ...Object.values(ON_DEMAND_STATUS_CODES)]);

function validRole(role) {
  if (!hasExactKeys(role, ROLE_KEYS)
      || typeof role.instance !== "string" || !CLOUD_SQL_INSTANCE_ID_PATTERN.test(role.instance)
      || !hasExactKeys(role.settings, [...SETTINGS_BOOLEAN_KEYS, "locationCompliant"])
      || !SETTINGS_BOOLEAN_KEYS.every((key) => typeof role.settings[key] === "boolean")
      || !(role.settings.locationCompliant === null || typeof role.settings.locationCompliant === "boolean")
      || !(role.oldestAutomatedAgeDays === null || isNonNegativeSafeInteger(role.oldestAutomatedAgeDays))
      || !(role.lastSuccessfulAutomatedAgeHours === null
        || isNonNegativeSafeInteger(role.lastSuccessfulAutomatedAgeHours))
      || !validCodeList(role.codes)) {
    return false;
  }
  if (role.onDemand === null) {
    // Run evidence unavailable: every run-derived value is null and the role says why.
    return role.automatedCount === null
      && role.oldestAutomatedAgeDays === null
      && role.lastSuccessfulAutomatedAgeHours === null
      && role.settings.recognized === false
      && role.codes.includes("BACKUP_SETTINGS_UNRECOGNIZED")
      && !role.codes.includes("AUTOMATED_BACKUP_STALE");
  }
  if (!Array.isArray(role.onDemand) || !isNonNegativeSafeInteger(role.automatedCount)) return false;
  const ids = new Set();
  const impliedCodes = new Set();
  for (const entry of role.onDemand) {
    if (!hasExactKeys(entry, ON_DEMAND_KEYS)
        || typeof entry.id !== "string" || !BACKUP_RUN_ID_PATTERN.test(entry.id) || ids.has(entry.id)
        || !isCanonicalInstant(entry.windowStartTime)
        || !isNonNegativeSafeInteger(entry.ageDays)
        || !STATUSES.has(entry.status)
        || (entry.purpose === null) !== (entry.expiresOn === null)
        || (entry.purpose !== null && (!PURPOSES.has(entry.purpose) || parseCalendarDate(entry.expiresOn) === null))
        || (entry.status === "unlabelled" && entry.purpose !== null)
        || ((entry.status === "ok" || entry.status === "due") && entry.purpose === null)) {
      return false;
    }
    ids.add(entry.id);
    if (entry.purpose === null) impliedCodes.add("ON_DEMAND_UNLABELLED");
    if (Object.hasOwn(ON_DEMAND_STATUS_CODES, entry.status)) impliedCodes.add(ON_DEMAND_STATUS_CODES[entry.status]);
  }
  // Listed entries and on-demand codes must describe the same backups.
  const onDemandCodes = role.codes.filter((code) => ON_DEMAND_CODES.has(code));
  return onDemandCodes.length === impliedCodes.size && onDemandCodes.every((code) => impliedCodes.has(code));
}

/**
 * Validate a receipt produced by assessBackupRuns (for example one read back
 * from a file) against the closed schema, and recompute its digest. Returns
 * the deep-frozen receipt or throws BACKUP_HORIZON_RECEIPT_INVALID.
 */
export function verifyBackupHorizonReceipt(receipt) {
  if (!hasExactKeys(receipt, RECEIPT_KEYS)
      || receipt.schema !== BACKUP_HORIZON_AUDIT_SCHEMA
      || receipt.coverage !== BACKUP_HORIZON_COVERAGE
      || !BACKUP_HORIZON_ENVIRONMENTS.includes(receipt.environment)
      || typeof receipt.project !== "string" || !GCP_PROJECT_ID_PATTERN.test(receipt.project)
      || !(receipt.region === null
        || (typeof receipt.region === "string" && GCP_REGION_PATTERN.test(receipt.region)))
      || !isCanonicalInstant(receipt.generatedAt)
      || !hasExactKeys(receipt.roles, BACKUP_HORIZON_ROLES)
      || !BACKUP_HORIZON_ROLES.every((role) => validRole(receipt.roles[role]))
      || receipt.roles.primary.instance === receipt.roles.ledger.instance
      || !validCodeList(receipt.codes)
      || canonicalJson(receipt.codes)
        !== canonicalJson(sortCodes([...receipt.roles.primary.codes, ...receipt.roles.ledger.codes]))
      || receipt.verdict !== verdictFor(receipt.codes)
      || typeof receipt.digest !== "string" || !DIGEST.test(receipt.digest)
      || receipt.digest !== backupHorizonReceiptDigest(receipt)) {
    fail("BACKUP_HORIZON_RECEIPT_INVALID");
  }
  return deepFreeze(receipt);
}

/**
 * The exact Cloud SQL backup flags OPS-2 renders for `gcloud sql instances
 * create|patch`, and the describe fields its readback must see.
 *
 * `finalBackupFlags` keep final backups bounded (at most FINAL_BACKUP_MAX_DAYS)
 * and retained-after-delete backups off. When the installed gcloud lacks a
 * final-backup flag, readback still verifies the describe fields through
 * assessBackupRuns, which fails closed on unknown values.
 */
export function desiredBackupConfiguration({ region, backupStartTime } = {}) {
  if (typeof region !== "string" || !GCP_REGION_PATTERN.test(region)
      || typeof backupStartTime !== "string" || !START_TIME.test(backupStartTime)) {
    fail("BACKUP_CONFIGURATION_INPUT_INVALID");
  }
  return deepFreeze({
    flags: [
      `--backup-start-time=${backupStartTime}`,
      `--retained-backups-count=${AUTOMATED_RETAINED_BACKUPS}`,
      `--retained-transaction-log-days=${PITR_LOG_RETENTION_DAYS}`,
      "--enable-point-in-time-recovery",
      `--backup-location=${region}`,
    ],
    finalBackupFlags: [
      "--final-backup",
      `--final-backup-retention-days=${FINAL_BACKUP_MAX_DAYS}`,
      "--no-retain-backups-on-delete",
    ],
    expectedSettings: {
      backupConfiguration: {
        enabled: true,
        startTime: backupStartTime,
        location: region,
        pointInTimeRecoveryEnabled: true,
        transactionLogRetentionDays: PITR_LOG_RETENTION_DAYS,
        backupRetentionSettings: {
          retentionUnit: "COUNT",
          retainedBackups: AUTOMATED_RETAINED_BACKUPS,
        },
      },
      finalBackupConfig: { enabled: true, retentionDays: FINAL_BACKUP_MAX_DAYS },
      retainBackupsOnDelete: false,
    },
  });
}
