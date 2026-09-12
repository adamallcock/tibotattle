// Synthetic owned companion for desktop/private-channel integration tests.
// It uses the real local scheduler composition with a credential-only runner;
// it never enrolls, reads provider history or uploads to a hosted service.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createLocalAccountlessContribution } from "../../apps/local/accountless-contribution.js";

let passes = 0;
const contribution = createLocalAccountlessContribution({
  environment: process.env,
  stateRoot: process.env.USAGE_MONITOR_STATE_ROOT,
  indexFile: join(process.env.USAGE_MONITOR_STATE_ROOT, "unused-synthetic-index.sqlite"),
  runner: async ({ backend, signal }) => {
    let secret = await backend.read({});
    if (secret === null) {
      const candidate = randomBytes(32);
      try { await backend.createIfMissing({}, candidate); }
      finally { candidate.fill(0); }
      secret = await backend.read({});
    }
    try {
      if (secret?.length !== 32) throw new Error("Synthetic credential unavailable");
    } finally { secret?.fill(0); }
    passes += 1;
    if (passes > 1) {
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
    }
    return { status: "complete", chunksUploaded: 0 };
  },
});
process.on("message", (message) => {
  if (message?.schemaVersion === "synthetic-accountless-runtime-control-v1"
      && message.action === "run") void contribution.runNow();
});
// The owned runtime integration contract only needs a valid ready origin. Its
// credential-only runner never sends an HTTP request, so opening a loopback
// listener makes this fixture depend on the host sandbox without exercising a
// product path.
process.stdout.write("USAGE_MONITOR_READY http://127.0.0.1:4811/\n");
contribution.start();
process.once("SIGTERM", async () => {
  await contribution.stop();
  process.exit(0);
});
