import { defineConfig } from "vitest/config";

// Deliberately no Cloudflare plugin, bindings, or ambient runtime.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "portable-test/**/*.spec.ts",
      "test/gcs-release-object-store.spec.ts",
      "test/gcs-erasure-object-store.spec.ts",
    ],
    fileParallelism: false,
  },
});
