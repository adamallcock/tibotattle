import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "postgres-test/v12-domain-roundtrip.spec.mjs",
      "postgres-test/postgres-community-graph-roundtrip.spec.mjs",
      "postgres-test/postgres-community-graph-cohort.spec.mjs",
      "postgres-test/postgres-community-allowance-fits.spec.mjs",
      "postgres-test/postgres-community-daily-roundtrip.spec.mjs",
      "postgres-test/postgres-community-daily-host.spec.mjs",
      "postgres-test/postgres-analytics-event-tuple.spec.mjs",
      "postgres-test/postgres-ingestion-journal-transfer.spec.mjs",
      "postgres-test/d1-analytics-export-oracle.spec.mjs",
      "postgres-test/postgres-identity-authority-transfer.spec.mjs",
      "postgres-test/postgres-legacy-contribution-transfer.spec.mjs",
      "postgres-test/cutover-source-seal-rehearsal.spec.mjs",
    ],
    fileParallelism: false,
  },
});
