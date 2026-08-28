import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEPLOYMENT_ENDPOINTS,
  assertDeploymentEndpoints,
} from "../config/deployment-endpoints.js";
import {
  checkDeploymentEndpointConsumers,
  validateWorkerSparkleReleaseContract,
  validateWorkerSparkleAppcastGuard,
  validateWorkerDeploymentEndpoints,
  validateWorkerDeploymentEndpointGates,
  WORKER_SPARKLE_RELEASE_CONTRACT_PATH,
} from "../apps/worker/scripts/check-deployment-endpoints.mjs";

test("reviewed deployment endpoint manifest is internally coherent", () => {
  assert.equal(
    DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
    `${DEPLOYMENT_ENDPOINTS.sparkle.origin}/appcast.xml`,
  );
  assert.equal(
    DEPLOYMENT_ENDPOINTS.sparkle.previewAppcastURL,
    `${DEPLOYMENT_ENDPOINTS.sparkle.origin}/preview/appcast.xml`,
  );
  assert.deepEqual(
    DEPLOYMENT_ENDPOINTS.public.routeHosts,
    ["tibotattle.com", "www.tibotattle.com"],
  );
  assert.deepEqual(DEPLOYMENT_ENDPOINTS.admin, {
    host: "admin.tibotattle.com",
    origin: "https://admin.tibotattle.com",
  });
  assert.equal(assertDeploymentEndpoints(), DEPLOYMENT_ENDPOINTS);
});

test("Worker endpoint projection rejects an independent public origin", () => {
  const configuration = {
    env: {
      production: {
        routes: [
          ...DEPLOYMENT_ENDPOINTS.public.routeHosts,
          DEPLOYMENT_ENDPOINTS.admin.host,
        ].map((pattern) => ({
          custom_domain: true,
          pattern,
        })),
        vars: {
          PUBLIC_ORIGIN: DEPLOYMENT_ENDPOINTS.public.origin,
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
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
  configuration.env.production.vars.PUBLIC_ORIGIN =
    DEPLOYMENT_ENDPOINTS.public.origin;

  // Dropping the admin custom domain or its Access variable slots must fail:
  // the admin surface only ships alongside its Zero Trust binding.
  const withoutAdminRoute = {
    env: {
      production: {
        ...configuration.env.production,
        routes: configuration.env.production.routes.slice(0, 2),
      },
    },
  };
  assert.throws(
    () => validateWorkerDeploymentEndpoints(withoutAdminRoute),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
  const withoutAccessVars = {
    env: {
      production: {
        ...configuration.env.production,
        vars: { PUBLIC_ORIGIN: DEPLOYMENT_ENDPOINTS.public.origin },
      },
    },
  };
  assert.throws(
    () => validateWorkerDeploymentEndpoints(withoutAccessVars),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
});

test("Worker deployment scripts run the endpoint check before deployment", () => {
  const endpointCheckCommand = "npm run deployment:endpoints:check";
  const deploymentOperations = [
    ["deploy:dry", "wrangler deploy --env=\"\" --dry-run"],
    ["production:deploy:dry", "wrangler deploy --env production --dry-run"],
    ["staging:check", "wrangler deploy --env staging --dry-run"],
    ["staging:deploy", "node ./scripts/deploy-disabled-staging.mjs"],
  ];
  const scripts = {
    "deployment:endpoints:check": "node ./scripts/check-deployment-endpoints.mjs",
    "production:deploy": "node ./scripts/production-deploy.mjs",
  };
  for (const [name, operation] of deploymentOperations) {
    scripts[name] = `${endpointCheckCommand} && ${operation}`;
  }

  assert.doesNotThrow(() => validateWorkerDeploymentEndpointGates({ scripts }));
  for (const [name, operation] of deploymentOperations) {
    scripts[name] = `${operation} && ${endpointCheckCommand}`;
    assert.throws(
      () => validateWorkerDeploymentEndpointGates({ scripts }),
      { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
      `${name} must reject an endpoint check after its deployment operation`,
    );
    scripts[name] = `${endpointCheckCommand} && ${operation}`;
  }
});

test("checked-in deployment endpoint consumers match the reviewed manifest", async () => {
  const checked = await checkDeploymentEndpointConsumers();
  assert.equal(checked.publicOrigin, DEPLOYMENT_ENDPOINTS.public.origin);
  assert.equal(checked.appcastURL, DEPLOYMENT_ENDPOINTS.sparkle.appcastURL);
  assert.equal(
    checked.previewAppcastURL,
    DEPLOYMENT_ENDPOINTS.sparkle.previewAppcastURL,
  );
  assert.equal(checked.r2Bucket, DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket);
  assert.deepEqual(checked.workerSparkleReleaseContract, {
    channel: "stable",
    appcastURL: DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
    appcastObjectKey: "appcast.xml",
    guardRoute: "/api/v1/internal/release/appcast",
    objectPrefix: "releases",
    r2Bucket: DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket,
  });
  assert.deepEqual(checked.worker.routeHosts, [
    ...DEPLOYMENT_ENDPOINTS.public.routeHosts,
    DEPLOYMENT_ENDPOINTS.admin.host,
  ]);
  assert.equal(checked.worker.adminHost, DEPLOYMENT_ENDPOINTS.admin.host);
  assert.deepEqual(checked.gates.checkedScripts, [
    "deploy:dry",
    "production:deploy",
    "production:deploy:dry",
    "staging:check",
    "staging:deploy",
  ]);
});

test("Worker Sparkle release contract rejects drift from canonical manifests", async () => {
  const contract = JSON.parse(
    await readFile(WORKER_SPARKLE_RELEASE_CONTRACT_PATH, "utf8"),
  );
  assert.doesNotThrow(() => validateWorkerSparkleReleaseContract(contract));
  contract.objectPrefix = "different-prefix";
  assert.throws(
    () => validateWorkerSparkleReleaseContract(contract),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
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
