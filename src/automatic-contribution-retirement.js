import { randomUUID } from "node:crypto";

import {
  createOwnerOnlyAutomaticContributionStorageContext,
} from "./platform/index.js";

export const AUTOMATIC_CONTRIBUTION_RETIREMENT_SCHEMA_VERSION =
  "automatic-contribution-retired-v1";
export const AUTOMATIC_CONTRIBUTION_RETIRED_SETTINGS_SCHEMA_VERSIONS =
  Object.freeze([
    "automatic-contribution-settings-v0.1",
    "automatic-contribution-settings-v0.2",
    "automatic-contribution-settings-v0.3",
    "automatic-contribution-settings-v0.4",
  ]);

const MAXIMUM_INSTANCE_LOCK_BYTES = 4 * 1_024;
const MAXIMUM_SETTINGS_BYTES = 64 * 1_024;
const LEGACY_SETTINGS_SCHEMAS = new Set(
  AUTOMATIC_CONTRIBUTION_RETIRED_SETTINGS_SCHEMA_VERSIONS,
);
const PRIOR_STATES = new Set(["absent", "disabled", "enabled", "unavailable"]);
const TOMBSTONE_KEYS = Object.freeze([
  "networkActivity",
  "priorState",
  "retiredAt",
  "schemaVersion",
]);

export class AutomaticContributionRetirementError extends Error {
  constructor(code) {
    super("Automatic contribution retirement failed closed");
    this.name = "AutomaticContributionRetirementError";
    this.code = `automatic_contribution_retirement_${code}`;
  }
}

const storage = createOwnerOnlyAutomaticContributionStorageContext({
  createError: (code) => new AutomaticContributionRetirementError(code),
  uuid: randomUUID,
});

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function canonicalTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AutomaticContributionRetirementError("configuration_invalid");
  }
  return date.toISOString();
}

function parseTombstone(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  let retiredAt = null;
  try {
    retiredAt = canonicalTimestamp(value?.retiredAt);
  } catch {
    retiredAt = null;
  }
  if (!exactKeys(value, TOMBSTONE_KEYS)
      || value.schemaVersion !== AUTOMATIC_CONTRIBUTION_RETIREMENT_SCHEMA_VERSION
      || !PRIOR_STATES.has(value.priorState)
      || value.networkActivity !== false
      || retiredAt !== value.retiredAt) {
    return null;
  }
  return Object.freeze({ ...value });
}

function priorState(text) {
  if (text === null) return "absent";
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return "unavailable";
  }
  if (!value
      || typeof value !== "object"
      || Array.isArray(value)
      || !LEGACY_SETTINGS_SCHEMAS.has(value.schemaVersion)
      || typeof value.enabled !== "boolean") {
    return "unavailable";
  }
  return value.enabled ? "enabled" : "disabled";
}

/**
 * Atomically replace only the retired automatic-scheduler settings file with
 * a content-free downgrade tombstone. Queue and prepared-set paths are never
 * accepted by this boundary and therefore cannot be changed here.
 */
export async function retireAutomaticContributionState({
  settingsFile,
  now = () => new Date(),
} = {}) {
  if (typeof now !== "function") {
    throw new AutomaticContributionRetirementError("configuration_invalid");
  }
  const text = await storage.readSettingsText({
    settingsFile,
    maximumBytes: MAXIMUM_SETTINGS_BYTES,
  });
  const existing = text === null ? null : parseTombstone(text);
  if (existing !== null) {
    return Object.freeze({ status: "already_retired", ...existing });
  }
  const tombstone = Object.freeze({
    schemaVersion: AUTOMATIC_CONTRIBUTION_RETIREMENT_SCHEMA_VERSION,
    retiredAt: canonicalTimestamp(now()),
    priorState: priorState(text),
    networkActivity: false,
  });
  await storage.writeSettingsText({
    settingsFile,
    text: `${JSON.stringify(tombstone)}\n`,
    maximumBytes: MAXIMUM_SETTINGS_BYTES,
  });
  return Object.freeze({ status: "retired", ...tombstone });
}

export function acquireAutomaticContributionRetirementLock({
  lockFile,
  pid,
  now,
  processIsAlive,
} = {}) {
  return storage.acquireInstanceLock({
    lockFile,
    pid,
    now,
    processIsAlive,
    maximumBytes: MAXIMUM_INSTANCE_LOCK_BYTES,
  });
}
