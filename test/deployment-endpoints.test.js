import assert from "node:assert/strict";
import test from "node:test";
import {
  DEPLOYMENT_ENDPOINTS,
  assertDeploymentEndpoints,
} from "../config/deployment-endpoints.js";
import {
  checkDeploymentEndpointConsumers,
  validateWorkerSparkleAppcastGuard,
  validateWorkerDeploymentEndpoints,
} from "../apps/worker/scripts/check-deployment-endpoints.mjs";

test("reviewed deployment endpoint manifest is internally coherent", () => {
  assert.equal(
    DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
    `${DEPLOYMENT_ENDPOINTS.sparkle.origin}/appcast.xml`,
  );
  assert.deepEqual(
    DEPLOYMENT_ENDPOINTS.public.routeHosts,
    ["tibotattle.com", "www.tibotattle.com"],
  );
  assert.equal(assertDeploymentEndpoints(), DEPLOYMENT_ENDPOINTS);
});

test("Worker endpoint projection rejects an independent public origin", () => {
  const configuration = {
    env: {
      production: {
        routes: DEPLOYMENT_ENDPOINTS.public.routeHosts.map((pattern) => ({
          custom_domain: true,
          pattern,
        })),
        vars: {
          PUBLIC_ORIGIN: DEPLOYMENT_ENDPOINTS.public.origin,
        },
      },
    },
  };
  assert.doesNotThrow(() => validateWorkerDeploymentEndpoints(configuration));
  configuration.env.production.vars.PUBLIC_ORIGIN = "https://other.example";
  assert.throws(
    () => validateWorkerDeploymentEndpoints(configuration),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
});

test("checked-in deployment endpoint consumers match the reviewed manifest", async () => {
  const checked = await checkDeploymentEndpointConsumers();
  assert.equal(checked.publicOrigin, DEPLOYMENT_ENDPOINTS.public.origin);
  assert.equal(checked.appcastURL, DEPLOYMENT_ENDPOINTS.sparkle.appcastURL);
  assert.equal(checked.r2Bucket, DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket);
  assert.deepEqual(
    checked.worker.routeHosts,
    DEPLOYMENT_ENDPOINTS.public.routeHosts,
  );
  assert.deepEqual(checked.gates.checkedScripts, [
    "deploy:dry",
    "production:deploy",
    "production:deploy:dry",
    "staging:check",
    "staging:deploy",
  ]);
});

test("enabled Sparkle guard requires reviewed bindings and the nonce schema", () => {
  const configuration = {
    vars: { SPARKLE_APPCAST_GUARD_MODE: "enabled" },
    r2_buckets: [{
      binding: "SPARKLE_RELEASES",
      bucket_name: DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket,
    }],
    d1_databases: [{
      binding: "USAGE_MONITOR_DB",
      migrations_dir: "migrations",
    }],
  };
  const migration = `
    CREATE TABLE IF NOT EXISTS sparkle_appcast_guard_nonces (
      nonce TEXT PRIMARY KEY NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sparkle_appcast_guard_nonces_expires_at
      ON sparkle_appcast_guard_nonces(expires_at);
  `;
  assert.doesNotThrow(() => validateWorkerSparkleAppcastGuard(
    configuration,
    migration,
  ));
  configuration.r2_buckets[0].bucket_name = "wrong-reviewed-bucket";
  assert.throws(
    () => validateWorkerSparkleAppcastGuard(configuration, migration),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
  configuration.r2_buckets[0].bucket_name = DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket;
  assert.throws(
    () => validateWorkerSparkleAppcastGuard(configuration, ""),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
  delete configuration.r2_buckets;
  assert.throws(
    () => validateWorkerSparkleAppcastGuard(configuration, migration),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
});
