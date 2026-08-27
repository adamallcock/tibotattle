const SAFE_ERROR_CODES = new Set([
  "companion_ready_invalid",
  "companion_ready_overflow",
  "companion_spawn_failed",
  "companion_start_timeout",
  "companion_exit_before_ready",
  "companion_shutdown_timeout",
  "companion_busy",
  "companion_not_running",
  "invalid_loopback_origin",
  "windows_readiness_unavailable",
  "windows_qualification_launch_override_forbidden",
  "desktop_ipc_unavailable",
  "electron_configuration_invalid",
  "desktop_dashboard_browser_unavailable",
  "desktop_diagnostics_unavailable",
  "desktop_local_data_unavailable",
  "desktop_codex_roots_invalid",
  "desktop_refresh_lease_exhausted",
]);

// The automatic Electron entrypoint may report this one fixed code to the
// process boundary. It intentionally never reflects an exception, path, URL,
// child output, or native diagnostic.
export const ELECTRON_ENTRY_FAILURE_DIAGNOSTIC = "electron_shell_entry_failed";

/**
 * Errors crossing the desktop boundary carry only a fixed code. Child output,
 * paths, URLs, and native error messages never cross this boundary.
 */
export class ElectronShellError extends Error {
  constructor(code) {
    if (!SAFE_ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Electron shell error code");
    }
    super("Electron shell operation failed");
    this.name = "ElectronShellError";
    this.code = `electron_shell_${code}`;
  }
}

export function shellError(code) {
  return new ElectronShellError(code);
}

export function safeShellCode(error, fallback = "electron_shell_failed") {
  if (error instanceof ElectronShellError) return error.code;
  return fallback;
}

export const ELECTRON_SHELL_ERROR_CODES = Object.freeze(
  Object.fromEntries([...SAFE_ERROR_CODES].map((code) => [
    code,
    `electron_shell_${code}`,
  ])),
);
