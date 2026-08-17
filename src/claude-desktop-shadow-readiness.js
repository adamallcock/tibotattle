import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { detectClaudeDesktopRetention } from "./claude-desktop-retention.js";

export const CLAUDE_DESKTOP_SHADOW_READINESS_VERSION =
  "claude-desktop-shadow-readiness-v0.1";

const SOURCE_STATUSES = new Set(["available", "missing", "inaccessible", "unsafe"]);

function safeAbsoluteDirectory(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
      || !isAbsolute(value) || resolve(value) !== value) {
    throw new TypeError(`${label} must be a normalized absolute path`);
  }
  return value;
}

function ownerMatches(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

async function classifySource(path, kind) {
  try {
    const stats = await lstat(path);
    const expectedKind = kind === "directory" ? stats.isDirectory() : stats.isFile();
    const unsafePermissions = process.platform !== "win32" && (stats.mode & 0o022) !== 0;
    const unsafeLinks = stats.isSymbolicLink() || (kind === "file" && stats.nlink !== 1);
    return expectedKind && ownerMatches(stats) && !unsafePermissions && !unsafeLinks
      ? "available"
      : "unsafe";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "missing";
    return "inaccessible";
  }
}

function closedSource(status) {
  if (!SOURCE_STATUSES.has(status)) throw new TypeError("invalid Claude readiness source status");
  return { status };
}

/**
 * Inspect only the allowlisted Claude Desktop Code roots and the already
 * minimized retention projection. No transcript, metadata, quota, settings
 * body, path, filename, or identifier crosses this boundary.
 */
export async function inspectClaudeDesktopShadowReadiness({
  homeDirectory = homedir(),
  projectDirectory = process.cwd(),
  claudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR,
  platform = process.platform,
  shadowEnabled = false,
  managedSettingsPaths = undefined,
} = {}) {
  const home = safeAbsoluteDirectory(homeDirectory, "homeDirectory");
  const project = safeAbsoluteDirectory(projectDirectory, "projectDirectory");
  if (claudeConfigDirectory !== undefined) {
    safeAbsoluteDirectory(claudeConfigDirectory, "claudeConfigDirectory");
  }
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new TypeError("platform is invalid");
  }
  if (typeof shadowEnabled !== "boolean"
      || (managedSettingsPaths !== undefined && (
        !Array.isArray(managedSettingsPaths)
        || managedSettingsPaths.some((value) => (
          typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
        ))
      ))) {
    throw new TypeError("Claude shadow readiness configuration is invalid");
  }

  if (platform !== "darwin") {
    return {
      schemaVersion: CLAUDE_DESKTOP_SHADOW_READINESS_VERSION,
      provider: "anthropic_claude_code",
      shadowMode: shadowEnabled ? "enabled" : "disabled",
      status: "blocked",
      usageSources: {
        metadata: closedSource("missing"),
        projects: closedSource("missing"),
      },
      quotaSource: closedSource("missing"),
      retention: {
        status: "unavailable",
        effectiveDays: null,
        effectiveScope: null,
        canOfferNinetyDayInstructions: false,
      },
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
    };
  }

  const applicationSupport = join(home, "Library", "Application Support", "Claude");
  const configRoot = claudeConfigDirectory === undefined
    ? join(home, ".claude")
    : resolve(claudeConfigDirectory);
  const [metadataStatus, projectsStatus, quotaStatus, retention] = await Promise.all([
    classifySource(join(applicationSupport, "claude-code-sessions"), "directory"),
    classifySource(join(configRoot, "projects"), "directory"),
    classifySource(join(applicationSupport, "plan-usage-history.json"), "file"),
    detectClaudeDesktopRetention({
      homeDirectory: home,
      projectDirectory: project,
      claudeConfigDirectory,
      ...(managedSettingsPaths === undefined ? {} : { managedSettingsPaths }),
    }),
  ]);
  const usageReady = metadataStatus === "available" && projectsStatus === "available";
  const status = !usageReady
    ? "blocked"
    : retention.valid && quotaStatus === "available" ? "ready" : "partial";
  return {
    schemaVersion: CLAUDE_DESKTOP_SHADOW_READINESS_VERSION,
    provider: "anthropic_claude_code",
    shadowMode: shadowEnabled ? "enabled" : "disabled",
    status,
    usageSources: {
      metadata: closedSource(metadataStatus),
      projects: closedSource(projectsStatus),
    },
    quotaSource: closedSource(quotaStatus),
    retention: {
      status: retention.valid ? "available" : "partial",
      effectiveDays: retention.effectiveDays,
      effectiveScope: retention.effectiveScope,
      canOfferNinetyDayInstructions:
        retention.guidance.canOfferNinetyDayInstructions,
    },
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
  };
}
