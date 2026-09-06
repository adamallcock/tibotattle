import { join } from "node:path";
import {
  createAccountlessContributionScheduler,
} from "../../src/application/index.js";
import { createAccountlessChildChannel } from "../../src/platform/index.js";
import { runAccountlessContributionSyncOnce } from "../../src/contribution-accountless-client.js";

// Deliberately limited to the disposable local laboratory. The normal desktop
// launcher supplies neither this lane nor its private inherited IPC channel.
export function createLocalAccountlessContribution({
  environment, stateRoot, indexFile, channel = process,
  readAccountMarkers, loadExistingAccountObservationSecret,
  runner = runAccountlessContributionSyncOnce, schedulerOptions = {},
} = {}) {
  if (environment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN === undefined) return null;
  const origin = environment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN;
  let url;
  try { url = new URL(origin); } catch { throw new TypeError("Invalid accountless laboratory configuration"); }
  if (environment.USAGE_MONITOR_TEST_LANE !== "accountless-local-lab-v1"
      || environment.USAGE_MONITOR_CENTRAL_ORIGIN !== undefined
      || url.origin !== origin || url.hostname !== "127.0.0.1"
      || url.protocol !== "http:" || !url.port || url.username || url.password
      || typeof channel.send !== "function" || channel.connected !== true) {
    throw new TypeError("Invalid accountless laboratory configuration");
  }
  let scheduler;
  const bridge = createAccountlessChildChannel({ channel,
    onInvalidated: () => scheduler?.preferenceChanged() });
  scheduler = createAccountlessContributionScheduler({
    ...schedulerOptions, origin,
    readPreference: bridge.readPreference,
    runner: ({ signal }) => runner({ laboratory: true, origin, indexFile,
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
