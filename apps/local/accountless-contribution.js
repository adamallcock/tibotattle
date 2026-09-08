import { join } from "node:path";
import {
  accountlessTransportOrigin,
  createAccountlessContributionScheduler,
} from "../../src/application/index.js";
import { createAccountlessChildChannel } from "../../src/platform/index.js";
import { runAccountlessContributionSyncOnce } from "../../src/contribution-accountless-client.js";

function accountlessConfigurationError() {
  return new TypeError("Invalid accountless contribution configuration");
}

/**
 * Select the closed production companion profile. The environment can request
 * this profile, but only the inherited private channel supplies the protected
 * preference and installation credential it requires.
 */
export function selectLocalAccountlessProductionProfile({
  environment,
  channel = process,
} = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw accountlessConfigurationError();
  }
  if (environment.USAGE_MONITOR_ACCOUNTLESS_MODE === undefined) return false;
  const origin = environment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN;
  if (environment.USAGE_MONITOR_ACCOUNTLESS_MODE !== "production-v1"
      || Object.hasOwn(environment, "USAGE_MONITOR_TEST_LANE")
      || Object.hasOwn(environment, "USAGE_MONITOR_CENTRAL_ORIGIN")
      || accountlessTransportOrigin({ production: true, origin }) === null
      || typeof channel?.send !== "function" || channel.connected !== true) {
    throw accountlessConfigurationError();
  }
  return true;
}

// Both modes require the private inherited channel. Only Electron can supply
// the protected preference and credential; environment values grant neither.
export function createLocalAccountlessContribution({
  environment, stateRoot, indexFile, channel = process,
  readAccountMarkers, loadExistingAccountObservationSecret,
  runner = runAccountlessContributionSyncOnce, schedulerOptions = {},
} = {}) {
  const production = selectLocalAccountlessProductionProfile({
    environment,
    channel,
  });
  if (environment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN === undefined) return null;
  const origin = environment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN;
  const laboratory = environment.USAGE_MONITOR_TEST_LANE === "accountless-local-lab-v1";
  if (accountlessTransportOrigin({ laboratory, production, origin }) === null
      || environment.USAGE_MONITOR_CENTRAL_ORIGIN !== undefined
      || (laboratory && environment.USAGE_MONITOR_ACCOUNTLESS_MODE !== undefined)
      || typeof channel.send !== "function" || channel.connected !== true) {
    throw accountlessConfigurationError();
  }
  let scheduler;
  const bridge = createAccountlessChildChannel({ channel,
    onInvalidated: () => scheduler?.preferenceChanged() });
  scheduler = createAccountlessContributionScheduler({
    ...schedulerOptions, origin,
    readPreference: bridge.readPreference,
    runner: ({ signal }) => runner({ laboratory, production, origin, indexFile,
      stateFile: join(stateRoot, "accountless-device-binding-v1.json"),
      progressFile: join(stateRoot, "private", "accountless-upload-progress-v1.json"),
      backend: bridge.backend, readPreference: bridge.readPreference, signal,
      readAccountMarkers, loadExistingAccountObservationSecret }),
    onStatus: (status) => { void bridge.reportStatus(status).catch(() => {}); },
  });
  return Object.freeze({
    start: scheduler.start,
    inspect: scheduler.inspect,
    runNow: scheduler.runNow,
    async stop() {
      try { await scheduler.stop(); }
      finally { bridge.dispose(); }
    },
  });
}
