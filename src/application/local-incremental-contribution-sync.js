import {
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  telemetryV1RequiredConsent,
} from "../contribution/telemetry-v1-chunks.js";

// The incremental full-history sync controller: consent-once, then sync
// passes run on a six-hour cadence with bounded
// dither — daily-or-finer by construction) without further user action. A
// pass that leaves work pending reschedules within a minute; an exhausted
// chunk-admission budget backs off to the service's next window; a device
// the service no longer recognises pauses the schedule exactly as the v0.1
// queue pauses, until the device is paired again.
//
// The legacy prepared-set scheduler is retired. Its settings are replaced by
// a content-free downgrade tombstone before this controller can start; this
// v1 consent and schedule are the sole automatic contribution authority.

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
// The pass deadline is a hard watchdog, not merely a cooperative abort: the
// timer resolves this sentinel so the runner can be raced against it and a
// runner that never settles can never pin #running true.
const RUN_DEADLINE_REACHED = Symbol("incremental-contribution-run-deadline");
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
// Additive since 2026-08-10: a thrown runner error is recorded as a bounded
// `detail` on the outcome, so a `run_failed` is never anonymous again. An
// outcome without the key (an older settings file, or a shaped run outcome)
// still parses; an outcome carrying it round-trips.
const OUTCOME_KEYS_WITH_DETAIL = Object.freeze([...OUTCOME_KEYS, "detail"]);
const OUTCOME_DETAIL_KEYS = Object.freeze(["code", "message"]);
const MAXIMUM_OUTCOME_DETAIL_MESSAGE_CHARS = 200;
const OUTCOME_STATUSES = new Set(["succeeded", "partial", "failed", "paused"]);
// Thrown runner errors that mean "another local writer holds the resource
// right now" — the legacy v0.1 pipeline holding the shared sync mutex, or the
// foreground indexer writing the unified index. These are expected local
// coordination, not service pressure: they retry within the pending minute
// and must never escalate the exponential ladder (observed live 2026-08-10:
// one anonymous collision inflated the gap toward an hour).
const COORDINATION_RETRY_CODES = new Set(["sync_in_progress", "index_busy"]);
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

// Bounded, path-free evidence of a thrown runner error: the error's own code
// when it already fits the outcome-code vocabulary, and a truncated message
// with any slash-joined run elided whole so a filesystem path (or anything
// shaped like one) can never persist.
function boundedErrorDetail(error) {
  const code = typeof error?.code === "string" && OUTCOME_CODE.test(error.code)
    ? error.code
    : null;
  const message = (typeof error?.message === "string" ? error.message : "")
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/\S*[/\\]\S*/gu, "[path]")
    .slice(0, MAXIMUM_OUTCOME_DETAIL_MESSAGE_CHARS)
    .trim();
  return Object.freeze({ code, message });
}

function validOutcomeDetail(value) {
  return value === undefined
    || (exactKeys(value, OUTCOME_DETAIL_KEYS)
      && (value.code === null || OUTCOME_CODE.test(value.code))
      && typeof value.message === "string"
      && value.message.length <= MAXIMUM_OUTCOME_DETAIL_MESSAGE_CHARS);
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
        && !((exactKeys(value.lastOutcome, OUTCOME_KEYS)
            || exactKeys(value.lastOutcome, OUTCOME_KEYS_WITH_DETAIL))
          && nullableTimestamp(value.lastOutcome.at) !== null
          && OUTCOME_CODE.test(value.lastOutcome.code ?? "")
          && OUTCOME_STATUSES.has(value.lastOutcome.status)
          && validOutcomeDetail(value.lastOutcome.detail)))
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
  // The backlog clamp fires at most once, on the first start() after load: a
  // later start() call must never defeat a ladder a live process is walking.
  #startupClampConsidered = false;
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
      } else if (this.#consentCurrent()
          && !this.#settings.paused
          && this.#settingsAvailable
          && !this.#startupClampConsidered
          && this.#settings.nextAttemptAt !== null
          && ((this.#settings.progress?.daysPending ?? 0) > 0
            || this.#settings.lastOutcome?.status !== "succeeded")
          && Date.parse(this.#settings.nextAttemptAt)
              - Date.parse(this.#nowIso())
            > PENDING_RETRY_MILLISECONDS) {
        // Startup clamp (2026-08-10, observed live): the exponential ladder
        // protects a live process from hammering a struggling service, but a
        // persisted next-attempt inherited across a restart — often an app
        // update, itself a natural re-probe point — left an 86-day backfill
        // idle for most of an hour after the service had recovered. With
        // backlog evidence (pending days, or a last outcome that is not
        // "succeeded"), a fresh process re-probes within the pending minute
        // and the ladder starts over. Steady state (succeeded, nothing
        // pending) keeps its six-hour schedule untouched.
        this.#settings.retryCount = 0;
        this.#settings.nextAttemptAt = new Date(
          Date.parse(this.#nowIso())
            + PENDING_RETRY_MILLISECONDS
            + this.#dither(MAXIMUM_PENDING_DITHER_MILLISECONDS),
        ).toISOString();
        await this.#persist();
      }
      this.#startupClampConsidered = true;
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
   *
   * `awaitingDevicePairing` carries the one-step ceremony's ordering fact:
   * local consent lands BEFORE the hosted pairing mints this Mac's upload
   * credential, so an attempt scheduled at the approval instant can only die
   * at credential_missing and record the device_unavailable pause mid-ceremony
   * (observed live 2026-08-19 on two fresh Macs). With the flag, the first
   * attempt waits one pending minute: the pairing that follows in the same
   * interaction resumes the schedule immediately (the device-pair cure), and
   * a ceremony that dies before pairing still reaches the honest
   * device_unavailable pause one minute later, so the repair path that keys
   * on that pause never becomes unreachable.
   */
  async approve({ awaitingDevicePairing = false } = {}) {
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
      this.#settings.nextAttemptAt = awaitingDevicePairing === true
        ? new Date(
          Date.parse(this.#nowIso())
            + PENDING_RETRY_MILLISECONDS
            + this.#dither(MAXIMUM_PENDING_DITHER_MILLISECONDS),
        ).toISOString()
        : this.#nowIso();
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
      // The cure erases the pause's own record along with the pause. A
      // lastOutcome with status "paused" is written only by the auto-pause
      // settle, and once re-pairing removes the condition it described, the
      // healed schedule must not keep rendering it as "Last error: …" beside
      // the first cured pass (observed live 2026-08-19: the self-heal window
      // showed "device unavailable" on two fresh Macs). Failed, partial and
      // succeeded outcomes are real pass history and survive resume.
      if (this.#settings.lastOutcome?.status === "paused") {
        this.#settings.lastOutcome = null;
      }
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
    let timeout = null;
    // The pass deadline is a hard watchdog, not merely a cooperative abort. A
    // runner that never settles — a fetch wedged mid-body during a service
    // redeploy, or a hang the abort signal never reaches — must not pin
    // #running true and starve the retry ladder (observed live 2026-08-12: a
    // backfill froze at 56/88 with running:true for nine minutes after a
    // transient service_unavailable, and only a manual kick cleared it). So
    // the runner is raced against the deadline: whichever settles first
    // decides the outcome, and a deadline win abandons the still-pending
    // runner — its abort is already signalled, and its own finally releases
    // the index handle and the shared sync mutex whenever it eventually
    // settles. The next pass then re-plans from the durable watermark.
    const deadlineReached = new Promise((resolve) => {
      timeout = this.#setTimeout(() => {
        timedOut = true;
        abortController.abort();
        resolve(RUN_DEADLINE_REACHED);
      }, this.#runTimeoutMilliseconds);
      timeout?.unref?.();
    });
    // The inner try/catch guarantees this promise settles (never rejects), so
    // an abandoned runner leaves no unhandled rejection behind.
    const runnerSettled = (async () => {
      try {
        return {
          kind: "outcome",
          value: await this.#runner({ signal: abortController.signal }),
        };
      } catch (error) {
        return { kind: "error", value: error };
      }
    })();
    let runOutcome = null;
    let runFailed = false;
    let runError = null;
    const raced = await Promise.race([runnerSettled, deadlineReached]);
    this.#clearTimeout(timeout);
    if (this.#runAbortController === abortController) {
      this.#runAbortController = null;
    }
    if (raced === RUN_DEADLINE_REACHED) {
      // The deadline won: the runner is still pending and is now abandoned.
      // Settle as run_timeout (timedOut is already set by the timer) and let
      // the runner unwind unobserved.
      runFailed = true;
    } else if (raced.kind === "error") {
      runFailed = true;
      runError = raced.value;
    } else {
      runOutcome = raced.value;
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
        detail = null,
      } = {}) => {
        this.#settings.lastOutcome = detail === null
          ? { at: completedAt, code, status }
          : { at: completedAt, code, status, detail };
        this.#settings.paused = pause;
        this.#settings.pausedReason = pause ? pausedReason : null;
        if (resetRetries) this.#settings.retryCount = 0;
        this.#settings.nextAttemptAt = pause || nextDelay === null
          ? null
          : new Date(completedMs + nextDelay).toISOString();
      };
      if (runFailed || !validRunOutcome(runOutcome)) {
        const detail = runError === null ? null : boundedErrorDetail(runError);
        const coordinationCode = !timedOut
          && runError?.retryable === true
          && typeof runError?.code === "string"
          && COORDINATION_RETRY_CODES.has(runError.code)
          ? runError.code
          : null;
        if (coordinationCode !== null) {
          // A known local coordination collision — another writer holds the
          // shared mutex or the unified index for a moment. Retry within the
          // pending minute; the exponential ladder is for service pressure
          // and must stay exactly where it is (neither escalated nor reset).
          settle(
            coordinationCode,
            "failed",
            PENDING_RETRY_MILLISECONDS
              + this.#dither(MAXIMUM_PENDING_DITHER_MILLISECONDS),
            { resetRetries: false, detail },
          );
        } else {
          // The runner itself failed shapelessly. Never spin: pause after the
          // bounded retry ladder tops out, exactly one honest state — and
          // since 2026-08-10 the thrown error's code and bounded message are
          // recorded, so the failure is never anonymous.
          this.#settings.retryCount += 1;
          settle(
            timedOut ? "run_timeout" : "run_failed",
            "failed",
            this.#retryDelayMilliseconds(null),
            { resetRetries: false, detail },
          );
        }
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
        // An outcome with networkActivity === false describes a pass that
        // never ran (the wiring shaping a pre-engine capability failure into
        // the device_unavailable pause). It measured nothing, so its zeroed
        // counts must not overwrite the last honest progress the dashboard
        // shows beside the pause.
        if (runOutcome.networkActivity !== false) {
          this.#settings.progress = {
            daysTotal: runOutcome.daysTotal,
            daysSynced: runOutcome.daysSynced,
            daysPending: runOutcome.daysPending,
            chunksUploaded: (this.#settings.progress?.chunksUploaded ?? 0)
              + runOutcome.chunksUploaded,
            acknowledgedThroughDay: runOutcome.acknowledgedThroughDay ?? null,
          };
        }
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
