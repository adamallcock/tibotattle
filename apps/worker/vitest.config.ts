import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");
const deletionLedgerMigrations = await readD1Migrations(
  "./deletion-ledger-migrations",
);
const typedIngestionMigrations = await readD1Migrations("./typed-ingestion-migrations");
const analyticsMigrations = await readD1Migrations("./analytics-migrations");
const routingMigrations = await readD1Migrations("./routing-migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["USAGE_MONITOR_DB", "DELETION_LEDGER", "STORAGE_ROUTING_DB",
          "STORAGE_INGESTION_A", "STORAGE_INGESTION_B", "STORAGE_ANALYTICS_DB"],
        bindings: {
          ENVELOPE_PRIVATE_JWK: "",
          ENVELOPE_PUBLIC_JWK: "",
          TEST_MIGRATIONS: migrations,
          TEST_DELETION_LEDGER_MIGRATIONS: deletionLedgerMigrations,
          TEST_TYPED_INGESTION_MIGRATIONS: typedIngestionMigrations,
          TEST_ANALYTICS_MIGRATIONS: analyticsMigrations,
          TEST_ROUTING_MIGRATIONS: routingMigrations,
        },
      },
    }),
  ],
  test: {
    fileParallelism: false,
  },
});
