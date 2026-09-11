const POLICY = "accountless-opt-out-v1";
const INTERVAL = 4 * 60 * 60 * 1000;
const RETRY = 60 * 1000;
const MAX_PASS = 5 * 60 * 1000;
const MAX_RETRY_AFTER = 7 * 24 * 60 * 60 * 1000;
function untilAborted(operation, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(Object.assign(new Error("Contribution interrupted"), { retryable: true }));
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

export function createAccountlessContributionScheduler({
  origin, readPreference, runner, onStatus = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  intervalMilliseconds = INTERVAL, retryMilliseconds = RETRY,
  maximumPassMilliseconds = MAX_PASS,
} = {}) {
  if (typeof origin !== "string" || typeof readPreference !== "function"
      || typeof runner !== "function" || typeof onStatus !== "function"
      || typeof now !== "function" || typeof setTimer !== "function"
      || typeof clearTimer !== "function"
      || [intervalMilliseconds, retryMilliseconds, maximumPassMilliseconds]
        .some((value) => !Number.isSafeInteger(value) || value < 1 || value > INTERVAL)) {
    throw new TypeError("Invalid accountless scheduler configuration");
  }
  let started = false;
  let stopped = false;
  let timer = null;
  let pending = null;
  let abort = null;
  let generation = 0;
  let failures = 0;
  let rerun = false;
  let status = Object.freeze({ state: "off", lastAcceptedAt: null, nextAttemptAt: null });
  const publish = (state, nextAttemptAt = null, accepted = false) => {
    status = Object.freeze({ state, nextAttemptAt,
      lastAcceptedAt: accepted ? new Date(now()).toISOString() : status.lastAcceptedAt });
    try { onStatus(status); } catch { /* Presentation cannot authorize work. */ }
  };
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = (milliseconds) => {
    if (!started || stopped) return;
    clear();
    timer = setTimer(() => { timer = null; void run(); }, milliseconds);
    timer?.unref?.();
  };
  async function run() {
    if (!started || stopped) return status;
    if (pending !== null) return pending;
    clear();
    const epoch = generation;
    const controller = new AbortController();
    abort = controller;
    const deadline = setTimer(() => controller.abort(), maximumPassMilliseconds);
    deadline?.unref?.();
    pending = Promise.resolve().then(async () => {
      try {
        const preference = await untilAborted(readPreference(), controller.signal);
        if (stopped || epoch !== generation || controller.signal.aborted) return status;
        if (preference?.available !== true || preference.current !== true
            || preference.policyVersion !== POLICY || preference.destinationOrigin !== origin) {
          publish("unavailable");
          schedule(retryMilliseconds);
          return status;
        }
        if (preference.enabled !== true) {
          publish("off");
          // Evaluates the three-notice transition while the desktop is open.
          schedule(retryMilliseconds);
          return status;
        }
        publish("uploading");
        const result = await untilAborted(runner({ signal: controller.signal }), controller.signal);
        if (stopped || epoch !== generation) return status;
        if (!["complete", "partial", "failed"].includes(result?.status)
            || (result.chunksUploaded !== undefined && (!Number.isSafeInteger(result.chunksUploaded)
              || result.chunksUploaded < 0 || result.chunksUploaded > 2000))) {
          throw Object.assign(new Error("Contribution result unavailable"), { retryable: true });
        }
        if (result?.failure?.code === "credential_recovery_required") {
          publish("recovery_required");
          return status;
        }
        if (result?.failure?.deviceUnavailable === true
            || result?.failure?.retryable === false) {
          publish("paused");
          return status;
        }
        if (controller.signal.aborted || result?.status === "failed" || result?.failure) {
          throw Object.assign(new Error("Contribution retry required"), {
            retryable: true, retryAfterMilliseconds: result?.failure?.retryAfterMilliseconds,
          });
        }
        failures = 0;
        const more = result?.status === "partial" || result?.hasMore === true;
        const delay = more ? retryMilliseconds : intervalMilliseconds;
        publish(more ? "pending" : "up_to_date", new Date(now() + delay).toISOString(),
          result?.chunksUploaded > 0);
        schedule(delay);
      } catch (error) {
        if (stopped || epoch !== generation) return status;
        if (error?.retryable === false || /(?:device_unavailable|ownership_rejected|preference_ineligible)$/u.test(error?.code ?? "")) {
          publish("paused");
        } else {
          const requestedDelay = Number.isSafeInteger(error?.retryAfterMilliseconds)
            && error.retryAfterMilliseconds >= 0 && error.retryAfterMilliseconds <= MAX_RETRY_AFTER
            ? error.retryAfterMilliseconds : 0;
          const delay = Math.max(requestedDelay,
            Math.min(intervalMilliseconds, retryMilliseconds * (2 ** Math.min(failures++, 8))));
          publish("retry_wait", new Date(now() + delay).toISOString());
          schedule(delay);
        }
      }
      return status;
    }).finally(() => {
      clearTimer(deadline);
      abort = null;
      pending = null;
      if (rerun && !stopped) { rerun = false; schedule(0); }
    });
    return pending;
  }
  return Object.freeze({
    start() { if (!stopped) { started = true; schedule(0); } return status; },
    runNow: run,
    inspect: () => status,
    preferenceChanged() {
      generation += 1;
      abort?.abort();
      clear();
      failures = 0;
      publish("off");
      if (pending !== null) rerun = true;
      else schedule(0);
    },
    async stop() {
      stopped = true;
      generation += 1;
      clear();
      abort?.abort();
      publish("off");
      await pending;
    },
  });
}
