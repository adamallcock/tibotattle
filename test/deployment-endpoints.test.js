import assert from "node:assert/strict";
import test from "node:test";
import {
  DEPLOYMENT_ENDPOINTS,
  assertDeploymentEndpoints,
} from "../config/deployment-endpoints.js";
import {
  checkDeploymentEndpointConsumers,
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
});
