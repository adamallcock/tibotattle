// Runtime-neutral Claude Code configuration-root contract.  The caller owns
// the filesystem ports; this module only validates and composes path strings.

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const WINDOWS_CONTROL = /[\u0000-\u001f]/u;
const WINDOWS_INVALID_COMPONENT = /[<>:"|?*]/u;
const WINDOWS_DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);

function fail(code = "configuration") {
  const error = new TypeError("Claude configuration-root path is invalid");
  error.code = `claude_config_root_${code}`;
  throw error;
}

function assertPlatform(platform) {
  if (typeof platform !== "string" || !SUPPORTED_PLATFORMS.has(platform)) {
    fail("platform");
  }
  // A real Windows process must never be made to use POSIX path semantics by
  // an injected label.  Non-Windows tests may exercise the win32 contract
  // without pretending that the host filesystem is Windows.
  if (process.platform === "win32" && platform !== "win32") fail("platform_downgrade");
  return platform;
}

function assertPlainString(value, code = "configuration") {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096
      || value.includes("\0") || WINDOWS_CONTROL.test(value)) {
    fail(code);
  }
  return value;
}

function isReservedWindowsComponent(component) {
  const stem = component.split(".", 1)[0].replace(/[ .]+$/gu, "");
  return WINDOWS_DEVICE_STEM.test(stem);
}

function assertWindowsComponent(component, code) {
  if (component === "") return;
  if (component === "." || component === ".."
      || WINDOWS_INVALID_COMPONENT.test(component)
      || /[. ]$/u.test(component)
      || isReservedWindowsComponent(component)) {
    fail(code);
  }
}

function normalizeWindowsAbsolutePath(value, code = "path") {
  assertPlainString(value, code);
  if (!WINDOWS_DRIVE_ABSOLUTE.test(value)) fail(code);
  const replaced = value.replaceAll("/", "\\");
  const drive = replaced.slice(0, 2);
  const suffix = replaced.slice(3);
  const parts = suffix.split("\\");
  // Repeated separators are intentionally accepted and collapsed. Empty
  // components are harmless; every non-empty component must be Windows-safe.
  for (const part of parts) assertWindowsComponent(part, code);
  const compact = parts.filter((part) => part.length > 0);
  return compact.length === 0
    ? `${drive}\\`
    : `${drive}\\${compact.join("\\")}`;
}

function normalizePosixAbsolutePath(value, resolvePath, code = "path") {
  assertPlainString(value, code);
  if (typeof resolvePath !== "function") fail("ports");
  let normalized;
  try {
    normalized = resolvePath(value);
  } catch {
    fail(code);
  }
  if (normalized !== value) fail(code);
  return normalized;
}

function joinWindows(root, child) {
  return root.endsWith("\\") ? `${root}${child}` : `${root}\\${child}`;
}

function joinPathForPlatform(platform, root, child, joinPath) {
  if (platform === "win32") return joinWindows(root, child);
  if (typeof joinPath !== "function") fail("ports");
  try {
    return joinPath(root, child);
  } catch {
    fail("path");
  }
}

function environmentValue(environment, key) {
  if (environment === undefined) return undefined;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("environment");
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (descriptor === undefined) return undefined;
    if (!Object.hasOwn(descriptor, "value")) fail("environment");
    return descriptor.value;
  } catch (error) {
    if (error?.code?.startsWith("claude_config_root_")) throw error;
    fail("environment");
  }
}

/**
 * Resolve the Claude Code user root and its two supported source paths.
 *
 * `CLAUDE_CONFIG_DIR` changes both settings and transcript roots.  It is
 * intentionally not used for Claude Desktop's separate plan-history source.
 */
export function resolveClaudeConfigRoot({
  platform,
  homeDirectory,
  userProfile,
  claudeConfigDirectory,
  environment,
  joinPath,
  resolvePath,
} = {}) {
  const selectedPlatform = assertPlatform(platform);
  const environmentHome = selectedPlatform === "win32"
    ? environmentValue(environment, "USERPROFILE")
    : undefined;
  const selectedHome = userProfile !== undefined
    ? userProfile
    : environmentHome ?? homeDirectory;
  if (selectedPlatform === "win32") {
    const home = normalizeWindowsAbsolutePath(selectedHome, "home");
    const configured = claudeConfigDirectory === undefined
      ? environmentValue(environment, "CLAUDE_CONFIG_DIR")
      : claudeConfigDirectory;
    const configDirectory = configured === undefined
      ? joinWindows(home, ".claude")
      : normalizeWindowsAbsolutePath(configured);
    return Object.freeze({
      platform: selectedPlatform,
      homeDirectory: home,
      configDirectory,
      settingsFile: joinWindows(configDirectory, "settings.json"),
      projectsDirectory: joinWindows(configDirectory, "projects"),
    });
  }

  const home = normalizePosixAbsolutePath(selectedHome, resolvePath, "home");
  const configured = claudeConfigDirectory === undefined
    ? environmentValue(environment, "CLAUDE_CONFIG_DIR")
    : claudeConfigDirectory;
  const configDirectory = configured === undefined
    ? joinPathForPlatform(selectedPlatform, home, ".claude", joinPath)
    : normalizePosixAbsolutePath(configured, resolvePath);
  return Object.freeze({
    platform: selectedPlatform,
    homeDirectory: home,
    configDirectory,
    settingsFile: joinPathForPlatform(selectedPlatform, configDirectory, "settings.json", joinPath),
    projectsDirectory: joinPathForPlatform(selectedPlatform, configDirectory, "projects", joinPath),
  });
}

export function normalizeClaudeConfiguredPath(value, { platform, resolvePath } = {}) {
  const selectedPlatform = assertPlatform(platform);
  return selectedPlatform === "win32"
    ? normalizeWindowsAbsolutePath(value)
    : normalizePosixAbsolutePath(value, resolvePath);
}
