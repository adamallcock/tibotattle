import { defineConfig } from "vitest/config";

// Opt-in real database lane. The test creates and drops its own local database.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "./postgres-test/cloudflare-workers-stub.mjs",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./postgres-test/setup-node-worker-crypto.mjs"],
    include: ["postgres-test/**/*.spec.mjs"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
