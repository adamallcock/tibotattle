import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_COMPANION_REPORT_FILES,
  LOCAL_COMPANION_SCHEMA_VERSION,
  LocalCompanionDataStore,
  buildLocalCompanionSnapshot,
} from "../../src/local-companion-data.js";
import {
  resolveLocalLegacyReportReadPath,
} from "../../src/local-legacy-report-storage.js";
import {
  refreshReplaySafeAccountingCache,
} from "../../src/replay-safe-accounting-cache.js";
import {
  refreshLocalArchiveAccountingIndex,
} from "../../src/local-archive-accounting-index.js";
import {
  ingestLocalUnifiedIndexIncrement,
} from "../../src/local-unified-index-ingest.js";
import {
  readLocalUnifiedWindowBreakdown,
} from "../../src/local-unified-window-breakdown.js";
import { TELEMETRY_SCHEMA_VERSION } from "@app-usagemonitor/telemetry-contract";
import {
  acquireAutomaticContributionRetirementLock,
  retireAutomaticContributionState,
} from "../../src/automatic-contribution-retirement.js";
import {
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  createIncrementalContributionSyncController,
} from "../../src/incremental-contribution.js";
import {
  runIncrementalContributionSyncOnce,
} from "../../src/contribution-incremental-sync.js";
import {
  createFastModePreferenceController,
} from "../../src/fast-mode-preference.js";
import {
  HostedSignInHandoffError,
  createHostedSignInHandoffController,
} from "../../src/hosted-signin-handoff.js";
import {
  createCodexSpeedBaselineController,
} from "../../src/codex-speed-baseline.js";
import { createLocalCentralProxy } from "../../src/local-companion-central-proxy.js";
import {
  LocalCompanionRefreshController,
  createDeferredAccountingRebuildRecorder,
  createLocalCollectorRefreshRunner,
  createTerminalRefreshFailureRecorder,
} from "../../src/local-companion-refresh.js";
import {
  createClaudeDesktopShadowController,
} from "../../src/claude-desktop-shadow-controller.js";
import {
  localContributionSyncQueue,
} from "../../src/local-node-runtime.js";
import {
  CONTRIBUTION_DEVICE_KEYCHAIN_PROMPT_SURFACES,
  contributionDeviceKeychainPromptSurface,
  createAppBrokeredContributionDeviceBackend,
  createProductionContributionDeviceBackend,
  migrateLegacyContributionDeviceCapability,
  readContributionDeviceCapability,
  removeContributionDeviceCapability,
} from "../../src/contribution-device-capability.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  createExportIdentityKeychainBackend,
  deleteExportIdentityKeychainItemByAttributes,
} from "../../src/platform/export-identity-keychain.js";
import {
  contributionDeviceKeychainBrokerConfiguration,
  createContributionDeviceKeychainBrokerTransport,
  createMacOSKeychainBrokerBindingFromEnvironment,
} from "../../src/contribution-device-keychain-broker.js";
import {
  claimContributionDevicePairing,
  disconnectContributionDevice as disconnectContributionDeviceRemotely,
} from "../../src/contribution-device-client.js";
import {
  renewContributionDeviceCredentialIfDue,
  writeContributionDeviceRenewalState,
} from "../../src/contribution-device-renewal.js";
import {
  LOCAL_CONTRIBUTION_PREPARATION_ALLOWED_LOOKBACK_HOURS,
  LOCAL_CONTRIBUTION_PREPARATION_DEFAULT_LOOKBACK_HOURS,
  LOCAL_CONTRIBUTION_PREPARATION_DETAIL_CODES,
  LOCAL_CONTRIBUTION_PREPARATION_ERROR_VERSION,
  LOCAL_CONTRIBUTION_PREPARATION_MAX_WINDOW_MS,
  LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION,
  createLocalContributionPreparationRunner,
  projectLocalContributionPreparationError,
} from "../../src/local-contribution-preparation.js";
import {
  assertLocalAbsolutePath,
  assertLocalResourceDirectory,
  assertLocalStatePath,
  defaultLocalCompanionStateRoot,
  inspectLocalOnboarding,
  prepareLocalInstallationRoots,
  projectLocalOnboarding,
} from "../../src/local-installation-diagnostics.js";
import {
  selectProductionParticipantIdentity,
} from "../../src/export-identity-production.js";
import {
  selectProductionAccountObservationSecret,
} from "../../src/account-observation-production.js";
import {
  PREVIEW_PRODUCT_BRAND,
  PRODUCT_BRAND,
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../../config/product-brand.js";
import {
  RELEASE_VERSION,
  RELEASE_VERSION_PLACEHOLDER,
} from "../../config/release-manifest.js";
import {
  FAST_MODE_PREFERENCE_VALUES,
} from "@app-usagemonitor/accounting";
import {
  validateTelemetryContribution,
} from "@app-usagemonitor/telemetry-contract";
import {
  LOCAL_COMPANION_STATIC_FILES as STATIC_FILES,
  createLocalCompanionReportRoutes,
} from "./static-assets.js";
import {
  matchParticipantRelayRoute,
} from "./transport/participant-relay-routes.js";
import {
  createParticipantSessionCookieBridge,
  participantRelayPathUsesSessionCookie,
} from "./transport/participant-session-cookie-bridge.js";

const {
  inspectExactNextContributionSyncUpload,
  inspectContributionSyncQueue,
  inspectNextContributionSyncUpload,
  retireSupersededPendingContributionArtifacts,
  setContributionSyncPaused,
} = localContributionSyncQueue;

const LOOPBACK_HOST = "127.0.0.1";
const LOCAL_COMPANION_MODULE_FILE = fileURLToPath(import.meta.url);
const DEFAULT_RESOURCE_ROOT = resolve(
  dirname(LOCAL_COMPANION_MODULE_FILE),
  "..",
  "..",
);
const PARENT_WATCHDOG_PID = Symbol("parentWatchdogPid");
const PARENT_PID_ENV = "USAGE_MONITOR_PARENT_PID";
const PARENT_PID = /^[1-9][0-9]{0,9}$/u;
const MAXIMUM_PARENT_PID = 2_147_483_647;
const PARENT_WATCHDOG_INTERVAL_MS = 250;
const PARENT_WATCHDOG_EXIT_GRACE_MS = 1_000;
const MAX_REQUEST_BODY_BYTES = 1_024;
const MAX_STATIC_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_PARTICIPANT_RELAY_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_PARTICIPANT_RELAY_RESPONSE_BYTES = 4 * 1024 * 1024;
const PARTICIPANT_RELAY_TIMEOUT_MS = 15_000;
// Outbound pre-warm to the contribution service (owner-reported 15.23s cold
// call, 2026-08-10). This is the outbound twin of v0.1.6's inbound keep-alive
// fix, which only tuned the WKWebView->companion socket. Node's global fetch
// dispatcher pays the full cold DNS+TCP+TLS handshake on the first outbound
// call — a measured 15.23s, right at the relay's 15s abort budget above, so the
// first participant action after startup can time out. A best-effort pre-warm
// ping at startup pays that handshake off the hot path and seeds the outbound
// connection pool before the user's first action.
//
// NOTE: the deeper "hold the warm connection for minutes between actions" half
// of this fix wants a persistent dispatcher with a minutes-long
// keepAliveTimeout, which on Node means an undici Agent. undici is deliberately
// NOT added here: the macOS runtime is closed over an exact dependency
// allowlist (test/macos-app-bundle.test.js) that undici is not part of, and
// smuggling it in — statically or by a computed import — would break that
// supply-chain closure. Extending the idle window is therefore left to an owner
// decision (approve undici into the runtime allowlist) or to the Worker
// emitting a long `Keep-Alive: timeout=` response header; the pre-warm below is
// the dependency-free half that removes the measured cold handshake.
const CENTRAL_PREWARM_TIMEOUT_MS = 10_000;

function createAppAwareKeychainBackend(environment) {
  return createExportIdentityKeychainBackend({
    loadBrokerBinding: () =>
      createMacOSKeychainBrokerBindingFromEnvironment(environment),
  });
}

/**
 * Wrap the outbound central fetch with a startup pre-warm, engaged only for the
 * real production HTTPS service and only when the process is using Node's own
 * fetch (tests inject their own fetchImpl and are never wrapped or pre-warmed).
 * The fetch itself is unchanged — only the startup handshake is paid early.
 */
export function createCentralOutboundFetch({ baseFetch, centralOrigin, enabled }) {
  const origin = participantCentralOrigin(centralOrigin);
  const eligible = enabled === true
    && origin !== null
    && origin.startsWith("https://");
  return Object.freeze({
    fetch: baseFetch,
    async warmUp() {
      if (!eligible) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CENTRAL_PREWARM_TIMEOUT_MS);
      timeout.unref?.();
      try {
        await baseFetch(`${origin}/api/health`, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        // Best effort: even a rejected request has already completed the
        // DNS+TCP+TLS handshake and seeded the connection pool, which is the
        // whole point of warming it.
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
const DEVELOPMENT_IDENTITY_FILE_ENV =
  "USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE";
const DEVELOPMENT_IDENTITY_OPT_IN_ENV =
  "USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY";
const EXPORT_IDENTITY_ENV = "APP_USAGEMONITOR_EXPORT_SECRET";
const REVIEW_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const REVIEWABLE_CONTRIBUTION_QUEUE_STATES = new Set([
  "ready",
  "retry_wait",
  "paused",
]);
const CONTRIBUTION_DEVICE_PAIRING_CODE =
  /^um_pair_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const REVIEW_JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEW_AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;
const MAX_ACTIVE_REVIEW_AUTHORIZATIONS = 8;
// One appended line per user-visible failure, so a support conversation can
// quote a reference the user can also see on the page. The file name is fixed
// and lives beside the other local state.
const DIAGNOSTICS_LOG_FILE_NAME = "diagnostics-v0.1.log";
export const LOCAL_DIAGNOSTIC_NOTE_SCHEMA_VERSION =
  "local-diagnostic-note-v0.1";
export const LOCAL_CONTRIBUTION_DIAGNOSTICS_SCHEMA_VERSION =
  "local-contribution-diagnostics-v0.1";
export const LOCAL_CONTRIBUTION_DEVICE_RESET_VERSION =
  "local-contribution-device-reset-v0.1";
export const LOCAL_CONTRIBUTION_DEVICE_DISCONNECT_VERSION =
  "local-contribution-device-disconnect-v0.1";
const MAX_DIAGNOSTICS_LOG_BYTES = 256 * 1024;
const DIAGNOSTIC_REFERENCE = /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u;
// Fixed journey names. Anything else is refused, so no free-form label can
// ever be written to the log.
const DIAGNOSTIC_SURFACES = new Set([
  "automatic_contribution",
  "community_results",
  "contribution_connect",
  "contribution_prepare",
  "contribution_send",
  "device_credential_reset",
  "fast_mode_preference",
  "hosted_identity",
  "hosted_privacy",
  "local_refresh",
  // 2026-08-08 (deletion honesty): the dashboard's "Delete my contributions"
  // action files its failures like every other journey.
  "participant_deletion",
]);
// Identifier-shaped fixed codes only: SCREAMING_SNAKE from the contribution
// service, lower_snake from this companion. Neither shape can carry a
// sentence, a path, or a quoted value.
const DIAGNOSTIC_ERROR_CODE =
  /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;
const DIAGNOSTIC_SERVICE_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// The bound that actually stopped a resource-limited preparation: the coarse
// classification the page speaks is one word for a whole family of unrelated
// ceilings. This closed vocabulary is the domain's, not this route's, so the
// two cannot drift. It gates both the prepare response's detail and the only
// detail a caller may attach to a diagnostics note.
const PREPARATION_DETAIL_CODES = new Set(
  LOCAL_CONTRIBUTION_PREPARATION_DETAIL_CODES,
);
const HOSTED_SIGNIN_HANDOFF_BOUND_VALUE = /^[A-Za-z0-9_-]{43,128}$/u;
const HOSTED_SIGNIN_HANDOFF_PROVIDERS = new Set(["google", "apple"]);
const MAX_RECENT_DIAGNOSTIC_REFERENCES = 5;
const CONTRIBUTION_DEVICE_KEYCHAIN_CAPABILITY =
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice;
const CONTRIBUTION_DEVICE_APP_KEYCHAIN_CAPABILITY =
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp;
const MAX_CONTRIBUTION_DEVICE_STATE_BYTES = 512;

function developmentIdentityConfigurationError() {
  const error = new TypeError(
    "Development identity override configuration is invalid",
  );
  error.code = "USAGE_MONITOR_DEVELOPMENT_IDENTITY_INVALID";
  return error;
}

function resolveDevelopmentIdentityConfiguration({
  file,
  optIn,
  environmentExportSecretPresent,
} = {}) {
  const fileConfigured = file !== null && file !== undefined;
  const optInConfigured = optIn !== null && optIn !== undefined;
  if (!fileConfigured) {
    if (optInConfigured) throw developmentIdentityConfigurationError();
    return Object.freeze({
      explicitSecretFile: null,
      mode: environmentExportSecretPresent
        ? "development_environment_override"
        : "production_keychain",
    });
  }
  if (typeof file !== "string"
      || file.length < 1
      || !isAbsolute(file)
      || optIn !== "1"
      || environmentExportSecretPresent) {
    throw developmentIdentityConfigurationError();
  }
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch {
    throw developmentIdentityConfigurationError();
  }
  const userId = typeof process.getuid === "function"
    ? process.getuid()
    : null;
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size !== 44
      || !Number.isSafeInteger(userId)
      || metadata.uid !== userId
      || (metadata.mode & 0o7777) !== 0o600) {
    throw developmentIdentityConfigurationError();
  }
  return Object.freeze({
    explicitSecretFile: file,
    mode: "development_file_override",
  });
}

const SESSION_COOKIE_NAME = "__Host-usage_monitor_session";
const SESSION_COOKIE_VALUE = /^[A-Za-z0-9_.-]{0,384}$/u;
const SET_COOKIE_VALUE =
  /^__Host-usage_monitor_session=[A-Za-z0-9_.-]{0,384}; Path=\/; Max-Age=[0-9]+; Secure; HttpOnly; SameSite=Strict$/u;
const CSRF_VALUE = /^[A-Za-z0-9_-]{1,384}$/u;
const REPORT_ROUTES = createLocalCompanionReportRoutes(
  LOCAL_COMPANION_REPORT_FILES,
);

const API_ROUTES = new Set([
  "/api/local/health",
  "/api/local/diagnostics/contribution",
  "/api/local/diagnostics/note",
  "/api/local/identity/hosted-signin-handoff",
  "/api/local/onboarding",
  "/api/local/overview",
  "/api/local/gradient",
  "/api/local/weekly",
  "/api/local/quality",
  "/api/local/timeline/window-breakdown",
  "/api/local/refresh",
  "/api/local/refresh/cancel",
  "/api/local/contribution/prepare",
  "/api/local/contribution/sync-status",
  "/api/local/contribution/sync-next",
  "/api/local/contribution/device-pair",
  "/api/local/contribution/device-disconnect",
  "/api/local/contribution/device-credential-reset",
  "/api/local/contribution/sync-inspect-exact",
  "/api/local/contribution/incremental-status",
  "/api/local/contribution/incremental-approve",
  "/api/local/contribution/incremental-run",
  "/api/local/accounting/fast-mode-preference",
]);

// Routes that do not read the Codex dashboard snapshot must answer while that
// snapshot is still being built (or even if it fails): readiness and
// diagnostics.
const SNAPSHOT_INDEPENDENT_API_ROUTES = new Set([
  "/api/local/health",
  "/api/local/diagnostics/contribution",
  "/api/local/diagnostics/note",
  "/api/local/identity/hosted-signin-handoff",
]);


function jsonBody(value) {
  return Buffer.from(JSON.stringify(value));
}

// A query-string parameter that must be a plain base-ten safe integer. Anything
// else — a float, a sign, whitespace, scientific notation, an empty value — is
// rejected rather than coerced, so the two bounded window parameters can never
// carry a surprising value into the reader.
function integerParameter(value) {
  if (typeof value !== "string" || !/^-?\d{1,16}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function securityHeaders({ report = false } = {}) {
  const scriptPolicy = report ? "'self' 'unsafe-inline'" : "'self'";
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src ${scriptPolicy}; style-src 'self' 'unsafe-inline'`,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(response, statusCode, body, type = "application/json; charset=utf-8", options = {}) {
  const payload = Buffer.isBuffer(body) ? body : jsonBody(body);
  response.writeHead(statusCode, {
    ...securityHeaders(options),
    ...(options.headers ?? {}),
    "Content-Type": type,
    "Content-Length": payload.length,
  });
  response.end(payload);
}

function sendError(response, statusCode, code) {
  send(response, statusCode, {
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    error: { code },
  });
}

function contributionDeviceRecoveryRequired(error) {
  try {
    // Every one of these means this Mac's own device credential is present-but-
    // unusable (or its binding is half-there): the LOCAL half is broken and the
    // cure is the local reset ceremony — an attribute delete plus binding-file
    // removal that never needs to read the secret — followed by a fresh mint on
    // the next approval. Mapping them all to the recovery code routes the user
    // into renderContributionDeviceRecovery (the reset button) instead of a
    // generic 502 pairing/sync failure that offers no path and re-hits the same
    // unreadable item on every retry (a silent forever-loop).
    //   credential_conflict     keychain secret and binding file disagree, or a
    //                           secret exists with no binding (or vice-versa).
    //   credential_locked /     a signed update re-signed the app and the old
    //   credential_denied       item's ACL no longer grants the companion read
    //                           access (observed live 2026-08-10). The v0.1.9+
    //                           durable-requirement ACL prevents this for items
    //                           minted from now on; this is the recovery net for
    //                           any item minted by an earlier build, or if the
    //                           durable ACL ever fails to hold across a re-sign.
    //   credential_unavailable  the secret is unreadable/corrupt or a fresh
    //                           mint's read-back did not match — reset+remint.
    //   credential_missing      a binding file with no backing secret (a
    //                           half-completed prior reset or an out-of-band
    //                           Keychain deletion) — clearing the binding lets
    //                           the next approval mint cleanly.
    const code = error?.code;
    return code === "contribution_device_credential_conflict"
      || code === "contribution_device_credential_locked"
      || code === "contribution_device_credential_denied"
      || code === "contribution_device_credential_unavailable"
      || code === "contribution_device_credential_missing";
  } catch {
    return false;
  }
}

/**
 * A locked login keychain, and nothing else.
 *
 * It shares the recovery family's 409 because uploads genuinely cannot
 * proceed, but it is the one member where NOTHING on this Mac is broken: the
 * credential and its binding are intact and become readable again the moment
 * the keychain is unlocked. Collapsing it into the generic recovery code told
 * the user their credential was leftover from an earlier install and offered a
 * destructive clear — a wrong diagnosis whose suggested cure forces a needless
 * re-pair. Keeping the cause distinguishable is what lets the dashboard say
 * "uploads are paused until you unlock it" instead.
 *
 * With SecKeychainSetUserInteractionAllowed(false) around every app-side
 * SecItem call, this is what a locked keychain reaches: errSecInteractionNotAllowed
 * → "locked" → KEYCHAIN_LOCKED over the broker → credential_locked. It arrives
 * promptly and rejects one broker request, so the channel is not poisoned and
 * the next pass after an unlock simply succeeds.
 */
function contributionDeviceKeychainLocked(error) {
  try {
    return error?.code === "contribution_device_credential_locked";
  } catch {
    return false;
  }
}

/**
 * A legacy Keychain item that the signed app could not migrate because the
 * one permitted interactive read was declined. The broker leaves that item
 * untouched, so clearing or resetting it would destroy the rollback path.
 */
function contributionDeviceKeychainMigrationRequired(error) {
  try {
    return error?.code ===
      "contribution_device_credential_migration_required";
  } catch {
    return false;
  }
}

/**
 * Append one bounded diagnostics line the user can quote to support.
 *
 * Every field was validated before this point and is either minted by the
 * dashboard or this companion (the reference), chosen from a fixed set (the
 * surface, and for server-minted refresh-failure notes the step), fixed and
 * identifier-shaped (the code and the optional detail code), or the service's
 * own request id. No message, payload, path, or participant value is written.
 * The optional step member exists only on server-minted terminal
 * refresh-failure notes; the POST route's key validation keeps it unreachable
 * to callers. The optional detail is either server-minted the same way or, for
 * a caller, one member of a closed vocabulary of resource-bound codes — a
 * coarse code such as export_too_large is useless to a reader who cannot see
 * which bound it stood for. The file is capped: once it would exceed the bound,
 * the current file becomes the single previous generation and a fresh one
 * starts, so the log can never grow without limit.
 */
// Server-minted resource measurements for a budget-miss note: a closed set of
// three keys whose values are rounded whole MiB or null, and nothing else. A
// coarse code such as accounting_transition_rss_limit_exceeded is useless to a
// reader who cannot see how far over the bound it went or what the bound was —
// the same reasoning that already admits `detail`. Bounded integers carry no
// message, payload, path, or participant value, so the privacy contract above
// is unchanged; anything not matching that exact shape is dropped rather than
// written, so a caller can never widen this into a free-form channel.
const NOTE_MEASUREMENT_KEYS = Object.freeze([
  "baselineRssMib",
  "observedRssMib",
  "ceilingRssMib",
]);

function boundedNoteMeasurements(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const bounded = {};
  for (const key of NOTE_MEASUREMENT_KEYS) {
    const measurement = value[key];
    bounded[key] = Number.isSafeInteger(measurement) && measurement >= 0
      ? measurement
      : null;
  }
  return bounded;
}

async function appendDiagnosticNote({
  file,
  note,
  now = Date.now(),
}) {
  const line = `${JSON.stringify({
    schemaVersion: LOCAL_DIAGNOSTIC_NOTE_SCHEMA_VERSION,
    recordedAt: new Date(now).toISOString(),
    reference: note.reference,
    surface: note.surface,
    code: note.code,
    requestId: note.requestId,
    ...(note.step === undefined ? {} : { step: note.step }),
    ...(note.detail === undefined ? {} : { detail: note.detail }),
    ...(note.measurements === undefined
      ? {}
      : { measurements: boundedNoteMeasurements(note.measurements) }),
  })}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  let current = null;
  try {
    current = await lstat(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (current !== null
      && (!current.isFile()
        || current.isSymbolicLink()
        || current.nlink !== 1)) {
    throw new Error("diagnostics log is not a plain owner-only file");
  }
  if (current !== null && current.size + bytes > MAX_DIAGNOSTICS_LOG_BYTES) {
    try {
      await rename(file, `${file}.previous`);
    } catch (error) {
      // Another concurrent note may have rotated first. Losing that race is
      // fine; losing this line because of it is not.
      if (error?.code !== "ENOENT") throw error;
    }
  }
  let handle;
  try {
    handle = await open(
      file,
      constants.O_WRONLY
        | constants.O_APPEND
        | constants.O_CREAT
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(line, "utf8");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readDiagnosticReferenceGeneration(file) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size > MAX_DIAGNOSTICS_LOG_BYTES) {
    return [];
  }
  const references = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (line === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value?.schemaVersion !== LOCAL_DIAGNOSTIC_NOTE_SCHEMA_VERSION
        || !DIAGNOSTIC_REFERENCE.test(value?.reference ?? "")
        || nullableInstant(value?.recordedAt) === null) {
      continue;
    }
    references.push(Object.freeze({
      reference: value.reference,
      recordedAt: value.recordedAt,
    }));
  }
  return references;
}

export async function readRecentDiagnosticReferences({
  file,
  maximum = MAX_RECENT_DIAGNOSTIC_REFERENCES,
} = {}) {
  if (typeof file !== "string"
      || !isAbsolute(file)
      || !Number.isSafeInteger(maximum)
      || maximum < 1
      || maximum > MAX_RECENT_DIAGNOSTIC_REFERENCES) {
    throw new TypeError("recent diagnostic reference request is invalid");
  }
  const [previous, current] = await Promise.all([
    readDiagnosticReferenceGeneration(`${file}.previous`),
    readDiagnosticReferenceGeneration(file),
  ]);
  return Object.freeze(
    [...previous, ...current].slice(-maximum).reverse(),
  );
}

/**
 * Clear this Mac's leftover contribution-device credential.
 *
 * This is the narrow repair for the local faults that leave the ordinary
 * capability layer unable to read or replace the credential: a Keychain
 * secret whose binding state file is gone, an access control list a Sparkle
 * update no longer satisfies, or a capability backend that cannot even be
 * constructed. When the backend can read the secret, the exact-value delete
 * is kept; when it cannot — the exact disease this route cures — the
 * credential is deleted by its fixed attributes instead, which never needs
 * the secret (verified live 2026-08-10). Only local things are removed: the
 * this bundle's sealed contribution-device Keychain entries and the binding
 * state file (plus its pre-rename legacy twin, whose leftover
 * would otherwise wedge the next pairing). It contacts no network, revokes
 * no hosted device, and deletes no contributed metadata; the hosted side is
 * unaware of it.
 */
async function resetContributionDeviceCredentialLocally({
  backend,
  stateFile,
  legacyStateFile = null,
  // Both storage generations are addressed: the app-minted
  // `.app.v1` item and the companion-minted `.v1` item. Attribute deletes
  // never decrypt, so clearing the generation that does not exist is a free
  // "missing" rather than a prompt or a failure.
  attributeDelete = () => {
    const app = deleteExportIdentityKeychainItemByAttributes(
      CONTRIBUTION_DEVICE_APP_KEYCHAIN_CAPABILITY,
    );
    const legacy = deleteExportIdentityKeychainItemByAttributes(
      CONTRIBUTION_DEVICE_KEYCHAIN_CAPABILITY,
    );
    return app === "deleted" || legacy === "deleted" ? "deleted" : "missing";
  },
}) {
  let stored = null;
  let expected = null;
  let credential = null;
  let conflicted = false;
  if (backend !== null) {
    try {
      stored = await backend.read(CONTRIBUTION_DEVICE_KEYCHAIN_CAPABILITY);
      if (stored === null) {
        credential = "already_missing";
      } else {
        expected = Buffer.from(stored);
        const outcome = await backend.deleteExact(
          CONTRIBUTION_DEVICE_KEYCHAIN_CAPABILITY,
          expected,
        );
        if (outcome === "conflict") {
          conflicted = true;
        } else if (outcome === "deleted" || outcome === "missing") {
          credential = outcome === "deleted" ? "deleted" : "already_missing";
        }
      }
    } catch {
      // The read (or the read inside the exact delete) is the operation the
      // broken state cannot perform. Fall through to the attribute delete.
    } finally {
      if (Buffer.isBuffer(stored)) stored.fill(0);
      expected?.fill(0);
    }
  }
  // A conflict means a concurrent operation wrote a fresh credential between
  // the read and the delete; falling through to the attribute delete would
  // erase that newcomer, so the reset refuses instead.
  if (conflicted) throw new Error("device credential changed during reset");
  if (credential === null) {
    const outcome = await attributeDelete();
    if (outcome !== "deleted" && outcome !== "missing") {
      throw new Error("device credential was not removed");
    }
    credential = outcome === "deleted" ? "deleted" : "already_missing";
  }
  const removeOwnerOnlyBindingFile = async (file) => {
    let current = null;
    try {
      current = await lstat(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current === null) return "already_missing";
    if (!current.isFile()
        || current.isSymbolicLink()
        || current.nlink !== 1
        || current.size > MAX_CONTRIBUTION_DEVICE_STATE_BYTES
        || (typeof process.getuid === "function"
          && current.uid !== process.getuid())) {
      throw new Error("device binding state file is not owner-only");
    }
    await unlink(file);
    return "removed";
  };
  let binding = await removeOwnerOnlyBindingFile(stateFile);
  if (legacyStateFile !== null) {
    const legacy = await removeOwnerOnlyBindingFile(legacyStateFile);
    if (legacy === "removed") binding = "removed";
  }
  return Object.freeze({
    status: credential === "already_missing" && binding === "already_missing"
      ? "already_absent"
      : "reset",
    credential,
    binding,
  });
}

function actualPort(server) {
  const address = server.address();
  return address && typeof address === "object" ? address.port : null;
}

function allowedHostHeader(server, value) {
  const port = actualPort(server);
  if (!Number.isSafeInteger(port) || typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return normalized === `${LOOPBACK_HOST}:${port}` || normalized === `localhost:${port}`;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  return origin.toLowerCase() === `http://${host.toLowerCase()}`;
}

function isLoopbackPeer(request) {
  const peer = request.socket.remoteAddress;
  return peer === LOOPBACK_HOST || peer === "::ffff:127.0.0.1";
}

function fixedRelayError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function participantCentralOrigin(value) {
  if (value === null || value === undefined || value === "") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return null;
  }
  const developmentLoopback = parsed.protocol === "http:"
    && parsed.hostname === LOOPBACK_HOST
    && parsed.port !== "";
  const productionHTTPS = parsed.protocol === "https:"
    && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (!developmentLoopback && !productionHTTPS) return null;
  return parsed.origin;
}

function participantSessionCookie(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 2_048) {
    throw fixedRelayError("central_participant_cookie_invalid");
  }
  const candidates = value.split(";").map((item) => item.trim());
  const matching = candidates.filter((item) => item.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (matching.length === 0) return null;
  if (matching.length !== 1) throw fixedRelayError("central_participant_cookie_invalid");
  const cookie = matching[0];
  const cookieValue = cookie.slice(SESSION_COOKIE_NAME.length + 1);
  if (!SESSION_COOKIE_VALUE.test(cookieValue)) {
    throw fixedRelayError("central_participant_cookie_invalid");
  }
  return cookie;
}

async function boundedParticipantRelayBody(request) {
  if (["GET", "DELETE"].includes(request.method)) {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > 0) {
      throw fixedRelayError("central_participant_request_invalid");
    }
    return null;
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw fixedRelayError("central_participant_content_type_invalid");
  }
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 1) {
      throw fixedRelayError("central_participant_request_invalid");
    }
    if (length > MAX_PARTICIPANT_RELAY_REQUEST_BYTES) {
      throw fixedRelayError("central_participant_request_too_large");
    }
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_PARTICIPANT_RELAY_REQUEST_BYTES) {
      throw fixedRelayError("central_participant_request_too_large");
    }
    chunks.push(chunk);
  }
  if (total === 0) throw fixedRelayError("central_participant_request_invalid");
  return Buffer.concat(chunks);
}

async function boundedParticipantRelayResponse(
  response,
  maximumBytes = MAX_PARTICIPANT_RELAY_RESPONSE_BYTES,
) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw fixedRelayError("central_participant_response_invalid");
    }
    if (length > maximumBytes) {
      throw fixedRelayError("central_participant_response_too_large");
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw fixedRelayError("central_participant_response_too_large");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function createParticipantRelay({
  centralOrigin,
  fetchImpl,
  timeoutMs = PARTICIPANT_RELAY_TIMEOUT_MS,
}) {
  const origin = participantCentralOrigin(centralOrigin);
  // One session-cookie bridge for the life of the relay: it holds the freshest
  // session the upstream has issued so the enroll -> mint sequence carries that
  // session even before the WKWebView jar commits its Set-Cookie (owner-reported
  // first-sign-in AUTH_REQUIRED, 2026-08-11).
  const sessionCookieBridge = createParticipantSessionCookieBridge();
  return Object.freeze({
    enabled: origin !== null,
    handles(path) {
      return origin !== null && matchParticipantRelayRoute(path) !== null;
    },
    async request(request, path) {
      if (origin === null) throw fixedRelayError("central_participant_relay_not_configured");
      const route = matchParticipantRelayRoute(path);
      if (route === null) {
        throw fixedRelayError("central_participant_route_not_allowed");
      }
      if (!route.methods.includes(request.method)) {
        throw fixedRelayError("central_participant_method_not_allowed");
      }
      const body = await boundedParticipantRelayBody(request);
      const headers = {
        Accept: "application/json",
        Origin: origin,
      };
      if (body !== null) headers["Content-Type"] = "application/json";
      const jarCookie = participantSessionCookie(request.headers.cookie);
      // Session-authenticated routes (session, logout, /me/* including the
      // device-pairing mint) take the bridge's freshest captured session so the
      // enroll -> mint sequence never races the WKWebView jar commit. Identity
      // handoff and enrollment routes keep exactly the jar's own cookie.
      const cookie = participantRelayPathUsesSessionCookie(path)
        ? sessionCookieBridge.cookieForRequest(jarCookie)
        : jarCookie;
      if (cookie !== null) headers.Cookie = cookie;
      const csrf = request.headers["x-usage-monitor-csrf"];
      if (csrf !== undefined) {
        if (typeof csrf !== "string" || !CSRF_VALUE.test(csrf)) {
          throw fixedRelayError("central_participant_csrf_invalid");
        }
        headers["X-Usage-Monitor-CSRF"] = csrf;
      }
      const authorization = request.headers.authorization;
      if (authorization !== undefined) {
        throw fixedRelayError("central_participant_authorization_invalid");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let upstream;
      try {
        upstream = await fetchImpl(`${origin}${path}`, {
          method: request.method,
          headers,
          body,
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw fixedRelayError("central_participant_service_unavailable");
      } finally {
        clearTimeout(timeout);
      }
      const contentType = upstream.headers.get("content-type")
        ?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") {
        throw fixedRelayError("central_participant_response_invalid");
      }
      const responseBody = await boundedParticipantRelayResponse(
        upstream,
        MAX_PARTICIPANT_RELAY_RESPONSE_BYTES,
      );
      try {
        JSON.parse(responseBody.toString("utf8"));
      } catch {
        throw fixedRelayError("central_participant_response_invalid");
      }
      const responseHeaders = {};
      const setCookie = upstream.headers.get("set-cookie");
      if (setCookie !== null) {
        if (setCookie.length > 1_024 || !SET_COOKIE_VALUE.test(setCookie)) {
          throw fixedRelayError("central_participant_response_invalid");
        }
        responseHeaders["Set-Cookie"] = setCookie;
        // Capture the session the worker just issued so the very next relay
        // request (the ceremony's device-pairing mint) presents it regardless
        // of whether the WKWebView jar has committed this Set-Cookie yet.
        sessionCookieBridge.observeUpstreamSetCookie(setCookie);
      }
      if (upstream.headers.get("idempotency-replayed") === "true") {
        responseHeaders["Idempotency-Replayed"] = "true";
      }
      if (upstream.headers.get("vary") === "Cookie") {
        responseHeaders.Vary = "Cookie";
      }
      return {
        status: upstream.status,
        body: responseBody,
        headers: responseHeaders,
      };
    },
  });
}

async function readEmptyJsonObject(
  request,
  { allowFixedUserRequest = true } = {},
) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    const error = new Error("unsupported_media_type");
    error.code = "unsupported_media_type";
    throw error;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    const error = new Error("request_too_large");
    error.code = "request_too_large";
    throw error;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("request_too_large");
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
  const isObject = value && typeof value === "object" && !Array.isArray(value);
  const keys = isObject ? Object.keys(value) : [];
  const isEmpty = isObject && keys.length === 0;
  const isFixedUserRequest = isObject && keys.length === 1 && keys[0] === "reason" && value.reason === "user_request";
  if (!isEmpty && !(allowFixedUserRequest && isFixedUserRequest)) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
}

async function authorizeLocalMutation(
  request,
  response,
  errorCode,
  { allowFixedUserRequest = true } = {},
) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, errorCode);
    return false;
  }
  try {
    await readEmptyJsonObject(request, { allowFixedUserRequest });
    return true;
  } catch (error) {
    const status = error.code === "unsupported_media_type"
      ? 415
      : error.code === "request_too_large" ? 413 : 400;
    sendError(response, status, error.code ?? "invalid_request");
    return false;
  }
}

async function readBoundedJsonObject(request) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    const error = new Error("unsupported_media_type");
    error.code = "unsupported_media_type";
    throw error;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength)
      && declaredLength > MAX_REQUEST_BODY_BYTES) {
    const error = new Error("request_too_large");
    error.code = "request_too_large";
    throw error;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("request_too_large");
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
  return value;
}

function boundedRequestStatus(error) {
  if (error?.code === "unsupported_media_type") return 415;
  return error?.code === "request_too_large" ? 413 : 400;
}

async function authorizeFastModePreference(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "fast_mode_preference_not_authorized");
    return null;
  }
  let value;
  try {
    value = await readBoundedJsonObject(request);
  } catch (error) {
    sendError(
      response,
      boundedRequestStatus(error),
      error.code ?? "invalid_request",
    );
    return null;
  }
  if (Object.keys(value).sort().join("\0") !== "mode"
      || !FAST_MODE_PREFERENCE_VALUES.includes(value.mode)) {
    sendError(response, 400, "invalid_request");
    return null;
  }
  return Object.freeze({ mode: value.mode });
}

async function authorizeDiagnosticNote(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "diagnostic_note_not_authorized");
    return null;
  }
  let value;
  try {
    value = await readBoundedJsonObject(request);
  } catch (error) {
    sendError(
      response,
      boundedRequestStatus(error),
      error.code ?? "invalid_request",
    );
    return null;
  }
  // A caller may name the specific bound behind a coarse code, but only by
  // choosing from a closed vocabulary the companion owns. That is strictly
  // tighter than the shape test `code` itself passes, so widening the accepted
  // keys does not widen what a caller can write into the log.
  const keys = Object.keys(value).sort().join("\0");
  const withDetail = keys === "code\0detail\0reference\0requestId\0surface";
  if ((!withDetail && keys !== "code\0reference\0requestId\0surface")
      || !DIAGNOSTIC_REFERENCE.test(value.reference)
      || !DIAGNOSTIC_SURFACES.has(value.surface)
      || !DIAGNOSTIC_ERROR_CODE.test(value.code)
      || (withDetail && !PREPARATION_DETAIL_CODES.has(value.detail))
      || typeof value.requestId !== "string"
      || (value.requestId !== ""
        && !DIAGNOSTIC_SERVICE_REQUEST_ID.test(value.requestId))) {
    sendError(response, 400, "invalid_request");
    return null;
  }
  return Object.freeze({
    reference: value.reference,
    surface: value.surface,
    code: value.code,
    requestId: value.requestId,
    ...(withDetail ? { detail: value.detail } : {}),
  });
}

function authorizeHostedSignInHandoffRead(request, response) {
  // Per the Fetch specification, a browser only appends an Origin header to
  // requests whose method is not GET/HEAD or whose tainting is CORS. The
  // dashboard's own same-origin GET therefore arrives WITHOUT an Origin
  // header (found live in the packaged 0.1.13 (1011) build: the restart
  // recovery read was refused 403 and resume silently did nothing). Accept
  // an absent Origin, refuse a present-but-foreign one, and always require
  // the custom header — a cross-origin page cannot attach it without a CORS
  // preflight this server never grants, and the global allowedHostHeader
  // gate already rejects DNS-rebinding hosts before routing.
  const origin = request.headers.origin;
  if ((origin !== undefined && !sameOrigin(request))
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "hosted_signin_handoff_not_authorized");
    return false;
  }
  return true;
}

async function authorizeHostedSignInHandoffMutation(request, response) {
  if (!authorizeHostedSignInHandoffRead(request, response)) return null;
  let value;
  try {
    value = await readBoundedJsonObject(request);
  } catch (error) {
    sendError(
      response,
      boundedRequestStatus(error),
      error.code ?? "invalid_request",
    );
    return null;
  }
  const keys = Object.keys(value).sort().join("\0");
  if (value.action === "clear" && keys === "action") {
    return Object.freeze({ action: "clear" });
  }
  if (value.action !== "store"
      || keys !== "action\0provider\0state\0verifier"
      || !HOSTED_SIGNIN_HANDOFF_PROVIDERS.has(value.provider)
      || typeof value.state !== "string"
      || !HOSTED_SIGNIN_HANDOFF_BOUND_VALUE.test(value.state)
      || typeof value.verifier !== "string"
      || !HOSTED_SIGNIN_HANDOFF_BOUND_VALUE.test(value.verifier)) {
    sendError(response, 400, "invalid_request");
    return null;
  }
  return Object.freeze({
    action: "store",
    provider: value.provider,
    state: value.state,
    verifier: value.verifier,
  });
}

async function authorizeContributionDeviceCredentialReset(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "device_credential_reset_not_authorized");
    return false;
  }
  let value;
  try {
    value = await readBoundedJsonObject(request);
  } catch (error) {
    sendError(
      response,
      boundedRequestStatus(error),
      error.code ?? "invalid_request",
    );
    return false;
  }
  // The one fixed confirmation this destructive local repair accepts.
  if (Object.keys(value).join("\0") !== "confirm"
      || value.confirm !== "reset_device_credential") {
    sendError(response, 400, "invalid_request");
    return false;
  }
  return true;
}

async function authorizeContributionDeviceDisconnect(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "contribution_device_disconnect_not_authorized");
    return false;
  }
  let value;
  try {
    value = await readBoundedJsonObject(request);
  } catch (error) {
    sendError(response, boundedRequestStatus(error), error.code ?? "invalid_request");
    return false;
  }
  // This revokes a live remote bearer and then clears its exact local
  // Keychain binding. It needs a distinct explicit confirmation from the
  // local-only leftover-credential repair.
  if (Object.keys(value).join("\0") !== "confirm"
      || value.confirm !== "disconnect_this_mac") {
    sendError(response, 400, "invalid_request");
    return false;
  }
  return true;
}

async function authorizeContributionDevicePairing(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "contribution_device_pairing_not_authorized");
    return null;
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    sendError(response, 415, "unsupported_media_type");
    return null;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength)
      && declaredLength > MAX_REQUEST_BODY_BYTES) {
    sendError(response, 413, "request_too_large");
    return null;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      sendError(response, 413, "request_too_large");
      return null;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendError(response, 400, "invalid_json");
    return null;
  }
  if (!value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "pairingCode"
      || !CONTRIBUTION_DEVICE_PAIRING_CODE.test(value.pairingCode)) {
    sendError(response, 400, "invalid_request");
    return null;
  }
  return value.pairingCode;
}

async function readContributionPreparationRequest(request) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    const error = new Error("unsupported_media_type");
    error.code = "unsupported_media_type";
    throw error;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength)
      && declaredLength > MAX_REQUEST_BODY_BYTES) {
    const error = new Error("request_too_large");
    error.code = "request_too_large";
    throw error;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("request_too_large");
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
  const isObject = value && typeof value === "object" && !Array.isArray(value);
  const keys = isObject ? Object.keys(value) : [];
  if (!isObject
      || keys.length > 1
      || (keys.length === 1 && keys[0] !== "lookbackHours")) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
  const lookbackHours = keys.length === 0
    ? LOCAL_CONTRIBUTION_PREPARATION_DEFAULT_LOOKBACK_HOURS
    : value.lookbackHours;
  if (!LOCAL_CONTRIBUTION_PREPARATION_ALLOWED_LOOKBACK_HOURS.includes(
    lookbackHours,
  )) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
  return Object.freeze({ lookbackHours });
}

async function authorizeContributionPreparation(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "preparation_not_authorized");
    return null;
  }
  try {
    return await readContributionPreparationRequest(request);
  } catch (error) {
    const status = error.code === "unsupported_media_type"
      ? 415
      : error.code === "request_too_large" ? 413 : 400;
    sendError(response, status, error.code ?? "invalid_request");
    return null;
  }
}

async function authorizeReviewedContributionMutation(
  request,
  response,
  errorCode,
) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, errorCode);
    return null;
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    sendError(response, 415, "unsupported_media_type");
    return null;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength)
      && declaredLength > MAX_REQUEST_BODY_BYTES) {
    sendError(response, 413, "request_too_large");
    return null;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      sendError(response, 413, "request_too_large");
      return null;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendError(response, 400, "invalid_json");
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 1
      || !REVIEW_TOKEN.test(value.reviewToken ?? "")) {
    sendError(response, 400, "invalid_request");
    return null;
  }
  return value.reviewToken;
}

async function readFixedFile(root, file, maximumBytes) {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, file);
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (!path.startsWith(rootPrefix)) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  return readFile(path);
}

const ALLOWED_SEMANTIC_OPEN_TARGETS = new Set([
  PRODUCT_BRAND.appOpenURL,
  PREVIEW_PRODUCT_BRAND.appOpenURL,
]);

export function configuredSemanticOpenTarget(environment = process.env) {
  const value = environment?.USAGE_MONITOR_APP_OPEN_URL
    ?? PRODUCT_BRAND.appOpenURL;
  if (typeof value !== "string" || !ALLOWED_SEMANTIC_OPEN_TARGETS.has(value)) {
    throw new Error(
      "USAGE_MONITOR_APP_OPEN_URL must match a reviewed product identity",
    );
  }
  return value;
}

function stampSemanticOpenTarget(body, semanticOpenTarget) {
  const source = body.toString("utf8");
  const first = source.indexOf(SEMANTIC_OPEN_TARGET_PLACEHOLDER);
  if (first < 0
      || source.indexOf(
        SEMANTIC_OPEN_TARGET_PLACEHOLDER,
        first + SEMANTIC_OPEN_TARGET_PLACEHOLDER.length,
      ) >= 0) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  return Buffer.from(
    source.replace(
      SEMANTIC_OPEN_TARGET_PLACEHOLDER,
      semanticOpenTarget,
    ),
  );
}

function stampReleaseVersion(body) {
  const source = body.toString("utf8");
  const first = source.indexOf(RELEASE_VERSION_PLACEHOLDER);
  if (first < 0) return Buffer.from(source);
  if (source.indexOf(
    RELEASE_VERSION_PLACEHOLDER,
    first + RELEASE_VERSION_PLACEHOLDER.length,
  ) >= 0) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  return Buffer.from(source.replace(RELEASE_VERSION_PLACEHOLDER, RELEASE_VERSION));
}

function stampLocalDashboard(body, semanticOpenTarget) {
  return stampReleaseVersion(
    stampSemanticOpenTarget(body, semanticOpenTarget),
  );
}

function finiteNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nullableInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function syncStatusProjection(value) {
  const counts = value?.counts ?? {};
  const valid = value?.schemaVersion === "contribution-sync-status-v0.1"
    && typeof value?.paused === "boolean";
  return {
    schemaVersion: "contribution-sync-status-v0.1",
    status: valid ? "available" : "unavailable",
    paused: valid ? value.paused : null,
    counts: {
      pending: finiteNonNegativeInteger(counts.pending),
      inFlight: finiteNonNegativeInteger(counts.in_flight),
      accepted: finiteNonNegativeInteger(counts.accepted),
      retryable: finiteNonNegativeInteger(counts.retryable),
      rejected: finiteNonNegativeInteger(counts.rejected),
    },
    dueNow: valid ? finiteNonNegativeInteger(value.dueNow) : 0,
    nextAttemptAt: valid ? nullableInstant(value.nextAttemptAt) : null,
    lastAcceptedAt: valid ? nullableInstant(value.lastAcceptedAt) : null,
    includesContent: false,
    includesPaths: false,
    includesCredentials: false,
  };
}

function syncNextProjection(value, {
  previewConfigured = false,
  deliveryConfigured = false,
} = {}) {
  const allowedStates = new Set(["empty", "ready", "retry_wait", "paused"]);
  const item = value?.item;
  const valid = value?.schemaVersion === "contribution-sync-preview-v0.1"
    && value?.networkActivity === false
    && allowedStates.has(value?.state)
    && isNonNegativeInteger(value?.discoveredSets)
    && isNonNegativeInteger(value?.enqueued)
    && (value.state === "empty" ? item === null : item && typeof item === "object");
  const projected = {
    schemaVersion: "contribution-sync-preview-v0.1",
    status: valid
      ? "available"
      : previewConfigured ? "unavailable" : "not_configured",
    state: valid ? value.state : "unavailable",
    discoveredSets: valid ? value.discoveredSets : 0,
    newlyQueued: valid ? value.enqueued : 0,
    deliveryConfigured,
    item: null,
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  };
  if (!valid || item === null) return projected;
  const allowedPlatforms = new Set([
    "macos",
    "linux",
    "windows",
    "other",
    "unknown",
  ]);
  const allowedEpochs = new Set([
    "unknown",
    "openai_pre_agentic_pool_2026_07_09",
    "openai_agentic_pool_2026_07_09",
    "anthropic_unknown",
  ]);
  const allowedPriceBases = new Set([
    "current_api_prices",
    "historical_api_prices",
    "unpriced",
  ]);
  const counts = {
    usageEvents: item.recordCounts?.usageEvents,
    quotaSnapshots: item.recordCounts?.quotaSnapshots,
    activityMarkers: item.recordCounts?.activityMarkers,
  };
  const total = counts.usageEvents + counts.quotaSnapshots
    + counts.activityMarkers;
  const estimatedCost = item.accounting?.estimatedApiCostUsd;
  const coverage = item.accounting?.pricedEventCoveragePercent;
  const itemValid = item.schemaVersion === "telemetry-contribution-v0.1"
    && allowedPlatforms.has(item.clientPlatform)
    && allowedEpochs.has(item.providerPolicyEpoch)
    && nullableInstant(item.coveredAt?.startAt) !== null
    && nullableInstant(item.coveredAt?.endAt) !== null
    && Object.values(counts).every(isNonNegativeInteger)
    && total > 0 && total <= 200
    && item.recordCounts?.total === total
    && (estimatedCost === null
      || (typeof estimatedCost === "string"
        && /^(?:0|[1-9]\d*)\.\d{6}$/u.test(estimatedCost)))
    && Number.isFinite(coverage) && coverage >= 0 && coverage <= 100
    && Number.isSafeInteger(item.accounting?.unknownModelEventCount)
    && item.accounting.unknownModelEventCount >= 0
    && item.accounting.unknownModelEventCount <= counts.usageEvents
    && Number.isSafeInteger(item.accounting?.unknownBillableUnits)
    && item.accounting.unknownBillableUnits >= 0
    && item.accounting.unknownBillableUnits <= 1_000_000_000
    && allowedPriceBases.has(item.accounting?.priceBasis)
    && item.accounting?.verification === "client_declared_unverified"
    && Number.isSafeInteger(item.preparedBytes) && item.preparedBytes >= 0
    && Number.isSafeInteger(item.reservedUploadBytes)
    && item.reservedUploadBytes >= item.preparedBytes
    && Number.isSafeInteger(item.attemptCount) && item.attemptCount >= 0
    && nullableInstant(item.nextAttemptAt) !== null;
  if (!itemValid) {
    return {
      ...projected,
      status: "unavailable",
      state: "unavailable",
    };
  }
  return {
    ...projected,
    item: {
      schemaVersion: item.schemaVersion,
      clientPlatform: item.clientPlatform,
      providerPolicyEpoch: item.providerPolicyEpoch,
      coveredAt: {
        startAt: nullableInstant(item.coveredAt.startAt),
        endAt: nullableInstant(item.coveredAt.endAt),
      },
      recordCounts: { ...counts, total },
      accounting: {
        estimatedApiCostUsd: estimatedCost,
        pricedEventCoveragePercent: coverage,
        unknownModelEventCount: item.accounting.unknownModelEventCount,
        unknownBillableUnits: item.accounting.unknownBillableUnits,
        priceBasis: item.accounting.priceBasis,
        verification: "client_declared_unverified",
      },
      preparedBytes: item.preparedBytes,
      reservedUploadBytes: item.reservedUploadBytes,
      attemptCount: item.attemptCount,
      nextAttemptAt: nullableInstant(item.nextAttemptAt),
    },
  };
}

function syncExactReviewProjection(
  value,
  { configured = false, reviewToken = null } = {},
) {
  const allowedStates = new Set(["empty", "ready", "retry_wait", "paused"]);
  const validEnvelope = value?.schemaVersion
      === "contribution-sync-exact-review-v0.1"
    && value?.networkActivity === false
    && allowedStates.has(value?.state)
    && isNonNegativeInteger(value?.discoveredSets)
    && isNonNegativeInteger(value?.enqueued);
  const projected = {
    schemaVersion: "contribution-sync-exact-review-v0.1",
    status: validEnvelope
      ? "available"
      : configured ? "unavailable" : "not_configured",
    state: validEnvelope ? value.state : "unavailable",
    networkActivity: false,
    payloadBytes: null,
    payload: null,
    reviewToken: null,
    includesExactRetainedFields: false,
    includesRawContent: false,
    includesPaths: false,
    includesDirectIdentifiers: false,
    includesCredentials: false,
  };
  if (!validEnvelope || value.state === "empty") return projected;
  try {
    validateTelemetryContribution(value.payload);
  } catch {
    return { ...projected, status: "unavailable", state: "unavailable" };
  }
  const payloadBytes = value.payloadBytes;
  if (!Number.isSafeInteger(payloadBytes)
      || payloadBytes < 1
      || payloadBytes > 1_310_720
      || Buffer.byteLength(JSON.stringify(value.payload), "utf8") > 1_310_720) {
    return { ...projected, status: "unavailable", state: "unavailable" };
  }
  return {
    ...projected,
    payloadBytes,
    payload: value.payload,
    reviewToken: REVIEW_TOKEN.test(reviewToken ?? "") ? reviewToken : null,
    includesExactRetainedFields: true,
  };
}

const INCREMENTAL_SYNC_OUTCOME_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const INCREMENTAL_SYNC_DAY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A sqlite error that means the unified index is momentarily held by another
 * local writer (the foreground refresh/indexer ingesting rollouts) — primary
 * result codes SQLITE_BUSY (5) and SQLITE_LOCKED (6), including their
 * extended variants in the low byte. Everything else (corruption, missing
 * table, I/O) is NOT coordination and must keep failing loudly.
 */
function unifiedIndexBusyError(error) {
  if (error?.code !== "ERR_SQLITE_ERROR") return false;
  if (Number.isSafeInteger(error.errcode)) {
    const primary = error.errcode & 0xff;
    return primary === 5 || primary === 6;
  }
  return /database is locked|database table is locked/iu
    .test(typeof error.message === "string" ? error.message : "");
}

/**
 * A thrown contribution-device capability failure — the same family the sync
 * engine itself maps to its device_unavailable outcome. The wiring can hit
 * this family before the engine exists (constructing the Keychain backend,
 * or migrating the legacy binding file), so the same mapping must live here
 * too.
 */
function contributionDeviceCapabilityFailure(error) {
  try {
    return typeof error?.code === "string"
      && error.code.startsWith("contribution_device_");
  } catch {
    return false;
  }
}

/**
 * The engine's own device_unavailable failure shape for a pass that never
 * ran: the controller pauses with the exact reason the dashboard's
 * re-approve repair path keys on, instead of walking an anonymous run_failed
 * retry ladder forever (observed live 2026-08-10, after a Sparkle update
 * left the credential unreadable). networkActivity is false — no counts were
 * measured, so the controller must not let these zeros overwrite the last
 * honest progress.
 */
function deviceUnavailableIncrementalRunOutcome() {
  return Object.freeze({
    schemaVersion: "incremental-contribution-sync-run-v1.0",
    status: "failed",
    daysTotal: 0,
    daysSynced: 0,
    daysPending: 0,
    chunksUploaded: 0,
    chunksSkipped: 0,
    recordsUploaded: 0,
    acknowledgedThroughDay: null,
    orphanChunkIds: Object.freeze([]),
    failure: Object.freeze({
      code: "device_unavailable",
      retryable: false,
      deviceUnavailable: true,
      retryAfterMilliseconds: null,
    }),
    networkActivity: false,
  });
}

/**
 * The bounded status the dashboard's incremental surface reads: consent
 * state, cursor progress as day counts and the acknowledged watermark day,
 * pause reason as a fixed code. No path, no content, no identifier.
 *
 * `keychainPrompt` rides along because this is the projection the ceremony
 * already polls: it names where a macOS Keychain dialog is still reachable
 * ("pairing", "migration", "none") so the dashboard can withhold guidance from
 * the installs that can never see one. It is a fixed vocabulary, never a
 * path, an identifier, or a credential fact.
 */
function incrementalSyncStatusProjection(value, {
  configured = false,
  keychainPrompt = "pairing",
} = {}) {
  const promptSurface =
    CONTRIBUTION_DEVICE_KEYCHAIN_PROMPT_SURFACES.includes(keychainPrompt)
      ? keychainPrompt
      : "pairing";
  const consent = value?.consent;
  const valid = value?.schemaVersion
      === "incremental-contribution-sync-status-v1.0"
    && typeof value?.paused === "boolean"
    && typeof value?.running === "boolean"
    && consent && typeof consent === "object"
    && typeof consent.approved === "boolean"
    && typeof consent.current === "boolean";
  const projected = {
    schemaVersion: "local-incremental-contribution-sync-v1.0",
    status: valid
      ? "available"
      : configured ? "unavailable" : "not_configured",
    contractVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    keychainPrompt: promptSurface,
    consent: { approved: false, current: false, consentedAt: null },
    paused: false,
    pausedReason: null,
    running: false,
    progress: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastOutcome: null,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  };
  if (!valid) return projected;
  const progress = value.progress;
  const progressValid = progress !== null
    && typeof progress === "object"
    && [progress.daysTotal, progress.daysSynced, progress.daysPending,
      progress.chunksUploaded].every(isNonNegativeInteger)
    && (progress.acknowledgedThroughDay === null
      || (typeof progress.acknowledgedThroughDay === "string"
        && INCREMENTAL_SYNC_DAY.test(progress.acknowledgedThroughDay)));
  const outcome = value.lastOutcome;
  const outcomeValid = outcome !== null
    && typeof outcome === "object"
    && nullableInstant(outcome.at) !== null
    && INCREMENTAL_SYNC_OUTCOME_CODE.test(outcome.code ?? "")
    && ["succeeded", "partial", "failed", "paused"].includes(outcome.status);
  return {
    ...projected,
    status: "available",
    consent: {
      approved: consent.approved,
      current: consent.current,
      consentedAt: nullableInstant(consent.consentedAt),
    },
    paused: value.paused,
    pausedReason: value.paused
      && INCREMENTAL_SYNC_OUTCOME_CODE.test(value.pausedReason ?? "")
      ? value.pausedReason
      : null,
    running: value.running,
    progress: progressValid
      ? {
        daysTotal: progress.daysTotal,
        daysSynced: progress.daysSynced,
        daysPending: progress.daysPending,
        chunksUploaded: progress.chunksUploaded,
        acknowledgedThroughDay: progress.acknowledgedThroughDay,
      }
      : null,
    lastAttemptAt: nullableInstant(value.lastAttemptAt),
    nextAttemptAt: nullableInstant(value.nextAttemptAt),
    lastOutcome: outcomeValid
      ? {
        at: nullableInstant(outcome.at),
        code: outcome.code,
        status: outcome.status,
        // The engine's recorded cause beside the bare outcome code (0.1.2),
        // code only — the scrubbed message stays out of the projection. This
        // is what lets the dashboard say "device credential unavailable"
        // instead of an anonymous "run_failed".
        ...(INCREMENTAL_SYNC_OUTCOME_CODE.test(outcome.detail?.code ?? "")
          ? { detail: { code: outcome.detail.code } }
          : {}),
      }
      : null,
  };
}

function contributionDiagnosticQueueState(queue) {
  if (queue?.status !== "available") return "unavailable";
  if (queue.paused === true) return "paused";
  if (queue.counts.inFlight > 0 || queue.counts.pending > 0) return "ready";
  if (queue.counts.retryable > 0) return "retry_wait";
  return "empty";
}

function contributionDiagnosticJourneyPhase({
  configured,
  queueState,
  incremental,
  pairingObserved,
  paired,
}) {
  if (!configured) return "not_configured";
  if (incremental.status !== "available") return "unavailable";
  if (!incremental.consent.approved || !incremental.consent.current) {
    return queueState === "empty" ? "preparing_review" : "review_ready";
  }
  if (!pairingObserved || !paired) return "approved_connection_needed";
  if (incremental.paused) return "approved_paused";
  if (incremental.running || (incremental.progress?.daysPending ?? 0) > 0) {
    return "approved_syncing";
  }
  return "approved_idle";
}

function localContributionDiagnosticsProjection({
  queue,
  incremental,
  configured,
  pairingObserved,
  paired,
  recentDiagnosticReferences,
}) {
  const queueState = contributionDiagnosticQueueState(queue);
  return Object.freeze({
    schemaVersion: LOCAL_CONTRIBUTION_DIAGNOSTICS_SCHEMA_VERSION,
    journeyPhase: contributionDiagnosticJourneyPhase({
      configured,
      queueState,
      incremental,
      pairingObserved,
      paired,
    }),
    // Preview discovery is a local mutation (it can enqueue a prepared set),
    // so this read-only support route never runs it. The page merges its
    // already-observed preview state into copied diagnostics when available.
    previewState: "not_observed",
    queueState,
    consent: Object.freeze({
      approved: incremental.consent.approved === true,
      current: incremental.consent.current === true,
    }),
    signedIn: Object.freeze({ observed: false, value: false }),
    pairing: Object.freeze({
      observed: pairingObserved,
      paired,
    }),
    recentDiagnosticReferences: Object.freeze(recentDiagnosticReferences),
    includesTokens: false,
    includesOauthState: false,
    includesVerifiers: false,
    includesDeviceIdentifiers: false,
    includesAccountIdentifiers: false,
    includesContent: false,
    includesPaths: false,
  });
}

const PREPARATION_ERROR_CODES = new Set([
  "coverage_unavailable",
  "coverage_invalid",
  "identity_unavailable",
  "identity_migration_required",
  "no_safe_records",
  "export_too_large",
  "privacy_verification_failed",
  "review_archive_invalid",
  "prepared_spool_invalid",
  "preparation_in_progress",
  "preparation_failed",
  "consent_already_current",
]);

function preparationResultProjection(value) {
  const startAt = nullableInstant(value?.coveredAt?.startAt);
  const endAt = nullableInstant(value?.coveredAt?.endAt);
  const counts = value?.recordCounts ?? {};
  const countValues = [
    counts.usageEvents,
    counts.quotaSnapshots,
    counts.activityMarkers,
  ];
  const totalRecords = countValues.every(isNonNegativeInteger)
    ? countValues.reduce((sum, count) => sum + count, 0)
    : -1;
  const startMs = startAt === null ? Number.NaN : Date.parse(startAt);
  const endMs = endAt === null ? Number.NaN : Date.parse(endAt);
  const valid = value?.schemaVersion
      === LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION
    && value?.status === "prepared"
    && Number.isFinite(startMs)
    && Number.isFinite(endMs)
    && endMs > startMs
    // Seven days is the largest request contract. The existing 100-batch,
    // 100k-record and 125 MiB ceilings below remain authoritative: a dense
    // seven-day selection deterministically fails as export_too_large rather
    // than being silently truncated or split into an unreviewed second set.
    && endMs - startMs <= LOCAL_CONTRIBUTION_PREPARATION_MAX_WINDOW_MS
    && totalRecords > 0
    && totalRecords <= 100_000
    && value?.privacy?.verdict === "passed"
    && isNonNegativeInteger(value?.privacy?.checksPassed)
    && value.privacy.checksPassed <= 32
    && value?.privacy?.checksFailed === 0
    && value?.privacy?.sourceTransportReady === false
    && value?.privacy?.provenanceRetained === true
    && value?.prepared?.schemaVersion === "prepared-contribution-set-v0.1"
    && value?.prepared?.eligibleSchemaVersion
      === "telemetry-contribution-v0.1"
    && Number.isSafeInteger(value?.prepared?.batchCount)
    && value.prepared.batchCount >= 1
    && value.prepared.batchCount <= 100
    && Number.isSafeInteger(value?.prepared?.bytes)
    && value.prepared.bytes >= 1
    && value.prepared.bytes <= 131_072_000
    && value?.networkActivity === false
    && value?.includesContent === false
    && value?.includesPaths === false
    && value?.includesIdentifiers === false
    && value?.includesCredentials === false;
  if (!valid) return null;
  return {
    schemaVersion: LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION,
    status: "prepared",
    coveredAt: { startAt, endAt },
    recordCounts: {
      usageEvents: counts.usageEvents,
      quotaSnapshots: counts.quotaSnapshots,
      activityMarkers: counts.activityMarkers,
    },
    privacy: {
      verdict: "passed",
      checksPassed: value.privacy.checksPassed,
      checksFailed: 0,
      sourceTransportReady: false,
      provenanceRetained: true,
    },
    prepared: {
      schemaVersion: "prepared-contribution-set-v0.1",
      eligibleSchemaVersion: "telemetry-contribution-v0.1",
      batchCount: value.prepared.batchCount,
      bytes: value.prepared.bytes,
    },
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  };
}

function preparationDetailProjection(value) {
  if (typeof value?.code !== "string"
      || !PREPARATION_DETAIL_CODES.has(value.code)) {
    return null;
  }
  return {
    code: value.code,
    observed: isNonNegativeInteger(value.observed) ? value.observed : null,
    limit: isNonNegativeInteger(value.limit) ? value.limit : null,
  };
}

function preparationErrorProjection(error, overrideCode = null) {
  const source = projectLocalContributionPreparationError(error);
  const candidate = overrideCode ?? source?.errorCode;
  const errorCode = PREPARATION_ERROR_CODES.has(candidate)
    ? candidate
    : "preparation_failed";
  // An overriding code is this route's own verdict about the request, not the
  // domain's, so it never inherits a detail the domain raised for some other
  // failure.
  const detail = overrideCode === null
    ? preparationDetailProjection(source?.detail)
    : null;
  return {
    schemaVersion: LOCAL_CONTRIBUTION_PREPARATION_ERROR_VERSION,
    status: "failed",
    errorCode,
    ...(detail === null ? {} : { detail }),
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  };
}

function preparationErrorStatus(code) {
  if (code === "preparation_in_progress"
      || code === "consent_already_current") return 409;
  if (code === "export_too_large") return 413;
  if (code === "coverage_unavailable"
      || code === "identity_unavailable"
      || code === "identity_migration_required") return 503;
  if (code === "coverage_invalid"
      || code === "no_safe_records"
      || code === "privacy_verification_failed") return 422;
  return 500;
}

function configuredHomeDirectory(environment) {
  const selected = process.platform === "win32"
    ? environment.USERPROFILE
    : environment.HOME;
  if (typeof selected === "string" && selected.length > 0
      && isAbsolute(selected) && resolve(selected) === selected) {
    return selected;
  }
  const fallback = homedir();
  if (!isAbsolute(fallback) || resolve(fallback) !== fallback) {
    throw new TypeError("Home directory is invalid");
  }
  return fallback;
}

/**
 * Resolve the Claude roots independently from the installed dashboard
 * resources.  `CLAUDE_CONFIG_DIR` is a provider path configuration, not a
 * feature toggle; shadow collection remains controlled only by the explicit
 * programmatic `claudeShadowEnabled` option below.  Claude Code exposes
 * `CLAUDE_PROJECT_DIR` to its own hooks; the longer directory spelling is
 * accepted as a companion-launcher override for callers that do not inherit
 * the hook environment.
 */
export function resolveClaudeDesktopShadowConfiguration({
  options = {},
  environment = process.env,
  fallbackProjectDirectory = process.cwd(),
} = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
      || !environment || typeof environment !== "object"
      || Array.isArray(environment)) {
    throw new TypeError("Claude shadow path configuration is invalid");
  }
  const configCandidate = Object.hasOwn(options, "claudeConfigDirectory")
    ? options.claudeConfigDirectory
    : Object.hasOwn(environment, "CLAUDE_CONFIG_DIR")
      ? environment.CLAUDE_CONFIG_DIR
      : undefined;
  const projectCandidate = Object.hasOwn(options, "claudeProjectDirectory")
    ? options.claudeProjectDirectory
    : Object.hasOwn(environment, "CLAUDE_PROJECT_DIR")
      ? environment.CLAUDE_PROJECT_DIR
      : Object.hasOwn(environment, "CLAUDE_PROJECT_DIRECTORY")
        ? environment.CLAUDE_PROJECT_DIRECTORY
        : fallbackProjectDirectory;
  return Object.freeze({
    claudeConfigDirectory: configCandidate === undefined
      ? undefined
      : assertLocalAbsolutePath(configCandidate),
    claudeProjectDirectory: assertLocalAbsolutePath(projectCandidate),
  });
}

// Accounting authority is a composition-root choice. The shipped default is
// the generation-bound unified index; legacy remains an explicit rollback only.
// Either mode is selected here and there is no implicit fallback between them.
export function configuredAccountingSourceMode(environment) {
  if (!environment || typeof environment !== "object"
      || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  const selected = environment.USAGE_MONITOR_ACCOUNTING_SOURCE_MODE ?? "unified";
  if (!new Set(["legacy", "unified"]).has(selected)) {
    throw new TypeError(
      "USAGE_MONITOR_ACCOUNTING_SOURCE_MODE must be legacy or unified",
    );
  }
  return selected;
}

function parentWatchdogConfigurationError() {
  const error = new TypeError(
    "Parent watchdog configuration is invalid",
  );
  error.code = "USAGE_MONITOR_PARENT_PID_INVALID";
  return error;
}

function configuredParentWatchdogPid(
  environment,
  observedParentPid = process.ppid,
) {
  if (!Object.hasOwn(environment, PARENT_PID_ENV)) return null;
  const value = environment[PARENT_PID_ENV];
  if (typeof value !== "string" || !PARENT_PID.test(value)) {
    throw parentWatchdogConfigurationError();
  }
  const selected = Number(value);
  if (!Number.isSafeInteger(selected)
      || selected <= 1
      || selected > MAXIMUM_PARENT_PID
      || String(selected) !== value
      || selected !== observedParentPid) {
    throw parentWatchdogConfigurationError();
  }
  return selected;
}

function declaredParentIsCurrent(expectedParentPid) {
  if (expectedParentPid === null) return true;
  if (process.ppid !== expectedParentPid) return false;
  try {
    process.kill(expectedParentPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
    server.closeAllConnections?.();
  });
}

function startParentDeathWatchdog({
  server,
  expectedParentPid,
  terminateProcess,
}) {
  if (expectedParentPid === null) {
    return Object.freeze({ stop() {} });
  }
  let active = true;
  const timer = setInterval(() => {
    if (!active || declaredParentIsCurrent(expectedParentPid)) return;
    active = false;
    clearInterval(timer);
    let forcedExit = null;
    if (terminateProcess) {
      // `server.close()` can wait indefinitely on platform-specific socket
      // bookkeeping after the launcher has already disappeared. Preserve a
      // short graceful-close window, then guarantee that the orphan cannot
      // survive its declared parent on Linux or Windows.
      forcedExit = setTimeout(
        () => process.exit(0),
        PARENT_WATCHDOG_EXIT_GRACE_MS,
      );
    }
    void closeHttpServer(server)
      .catch(() => {})
      .then(() => {
        if (forcedExit !== null) clearTimeout(forcedExit);
        if (terminateProcess) process.exit(0);
      });
  }, PARENT_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return Object.freeze({
    stop() {
      if (!active) return;
      active = false;
      clearInterval(timer);
    },
  });
}

export function createLocalCompanionServer(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const environment = options.environment ?? process.env;
  if (!environment || typeof environment !== "object"
      || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  const semanticOpenTarget = configuredSemanticOpenTarget(environment);
  const parentWatchdogPid = configuredParentWatchdogPid(environment);
  const homeDirectory = configuredHomeDirectory(environment);
  // A malformed provider path must not make the ordinary disabled companion
  // fail before it can serve Codex. Resolve and validate Claude roots only
  // for the explicit programmatic shadow opt-in; the disabled controller can
  // safely carry the raw values without reading or touching them.
  const claudeShadowConfiguration = options.claudeShadowEnabled === true
    ? resolveClaudeDesktopShadowConfiguration({
      options,
      environment,
    })
    : Object.freeze({
      claudeConfigDirectory: Object.hasOwn(options, "claudeConfigDirectory")
        ? options.claudeConfigDirectory
        : environment.CLAUDE_CONFIG_DIR,
      claudeProjectDirectory: Object.hasOwn(options, "claudeProjectDirectory")
        ? options.claudeProjectDirectory
        : environment.CLAUDE_PROJECT_DIR
          ?? environment.CLAUDE_PROJECT_DIRECTORY
          ?? process.cwd(),
    });
  const resourceRoot = options.resourceRoot
    ?? environment.USAGE_MONITOR_RESOURCE_ROOT
    ?? options.root
    ?? DEFAULT_RESOURCE_ROOT;
  const stateRoot = options.stateRoot
    ?? environment.USAGE_MONITOR_STATE_ROOT
    ?? defaultLocalCompanionStateRoot({
      homeDirectory,
      environment,
    });
  const installation = prepareLocalInstallationRoots({
    resourceRoot,
    stateRoot,
  });
  const staticRoot = assertLocalResourceDirectory(
    installation.resourceRoot,
    options.staticRoot
      ?? resolve(installation.resourceRoot, "apps", "web", "public"),
  );
  const codexHome = assertLocalAbsolutePath(
    options.codexHome
      ?? environment.CODEX_HOME
      ?? join(homeDirectory, ".codex"),
  );
  const contributionQueueFile = assertLocalStatePath(
    installation.stateRoot,
    options.contributionQueueFile
      ?? environment.USAGE_MONITOR_CONTRIBUTION_QUEUE_FILE
      ?? installation.paths.contributionQueueFile,
  );
  const diagnosticsLogFile = assertLocalStatePath(
    installation.stateRoot,
    options.diagnosticsLogFile
      ?? join(installation.stateRoot, DIAGNOSTICS_LOG_FILE_NAME),
  );
  const legacyContributionDeviceStateCandidate = Object.hasOwn(
    options,
    "legacyContributionDeviceStateFile",
  )
    ? options.legacyContributionDeviceStateFile
    : process.platform === "darwin"
        && !Object.hasOwn(options, "contributionDeviceBackendFactory")
      ? join(
        homeDirectory,
        "Library",
        "Application Support",
        "app-usagemonitor",
        "contribution-device-binding-v1.json",
      )
      : null;
  const legacyContributionDeviceStateFile =
    legacyContributionDeviceStateCandidate === null
      ? null
      : assertLocalAbsolutePath(legacyContributionDeviceStateCandidate);
  const preparedCandidate = Object.hasOwn(
    options,
    "preparedContributionDirectory",
  )
    ? options.preparedContributionDirectory
    : Object.hasOwn(environment, "USAGE_MONITOR_PREPARED_DIRECTORY")
      ? environment.USAGE_MONITOR_PREPARED_DIRECTORY
      : installation.paths.preparedSpoolDirectory;
  const preparedContributionDirectory = preparedCandidate === null
    ? null
    : assertLocalStatePath(installation.stateRoot, preparedCandidate);
  const contributionPreparationOptions =
    options.contributionPreparationOptions ?? {};
  if (!contributionPreparationOptions
      || typeof contributionPreparationOptions !== "object"
      || Array.isArray(contributionPreparationOptions)) {
    throw new TypeError("contributionPreparationOptions must be an object");
  }
  const selectedPreparationOptions = {
    ...contributionPreparationOptions,
    activityFile: assertLocalStatePath(
      installation.stateRoot,
      contributionPreparationOptions.activityFile
        ?? installation.paths.activityMarkersFile,
    ),
    reviewArchiveDirectory: assertLocalStatePath(
      installation.stateRoot,
      contributionPreparationOptions.reviewArchiveDirectory
        ?? installation.paths.reviewArchiveDirectory,
    ),
  };
  return createPreparedLocalCompanionServer({
    ...options,
    environment,
    resourceRoot: installation.resourceRoot,
    stateRoot: installation.stateRoot,
    statePaths: installation.paths,
    staticRoot,
    codexHome,
    contributionQueueFile,
    diagnosticsLogFile,
    legacyContributionDeviceStateFile,
    preparedContributionDirectory,
    contributionPreparationOptions: selectedPreparationOptions,
    parentWatchdogPid,
    homeDirectory,
    semanticOpenTarget,
    ...claudeShadowConfiguration,
  });
}

function createPreparedLocalCompanionServer({
  environment,
  resourceRoot,
  stateRoot,
  statePaths,
  staticRoot,
  codexHome,
  homeDirectory,
  claudeConfigDirectory,
  claudeProjectDirectory,
  diagnosticsLogFile,
  parentWatchdogPid,
  semanticOpenTarget,
  // Explicit reversible authority switch. Unified is the normal authority;
  // legacy is retained only for an explicit rollback selection.
  accountingSourceMode =
    configuredAccountingSourceMode(environment),
  fastModePreference = createFastModePreferenceController({
    settingsFile: statePaths.fastModePreferenceFile,
  }),
  // The declared Codex speed-mode baseline. Codex records the mode only when
  // it is applied or changed, never at session start, so the baseline lives
  // nowhere but the configuration's top-level `service_tier` key - and only
  // that key is ever read from that file. Each reading is stamped with the
  // moment it happened and attributes only turns from then on.
  codexSpeedBaseline = createCodexSpeedBaselineController({
    ledgerFile: statePaths.codexSpeedBaselineFile,
    configFile: join(codexHome, "config.toml"),
  }),
  dataStore = new LocalCompanionDataStore({
    snapshotFile: statePaths.authoritativeDashboardSnapshotFile,
    builder: async ({ purpose = "full" } = {}) => buildLocalCompanionSnapshot({
      root: resourceRoot,
      collectorStateFile: statePaths.collectorStateFile,
      archiveIndexFile: accountingSourceMode === "legacy"
        ? statePaths.archiveAccountingIndexFile
        : null,
      unifiedIndexFile: statePaths.unifiedIndexFile,
      codexHome,
      accountingSourceMode,
      unifiedProjectionMode: ["startup", "quick"].includes(purpose)
        ? "deferred"
        : "full",
      allowDevelopmentArtifactFallback:
        environment.USAGE_MONITOR_DEVELOPMENT_ARTIFACT_FALLBACK === "1",
      includeDevelopmentSideChatEstimates:
        environment.USAGE_MONITOR_DEVELOPMENT_SIDE_CHAT_ESTIMATES === "1",
      developmentSideChatHistoricalGapDate:
        environment.USAGE_MONITOR_DEVELOPMENT_SIDE_CHAT_BACKCAST_DATE ?? null,
      developmentSideChatHistoricalGapTimeZone:
        environment.USAGE_MONITOR_DEVELOPMENT_SIDE_CHAT_BACKCAST_TIME_ZONE
          ?? "America/New_York",
      developmentSideChatHistoricalGapAssumedSpeed:
        environment.USAGE_MONITOR_DEVELOPMENT_SIDE_CHAT_BACKCAST_SPEED
          ?? "fast",
      // The owner's stated Codex speed mode. It attributes only the turns that
      // precede the first recorded tier change in their session; an observed
      // tier always wins. A missing or unreadable statement degrades to the
      // Standard default rather than inventing a Fast attribution.
      fastModePreference: await fastModePreference.readMode(),
      // Timestamped declared baselines. They fill only the turns the rollout
      // log left unobserved and that a reading actually covers; an observed
      // tier always wins, and an unreadable ledger is simply no coverage.
      codexSpeedBaselines: await codexSpeedBaseline.readWindows(),
    }),
  }),
  // Reprice the usage events inside a bounded [from, to] window from the
  // unified local index, grouped by model and observed speed. Injected so a
  // test can drive the route's range validation and response shape without a
  // real index on disk; in production it reads the same index the snapshot
  // draws from, strictly read-only.
  windowBreakdownProvider = ({ fromMs, toMs }) => readLocalUnifiedWindowBreakdown({
    indexFile: statePaths.unifiedIndexFile,
    fromMs,
    toMs,
  }),
  // This is a programmatic, development-only gate: no environment variable,
  // settings control, route, or UI surface enables Claude usage collection.
  // A caller must explicitly opt into the production-shaped local shadow.
  claudeShadowEnabled = false,
  claudeShadowControllerFactory = createClaudeDesktopShadowController,
  claudeShadowController = claudeShadowControllerFactory({
    enabled: claudeShadowEnabled,
    stateRoot,
    homeDirectory,
    projectDirectory: claudeProjectDirectory,
    claudeConfigDirectory,
  }),
  refreshRunner = createLocalCollectorRefreshRunner({
    codexHome,
    stateFile: statePaths.collectorStateFile,
    accountObservationOperationLockFile:
      statePaths.accountObservationLockFile,
    selectAccountObservationSecret: (options = {}) =>
      selectProductionAccountObservationSecret({
        ...options,
        createKeychainBackend: () =>
          createAppAwareKeychainBackend(environment),
      }),
    refreshAccounting: refreshReplaySafeAccountingCache,
    refreshClaudeUsageShadow: claudeShadowEnabled
      ? ({ signal }) => claudeShadowController.refresh({ signal })
      : null,
    accountingSourceMode,
    legacyAnalysisIndexFile: accountingSourceMode === "legacy"
      ? statePaths.legacyAnalysisIndexFile
      : null,
    legacyAnalysisIndexSecretFile: accountingSourceMode === "legacy"
      ? statePaths.legacyAnalysisIndexSecretFile
      : null,
    refreshArchiveIndex: accountingSourceMode === "legacy"
      ? refreshLocalArchiveAccountingIndex
      : null,
    archiveIndexFile: accountingSourceMode === "legacy"
      ? statePaths.archiveAccountingIndexFile
      : null,
    archiveIndexSecretFile: accountingSourceMode === "legacy"
      ? statePaths.archiveAccountingIndexSecretFile
      : null,
    // Advance the unified index by its cursors on every foreground refresh:
    // an ordinary pass reads only the bytes the rollout corpus grew.
    refreshUnifiedIndex: (options) => ingestLocalUnifiedIndexIncrement({
      ...options,
      contractVersion: TELEMETRY_SCHEMA_VERSION,
    }),
    unifiedIndexFile: statePaths.unifiedIndexFile,
    unifiedIndexSecretFile: statePaths.unifiedIndexSecretFile,
    recordCodexSpeedBaseline: async () => (
      (await codexSpeedBaseline.record()).windows
    ),
  }),
  onboardingProvider = () => inspectLocalOnboarding({
    codexHome,
    stateRoot,
    explicitRefresh: true,
    customCodexHomeConfigured:
      typeof environment.CODEX_HOME === "string"
      && environment.CODEX_HOME.length > 0,
  }),
  refreshTimeoutMs = 300_000,
  centralOrigin = environment.USAGE_MONITOR_CENTRAL_ORIGIN ?? null,
  centralFetch = globalThis.fetch,
  contributionPreparationRunner = null,
  contributionPreparationOptions = {},
  contributionPreparationCreateKeychainBackend = () =>
    createAppAwareKeychainBackend(environment),
  developmentExportSecretFile =
    environment[DEVELOPMENT_IDENTITY_FILE_ENV] ?? null,
  developmentIdentityOptIn =
    environment[DEVELOPMENT_IDENTITY_OPT_IN_ENV] ?? null,
  contributionQueueFile,
  legacyContributionDeviceStateFile = null,
  contributionSyncStatusProvider = () => inspectContributionSyncQueue({
    queueFile: contributionQueueFile,
  }),
  preparedContributionDirectory,
  contributionServiceOrigin = centralOrigin,
  // When the signed app spawned this companion it hands over a Keychain
  // broker channel (a socketpair end on the named descriptor): fresh
  // contribution-device credentials are then minted and read by the app —
  // the structural fix for the first-pairing Keychain dialog — while legacy
  // items migrate through the signed app on their next protected read.
  // Without the announcement (development, tests, Windows) the
  // production keytar backend stays authoritative, exactly as before. The
  // transport is shared across backend constructions: the channel is one
  // kernel socketpair whose lifetime is the app's.
  contributionDeviceBackendFactory = (() => {
    // A malformed environment is rejected by the body's own validation; the
    // selection here must not preempt that error with a different one.
    const brokerConfiguration = environment && typeof environment === "object"
        && !Array.isArray(environment)
      ? contributionDeviceKeychainBrokerConfiguration(environment)
      : null;
    if (brokerConfiguration === null) {
      return createProductionContributionDeviceBackend;
    }
    let brokerTransport = null;
    return () => {
      brokerTransport ??= createContributionDeviceKeychainBrokerTransport(
        brokerConfiguration,
      );
      return createAppBrokeredContributionDeviceBackend({
        transport: brokerTransport,
      });
    };
  })(),
  // Where a Keychain dialog is still reachable, resolved once. The legacy leg
  // of the answer shells out to an attribute probe, and the ceremony polls the
  // carrying route every four seconds, so this must not be recomputed per
  // request. Nothing in brokered mode ever creates a legacy item, so one
  // answer holds for the process; the migration that removes one only makes a
  // conditional sentence redundant, never wrong.
  contributionDeviceKeychainPromptProvider = () =>
    contributionDeviceKeychainPromptSurface({ environment }),
  contributionDevicePairingProvider = null,
  contributionDeviceCredentialResetRunner = null,
  contributionDeviceCredentialAttributeDelete = null,
  contributionDeviceDisconnectRunner = null,
  diagnosticNoteRecorder = null,
  clock = () => Date.now(),
  hostedSignInHandoffController = null,
  contributionSyncNextProvider = null,
  contributionSyncExactReviewProvider = null,
  supersededContributionRetirementRunner = null,
  contributionSyncPauseSetter = null,
  automaticContributionStateRetirementRunner =
    retireAutomaticContributionState,
  automaticContributionRetirementLockAcquirer =
    acquireAutomaticContributionRetirementLock,
  incrementalContributionController = null,
  onError = () => {},
} = {}) {
  if (!environment || typeof environment !== "object"
      || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  if (!dataStore || typeof dataStore.initialize !== "function") {
    throw new TypeError("dataStore.initialize must be a function");
  }
  if (typeof onboardingProvider !== "function") {
    throw new TypeError("onboardingProvider must be a function");
  }
  if (typeof claudeShadowEnabled !== "boolean"
      || typeof claudeShadowControllerFactory !== "function"
      || !claudeShadowController
      || typeof claudeShadowController.refresh !== "function") {
    throw new TypeError("Claude shadow controller configuration is invalid");
  }
  if (contributionPreparationRunner !== null
      && typeof contributionPreparationRunner !== "function") {
    throw new TypeError(
      "contributionPreparationRunner must be a function or null",
    );
  }
  if (!contributionPreparationOptions
      || typeof contributionPreparationOptions !== "object"
      || Array.isArray(contributionPreparationOptions)) {
    throw new TypeError("contributionPreparationOptions must be an object");
  }
  if (contributionPreparationCreateKeychainBackend !== undefined
      && typeof contributionPreparationCreateKeychainBackend !== "function") {
    throw new TypeError(
      "contributionPreparationCreateKeychainBackend must be a function",
    );
  }
  const developmentIdentity = resolveDevelopmentIdentityConfiguration({
    file: developmentExportSecretFile,
    optIn: developmentIdentityOptIn,
    environmentExportSecretPresent:
      Object.hasOwn(environment, EXPORT_IDENTITY_ENV),
  });
  if (typeof contributionSyncStatusProvider !== "function") {
    throw new TypeError("contributionSyncStatusProvider must be a function");
  }
  if (typeof contributionQueueFile !== "string"
      || contributionQueueFile.length < 1) {
    throw new TypeError("contributionQueueFile must be a non-empty string");
  }
  if (preparedContributionDirectory !== null
      && typeof preparedContributionDirectory !== "string") {
    throw new TypeError("preparedContributionDirectory must be a string or null");
  }
  if (contributionServiceOrigin !== null
      && typeof contributionServiceOrigin !== "string") {
    throw new TypeError("contributionServiceOrigin must be a string or null");
  }
  if (legacyContributionDeviceStateFile !== null
      && (typeof legacyContributionDeviceStateFile !== "string"
        || !isAbsolute(legacyContributionDeviceStateFile))) {
    throw new TypeError(
      "legacyContributionDeviceStateFile must be an absolute path or null",
    );
  }
  if (typeof diagnosticsLogFile !== "string"
      || diagnosticsLogFile.length < 1
      || typeof clock !== "function"
      || (diagnosticNoteRecorder !== null
        && typeof diagnosticNoteRecorder !== "function")) {
    throw new TypeError("local diagnostics controls are invalid");
  }
  if (hostedSignInHandoffController !== null
      && (!hostedSignInHandoffController
        || typeof hostedSignInHandoffController.inspect !== "function"
        || typeof hostedSignInHandoffController.store !== "function"
        || typeof hostedSignInHandoffController.clear !== "function")) {
    throw new TypeError("hosted sign-in handoff controller is invalid");
  }
  if (typeof contributionDeviceBackendFactory !== "function"
      || (contributionDevicePairingProvider !== null
        && typeof contributionDevicePairingProvider !== "function")
      || (contributionDeviceCredentialResetRunner !== null
        && typeof contributionDeviceCredentialResetRunner !== "function")
      || (contributionDeviceCredentialAttributeDelete !== null
        && typeof contributionDeviceCredentialAttributeDelete !== "function")
      || (contributionDeviceDisconnectRunner !== null
        && typeof contributionDeviceDisconnectRunner !== "function")
      || (contributionSyncNextProvider !== null
        && typeof contributionSyncNextProvider !== "function")
      || (contributionSyncExactReviewProvider !== null
        && typeof contributionSyncExactReviewProvider !== "function")
      || (supersededContributionRetirementRunner !== null
        && typeof supersededContributionRetirementRunner !== "function")
      || (contributionSyncPauseSetter !== null
        && typeof contributionSyncPauseSetter !== "function")
      || typeof automaticContributionStateRetirementRunner !== "function"
      || typeof automaticContributionRetirementLockAcquirer !== "function") {
    throw new TypeError("contribution sync controls are invalid");
  }
  const nextContribution = contributionSyncNextProvider
    ?? (preparedContributionDirectory === null
      ? async () => null
      : () => inspectNextContributionSyncUpload({
        directory: preparedContributionDirectory,
        queueFile: contributionQueueFile,
      }));
  const createContributionDeviceBackend = async () => {
    const backend = contributionDeviceBackendFactory();
    if (legacyContributionDeviceStateFile !== null) {
      await migrateLegacyContributionDeviceCapability({
        backend,
        legacyStateFile: legacyContributionDeviceStateFile,
        stateFile: statePaths.contributionDeviceStateFile,
        expectedOrigin: contributionServiceOrigin,
      });
    }
    return backend;
  };
  // Keychain-free pairing evidence: the binding file is published the moment
  // a credential is minted (at the legacy location until its lazy migration),
  // so its presence answers "has this Mac ever paired" without touching the
  // Keychain — this probe must never itself raise the macOS access prompt.
  // Anything other than a clean absence counts as present, so approval keeps
  // the immediate first attempt and the pass classifies the fault honestly.
  const contributionDeviceBindingPresent = async () => {
    const candidates = [
      statePaths.contributionDeviceStateFile,
      ...(legacyContributionDeviceStateFile === null
        ? []
        : [legacyContributionDeviceStateFile]),
    ];
    for (const candidate of candidates) {
      try {
        await lstat(candidate);
        return true;
      } catch (error) {
        if (error?.code !== "ENOENT") return true;
      }
    }
    return false;
  };
  const pairContributionDevice = contributionDevicePairingProvider
    ?? (contributionServiceOrigin === null
      ? null
      : async ({ pairingCode }) => {
        const backend = await createContributionDeviceBackend();
        const paired = await claimContributionDevicePairing({
          origin: contributionServiceOrigin,
          pairingCode,
          capabilityOptions: {
            backend,
            stateFile: statePaths.contributionDeviceStateFile,
          },
        });
        // Seed the auto-renewal due-tracker with the freshly issued expiry so a
        // later normal sync pass can rotate the credential ~5 days before it
        // lapses without any further user sign-in. Best-effort: the credential
        // is fully paired regardless of whether this hint persists.
        if (paired?.status === "paired"
            && typeof paired.deviceId === "string"
            && typeof paired.expiresAt === "string") {
          try {
            await writeContributionDeviceRenewalState(
              statePaths.contributionDeviceRenewalStateFile,
              { deviceId: paired.deviceId, expiresAt: paired.expiresAt },
            );
          } catch {
            // A missing due-tracker only defers the first silent renewal until
            // the next pairing; it never affects delivery.
          }
        }
        return paired;
      });
  // Purely local repair: it needs at most the Keychain backend and the
  // binding state files, never a contribution service origin, so it stays
  // available even when no service is configured. The backend is best-effort
  // here — when the capability layer itself is the fault (observed live
  // 2026-08-10: the signed native binding failed its integrity pin, so even
  // constructing the backend threw), the repair proceeds by attribute delete
  // rather than refusing to run.
  const resetContributionDeviceCredential =
    contributionDeviceCredentialResetRunner
    ?? (async () => {
      let backend = null;
      try {
        backend = await createContributionDeviceBackend();
      } catch {
        backend = null;
      }
      return resetContributionDeviceCredentialLocally({
        backend,
        stateFile: statePaths.contributionDeviceStateFile,
        legacyStateFile: legacyContributionDeviceStateFile,
        ...(contributionDeviceCredentialAttributeDelete === null
          ? {}
          : { attributeDelete: contributionDeviceCredentialAttributeDelete }),
      });
    });
  // Disconnect revokes the remote bearer before removing its local binding.
  // Serialize every delivery-affecting local mutation with that transition so
  // a foreground or automatic sync cannot begin in the await between the
  // initial idle check and remote revocation.
  let contributionDeviceDisconnectInProgress = false;
  const disconnectContributionDevice = contributionDeviceDisconnectRunner
    ?? (contributionServiceOrigin === null
      ? null
      : async () => {
        const backend = await createContributionDeviceBackend();
        let remoteConfirmed = false;
        try {
          const remote = await disconnectContributionDeviceRemotely({
            origin: contributionServiceOrigin,
            capabilityOptions: {
              backend,
              stateFile: statePaths.contributionDeviceStateFile,
            },
          });
          if (remote?.status !== "disconnected"
              || typeof remote.deviceId !== "string") {
            throw new Error("remote contribution-device disconnect invalid");
          }
          remoteConfirmed = true;
          // Once the remote bearer is gone, stop the local queue before
          // erasing the exact credential. A pause persistence failure leaves
          // the harmless stale local binding in place for a retry; it never
          // leaves a live remote upload authority behind.
          const queue = await setContributionPaused({ paused: true });
          if (queue?.paused !== true) {
            throw new Error("contribution delivery was not paused");
          }
          const removed = await removeContributionDeviceCapability({
            backend,
            stateFile: statePaths.contributionDeviceStateFile,
            expectedOrigin: contributionServiceOrigin,
            confirmDeviceId: remote.deviceId,
            remoteRevocationConfirmed: true,
          });
          if (removed?.status !== "removed"
              || removed.deviceId !== remote.deviceId) {
            throw new Error("local contribution-device removal invalid");
          }
          return Object.freeze({
            status: "disconnected",
            deliveryPaused: true,
            localCredential: removed.credential,
            localBinding: "removed",
          });
        } catch (error) {
          if (remoteConfirmed) {
            const cleanupPending = new Error("local disconnect cleanup pending");
            cleanupPending.code = "contribution_device_disconnect_cleanup_pending";
            throw cleanupPending;
          }
          throw error;
        }
      });
  const recordDiagnosticNote = diagnosticNoteRecorder
    ?? ((note) => appendDiagnosticNote({
      file: diagnosticsLogFile,
      note,
      now: clock(),
    }));
  const hostedSignInHandoff = hostedSignInHandoffController
    ?? createHostedSignInHandoffController({
      handoffFile: statePaths.hostedSignInHandoffFile,
      now: clock,
    });
  const reviewExactContribution = contributionSyncExactReviewProvider
    ?? (preparedContributionDirectory === null
      ? async () => null
      : () => inspectExactNextContributionSyncUpload({
        directory: preparedContributionDirectory,
        queueFile: contributionQueueFile,
      }));
  const setContributionPaused = contributionSyncPauseSetter
    ?? (({ paused }) => setContributionSyncPaused({
      paused,
      queueFile: contributionQueueFile,
    }));
  const syncPreviewConfigured = preparedContributionDirectory !== null
    || contributionSyncNextProvider !== null;
  const contributionDevicePairingConfigured =
    pairContributionDevice !== null;
  const contributionDeviceDisconnectConfigured =
    disconnectContributionDevice !== null;
  const syncExactReviewConfigured = preparedContributionDirectory !== null
    || contributionSyncExactReviewProvider !== null;
  const runContributionPreparation = contributionPreparationRunner
    ?? createLocalContributionPreparationRunner({
      ...contributionPreparationOptions,
      coverageProvider: () => (
        dataStore.getOverview()?.collector?.exportableCoveredAt
      ),
      ...(preparedContributionDirectory === null
        ? {}
        : { preparedSpoolDirectory: preparedContributionDirectory }),
      explicitSecretFile: developmentIdentity.explicitSecretFile,
      selectIdentity: ({ explicitSecretFile }) => (
        selectProductionParticipantIdentity({
          explicitSecretFile,
          environmentSecret: environment[EXPORT_IDENTITY_ENV],
          appStateSecretFile: statePaths.exportParticipantSecretFile,
          ...(contributionPreparationCreateKeychainBackend === undefined
            ? {}
            : {
              createKeychainBackend:
                contributionPreparationCreateKeychainBackend,
            }),
        })
      ),
  });
  let contributionPreparationInProgress = false;
  let contributionSyncInProgress = false;
  const runSupersededContributionRetirement =
    supersededContributionRetirementRunner
    ?? (preparedContributionDirectory === null
      ? async () => ({
        retiredSets: 0,
        retiredJobs: 0,
        interrupted: false,
        networkActivity: false,
      })
      : ({ signal } = {}) =>
        retireSupersededPendingContributionArtifacts({
          preparedSpoolDirectory: preparedContributionDirectory,
          reviewArchiveDirectory:
            contributionPreparationOptions.reviewArchiveDirectory,
          queueFile: contributionQueueFile,
          signal,
        }));
  if (incrementalContributionController !== null
      && (!incrementalContributionController
        || typeof incrementalContributionController !== "object"
        || typeof incrementalContributionController.start !== "function"
        || typeof incrementalContributionController.stop !== "function"
        || typeof incrementalContributionController.inspect !== "function"
        || typeof incrementalContributionController.approve !== "function"
        || typeof incrementalContributionController.resume !== "function")) {
    throw new TypeError("incrementalContributionController is invalid");
  }
  // Resolved on first use and then held: the provider's legacy leg spawns an
  // attribute probe, and the route carrying this answer is polled every few
  // seconds by the ceremony. An unusable provider reports the surface that
  // keeps today's guidance on screen.
  let resolvedKeychainPrompt = null;
  function keychainPromptSurface() {
    if (resolvedKeychainPrompt === null) {
      let resolved;
      try {
        resolved = contributionDeviceKeychainPromptProvider();
      } catch {
        resolved = "pairing";
      }
      resolvedKeychainPrompt =
        CONTRIBUTION_DEVICE_KEYCHAIN_PROMPT_SURFACES.includes(resolved)
          ? resolved
          : "pairing";
    }
    return resolvedKeychainPrompt;
  }

  // The telemetry-contribution-v1.0 incremental sync, additive beside the
  // v0.1 prepared-set path. Configured only when a contribution service
  // origin exists; the health capability additionally requires the unified
  // index file to be present, because the index is the upload source.
  const incrementalContribution = incrementalContributionController
    ?? (contributionServiceOrigin === null
      ? null
      : createIncrementalContributionSyncController({
        settingsFile: statePaths.incrementalContributionSyncSettingsFile,
        destinationOrigin: contributionServiceOrigin,
        runner: async ({ signal }) => {
          if (contributionSyncInProgress
              || contributionDeviceDisconnectInProgress) {
            const error = new Error("sync_in_progress");
            error.code = "sync_in_progress";
            error.retryable = true;
            throw error;
          }
          contributionSyncInProgress = true;
          try {
            const backend = await createContributionDeviceBackend();
            // Silent auto-renewal (sign-in-once durability, part 2). Before the
            // upload pass, rotate the 30-day credential in place if it is inside
            // its renewal window, authenticated by the existing credential. This
            // is strictly best-effort: it never throws into the pass, and a
            // failure just leaves the still-valid credential for the next try.
            try {
              await renewContributionDeviceCredentialIfDue({
                origin: contributionServiceOrigin,
                renewalStateFile: statePaths.contributionDeviceRenewalStateFile,
                capabilityOptions: {
                  backend,
                  stateFile: statePaths.contributionDeviceStateFile,
                },
              });
            } catch {
              // A renewal misconfiguration must never stall delivery; the pass
              // proceeds on the credential that is still valid.
            }
            return await runIncrementalContributionSyncOnce({
              indexFile: statePaths.unifiedIndexFile,
              origin: contributionServiceOrigin,
              backend,
              stateFile: statePaths.contributionDeviceStateFile,
              signal,
            });
          } catch (error) {
            // 2026-08-10 (observed live): a foreground ingest writing the
            // unified index while a pass reads it surfaced as an anonymous
            // run_failed with an escalating ladder. It is expected local
            // coordination — name it, mark it retryable-soon, and let the
            // controller retry within the pending minute.
            if (unifiedIndexBusyError(error)) {
              const busy = new Error(
                "unified index momentarily held by another local writer",
              );
              busy.code = "index_busy";
              busy.retryable = true;
              throw busy;
            }
            // 2026-08-10 (observed live): the Keychain capability failed
            // before the engine could shape it — the backend factory threw
            // once a Sparkle update invalidated the audited binding — and
            // the controller looped anonymous run_failed retries against a
            // fault no retry can fix. The engine already owns the honest
            // state for exactly this family; hand it over as the
            // device_unavailable pause so the dashboard shows the
            // re-approve repair path.
            if (contributionDeviceCapabilityFailure(error)) {
              return deviceUnavailableIncrementalRunOutcome();
            }
            throw error;
          } finally {
            contributionSyncInProgress = false;
          }
        },
      }));
  const unifiedIndexPresent = async () => {
    try {
      const metadata = await lstat(statePaths.unifiedIndexFile);
      return metadata.isFile() && !metadata.isSymbolicLink();
    } catch {
      return false;
    }
  };
  // The durable v1.0 consent verdict, read best-effort. `null` means the
  // verdict could not be read right now — callers must treat that as unknown,
  // never as either approved or pre-consent.
  const incrementalConsentVerdict = async () => {
    if (incrementalContribution === null) return null;
    try {
      const consent = (await incrementalContribution.inspect())?.consent;
      return consent && typeof consent === "object" ? consent : null;
    } catch {
      return null;
    }
  };
  // v0.1 prepared sets on a Mac whose uploads ride the approved v1.0
  // incremental consent can never deliver — no scheduler drains that queue
  // any more — so they only accumulate (observed live 2026-08-19: 73 pending
  // jobs, dueNow 74, lastAcceptedAt null). One bounded pass per trigger
  // converges such installs while keeping the oldest set: it is the instance
  // the approve-once consent was reviewed against. Failures are swallowed —
  // the next launch retries, and delivery state is never touched.
  const maybeRetireSupersededPreparedSets = async () => {
    const verdict = await incrementalConsentVerdict();
    if (verdict?.approved !== true || verdict?.current !== true) return;
    try {
      await runSupersededContributionRetirement({});
    } catch {
      // Bounded cleanup only; the queue converges on a later pass.
    }
  };
  let automaticContributionRetirementLock = null;
  let automaticContributionRetirementLockRelease = null;
  let automaticContributionRetirement = null;
  let contributionRuntimeShutdown = null;
  let instanceLockPromise = null;
  let snapshotPromise = null;
  // Building the first snapshot reads the whole retained collector state, which
  // is seconds of work on a large install. The port is opened before that work
  // starts, so this is the only record of whether the in-memory snapshot the
  // read routes project from actually exists yet. It is reported verbatim by
  // /api/local/health rather than being smoothed into "ready".
  let snapshotState = { status: "building", errorCode: null };
  const releaseAutomaticContributionRetirementLock = () => {
    if (automaticContributionRetirementLockRelease !== null) {
      return automaticContributionRetirementLockRelease;
    }
    const lock = automaticContributionRetirementLock;
    automaticContributionRetirementLock = null;
    automaticContributionRetirementLockRelease = Promise.resolve(
      lock?.release(),
    );
    return automaticContributionRetirementLockRelease;
  };
  const shutdownContributionRuntime = () => {
    if (contributionRuntimeShutdown === null) {
      contributionRuntimeShutdown = (async () => {
        try {
          await incrementalContribution?.stop();
        } catch {
          onError("incremental_contribution_stop_failed");
        }
        await releaseAutomaticContributionRetirementLock();
      })();
    }
    return contributionRuntimeShutdown;
  };
  // Single-instance exclusion is cheap (one lock file) and must still be
  // decided before this process is allowed to accept requests, so it stays on
  // the pre-listen path. Only the snapshot build moves behind the port.
  const acquireInstanceLock = () => {
    if (instanceLockPromise === null) {
      instanceLockPromise = (async () => {
        automaticContributionRetirementLock =
          await automaticContributionRetirementLockAcquirer({
            lockFile: statePaths.automaticContributionLockFile,
          });
        try {
          automaticContributionRetirement =
            await automaticContributionStateRetirementRunner({
              settingsFile: statePaths.automaticContributionSettingsFile,
            });
        } catch (error) {
          await releaseAutomaticContributionRetirementLock().catch(() => {});
          throw error;
        }
      })();
    }
    return instanceLockPromise;
  };
  // Resolved the moment the outcome of the first build is known. A failing
  // build still finishes stopping the contribution runtime before it rethrows;
  // the retirement lock must outlive that cleanup, but a request waiting to read
  // the snapshot is answered as soon as the answer exists, not held behind
  // someone else's teardown.
  let announceSnapshotOutcome = null;
  const snapshotOutcome = new Promise((resolveOutcome) => {
    announceSnapshotOutcome = resolveOutcome;
  });
  const buildSnapshot = () => {
    if (snapshotPromise === null) {
      snapshotPromise = (async () => {
        try {
          await dataStore.initialize();
          // The v1.0 incremental sync remains the only contribution scheduler.
          // A failure here must never take the local dashboard down.
          try {
            await incrementalContribution?.start();
          } catch {
            onError("incremental_contribution_start_failed");
          }
          // Fire-and-forget: superseded v0.1 sets are cleanup, not readiness,
          // so the snapshot never waits on (or fails with) the pass.
          void maybeRetireSupersededPreparedSets().catch(() => {});
          snapshotState = { status: "ready", errorCode: null };
          announceSnapshotOutcome();
        } catch (error) {
          snapshotState = {
            status: "failed",
            errorCode: typeof error?.code === "string"
              && /^[a-z0-9_]{1,64}$/u.test(error.code)
              ? error.code
              : "snapshot_unavailable",
          };
          announceSnapshotOutcome();
          await shutdownContributionRuntime().catch(() => {});
          throw error;
        }
      })();
    }
    return snapshotPromise;
  };
  // Read routes wait for the first build instead of projecting an empty or
  // half-built snapshot. A build that failed is reported as a failure rather
  // than waited on forever.
  const whenSnapshotSettled = async () => {
    buildSnapshot().catch(() => {});
    await snapshotOutcome;
    return snapshotState;
  };
  const refresh = new LocalCompanionRefreshController({
    runner: refreshRunner,
    dataStore,
    timeoutMs: refreshTimeoutMs,
    // Five hours of refresh_resource_limited loops once left zero local
    // trail: the terminal classification lived only in this controller's
    // in-memory state. Every terminal refresh failure now files one bounded,
    // rate-limited diagnostics note — codes, step, and timestamp only.
    onTerminalFailure: createTerminalRefreshFailureRecorder({
      recordNote: recordDiagnosticNote,
      clock,
    }),
    // A memory-budget miss is now a SOFT outcome (the refresh succeeds serving
    // the retained cache), so the terminal recorder above never files it. This
    // sibling recorder keeps that one bounded, rate-limited diagnostics note —
    // the trail the five-hour incident was found by — for the degraded event.
    onDegradedOutcome: createDeferredAccountingRebuildRecorder({
      recordNote: recordDiagnosticNote,
      clock,
    }),
  });
  // One keep-alive-tuned outbound fetch feeds both the proxy and the relay, so
  // the pre-warmed connection is reused by every central request. Only the real
  // production default fetch is wrapped; an injected fetchImpl passes through
  // untouched.
  const centralOutbound = createCentralOutboundFetch({
    baseFetch: centralFetch,
    centralOrigin,
    enabled: centralFetch === globalThis.fetch,
  });
  const centralProxy = createLocalCentralProxy({
    centralOrigin,
    fetchImpl: centralOutbound.fetch,
  });
  const participantRelay = createParticipantRelay({
    centralOrigin,
    fetchImpl: centralOutbound.fetch,
  });
  const readLocalContributionDiagnostics = async () => {
    let queueValue = null;
    let incrementalValue = null;
    let pairingObserved = false;
    let paired = false;
    try {
      queueValue = await contributionSyncStatusProvider();
    } catch {
      queueValue = null;
    }
    if (incrementalContribution !== null) {
      try {
        incrementalValue = await incrementalContribution.inspect();
      } catch {
        incrementalValue = null;
      }
    }
    if (contributionServiceOrigin !== null) {
      try {
        const capability = await readContributionDeviceCapability({
          backend: contributionDeviceBackendFactory(),
          stateFile: statePaths.contributionDeviceStateFile,
          expectedOrigin: contributionServiceOrigin,
        });
        pairingObserved = true;
        paired = capability !== null;
      } catch {
        pairingObserved = false;
        paired = false;
      }
    } else {
      pairingObserved = true;
    }
    let recentDiagnosticReferences = [];
    try {
      recentDiagnosticReferences = await readRecentDiagnosticReferences({
        file: diagnosticsLogFile,
      });
    } catch {
      recentDiagnosticReferences = [];
    }
    return localContributionDiagnosticsProjection({
      queue: syncStatusProjection(queueValue),
      incremental: incrementalSyncStatusProjection(incrementalValue, {
        configured: incrementalContribution !== null,
        keychainPrompt: keychainPromptSurface(),
      }),
      configured: incrementalContribution !== null,
      pairingObserved,
      paired,
      recentDiagnosticReferences,
    });
  };
  // Keep a small bounded set rather than one mutable slot. A loopback review
  // request that timed out in the page may still finish after a newer retry;
  // it must not invalidate the newer token merely by arriving last.
  const reviewedContributionAuthorizations = new Map();
  const purgeReviewedContributionAuthorizations = (now) => {
    for (const [token, authorization] of reviewedContributionAuthorizations) {
      if (authorization.expiresAt <= now) {
        reviewedContributionAuthorizations.delete(token);
      }
    }
  };
  const consumeReviewedContributionAuthorization = (reviewToken) => {
    const now = clock();
    purgeReviewedContributionAuthorizations(now);
    const authorization = reviewedContributionAuthorizations.get(reviewToken)
      ?? null;
    reviewedContributionAuthorizations.delete(reviewToken);
    return authorization;
  };

  const server = createServer(async (request, response) => {
    try {
      if (!isLoopbackPeer(request)) {
        sendError(response, 403, "loopback_required");
        return;
      }
      if (!allowedHostHeader(server, request.headers.host)) {
        sendError(response, 403, "host_not_allowed");
        return;
      }
      let url;
      try {
        url = new URL(request.url, `http://${request.headers.host}`);
      } catch {
        sendError(response, 400, "invalid_request");
        return;
      }
      const path = url.pathname;
      // Only the window-breakdown route accepts a query string, and only its
      // two bounded integer parameters. Hosted sign-in used to redirect back to
      // a loopback callback on this companion, which was the previous
      // exception; both providers now redirect to the contribution service's
      // own callback and the dashboard collects the result over the relay, so
      // nothing on this origin ever receives a provider's ?code again. Every
      // other route stays query-free by construction.
      const acceptsQueryString = path === "/api/local/timeline/window-breakdown";
      if (url.hash !== "" || (url.search !== "" && !acceptsQueryString)) {
        sendError(response, 400, "invalid_request");
        return;
      }
      if (centralProxy.handles(path)) {
        if (request.method !== "GET" && !sameOrigin(request)) {
          sendError(response, 403, "central_request_not_authorized");
          return;
        }
        try {
          const upstream = await centralProxy.request(request, path);
          send(response, upstream.status, upstream.body, upstream.contentType, {
            headers: upstream.headers,
          });
        } catch (error) {
          const status = error.code === "central_service_not_configured" ? 503
            : error.code === "central_method_not_allowed" ? 405
              : error.code === "central_content_type_invalid" ? 415
                : error.code === "central_request_too_large" ? 413
                  : error.code === "central_request_invalid" ? 400
                    : error.code === "central_route_not_allowed" ? 404
                      : 502;
          sendError(response, status, error.code ?? "central_service_unavailable");
        }
        return;
      }
      if (participantRelay.handles(path)) {
        if (request.method !== "GET" && !sameOrigin(request)) {
          sendError(response, 403, "central_participant_request_not_authorized");
          return;
        }
        try {
          const upstream = await participantRelay.request(request, path);
          send(
            response,
            upstream.status,
            upstream.body,
            "application/json; charset=utf-8",
            { headers: upstream.headers },
          );
        } catch (error) {
          const status =
            error.code === "central_participant_method_not_allowed" ? 405
              : error.code === "central_participant_content_type_invalid" ? 415
                : error.code === "central_participant_request_too_large" ? 413
                  : error.code === "central_participant_request_invalid"
                    || error.code === "central_participant_cookie_invalid"
                    || error.code === "central_participant_csrf_invalid"
                    || error.code === "central_participant_authorization_invalid" ? 400
                    : error.code === "central_participant_route_not_allowed" ? 404
                      : 502;
          sendError(
            response,
            status,
            error.code ?? "central_participant_service_unavailable",
          );
        }
        return;
      }
      if (path.startsWith("/api/") && !API_ROUTES.has(path)) {
        sendError(response, 404, "not_found");
        return;
      }
      // The listening port no longer proves the snapshot exists: it is opened
      // first so the window, its static assets, and readiness answer at once.
      // Every route that reads the snapshot therefore waits for the first build
      // here, and a build that failed is refused rather than answered with an
      // empty projection. Health and the diagnostic note stay outside the gate
      // precisely so a slow or failed build can still be observed.
      if (path.startsWith("/api/") && !SNAPSHOT_INDEPENDENT_API_ROUTES.has(path)) {
        if ((await whenSnapshotSettled()).status !== "ready") {
          sendError(response, 503, "snapshot_unavailable");
          return;
        }
      }

      if (path === "/api/local/health") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        // The dashboard's approve-once surface lights up only when this
        // advertises exactly the v1.0 contract: a configured contribution
        // service origin AND an existing unified index (the upload source).
        const incrementalSyncCapability = incrementalContribution !== null
          && await unifiedIndexPresent()
          ? TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION
          : false;
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          status: "ready",
          // `status` above states that this loopback surface is answering, which
          // it now does from the first millisecond. Whether the evidence
          // snapshot behind the read routes exists yet is a separate fact, and
          // it is stated separately rather than being folded into that word.
          snapshot: {
            status: snapshotState.status,
            errorCode: snapshotState.errorCode,
          },
          mode: "loopback_real_local_evidence",
          remoteUploadEnabled: false,
          capabilities: {
            localDashboard: true,
            explicitRefresh: true,
            contributionPreparation: true,
            contributionPreparationIdentityMode:
              developmentIdentity.mode,
            contributionSyncStatus: true,
            contributionSyncNext: syncPreviewConfigured,
            contributionDevicePairing:
              contributionDevicePairingConfigured,
            contributionDeviceDisconnect:
              contributionDeviceDisconnectConfigured,
            contributionSyncExactReview: syncExactReviewConfigured,
            incrementalContributionSync: incrementalSyncCapability,
            centralServiceProxy: centralProxy.enabled,
            centralParticipantRelay: participantRelay.enabled,
            arbitraryPathAccess: false,
            remoteProxy: false,
          },
        });
        return;
      }
      if (path === "/api/local/diagnostics/contribution") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, await readLocalContributionDiagnostics());
        return;
      }
      if (path === "/api/local/diagnostics/note") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const note = await authorizeDiagnosticNote(request, response);
        if (note === null) return;
        try {
          await recordDiagnosticNote(note);
        } catch {
          sendError(response, 500, "diagnostic_note_not_recorded");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_DIAGNOSTIC_NOTE_SCHEMA_VERSION,
          status: "recorded",
          reference: note.reference,
        });
        return;
      }
      if (path === "/api/local/identity/hosted-signin-handoff") {
        if (request.method === "GET") {
          if (!authorizeHostedSignInHandoffRead(request, response)) return;
          try {
            send(response, 200, await hostedSignInHandoff.inspect());
          } catch {
            sendError(response, 500, "hosted_signin_handoff_unavailable");
          }
          return;
        }
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const mutation = await authorizeHostedSignInHandoffMutation(
          request,
          response,
        );
        if (mutation === null) return;
        try {
          const result = mutation.action === "clear"
            ? await hostedSignInHandoff.clear()
            : await hostedSignInHandoff.store(mutation);
          send(response, 200, result);
        } catch (error) {
          sendError(
            response,
            error instanceof HostedSignInHandoffError
              && error.code === "hosted_signin_handoff_invalid"
              ? 400
              : 500,
            error instanceof HostedSignInHandoffError
              ? error.code
              : "hosted_signin_handoff_unavailable",
          );
        }
        return;
      }
      if (path === "/api/local/onboarding") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        let onboarding = null;
        try {
          onboarding = await onboardingProvider();
        } catch {
          // A failed source inspection is projected as closed, path-free
          // readiness rather than disclosing filesystem diagnostics.
        }
        send(response, 200, projectLocalOnboarding(onboarding));
        return;
      }
      if (path === "/api/local/overview") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, dataStore.getOverview());
        return;
      }
      if (path === "/api/local/gradient") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          gradient: dataStore.getGradient(),
        });
        return;
      }
      if (path === "/api/local/weekly") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          weekly: dataStore.getWeekly(),
        });
        return;
      }
      if (path === "/api/local/quality") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          quality: dataStore.getQuality(),
        });
        return;
      }
      if (path === "/api/local/timeline/window-breakdown") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        // The two bounded integer parameters, and only those. Anything else in
        // the query string is refused rather than ignored, so the one route
        // that reads a query string cannot be turned into a general parameter
        // channel. The window itself is bounded and validated by the reader.
        const allowed = new Set(["from", "to"]);
        for (const key of url.searchParams.keys()) {
          if (!allowed.has(key)) {
            sendError(response, 400, "invalid_request");
            return;
          }
        }
        const fromMs = integerParameter(url.searchParams.get("from"));
        const toMs = integerParameter(url.searchParams.get("to"));
        if (fromMs === null || toMs === null) {
          sendError(response, 400, "invalid_request");
          return;
        }
        let breakdown;
        try {
          breakdown = await windowBreakdownProvider({ fromMs, toMs });
        } catch (error) {
          sendError(
            response,
            error?.code === "window_range_invalid" ? 400 : 500,
            error?.code === "window_range_invalid"
              ? "window_range_invalid"
              : "window_breakdown_unavailable",
          );
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          breakdown,
        });
        return;
      }
      if (path === "/api/local/contribution/prepare") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const preparationRequest = await authorizeContributionPreparation(
          request,
          response,
        );
        if (preparationRequest === null) return;
        // The v0.1 review preparation exists only for the pre-consent
        // ceremony. Once the v1.0 incremental consent is approved and
        // current, a prepared set could never deliver — no scheduler drains
        // the v0.1 queue for that model — so minting one would only strand
        // disk and queue weight (observed live 2026-08-19: a 70-file set
        // pending forever). A consent-version change reads current=false and
        // legitimately prepares a fresh review; an unreadable verdict also
        // proceeds, because refusing would deadlock a fresh Mac's ceremony.
        const consentVerdict = await incrementalConsentVerdict();
        if (consentVerdict?.approved === true
            && consentVerdict?.current === true) {
          send(
            response,
            409,
            preparationErrorProjection(null, "consent_already_current"),
          );
          return;
        }
        if (contributionPreparationInProgress) {
          send(
            response,
            409,
            preparationErrorProjection(null, "preparation_in_progress"),
          );
          return;
        }
        contributionPreparationInProgress = true;
        try {
          const result = preparationResultProjection(
            await runContributionPreparation(preparationRequest),
          );
          if (result === null) {
            send(
              response,
              500,
              preparationErrorProjection(null, "preparation_failed"),
            );
            return;
          }
          send(response, 200, result);
        } catch (error) {
          const projected = preparationErrorProjection(error);
          send(
            response,
            preparationErrorStatus(projected.errorCode),
            projected,
          );
        } finally {
          contributionPreparationInProgress = false;
        }
        return;
      }
      if (path === "/api/local/contribution/incremental-status") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (incrementalContribution === null) {
          send(response, 200, incrementalSyncStatusProjection(null, {
            configured: false,
            keychainPrompt: keychainPromptSurface(),
          }));
          return;
        }
        let status;
        try {
          status = await incrementalContribution.inspect();
        } catch {
          status = null;
        }
        send(response, 200, incrementalSyncStatusProjection(status, {
          configured: true,
          keychainPrompt: keychainPromptSurface(),
        }));
        return;
      }
      if (path === "/api/local/contribution/incremental-approve") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        // Approve-once consent for the v1.0 incremental model. The review
        // token proves one verified real instance of the covered data was on
        // screen (the review-bootstrap requirement carried into the
        // approve-once flow); it is single-use, exactly like sync-once.
        const reviewToken = await authorizeReviewedContributionMutation(
          request,
          response,
          "incremental_consent_not_authorized",
        );
        if (reviewToken === null) return;
        if (incrementalContribution === null) {
          sendError(response, 409, "incremental_sync_not_configured");
          return;
        }
        const authorization = consumeReviewedContributionAuthorization(
          reviewToken,
        );
        if (authorization === null) {
          sendError(response, 409, "review_expired_or_changed");
          return;
        }
        let approved;
        try {
          // The one-step ceremony records local consent BEFORE the hosted
          // pairing mints this Mac's upload credential, so with no binding on
          // disk an attempt scheduled at the approval instant could only die
          // at credential_missing and record a device_unavailable pause
          // mid-ceremony (observed live 2026-08-19 on two fresh Macs). The
          // pairing that follows in the same interaction owns the first pass
          // instead — the device-pair route below resumes and kicks it — and
          // a Mac that already holds a binding keeps the immediate attempt.
          approved = await incrementalContribution.approve({
            awaitingDevicePairing: !await contributionDeviceBindingPresent(),
          });
        } catch {
          sendError(response, 500, "incremental_consent_failed");
          return;
        }
        if (approved?.consent?.approved !== true
            || approved?.consent?.current !== true
            || nullableInstant(approved.consent.consentedAt) === null) {
          sendError(response, 500, "incremental_consent_failed");
          return;
        }
        send(response, 200, {
          schemaVersion: "local-incremental-contribution-consent-v1.0",
          status: "approved",
          contractVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
          consentedAt: nullableInstant(approved.consent.consentedAt),
          includesIdentifiers: false,
          includesCredentials: false,
        });
        // 2026-08-08 (owner-directed immediate first pass): approval must
        // become a running sync pass now, not a pending timer the user cannot
        // see — production showed "waiting for the first pass" indefinitely.
        // The controller's approve() already schedules an immediate attempt;
        // this explicit due-run starts it in this tick while respecting the
        // controller's own serialization and the shared v0.1 sync lock (a
        // concurrent pass fails that run closed and the bounded retry ladder
        // re-runs it). Best-effort by design: the scheduled attempt survives.
        try {
          void incrementalContribution.runDue?.()?.catch?.(() => {});
        } catch {
          // deliberately ignored
        }
        // The freshly current consent also supersedes any v0.1 sets beyond
        // the just-reviewed provenance; converge now instead of waiting for
        // the next launch. Same fire-and-forget contract as the run kick.
        void maybeRetireSupersededPreparedSets().catch(() => {});
        return;
      }
      if (path === "/api/local/contribution/incremental-run") {
        // 2026-08-10 (observed live): during the first 86-day backfill the
        // operator's only lever against an inherited retry backoff was
        // waiting it out — resume() was reachable only through the
        // device-pair route. This is that lever: reset the ladder, schedule
        // now, and start the due pass in this tick. No consent bypass —
        // resume() re-arms nothing without current consent, and the honest
        // projection below reports exactly what it did or refused to do.
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "sync_control_not_authorized",
        )) return;
        if (incrementalContribution === null) {
          sendError(response, 409, "incremental_sync_not_configured");
          return;
        }
        let status;
        try {
          status = await incrementalContribution.resume();
        } catch {
          sendError(response, 500, "sync_control_failed");
          return;
        }
        // Same best-effort immediate pass as the approval and re-pair kicks:
        // the scheduled attempt survives if this tick's run fails closed.
        try {
          void incrementalContribution.runDue?.()?.catch?.(() => {});
        } catch {
          // deliberately ignored
        }
        send(response, 200, incrementalSyncStatusProjection(status, {
          configured: true,
          keychainPrompt: keychainPromptSurface(),
        }));
        return;
      }
      if (path === "/api/local/accounting/fast-mode-preference") {
        if (request.method === "GET") {
          try {
            send(response, 200, await fastModePreference.inspect());
          } catch {
            sendError(response, 500, "fast_mode_preference_unavailable");
          }
          return;
        }
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const selection = await authorizeFastModePreference(request, response);
        if (selection === null) return;
        let updated;
        try {
          updated = await fastModePreference.select(selection.mode);
        } catch (error) {
          sendError(
            response,
            error?.code === "fast_mode_preference_invalid" ? 400 : 500,
            error?.code === "fast_mode_preference_invalid"
              ? "fast_mode_preference_invalid"
              : "fast_mode_preference_unavailable",
          );
          return;
        }
        // The accounting projection is derived from this statement, so the
        // cached snapshot is rebuilt before the response is acknowledged.
        try {
          await dataStore.reload();
        } catch {
          // A stale snapshot is not a reason to lose the stored preference;
          // the next refresh picks it up.
        }
        send(response, 200, updated);
        return;
      }
      if (path === "/api/local/contribution/sync-status") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        let status;
        try {
          status = await contributionSyncStatusProvider();
        } catch {
          status = null;
        }
        send(response, 200, syncStatusProjection(status));
        return;
      }
      if (path === "/api/local/contribution/sync-next") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "sync_preview_not_authorized",
        )) return;
        let preview;
        try {
          preview = await nextContribution();
        } catch {
          preview = null;
        }
        send(response, 200, syncNextProjection(preview, {
          previewConfigured: syncPreviewConfigured,
          deliveryConfigured: false,
        }));
        return;
      }
      if (path === "/api/local/contribution/device-pair") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const pairingCode = await authorizeContributionDevicePairing(
          request,
          response,
        );
        if (pairingCode === null) return;
        if (!contributionDevicePairingConfigured) {
          sendError(
            response,
            409,
            "contribution_device_pairing_not_configured",
          );
          return;
        }
        if (contributionDeviceDisconnectInProgress) {
          sendError(response, 409, "sync_in_progress");
          return;
        }
        try {
          const paired = await pairContributionDevice({ pairingCode });
          const expiresAt = nullableInstant(paired?.expiresAt);
          if (paired?.status !== "paired"
              || paired?.scope !== "upload_registration"
              || expiresAt === null) {
            throw new Error("pairing response invalid");
          }
          // The sync queue auto-pauses when the service reports the device
          // credential invalid (device_unavailable); a successful pairing is
          // the cure, so it resumes here. Best-effort: the pairing itself
          // succeeded, and the sync status surface still reports a paused
          // queue if this resume fails.
          try {
            await setContributionPaused({ paused: false });
          } catch {
            // deliberately ignored
          }
          // The v1.0 incremental sync pauses on the same trigger and is
          // cured by the same pairing, equally best-effort.
          try {
            await incrementalContribution?.resume();
          } catch {
            // deliberately ignored
          }
          // 2026-08-08 (owner-directed): a fresh pairing translates into a
          // prompt sync attempt too — the re-pair path (a v0.1-consent claim
          // being replaced by a v1.0 one) must not leave its first pass
          // waiting on a timer the user cannot see. Same serialization
          // guarantees as the approval kick above.
          try {
            void incrementalContribution?.runDue?.()?.catch?.(() => {});
          } catch {
            // deliberately ignored
          }
          send(response, 200, {
            schemaVersion: "local-contribution-device-pairing-v0.1",
            status: "paired",
            scope: "upload_registration",
            expiresAt,
            includesCredentials: false,
            includesIdentifiers: false,
          });
        } catch (error) {
          const recoveryRequired =
            contributionDeviceRecoveryRequired(error);
          const migrationRequired =
            contributionDeviceKeychainMigrationRequired(error);
          // Three Keychain causes keep their own code because the reset
          // ceremony is the wrong instruction for them. Migration-required
          // means the old item was preserved after the one interactive read
          // was declined. Denied is the one the
          // user acted on directly — Deny (or cancel) in the macOS access
          // dialog the mint's read-back raises — so the dashboard can say
          // which dialog to answer differently. Locked is the one where
          // nothing is broken at all: unlocking restores it, and offering a
          // destructive clear instead would cost a needless re-pair. Every
          // other recovery code still means the reset ceremony.
          const keychainAccessDenied =
            error?.code === "contribution_device_credential_denied";
          const keychainLocked = contributionDeviceKeychainLocked(error);
          let errorCode = "contribution_device_pairing_failed";
          if (migrationRequired) {
            errorCode = "contribution_device_keychain_migration_required";
          } else if (recoveryRequired) {
            errorCode = keychainAccessDenied
              ? "contribution_device_keychain_access_denied"
              : keychainLocked
                ? "contribution_device_keychain_locked"
                : "contribution_device_recovery_required";
          }
          sendError(
            response,
            recoveryRequired || migrationRequired ? 409 : 502,
            errorCode,
          );
        }
        return;
      }
      if (path === "/api/local/contribution/device-disconnect") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeContributionDeviceDisconnect(request, response)) return;
        if (!contributionDeviceDisconnectConfigured) {
          sendError(response, 409, "contribution_device_disconnect_not_configured");
          return;
        }
        if (contributionSyncInProgress || contributionDeviceDisconnectInProgress) {
          sendError(response, 409, "sync_in_progress");
          return;
        }
        contributionDeviceDisconnectInProgress = true;
        let disconnected;
        try {
          disconnected = await disconnectContributionDevice();
        } catch (error) {
          const cleanupPending = error?.code
            === "contribution_device_disconnect_cleanup_pending";
          sendError(
            response,
            cleanupPending ? 409 : 502,
            cleanupPending
              ? "contribution_device_disconnect_cleanup_pending"
              : "contribution_device_disconnect_failed",
          );
          return;
        } finally {
          contributionDeviceDisconnectInProgress = false;
        }
        if (disconnected?.status !== "disconnected"
            || disconnected.deliveryPaused !== true
            || !["deleted", "already_missing"].includes(
              disconnected.localCredential,
            )
            || disconnected.localBinding !== "removed") {
          sendError(response, 500, "contribution_device_disconnect_failed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_CONTRIBUTION_DEVICE_DISCONNECT_VERSION,
          status: "disconnected",
          deliveryPaused: true,
          localCredential: disconnected.localCredential,
          localBinding: "removed",
          includesIdentifiers: false,
          includesCredentials: false,
          hostedDataDeleted: false,
        });
        return;
      }
      if (path === "/api/local/contribution/device-credential-reset") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeContributionDeviceCredentialReset(
          request,
          response,
        )) return;
        if (contributionDeviceDisconnectInProgress) {
          sendError(response, 409, "sync_in_progress");
          return;
        }
        let reset;
        try {
          reset = await resetContributionDeviceCredential();
        } catch {
          sendError(response, 500, "device_credential_reset_failed");
          return;
        }
        if (!["reset", "already_absent"].includes(reset?.status)
            || !["deleted", "already_missing"].includes(reset?.credential)
            || !["removed", "already_missing"].includes(reset?.binding)) {
          sendError(response, 500, "device_credential_reset_failed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_CONTRIBUTION_DEVICE_RESET_VERSION,
          status: reset.status,
          credential: reset.credential,
          binding: reset.binding,
          hostedDataDeleted: false,
          includesIdentifiers: false,
        });
        return;
      }
      if (path === "/api/local/contribution/sync-inspect-exact") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "exact_review_not_authorized",
        )) return;
        let review;
        try {
          review = await reviewExactContribution();
        } catch {
          review = null;
        }
        const binding = review?.reviewBinding;
        // Retry and pause are upload scheduling states. The payload and its
        // binding already passed the same local verification as a ready job,
        // so neither may suppress the local-only review authorization.
        const bindingValid = REVIEWABLE_CONTRIBUTION_QUEUE_STATES.has(
          review?.state,
        )
          && REVIEW_JOB_ID.test(binding?.jobId ?? "")
          && SHA256.test(binding?.contributionSha256 ?? "");
        const reviewToken = bindingValid
          ? randomBytes(32).toString("base64url")
          : null;
        if (bindingValid) {
          const now = clock();
          purgeReviewedContributionAuthorizations(now);
          while (reviewedContributionAuthorizations.size
              >= MAX_ACTIVE_REVIEW_AUTHORIZATIONS) {
            const oldest = reviewedContributionAuthorizations.keys().next().value;
            if (oldest === undefined) break;
            reviewedContributionAuthorizations.delete(oldest);
          }
          reviewedContributionAuthorizations.set(reviewToken, {
            reviewToken,
            reviewedJob: {
              jobId: binding.jobId,
              contributionSha256: binding.contributionSha256,
            },
            expiresAt: now + REVIEW_AUTHORIZATION_LIFETIME_MS,
          });
        }
        send(response, 200, syncExactReviewProjection(review, {
          configured: syncExactReviewConfigured,
          reviewToken,
        }));
        return;
      }
      if (path === "/api/local/refresh") {
        if (request.method === "GET") {
          send(response, 200, {
            schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
            refresh: refresh.getStatus(),
          });
          return;
        }
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "refresh_not_authorized",
        )) return;
        if (!refresh.start()) {
          // Keep the terminal receipt's opaque run identifier available to a
          // first-party native caller that joined an already-running explicit
          // refresh. It contains no account or evidence data and lets the
          // caller reject a later, unrelated terminal receipt.
          send(response, 409, {
            schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
            error: { code: "refresh_in_progress" },
            refresh: refresh.getStatus(),
          });
          return;
        }
        send(response, 202, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          refresh: refresh.getStatus(),
        });
        return;
      }
      if (path === "/api/local/refresh/cancel") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "refresh_cancel_not_authorized",
        )) return;
        if (!refresh.cancel()) {
          sendError(response, 409, "refresh_not_running");
          return;
        }
        send(response, 202, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          refresh: refresh.getStatus(),
        });
        return;
      }

      const report = REPORT_ROUTES[path];
      if (report) {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        try {
          const reportPath = await resolveLocalLegacyReportReadPath(
            resourceRoot,
            report.file,
          );
          const body = await readFixedFile(
            resourceRoot,
            reportPath,
            MAX_REPORT_BYTES,
          );
          send(response, 200, body, report.type, { report: true });
        } catch {
          sendError(response, 404, "not_found");
        }
        return;
      }

      const staticFile = STATIC_FILES[path];
      if (staticFile) {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        try {
          const source = await readFixedFile(
            staticRoot,
            staticFile.file,
            MAX_STATIC_BYTES,
          );
          const body = staticFile.file === "index.html"
            ? stampLocalDashboard(source, semanticOpenTarget)
            : source;
          send(response, 200, body, staticFile.type);
        } catch {
          sendError(response, 404, "not_found");
        }
        return;
      }
      sendError(response, 404, "not_found");
    } catch {
      onError("request_failed");
      if (!response.headersSent) sendError(response, 500, "internal_error");
      else response.destroy();
    }
  });
  // Node's 5-second keep-alive default races CFNetwork's connection pooling:
  // the WKWebView holds loopback sockets far longer, discovers the server's
  // FIN only on the next write, and a click-driven POST written onto the
  // torn-down socket dies with zero response bytes ("Load failed", no
  // request id) — CFNetwork silently retries idempotent GETs but never
  // POSTs, so exactly the user-initiated actions surfaced it. Ninety
  // seconds comfortably outlasts the pool's reuse horizon; headersTimeout
  // must stay above keepAliveTimeout or Node kills sockets mid-headers.
  server.keepAliveTimeout = 90_000;
  server.headersTimeout = 95_000;
  server.once("close", () => {
    void shutdownContributionRuntime().catch(() => {
      onError("automatic_contribution_retirement_lock_release_failed");
    });
  });

  return {
    server,
    dataStore,
    refresh,
    centralOutbound,
    [PARENT_WATCHDOG_PID]: parentWatchdogPid,
    async initialize() {
      await acquireInstanceLock();
      await buildSnapshot();
    },
    acquireInstanceLock,
    buildSnapshot,
    snapshotStatus: () => ({ ...snapshotState }),
    automaticContributionRetirement: () => (
      automaticContributionRetirement === null
        ? null
        : { ...automaticContributionRetirement }
    ),
    shutdownContributionRuntime,
  };
}

export async function startLocalCompanionServer({
  port = 8787,
  host = LOOPBACK_HOST,
  terminateProcessOnParentDeath = false,
  ...options
} = {}) {
  if (host !== LOOPBACK_HOST) throw new TypeError("Local companion must bind to 127.0.0.1");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("port is invalid");
  if (typeof terminateProcessOnParentDeath !== "boolean") {
    throw new TypeError("terminateProcessOnParentDeath must be a boolean");
  }
  const app = createLocalCompanionServer(options);
  const expectedParentPid = app[PARENT_WATCHDOG_PID];
  if (!declaredParentIsCurrent(expectedParentPid)) {
    throw parentWatchdogConfigurationError();
  }
  const parentWatchdog = startParentDeathWatchdog({
    server: app.server,
    expectedParentPid,
    terminateProcess: terminateProcessOnParentDeath,
  });
  try {
    // Single-instance exclusion still decides whether this process may serve at
    // all, so it stays ahead of listen(). The snapshot build does not: it used
    // to hold the port shut for the 3-7 s it takes to read the retained
    // collector state on a real install, and for far longer when a rejected
    // accounting cache forces a full re-price - long enough to exceed the
    // launcher's own startup budget and have the companion killed before it
    // could finish repairing itself.
    await app.acquireInstanceLock();
    if (!declaredParentIsCurrent(expectedParentPid)) {
      throw parentWatchdogConfigurationError();
    }
    await new Promise((resolveListen, rejectListen) => {
      app.server.once("error", rejectListen);
      app.server.listen(port, host, () => {
        app.server.off("error", rejectListen);
        resolveListen();
      });
    });
    if (!declaredParentIsCurrent(expectedParentPid)) {
      throw parentWatchdogConfigurationError();
    }
  } catch (error) {
    parentWatchdog.stop();
    await closeHttpServer(app.server).catch(() => {});
    await app.shutdownContributionRuntime().catch(() => {});
    throw error;
  }
  // Started behind the open port. The read routes await this same promise, and
  // a failure is surfaced through `snapshotReady` rather than being swallowed:
  // it still stops contribution activity and releases the retirement lock.
  const snapshotReady = app.buildSnapshot();
  snapshotReady.catch(() => {});
  // Warm the outbound connection to the contribution service off the hot path
  // with a best-effort pre-warm ping. A no-op unless this process is talking to
  // the real production service with Node's own fetch, and it never blocks
  // readiness.
  void app.centralOutbound?.warmUp().catch(() => {});
  return {
    ...app,
    host,
    port: actualPort(app.server),
    snapshotReady,
    close: async () => {
      parentWatchdog.stop();
      await closeHttpServer(app.server);
      await app.shutdownContributionRuntime();
    },
  };
}

if (process.argv[1]
    && resolve(process.argv[1]) === LOCAL_COMPANION_MODULE_FILE) {
  const requestedPort = Number(process.env.USAGE_MONITOR_PORT ?? 8787);
  const app = await startLocalCompanionServer({
    port: requestedPort,
    terminateProcessOnParentDeath: true,
  });
  process.stdout.write(`USAGE_MONITOR_READY http://${app.host}:${app.port}/\n`);
  let closing = false;
  const close = () => {
    if (closing) process.exit(0);
    closing = true;
    app.server.closeAllConnections?.();
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  // A snapshot that cannot be built leaves nothing for the read routes to
  // project, so the process still exits and the host still sees a failed
  // companion - the same outcome as before the port moved ahead of the build,
  // reported once the port is open rather than in place of opening it.
  app.snapshotReady.catch(() => {
    if (closing) return;
    closing = true;
    app.server.closeAllConnections?.();
    void app.close().then(
      () => process.exit(1),
      () => process.exit(1),
    );
  });
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
