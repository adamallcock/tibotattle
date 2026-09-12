import { createAccountlessContributionScheduler } from "../../src/application/index.js";
import { createAccountlessChildChannel } from "../../src/platform/index.js";
let scheduler;
const bridge = createAccountlessChildChannel({ channel: process,
  onInvalidated: () => scheduler?.preferenceChanged() });
scheduler = createAccountlessContributionScheduler({
  origin: "http://127.0.0.1:18765", readPreference: bridge.readPreference,
  runner: async ({ signal }) => {
    const value = await bridge.backend.read();
    if (value?.length !== 32) throw new Error("Synthetic credential unavailable");
    value.fill(0);
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    return { status: "complete", chunksUploaded: 1 };
  },
  onStatus: (value) => { void bridge.reportStatus(value).catch(() => {}); },
});
process.stdout.write("USAGE_MONITOR_READY http://127.0.0.1:18765/\n");
scheduler.start();
process.once("SIGTERM", async () => { await scheduler.stop(); bridge.dispose(); process.exit(0); });
