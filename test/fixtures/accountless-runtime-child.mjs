// Synthetic owned companion for desktop/private-channel integration tests.
// It uses the real local scheduler composition with a credential-only runner;
// it never enrolls, reads provider history or uploads to a hosted service.
import { createServer } from "node:http";
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
const server = createServer((_request, response) => {
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"synthetic_route_unavailable"}');
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
process.on("message", (message) => {
  if (message?.schemaVersion === "synthetic-accountless-runtime-control-v1"
      && message.action === "run") void contribution.runNow();
});
process.stdout.write(`USAGE_MONITOR_READY http://127.0.0.1:${server.address().port}/\n`);
contribution.start();
process.once("SIGTERM", async () => {
  await contribution.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
});
