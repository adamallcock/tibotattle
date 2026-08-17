import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const CLAUDE_DESKTOP_RETENTION_DETECTION_VERSION =
  "claude-desktop-retention-detection-v0.1";
export const CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS = 30;
export const CLAUDE_GUIDED_CLEANUP_PERIOD_DAYS = 90;

const MAXIMUM_SETTINGS_BYTES = 4 * 1024 * 1024;

export class ClaudeDesktopRetentionError extends Error {
  constructor(code) {
    super(`Claude Desktop retention detection failed (${code})`);
    this.name = "ClaudeDesktopRetentionError";
    this.code = `claude_desktop_retention_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopRetentionError(code);
}

function normalizeConfiguredValue(value) {
  if (value === undefined) return { state: "unset", value: null };
  if (!Number.isSafeInteger(value) || value < 1) return { state: "invalid", value: null };
  return { state: "valid", value };
}

async function readCleanupValue(path) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
        || stats.size > MAXIMUM_SETTINGS_BYTES) {
      return { state: "inaccessible", value: null };
    }
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid", value: null };
    }
    return normalizeConfiguredValue(parsed.cleanupPeriodDays);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { state: "unset", value: null };
    }
    if (error instanceof SyntaxError) return { state: "invalid", value: null };
    return { state: "inaccessible", value: null };
  }
}

export async function detectClaudeDesktopRetention({
  homeDirectory = homedir(),
  projectDirectory = process.cwd(),
  claudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR,
  managedSettingsPaths = [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/Library/ClaudeCode/managed-settings.json",
  ],
  managedPreferenceValue,
  commandLineValue,
} = {}) {
  if (typeof homeDirectory !== "string" || !isAbsolute(homeDirectory)
      || typeof projectDirectory !== "string" || !isAbsolute(projectDirectory)
      || (claudeConfigDirectory !== undefined
        && (typeof claudeConfigDirectory !== "string" || !isAbsolute(claudeConfigDirectory)))
      || !Array.isArray(managedSettingsPaths)
      || managedSettingsPaths.some((path) => typeof path !== "string" || !isAbsolute(path))) {
    fail("configuration");
  }

  const configRoot = claudeConfigDirectory
    ? resolve(claudeConfigDirectory)
    : resolve(homeDirectory, ".claude");
  const configured = [];
  configured.push({ scope: "managed_preference", ...normalizeConfiguredValue(managedPreferenceValue) });
  for (const path of managedSettingsPaths) {
    configured.push({ scope: "managed", ...(await readCleanupValue(path)) });
  }
  configured.push({ scope: "command_line", ...normalizeConfiguredValue(commandLineValue) });
  configured.push({
    scope: "local",
    ...(await readCleanupValue(join(resolve(projectDirectory), ".claude", "settings.local.json"))),
  });
  configured.push({
    scope: "project",
    ...(await readCleanupValue(join(resolve(projectDirectory), ".claude", "settings.json"))),
  });
  configured.push({ scope: "user", ...(await readCleanupValue(join(configRoot, "settings.json"))) });

  const winner = configured.find((entry) => entry.state === "valid") ?? {
    scope: "default",
    state: "valid",
    value: CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS,
  };
  const invalidScopes = [...new Set(configured
    .filter((entry) => entry.state === "invalid")
    .map((entry) => entry.scope))];
  const inaccessibleScopes = [...new Set(configured
    .filter((entry) => entry.state === "inaccessible")
    .map((entry) => entry.scope))];
  const managed = winner.scope === "managed" || winner.scope === "managed_preference";

  return {
    schemaVersion: CLAUDE_DESKTOP_RETENTION_DETECTION_VERSION,
    effectiveDays: winner.value,
    effectiveScope: winner.scope,
    configRootKind: claudeConfigDirectory ? "custom" : "default",
    managed,
    valid: invalidScopes.length === 0 && inaccessibleScopes.length === 0,
    invalidScopes,
    inaccessibleScopes,
    guidance: {
      canOfferNinetyDayInstructions: !managed && winner.value < CLAUDE_GUIDED_CLEANUP_PERIOD_DAYS,
      recommendedDays: CLAUDE_GUIDED_CLEANUP_PERIOD_DAYS,
      changesFutureCleanupOnly: true,
      restoresDeletedHistory: false,
      plaintextPrivacyWarningRequired: true,
    },
  };
}
