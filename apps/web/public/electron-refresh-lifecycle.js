export const ELECTRON_REFRESH_HEARTBEAT_INTERVAL_MS = 30_000;
export const ELECTRON_REFRESH_SIGNAL_TIMEOUT_MS = 1_000;

const REFRESH_MODES = new Set(["quick", "detailed"]);

function validLease(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Coordinate one renderer-owned refresh with Electron main. The local
 * companion still owns the operation itself; this bounded lease only prevents
 * the shell cadence from overlapping it and keeps that reservation recoverable.
 */
export function createElectronRefreshLease({
  bridge,
  mode,
  onState = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
  heartbeatIntervalMs = ELECTRON_REFRESH_HEARTBEAT_INTERVAL_MS,
  signalTimeoutMs = ELECTRON_REFRESH_SIGNAL_TIMEOUT_MS,
} = {}) {
  if (!REFRESH_MODES.has(mode)
      || typeof onState !== "function"
      || typeof schedule !== "function"
      || typeof cancel !== "function"
      || !Number.isSafeInteger(heartbeatIntervalMs)
      || heartbeatIntervalMs <= 0
      || !Number.isSafeInteger(signalTimeoutMs)
      || signalTimeoutMs <= 0) {
    throw new TypeError("Electron refresh lease options are invalid");
  }

  let state = "idle";
  let reason = null;
  let lease = null;
  let heartbeatTimer = null;
  let startPromise = null;
  let settlePromise = null;
  let finishRequested = false;

  const snapshot = () => Object.freeze({
    state,
    mode,
    leaseActive: validLease(lease) && state !== "settled",
    reason,
  });

  const publish = (nextState, nextReason = null) => {
    state = nextState;
    reason = nextReason;
    try {
      onState(snapshot());
    } catch {
      // Presentation cannot affect lease safety.
    }
  };

  const clearHeartbeat = () => {
    if (heartbeatTimer === null) return;
    cancel(heartbeatTimer);
    heartbeatTimer = null;
  };

  function invokeWithDeadline(method, args, onLateResolved = () => {}) {
    if (typeof bridge?.[method] !== "function") {
      return Promise.resolve(Object.freeze({ outcome: "unavailable", value: null }));
    }
    let operation;
    try {
      operation = Promise.resolve(bridge[method](...args));
    } catch {
      return Promise.resolve(Object.freeze({ outcome: "rejected", value: null }));
    }
    return new Promise((resolve) => {
      let complete = false;
      let timedOut = false;
      const timer = schedule(() => {
        complete = true;
        timedOut = true;
        resolve(Object.freeze({ outcome: "timeout", value: null }));
      }, signalTimeoutMs);
      operation.then((value) => {
        if (complete) {
          if (timedOut) {
            try {
              onLateResolved(value);
            } catch {
              // Late cleanup stays isolated from the local refresh.
            }
          }
          return;
        }
        complete = true;
        cancel(timer);
        resolve(Object.freeze({ outcome: "resolved", value }));
      }, () => {
        if (complete) return;
        complete = true;
        cancel(timer);
        resolve(Object.freeze({ outcome: "rejected", value: null }));
      });
    });
  }

  const settleLease = () => {
    if (!validLease(lease)) return Promise.resolve(false);
    if (settlePromise !== null) return settlePromise;
    clearHeartbeat();
    const selectedLease = lease;
    const acceptLateSettlement = (value) => {
      if (value === true && lease === selectedLease) publish("settled");
    };
    settlePromise = invokeWithDeadline(
      "refreshSettled",
      [selectedLease],
      acceptLateSettlement,
    ).then((result) => {
      if (result.outcome === "resolved" && result.value === true) {
        publish("settled");
        return true;
      }
      publish("recovering", result.outcome === "timeout"
        ? "settlement_reply_delayed"
        : "settlement_failed");
      return false;
    });
    return settlePromise;
  };

  const acceptLease = (value) => {
    if (!validLease(value)) {
      publish("unavailable", "invalid_start_reply");
      return null;
    }
    if (lease !== null && lease !== value) return lease;
    lease = value;
    if (finishRequested) {
      void settleLease();
    } else {
      publish("running");
      armHeartbeat();
    }
    return lease;
  };

  async function sendHeartbeat() {
    heartbeatTimer = null;
    if (finishRequested || !validLease(lease)) return;
    const result = await invokeWithDeadline("refreshHeartbeat", [lease]);
    if (finishRequested || !validLease(lease)) return;
    if (result.outcome === "resolved" && result.value === true) {
      publish("running");
    } else {
      publish("recovering", result.outcome === "timeout"
        ? "heartbeat_reply_delayed"
        : "heartbeat_failed");
    }
    armHeartbeat();
  }

  function armHeartbeat() {
    clearHeartbeat();
    if (finishRequested || !validLease(lease)) return;
    heartbeatTimer = schedule(() => {
      void sendHeartbeat();
    }, heartbeatIntervalMs);
    heartbeatTimer?.unref?.();
  }

  return Object.freeze({
    start() {
      if (startPromise !== null) return startPromise;
      publish("starting");
      startPromise = invokeWithDeadline(
        "refreshStarted",
        [mode],
        acceptLease,
      ).then((result) => {
        if (result.outcome === "resolved") return acceptLease(result.value);
        publish(result.outcome === "timeout" ? "recovering" : "unavailable",
          result.outcome === "timeout" ? "start_reply_delayed" : "start_failed");
        return null;
      });
      return startPromise;
    },
    async finish() {
      finishRequested = true;
      clearHeartbeat();
      if (validLease(lease)) return settleLease();
      if (startPromise !== null) {
        await startPromise;
        if (validLease(lease)) return settleLease();
      }
      return false;
    },
    status: snapshot,
  });
}
