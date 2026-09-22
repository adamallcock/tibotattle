import {
  initialTelemetryPerformanceSyncState,
  prepareTelemetryPerformanceDay,
  projectTelemetryPerformanceDay,
  runTelemetryPerformanceSync,
} from "../contribution/index.js";

const DAY_MILLISECONDS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DEFAULT_INTERVAL = 24 * 60 * 60 * 1_000;
const DEFAULT_RETRY = 15 * 60 * 1_000;
const MAX_TIMER = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_BACKFILL_DAYS = 7;
const MAX_BACKFILL_DAYS = 31;

function invalid(message = "invalid_telemetry_performance_scheduler") {
  throw new TypeError(message);
}

function validDay(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === `${value}T00:00:00.000Z`;
}

function validNow(value) {
  return Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
}

function completedDay(nowEpoch) {
  return new Date(nowEpoch - DAY_MILLISECONDS).toISOString().slice(0, 10);
}

function shiftDay(value, offset) {
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return new Date(epoch + offset * DAY_MILLISECONDS).toISOString().slice(0, 10);
}

function validSourceFacts(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Array.isArray(value.rows)
    && TOKEN.test(value.sourceGeneration)
    && DIGEST.test(value.sourceDigest)
    && Number.isSafeInteger(value.sourceRevision) && value.sourceRevision >= 0
    && TOKEN.test(value.parserVersion);
}

/**
 * Compose the local timing reader, closed daily projection, independent
 * performance report preparation, and independent transport state machine.
 * The reader returns only content-free source facts and validated timing rows;
 * it never supplies a path, session identifier, or raw rollout payload.
 */
export function createTelemetryPerformanceDayRunner({
  readRows,
  readState = async () => initialTelemetryPerformanceSyncState(),
  saveState = async () => {},
  readCapabilities,
  createEnvelope,
  send,
  project = projectTelemetryPerformanceDay,
  prepare = prepareTelemetryPerformanceDay,
  sync = runTelemetryPerformanceSync,
  now = () => Date.now(),
  provider = "openai_codex",
} = {}) {
  if (typeof readRows !== "function" || typeof readState !== "function"
      || typeof saveState !== "function" || typeof readCapabilities !== "function"
      || typeof createEnvelope !== "function" || typeof send !== "function"
      || typeof project !== "function" || typeof prepare !== "function"
      || typeof sync !== "function" || typeof now !== "function"
      || typeof provider !== "string") {
    invalid("invalid_telemetry_performance_runner_configuration");
  }

  return async function runTelemetryPerformanceDay({
    day = completedDay(now()),
    nowEpoch = now(),
    globalPaused = false,
    deviceConnected = true,
    resetRetryCount = true,
  } = {}) {
    if (!validDay(day) || !validNow(nowEpoch)) invalid("invalid_telemetry_performance_day");
    const state = await readState();
    let prepared = null;
    const prepareDay = async ({ day: selectedDay }) => {
      if (prepared !== null) return prepared;
      const source = await readRows({ day: selectedDay, nowEpoch });
      if (!validSourceFacts(source)) invalid("invalid_telemetry_performance_source");
      const records = project(source.rows, { day: selectedDay, provider, now: nowEpoch });
      prepared = await prepare({
        records,
        day: selectedDay,
        sourceGeneration: source.sourceGeneration,
        sourceDigest: source.sourceDigest,
        sourceRevision: source.sourceRevision,
        parserVersion: source.parserVersion,
      });
      return prepared;
    };
    return sync({
      day,
      state,
      nowEpoch,
      globalPaused,
      deviceConnected,
      resetRetryCount,
      readCapabilities,
      prepareDay,
      createEnvelope,
      send,
      saveState,
    });
  };
}

/**
 * Start/stop the performance supplement independently from usage sync.  The
 * scheduler has no implicit start from accounting or dashboard reads; the
 * composition root opts in after the device preference/capability is enabled.
 */
export function createTelemetryPerformanceScheduler({
  runner,
  day = null,
  now = () => Date.now(),
  onStatus = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  intervalMilliseconds = DEFAULT_INTERVAL,
  retryMilliseconds = DEFAULT_RETRY,
  backfillDays = DEFAULT_BACKFILL_DAYS,
  includeCurrentDay = false,
} = {}) {
  if (typeof runner !== "function" || typeof now !== "function"
      || typeof onStatus !== "function" || typeof setTimer !== "function"
      || typeof clearTimer !== "function"
      || (day !== null && !validDay(day))
      || [intervalMilliseconds, retryMilliseconds].some((value) =>
        !Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER)
      || !Number.isSafeInteger(backfillDays) || backfillDays < 1
      || backfillDays > MAX_BACKFILL_DAYS
      || typeof includeCurrentDay !== "boolean") {
    invalid("invalid_telemetry_performance_scheduler_configuration");
  }
  let started = false;
  let stopped = false;
  let timer = null;
  let pending = null;
  let generation = 0;
  let rerun = false;
  let status = Object.freeze({ state: "off", lastAcceptedAt: null, nextAttemptAt: null });
  const publish = (state, nextAttemptAt = null, accepted = false) => {
    status = Object.freeze({
      state,
      nextAttemptAt,
      lastAcceptedAt: accepted ? new Date(now()).toISOString() : status.lastAcceptedAt,
    });
    try { onStatus(status); } catch { /* status consumers cannot authorize work */ }
  };
  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const schedule = (delay) => {
    if (!started || stopped) return;
    clear();
    timer = setTimer(() => {
      timer = null;
      void run();
    }, delay);
    timer?.unref?.();
  };
  async function run() {
    if (!started || stopped) return status;
    if (pending !== null) return pending;
    clear();
    const epoch = generation;
    pending = Promise.resolve().then(async () => {
      try {
        const nowEpoch = now();
        if (!validNow(nowEpoch)) invalid("invalid_telemetry_performance_clock");
        // Revisit a bounded completed-day window on every pass. Local timing
        // evidence can arrive late or become ineligible after replay, and an
        // empty replacement must supersede an older uploaded day. A fixed day
        // remains a useful deterministic/test mode and performs one attempt.
        const days = day === null
          ? [
            ...(includeCurrentDay ? [new Date(nowEpoch).toISOString().slice(0, 10)] : []),
            ...Array.from({ length: backfillDays }, (_, index) => shiftDay(completedDay(nowEpoch), -index)),
          ]
          : [day];
        let result = null;
        for (const [index, selectedDay] of days.entries()) {
          if (stopped) break;
          // Successful prefixes must not reset the backoff for an older day
          // that repeatedly fails. Persist the count until the whole pass wins.
          result = await runner({ day: selectedDay, nowEpoch, resetRetryCount: index === days.length - 1 });
          if (epoch !== generation) return status;
          if (result?.status !== "succeeded") break;
        }
        result ??= { status: "paused" };
        if (stopped) return status;
        if (result?.status === "succeeded") {
          publish("up_to_date", new Date(now() + intervalMilliseconds).toISOString(), true);
          schedule(intervalMilliseconds);
        } else if (result?.status === "retry") {
          const retryAt = Date.parse(result.state?.nextAttemptAt ?? "");
          const delay = Number.isFinite(retryAt) ? Math.min(MAX_TIMER, Math.max(retryMilliseconds, retryAt - now())) : retryMilliseconds;
          publish("retry_wait", new Date(now() + delay).toISOString());
          schedule(delay);
        } else {
          publish("paused");
        }
      } catch {
        if (!stopped) {
          publish("retry_wait", new Date(now() + retryMilliseconds).toISOString());
          schedule(retryMilliseconds);
        }
      }
      return status;
    }).finally(() => {
      pending = null;
      if (rerun && !stopped) {
        rerun = false;
        schedule(0);
      }
    });
    return pending;
  }
  return Object.freeze({
    start() {
      if (!stopped) {
        started = true;
        schedule(0);
      }
      return status;
    },
    runNow: run,
    inspect: () => status,
    preferenceChanged() {
      generation += 1;
      clear();
      if (pending !== null) rerun = true;
      else if (started && !stopped) schedule(0);
    },
    async stop() {
      stopped = true;
      clear();
      publish("off");
      await pending;
    },
  });
}
