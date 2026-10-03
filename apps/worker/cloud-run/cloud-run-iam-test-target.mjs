/**
 * The named A2 test deployment's identities (the retired cloud-run-iam test
 * host). Plain JavaScript with no imports, so the production configuration
 * (CR-3), the OPS-2 manifest, the migrators and the analytics-refresh Job's
 * source entry (which answers --help under plain Node 22.16, with no type
 * stripping) can import it without loading the PostgreSQL test dispatch.
 *
 * Its cloud-run-iam host mode is retired (owner decision OD-6, 2026-10-02):
 * no host mode serves as this service any more, but its resources stay in the test project until owner
 * action OA-4, so the production refusal lists keep naming every value here
 * (and the shared test database remains the analytics-refresh Job's
 * non-fast-path test target). The `postgres.ledger` entry is a frozen
 * identity of the test estate's ledger instance (retired with the deletion
 * ledger, decisions D2, D4 and D6): no runtime path reads it.
 */
export const CLOUD_RUN_IAM_TEST_TARGET = Object.freeze({
  project: "tibotattle",
  region: "us-east1",
  service: "tibotattle-test-app",
  origin: "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app",
  listenHost: "0.0.0.0",
  port: 8080,
  postgres: Object.freeze({
    primary: Object.freeze({
      instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
      database: "tibotattle",
      schema: "tibotattle_v12_a2_20260925",
    }),
    ledger: Object.freeze({
      instanceConnectionName: "tibotattle:us-east1:tibotattle-test-ledger-20260922",
      database: "tibotattle_ledger",
      schema: "tibotattle_ledger_v12_a2_20260925",
    }),
    iamUser: "tibotattle-test-runtime@tibotattle.iam",
  }),
  gcsBucket: "tibotattle-gcs-test-cleanup-20260925-a2",
});
