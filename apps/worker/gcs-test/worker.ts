import { createGcsTestReleaseWorker } from "../src/gcs-test-release-worker";
import type { GcsTestReleaseWorkerEnv } from "../src/gcs-test-release-worker";

// Test-only transport diagnostics contain no URLs, headers, bodies or credentials.
// Keep helper exports out of workerd's named entrypoint table.
export default {
  async fetch(request: Request, env: GcsTestReleaseWorkerEnv): Promise<Response> {
    let phase = "configuration";
    const result = await createGcsTestReleaseWorker({
      env,
      fetchImpl: async (input, init) => {
        try {
          phase = "gcs-request";
          const response = await fetch(input, init);
          phase = `gcs-http-${response.status}`;
          console.error(`GCS_SMOKE_EVENT ${JSON.stringify({ status: response.status })}`);
          return response;
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const category = /redirect/iu.test(message) ? "redirect"
            : /certificate|TLS|SSL/iu.test(message) ? "tls"
            : /cache/iu.test(message) ? "cache"
            : /invocation/iu.test(message) ? "invocation" : "transport";
          phase = `gcs-${category}`;
          console.error(`GCS_SMOKE_EVENT ${JSON.stringify({ error: category })}`);
          throw error;
        }
      },
    }).fetch(request);
    const response = new Response(result.body, result);
    response.headers.set("x-gcs-test-phase", phase);
    return response;
  },
};
