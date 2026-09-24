import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["postgres-test/gcp-cloud-run-journey-fixture.spec.mjs"],
    fileParallelism: false,
  },
});
