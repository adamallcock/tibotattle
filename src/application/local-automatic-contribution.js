import {
  AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
  AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS,
  AUTOMATIC_CONTRIBUTION_PRIVACY_CONTRACT_VERSION,
  AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS,
  AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
  AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION,
  AutomaticContributionError,
  automaticContributionRequiredConsent,
  claimAutomaticContributionRun,
  completeAutomaticContributionRun,
  createInitialAutomaticContributionState,
  disableAutomaticContribution,
  enableAutomaticContribution,
  parseAutomaticContributionState,
  projectAutomaticContributionStatus,
  recordPreparedAutomaticContribution,
  recordReviewedManualAcceptance,
} from "../contribution/index.js";
const DEFAULT_RUN_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;
const MAXIMUM_SETTINGS_BYTES = 64 * 1_024;
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
function fail(code) {
  throw new AutomaticContributionError(code);
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function captureStorage(storage) {
  if (storage === null || typeof storage !== "object" || Array.isArray(storage)) {
    throw new TypeError("automatic contribution storage must be an object");
  }
  const captured = {};
  for (const name of ["readSettingsText", "writeSettingsText"]) {
    let value;
    try {
      value = storage[name];
    } catch {
      throw new TypeError("automatic contribution storage is invalid");
    }
    captured[name] = requireFunction(
      value,
      `automatic contribution storage ${name}`,
    );
  }
  return Object.freeze(captured);
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

async function loadSettings(settingsFile, storage) {
  const text = await Reflect.apply(storage.readSettingsText, undefined, [{
    settingsFile,
    maximumBytes: MAXIMUM_SETTINGS_BYTES,
  }]);
  if (text === null) return createInitialAutomaticContributionState();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("settings_unavailable");
  }
  return parseAutomaticContributionState(value);
}

async function persistSettings(settingsFile, value, storage) {
  const settings = parseAutomaticContributionState(value);
  await Reflect.apply(storage.writeSettingsText, undefined, [{
    settingsFile,
    text: `${JSON.stringify(settings)}\n`,
    maximumBytes: MAXIMUM_SETTINGS_BYTES,
  }]);
}

function uploadOutcome(value, expectedPending) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { code: "upload_failed", pause: true, preparedSet: null };
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
    return { code: "upload_failed", pause: true, preparedSet: null };
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
      preparedSet: null,
    };
  }
  const preparedSet = validatedPreparedSetStatus(
    value.preparedSet,
    expectedPending.preparedSetId,
  );
  if (preparedSet === null
      || preparedSet.coveredAt.startAt !== expectedPending.coveredStartAt
      || preparedSet.coveredAt.endAt !== expectedPending.coveredEndAt) {
    return { code: "upload_failed", pause: true, preparedSet: null };
  }
  if (value.status === "paused" || value.queue?.paused === true) {
    return { code: "queue_paused", pause: true, preparedSet: null };
  }
  if (preparedSet.completeAccepted) {
    return {
      code: "accepted",
      pause: false,
      preparedSet,
    };
  }
  if (preparedSet.rejectedJobs > 0 || rejected > 0) {
    return {
      code: "delivery_rejected",
      pause: true,
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
      preparedSet,
    };
  }
  return { code: "upload_failed", pause: true, preparedSet: null };
}

function preparationFailure(error) {
  const code = typeof error?.code === "string"
    ? error.code.replace(/^local_contribution_/u, "")
    : "";
  if (code.endsWith("no_safe_records")) {
    return { code: "no_new_evidence", pause: false, preparedSet: null };
  }
  if (code.endsWith("identity_unavailable")) {
    return { code: "identity_unavailable", pause: true, preparedSet: null };
  }
  if (code.endsWith("privacy_verification_failed")) {
    return { code: "privacy_verification_failed", pause: true, preparedSet: null };
  }
  return { code: "preparation_failed", pause: true, preparedSet: null };
}

function preparedRunnerResult(prepared) {
  const coveredAt = prepared?.coveredAt;
  const preparedSetId = prepared?.prepared?.preparedSetId;
  if (prepared?.status !== "prepared"
      || prepared?.networkActivity !== false
      || !SHA256.test(preparedSetId ?? "")
      || !exactKeys(coveredAt, COVERED_AT_KEYS)
      || nullableTimestamp(coveredAt.startAt) === null
      || nullableTimestamp(coveredAt.endAt) === null
      || Date.parse(coveredAt.startAt) >= Date.parse(coveredAt.endAt)) {
    return null;
  }
  return { preparedSetId, coveredAt: { ...coveredAt } };
}

class AutomaticContributionControllerBase {
  #settingsFile;
  #storage;
  #randomUuid;
  #resolvePath;
  #destinationOrigin;
  #requiredConsent;
  #prepareRunner;
  #uploadRunner;
  #maintenanceRunner;
  #now;
  #setTimeout;
  #clearTimeout;
  #runTimeoutMilliseconds;
  #settings = createInitialAutomaticContributionState();
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
  } = {}, {
    storage,
    randomUuid,
    resolvePath,
  }) {
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
    this.#storage = storage;
    this.#randomUuid = randomUuid;
    this.#resolvePath = resolvePath;
    this.#settingsFile = this.#resolvePath(settingsFile);
    this.#requiredConsent = automaticContributionRequiredConsent({
      destinationOrigin,
    });
    this.#destinationOrigin = this.#requiredConsent.destinationOrigin;
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
    return this.#project().consentCurrent;
  }

  #firstReviewComplete() {
    return this.#project().firstReviewComplete;
  }

  #nextAttemptAt() {
    return this.#project().nextAttemptAt;
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
      await persistSettings(this.#settingsFile, this.#settings, this.#storage);
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
        this.#settings = await loadSettings(this.#settingsFile, this.#storage);
      } catch {
        this.#settings = createInitialAutomaticContributionState();
        this.#settingsAvailable = false;
        this.#settings = completeAutomaticContributionRun(this.#settings, {
          destinationOrigin: this.#destinationOrigin,
          completedAt: this.#nowIso(),
          event: {
            code: "preparation_failed",
            pause: true,
            preparedSet: null,
          },
        });
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
      const enabledSettings = enableAutomaticContribution(this.#settings, {
        destinationOrigin: this.#destinationOrigin,
        intervalHours,
        consent,
        consentedAt: this.#nowIso(),
      });
      this.#generation += 1;
      this.#runAbortController?.abort();
      this.#settings = enabledSettings;
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
      if (this.#destinationOrigin === null || this.#firstReviewComplete()) {
        return this.#project();
      }
      this.#settings = recordReviewedManualAcceptance(this.#settings, {
        destinationOrigin: this.#destinationOrigin,
        status,
        accepted,
        preparedSet,
        acceptedAt: this.#nowIso(),
      });
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
      this.#settings = disableAutomaticContribution(this.#settings);
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
      let policyClaim;
      try {
        policyClaim = claimAutomaticContributionRun(this.#settings, {
          destinationOrigin: this.#destinationOrigin,
          attemptedAt,
          preparationId: this.#randomUuid(),
        });
      } catch (error) {
        if (error?.code !== "automatic_contribution_configuration_invalid") {
          this.#running = false;
          throw error;
        }
        this.#running = false;
        this.#settings = completeAutomaticContributionRun(this.#settings, {
          destinationOrigin: this.#destinationOrigin,
          completedAt: attemptedAt,
          event: {
            code: "preparation_failed",
            pause: true,
            preparedSet: null,
          },
        });
        await this.#persist();
        return null;
      }
      this.#settings = policyClaim.state;
      try {
        await this.#persist();
      } catch (error) {
        this.#running = false;
        throw error;
      }
      return {
        generation,
        attemptedAt,
        ...policyClaim.claim,
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
              const candidate = preparedRunnerResult({
                  status: "prepared",
                  prepared: { preparedSetId },
                  coveredAt,
                  networkActivity: false,
              });
              if (candidate === null) {
                fail("configuration_invalid");
              }
              const remembered = await this.#serialize(async () => {
                if (this.#generation !== claim.generation
                    || !this.#settings.enabled
                    || this.#settings.preparationClaim?.preparationId
                      !== claim.preparationClaim.preparationId) {
                  return false;
                }
                const currentClaim = this.#settings.preparationClaim;
                if (currentClaim?.preparedSetId !== null
                    && currentClaim?.preparedSetId
                      !== candidate.preparedSetId) {
                  return false;
                }
                this.#settings = recordPreparedAutomaticContribution(
                  this.#settings,
                  {
                    destinationOrigin: this.#destinationOrigin,
                    preparedAt: this.#nowIso(),
                    preparationId: claim.preparationClaim.preparationId,
                    preparedSetId: candidate.preparedSetId,
                    coveredAt: candidate.coveredAt,
                  },
                );
                await this.#persist();
                return true;
              });
              if (!remembered) {
                abortController.abort();
                fail("settings_unavailable");
              }
              durablePendingContribution = this.#settings.pendingContribution;
            },
            signal: abortController.signal,
          });
        } catch (error) {
          selectedOutcome = timedOut
            ? { code: "run_timeout", pause: true }
            : preparationFailure(error);
        }
        if (selectedOutcome === undefined) {
          const returned = preparedRunnerResult(prepared);
          if (returned === null
              || durablePendingContribution === null
              || returned.preparedSetId
                !== durablePendingContribution.preparedSetId
              || returned.coveredAt.startAt
                !== durablePendingContribution.coveredStartAt
              || returned.coveredAt.endAt
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
      this.#settings = completeAutomaticContributionRun(this.#settings, {
        destinationOrigin: this.#destinationOrigin,
        completedAt,
        event: {
          code: selectedOutcome.code,
          pause: selectedOutcome.pause,
          preparedSet: selectedOutcome.code === "accepted"
            ? selectedOutcome.preparedSet ?? null
            : null,
        },
      });
      await this.#persist();
      this.#schedule();
      return this.#project();
    });
  }

  #project() {
    return projectAutomaticContributionStatus(this.#settings, {
      destinationOrigin: this.#destinationOrigin,
      settingsAvailable: this.#settingsAvailable,
      running: this.#running,
    });
  }
}

const AUTOMATIC_CONTRIBUTION_LIMITS = Object.freeze({
  intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
  lookbackHours: AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS,
  replayOverlapHours: AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS,
  runTimeoutMilliseconds: DEFAULT_RUN_TIMEOUT_MILLISECONDS,
  maximumSettingsBytes: MAXIMUM_SETTINGS_BYTES,
});

export function createLocalAutomaticContributionContext({
  storage,
  randomUuid,
  resolvePath,
} = {}) {
  const runtime = Object.freeze({
    storage: captureStorage(storage),
    randomUuid: requireFunction(randomUuid, "randomUuid"),
    resolvePath: requireFunction(resolvePath, "resolvePath"),
  });
  const AutomaticContributionController =
    class AutomaticContributionController extends
      AutomaticContributionControllerBase {
      constructor(options = {}) {
        super(options, runtime);
      }
    };
  function createAutomaticContributionController(options = {}) {
    return new AutomaticContributionController(options);
  }
  return Object.freeze({
    AUTOMATIC_CONTRIBUTION_LIMITS,
    AutomaticContributionController,
    createAutomaticContributionController,
  });
}
