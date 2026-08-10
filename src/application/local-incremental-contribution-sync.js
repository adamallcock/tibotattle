import {
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  telemetryV1RequiredConsent,
} from "../contribution/telemetry-v1-chunks.js";

// The incremental full-history sync controller: consent-once, then sync
// passes run on the automatic-contribution cadence (6 hours with bounded
// dither — daily-or-finer by construction) without further user action. A
// pass that leaves work pending reschedules within a minute; an exhausted
// chunk-admission budget backs off to the service's next window; a device
// the service no longer recognises pauses the schedule exactly as the v0.1
// queue pauses, until the device is paired again.
//
// This is additive beside the v0.1 prepared-set scheduler, not a change to
// it: the v0.1 consent record, settings schema and recurrence policy are
// untouched, and the two consents are independent by design.

export const INCREMENTAL_CONTRIBUTION_SETTINGS_SCHEMA_VERSION =
  "incremental-contribution-sync-settings-v1.0";
export const INCREMENTAL_CONTRIBUTION_STATUS_SCHEMA_VERSION =
  "incremental-contribution-sync-status-v1.0";
export const INCREMENTAL_CONTRIBUTION_INTERVAL_HOURS = 6;

const INTERVAL_MILLISECONDS =
  INCREMENTAL_CONTRIBUTION_INTERVAL_HOURS * 60 * 60 * 1_000;
const PENDING_RETRY_MILLISECONDS = 60_000;
const MAXIMUM_SCHEDULE_DITHER_MILLISECONDS = 60 * 60 * 1_000;
const MAXIMUM_PENDING_DITHER_MILLISECONDS = 30_000;
const MAXIMUM_ADMISSION_DITHER_MILLISECONDS = 5 * 60_000;
const DEFAULT_RUN_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;
const MAXIMUM_SETTINGS_BYTES = 16 * 1_024;
const MAXIMUM_RETRY_AFTER_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
// The v0.1 queue's retry idiom, kept value-for-value: exponential from five
// seconds, capped at an hour, jittered, with any service Retry-After floor
// honored and dithered rather than truncated.
const RETRY_BACKOFF_POLICY = Object.freeze({
  initialDelayMilliseconds: 5_000,
  maximumDelayMilliseconds: 3_600_000,
  minimumDelayMilliseconds: 1_000,
  jitterMinimumMultiplier: 0.75,
  jitterMaximumMultiplier: 1.25,
});
const MAXIMUM_SERVER_RETRY_DITHER_MILLISECONDS = 60_000;

const SETTINGS_KEYS = Object.freeze([
  "consent", "lastAttemptAt", "lastOutcome", "nextAttemptAt", "paused",
  "pausedReason", "progress", "retryCount", "schemaVersion",
]);
const CONSENT_KEYS = Object.freeze([
  "consentedAt", "destinationOrigin", "fieldDictionaryVersion",
  "privacyContractVersion", "telemetrySchemaVersion",
]);
const PROGRESS_KEYS = Object.freeze([
  "acknowledgedThroughDay", "chunksUploaded", "daysPending", "daysSynced",
  "daysTotal",
]);
const OUTCOME_KEYS = Object.freeze(["at", "code", "status"]);
const OUTCOME_STATUSES = new Set(["succeeded", "partial", "failed", "paused"]);
const PAUSED_REASONS = new Set([
  "device_unavailable",
  "consent_rejected",
  "authorization_rejected",
  "upload_rejected",
  "response_invalid",
  "settings_unavailable",
]);
const OUTCOME_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const ERROR_CODES = new Set([
  "configuration_invalid",
  "settings_unavailable",
  "not_configured",
  "consent_unavailable",
]);

export class IncrementalContributionSyncError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown incremental contribution sync error code");
    }
    super("Incremental contribution sync failed closed");
    this.name = "IncrementalContributionSyncError";
    this.code = `incremental_contribution_${code}`;
  }
}

function fail(code) {
  throw new IncrementalContributionSyncError(code);
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
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
  if (!production && !loopbackDevelopment) fail("configuration_invalid");
  return parsed.origin;
}

export function incrementalContributionRequiredConsent({
  destinationOrigin = null,
} = {}) {
  const required = telemetryV1RequiredConsent();
  return Object.freeze({
    ...required,
    destinationOrigin: normalizedDestinationOrigin(destinationOrigin),
  });
}

function initialSettings() {
  return {
    schemaVersion: INCREMENTAL_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
    consent: null,
    paused: false,
    pausedReason: null,
    retryCount: 0,
    lastAttemptAt: null,
    lastOutcome: null,
    nextAttemptAt: null,
    progress: null,
  };
}

function validProgress(value) {
  return value === null
    || (exactKeys(value, PROGRESS_KEYS)
      && [value.daysTotal, value.daysSynced, value.daysPending,
        value.chunksUploaded]
        .every((count) => Number.isSafeInteger(count) && count >= 0)
      && (value.acknowledgedThroughDay === null
        || (typeof value.acknowledgedThroughDay === "string"
          && DAY_PATTERN.test(value.acknowledgedThroughDay))));
}

function parseSettings(value) {
  if (!exactKeys(value, SETTINGS_KEYS)
      || value.schemaVersion !== INCREMENTAL_CONTRIBUTION_SETTINGS_SCHEMA_VERSION
      || typeof value.paused !== "boolean"
      || (value.pausedReason !== null
        && !PAUSED_REASONS.has(value.pausedReason))
      || !Number.isSafeInteger(value.retryCount)
      || value.retryCount < 0
      || value.retryCount > 1_000
      || (value.lastAttemptAt !== null
        && nullableTimestamp(value.lastAttemptAt) === null)
      || (value.nextAttemptAt !== null
        && nullableTimestamp(value.nextAttemptAt) === null)
      || (value.consent !== null
        && !(exactKeys(value.consent, CONSENT_KEYS)
          && nullableTimestamp(value.consent.consentedAt) !== null
          && [value.consent.destinationOrigin,
            value.consent.telemetrySchemaVersion,
            value.consent.fieldDictionaryVersion,
            value.consent.privacyContractVersion]
            .every((entry) => typeof entry === "string" && entry.length > 0
              && entry.length <= 2_048)))
      || (value.lastOutcome !== null
        && !(exactKeys(value.lastOutcome, OUTCOME_KEYS)
          && nullableTimestamp(value.lastOutcome.at) !== null
          && OUTCOME_CODE.test(value.lastOutcome.code ?? "")
          && OUTCOME_STATUSES.has(value.lastOutcome.status)))
      || !validProgress(value.progress)) {
    fail("settings_unavailable");
  }
  return structuredClone(value);
}

function sameRequiredConsent(consent, required) {
  return consent !== null
    && consent.telemetrySchemaVersion === required.telemetrySchemaVersion
    && consent.fieldDictionaryVersion === required.fieldDictionaryVersion
    && consent.privacyContractVersion === required.privacyContractVersion
    && consent.destinationOrigin === required.destinationOrigin;
}

function validRunOutcome(value) {
  return value !== null
    && typeof value === "object"
    && value.schemaVersion === "incremental-contribution-sync-run-v1.0"
    && ["complete", "partial", "failed"].includes(value.status)
    && [value.daysTotal, value.daysSynced, value.daysPending,
      value.chunksUploaded]
      .every((count) => Number.isSafeInteger(count) && count >= 0)
    && (value.failure === null
      || (value.failure && typeof value.failure === "object"
        && OUTCOME_CODE.test(value.failure.code ?? "")));
}

class IncrementalContributionSyncController {
  #settingsFile;
  #storage;
  #destinationOrigin;
  #requiredConsent;
  #runner;
  #now;
  #ditherRandom;
  #setTimeout;
  #clearTimeout;
  #runTimeoutMilliseconds;
  #settings = initialSettings();
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
    runner,
    now = () => new Date(),
    ditherRandom = Math.random,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    runTimeoutMilliseconds = DEFAULT_RUN_TIMEOUT_MILLISECONDS,
  } = {}, { storage }) {
    if (typeof settingsFile !== "string"
        || settingsFile.length < 1
        || typeof runner !== "function"
        || typeof now !== "function"
        || typeof ditherRandom !== "function"
        || typeof setTimeoutImpl !== "function"
        || typeof clearTimeoutImpl !== "function"
        || !Number.isSafeInteger(runTimeoutMilliseconds)
        || runTimeoutMilliseconds < 1_000
        || runTimeoutMilliseconds > 30 * 60 * 1_000) {
      fail("configuration_invalid");
    }
    this.#settingsFile = settingsFile;
    this.#storage = storage;
    this.#requiredConsent = incrementalContributionRequiredConsent({
      destinationOrigin,
    });
    this.#destinationOrigin = this.#requiredConsent.destinationOrigin;
    this.#runner = runner;
    this.#now = now;
    this.#ditherRandom = ditherRandom;
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
    const value = this.#now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) fail("configuration_invalid");
    return date.toISOString();
  }

  #dither(maximum) {
    const random = Number(this.#ditherRandom());
    const bounded = Number.isFinite(random)
      ? Math.min(1, Math.max(0, random))
      : 0;
    return Math.round(bounded * maximum);
  }

  #consentCurrent() {
    return this.#destinationOrigin !== null
      && sameRequiredConsent(this.#settings.consent, this.#requiredConsent);
  }

  #retryDelayMilliseconds(retryAfterMilliseconds) {
    const attemptCount = this.#settings.retryCount;
    const base = Math.min(
      RETRY_BACKOFF_POLICY.maximumDelayMilliseconds,
      RETRY_BACKOFF_POLICY.initialDelayMilliseconds
        * (2 ** Math.max(0, attemptCount - 1)),
    );
    const random = Number(this.#ditherRandom());
    const boundedRandom = Number.isFinite(random)
      ? Math.min(1, Math.max(0, random))
      : 0;
    const jitter = RETRY_BACKOFF_POLICY.jitterMinimumMultiplier
      + (boundedRandom * (
        RETRY_BACKOFF_POLICY.jitterMaximumMultiplier
        - RETRY_BACKOFF_POLICY.jitterMinimumMultiplier
      ));
    const localDelay = Math.max(
      RETRY_BACKOFF_POLICY.minimumDelayMilliseconds,
      Math.round(base * jitter),
    );
    if (!Number.isSafeInteger(retryAfterMilliseconds)
        || retryAfterMilliseconds <= 0) {
      return localDelay;
    }
    const floor = Math.min(
      retryAfterMilliseconds,
      MAXIMUM_RETRY_AFTER_MILLISECONDS,
    );
    const serverDither = Math.round(
      Math.min(
        MAXIMUM_SERVER_RETRY_DITHER_MILLISECONDS,
        floor * 0.25,
      ) * boundedRandom,
    );
    return Math.max(localDelay, floor + serverDither);
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
        || !this.#consentCurrent()
        || this.#settings.paused
        || this.#running
        || this.#settings.nextAttemptAt === null) {
      return;
    }
    const delay = Math.max(
      0,
      Date.parse(this.#settings.nextAttemptAt) - Date.parse(this.#nowIso()),
    );
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.runDue().catch(() => {});
    }, delay);
    this.#timer?.unref?.();
  }

  async #persist() {
    const text = `${JSON.stringify(parseSettings(this.#settings))}\n`;
    try {
      await Reflect.apply(this.#storage.writeSettingsText, undefined, [{
        settingsFile: this.#settingsFile,
        text,
        maximumBytes: MAXIMUM_SETTINGS_BYTES,
      }]);
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
        const text = await Reflect.apply(
          this.#storage.readSettingsText,
          undefined,
          [{
            settingsFile: this.#settingsFile,
            maximumBytes: MAXIMUM_SETTINGS_BYTES,
          }],
        );
        this.#settings = text === null
          ? initialSettings()
          : parseSettings(JSON.parse(text));
      } catch {
        this.#settings = initialSettings();
        this.#settingsAvailable = false;
      }
      this.#initialized = true;
      return this.#project();
    });
  }

  async start() {
    await this.initialize();
    return this.#serialize(async () => {
      this.#started = true;
      // Consent that survives from an earlier run resumes the cadence
      // without user action; a fresh attempt is due within one dithered
      // interval of process start.
      if (this.#consentCurrent()
          && !this.#settings.paused
          && this.#settings.nextAttemptAt === null
          && this.#settingsAvailable) {
        this.#settings.nextAttemptAt = new Date(
          Date.parse(this.#nowIso())
            + this.#dither(MAXIMUM_PENDING_DITHER_MILLISECONDS),
        ).toISOString();
        await this.#persist();
      }
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

  /**
   * The consent-once approval. Records the required v1.0 identifiers with
   * the moment of approval and starts the schedule immediately: after this,
   * sync passes run on cadence without any further user action, and only
   * identifier drift or a destination change re-prompts.
   */
  async approve() {
    if (!this.#initialized) await this.initialize();
    return this.#serialize(async () => {
      if (this.#destinationOrigin === null) fail("not_configured");
      if (!this.#settingsAvailable) fail("settings_unavailable");
      this.#settings.consent = {
        consentedAt: this.#nowIso(),
        destinationOrigin: this.#requiredConsent.destinationOrigin,
        telemetrySchemaVersion: this.#requiredConsent.telemetrySchemaVersion,
        fieldDictionaryVersion: this.#requiredConsent.fieldDictionaryVersion,
        privacyContractVersion: this.#requiredConsent.privacyContractVersion,
      };
      this.#settings.paused = false;
      this.#settings.pausedReason = null;
      this.#settings.retryCount = 0;
      this.#settings.nextAttemptAt = this.#nowIso();
      await this.#persist();
      this.#schedule();
      return this.#project();
    });
  }

  /**
   * Clear an auto-pause. Wired to the same cure as the v0.1 queue: a
   * successful device pairing resumes delivery.
   *
   * 2026-08-08 (owner-directed immediate first pass): a successful pairing is
   * not only the cure for an auto-pause — it is fresh upload authority. A
   * controller that is mid retry-backoff rather than paused (for example
   * after the service refused uploads for a pairing that carried the v0.1
   * consent) would otherwise sit out the remainder of a ladder it has
   * already lost, and the user would read "waiting" for up to an hour after
   * the repair. Re-pairing now also pulls the next attempt to the present;
   * the schedule gate still requires current consent before anything runs.
   */
  async resume() {
    if (!this.#initialized) await this.initialize();
    return this.#serialize(async () => {
      if (!this.#settingsAvailable) fail("settings_unavailable");
      if (!this.#settings.paused) {
        if (this.#consentCurrent() && this.#settings.nextAttemptAt !== null) {
          this.#settings.retryCount = 0;
          this.#settings.nextAttemptAt = this.#nowIso();
          await this.#persist();
          this.#schedule();
        }
        return this.#project();
      }
      this.#settings.paused = false;
      this.#settings.pausedReason = null;
      this.#settings.retryCount = 0;
      this.#settings.nextAttemptAt = this.#nowIso();
      await this.#persist();
      this.#schedule();
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
          || !this.#consentCurrent()
          || this.#settings.paused
          || this.#settings.nextAttemptAt === null
          || Date.parse(this.#settings.nextAttemptAt)
            > Date.parse(this.#nowIso())) {
        this.#schedule();
        return null;
      }
      this.#running = true;
      this.#clearScheduledTimer();
      this.#settings.lastAttemptAt = this.#nowIso();
      try {
        await this.#persist();
      } catch (error) {
        this.#running = false;
        throw error;
      }
      return { generation: this.#generation };
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
    let runOutcome = null;
    let runFailed = false;
    try {
      runOutcome = await this.#runner({ signal: abortController.signal });
    } catch {
      runFailed = true;
    } finally {
      this.#clearTimeout(timeout);
      if (this.#runAbortController === abortController) {
        this.#runAbortController = null;
      }
    }

    return this.#serialize(async () => {
      this.#running = false;
      if (this.#generation !== claim.generation) {
        this.#schedule();
        return this.#project();
      }
      const completedAt = this.#nowIso();
      const completedMs = Date.parse(completedAt);
      const settle = (code, status, nextDelay, {
        pause = false,
        pausedReason = null,
        resetRetries = true,
      } = {}) => {
        this.#settings.lastOutcome = { at: completedAt, code, status };
        this.#settings.paused = pause;
        this.#settings.pausedReason = pause ? pausedReason : null;
        if (resetRetries) this.#settings.retryCount = 0;
        this.#settings.nextAttemptAt = pause || nextDelay === null
          ? null
          : new Date(completedMs + nextDelay).toISOString();
      };
      if (runFailed || !validRunOutcome(runOutcome)) {
        // The runner itself failed shapelessly. Never spin: pause after the
        // bounded retry ladder tops out, exactly one honest state.
        this.#settings.retryCount += 1;
        settle(
          timedOut ? "run_timeout" : "run_failed",
          "failed",
          this.#retryDelayMilliseconds(null),
          { resetRetries: false },
        );
      } else if (runOutcome.failure !== null) {
        const failure = runOutcome.failure;
        if (failure.deviceUnavailable === true) {
          settle("device_unavailable", "paused", null, {
            pause: true,
            pausedReason: "device_unavailable",
          });
        } else if (failure.code === "consent_rejected") {
          settle("consent_rejected", "paused", null, {
            pause: true,
            pausedReason: "consent_rejected",
          });
        } else if (failure.code === "admission_exhausted") {
          // The service's daily chunk budget is spent: resume at the next
          // admission window, dithered, never before the advertised floor.
          const floor = Number.isSafeInteger(failure.retryAfterMilliseconds)
            && failure.retryAfterMilliseconds > 0
            ? Math.min(
              failure.retryAfterMilliseconds,
              MAXIMUM_RETRY_AFTER_MILLISECONDS,
            )
            : DAY_MILLISECONDS_UNTIL_NEXT_UTC_MIDNIGHT(completedMs);
          settle(
            "admission_exhausted",
            "partial",
            floor + this.#dither(MAXIMUM_ADMISSION_DITHER_MILLISECONDS),
          );
        } else if (failure.retryable === true) {
          this.#settings.retryCount += 1;
          settle(
            failure.code,
            "failed",
            this.#retryDelayMilliseconds(failure.retryAfterMilliseconds),
            { resetRetries: false },
          );
        } else {
          settle(failure.code, "paused", null, {
            pause: true,
            pausedReason: PAUSED_REASONS.has(failure.code)
              ? failure.code
              : "response_invalid",
          });
        }
        this.#settings.progress = {
          daysTotal: runOutcome.daysTotal,
          daysSynced: runOutcome.daysSynced,
          daysPending: runOutcome.daysPending,
          chunksUploaded: (this.#settings.progress?.chunksUploaded ?? 0)
            + runOutcome.chunksUploaded,
          acknowledgedThroughDay: runOutcome.acknowledgedThroughDay ?? null,
        };
      } else {
        this.#settings.progress = {
          daysTotal: runOutcome.daysTotal,
          daysSynced: runOutcome.daysSynced,
          daysPending: runOutcome.daysPending,
          chunksUploaded: (this.#settings.progress?.chunksUploaded ?? 0)
            + runOutcome.chunksUploaded,
          acknowledgedThroughDay: runOutcome.acknowledgedThroughDay ?? null,
        };
        if (runOutcome.status === "partial") {
          // Bounded pass with work left: continue shortly, not next cycle —
          // this is what turns an hours-long first sync into steady progress
          // with no user action.
          settle(
            "partial_progress",
            "partial",
            PENDING_RETRY_MILLISECONDS
              + this.#dither(MAXIMUM_PENDING_DITHER_MILLISECONDS),
          );
        } else {
          settle(
            "synced",
            "succeeded",
            INTERVAL_MILLISECONDS
              + this.#dither(MAXIMUM_SCHEDULE_DITHER_MILLISECONDS),
          );
        }
      }
      await this.#persist();
      this.#schedule();
      return this.#project();
    });
  }

  #project() {
    const consent = this.#settings.consent;
    return Object.freeze({
      schemaVersion: INCREMENTAL_CONTRIBUTION_STATUS_SCHEMA_VERSION,
      contractVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
      configured: this.#destinationOrigin !== null,
      settingsAvailable: this.#settingsAvailable,
      consent: Object.freeze({
        approved: consent !== null,
        current: this.#consentCurrent(),
        consentedAt: consent?.consentedAt ?? null,
      }),
      paused: this.#settings.paused,
      pausedReason: this.#settings.pausedReason,
      running: this.#running,
      progress: this.#settings.progress === null
        ? null
        : Object.freeze({ ...this.#settings.progress }),
      lastAttemptAt: this.#settings.lastAttemptAt,
      nextAttemptAt: this.#settings.nextAttemptAt,
      lastOutcome: this.#settings.lastOutcome === null
        ? null
        : Object.freeze({ ...this.#settings.lastOutcome }),
    });
  }
}

function DAY_MILLISECONDS_UNTIL_NEXT_UTC_MIDNIGHT(nowMilliseconds) {
  const next = new Date(nowMilliseconds);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1_000, next.getTime() - nowMilliseconds);
}

function captureStorage(storage) {
  if (storage === null || typeof storage !== "object" || Array.isArray(storage)) {
    throw new TypeError("incremental contribution storage must be an object");
  }
  const captured = {};
  for (const name of ["readSettingsText", "writeSettingsText"]) {
    let value;
    try {
      value = storage[name];
    } catch {
      throw new TypeError("incremental contribution storage is invalid");
    }
    captured[name] = requireFunction(
      value,
      `incremental contribution storage ${name}`,
    );
  }
  return Object.freeze(captured);
}

export function createLocalIncrementalContributionSyncContext({
  storage,
} = {}) {
  const runtime = Object.freeze({ storage: captureStorage(storage) });
  function createIncrementalContributionSyncController(options = {}) {
    return new IncrementalContributionSyncController(options, runtime);
  }
  return Object.freeze({
    INCREMENTAL_CONTRIBUTION_INTERVAL_HOURS,
    INCREMENTAL_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
    INCREMENTAL_CONTRIBUTION_STATUS_SCHEMA_VERSION,
    createIncrementalContributionSyncController,
  });
}
