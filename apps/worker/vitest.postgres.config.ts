import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "postgres-test/v12-domain-roundtrip.spec.mjs",
      "postgres-test/postgres-community-graph-roundtrip.spec.mjs",
      "postgres-test/postgres-community-graph-cohort.spec.mjs",
      "postgres-test/postgres-community-allowance-fits.spec.mjs",
      "postgres-test/postgres-community-daily-roundtrip.spec.mjs",
      "postgres-test/postgres-community-daily-publisher.spec.mjs",
      "postgres-test/postgres-community-daily-host.spec.mjs",
    ],
    fileParallelism: false,
  },
});
