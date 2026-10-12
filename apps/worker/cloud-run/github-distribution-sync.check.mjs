// Local qualification only: synthetic values, recording dependencies and mocked fetch.
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({ root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  configFile: false, logLevel: "silent", appType: "custom", server: { middlewareMode: true, ws: false } });
const inventory = await vite.ssrLoadModule("/src/github-distribution-history.ts");
const writer = await vite.ssrLoadModule("/src/postgres-github-distribution-history.ts");
const job = await vite.ssrLoadModule("/cloud-run/postgres-maintenance-job.mjs");
after(() => vite.close());

test("the inventory deadline includes a stalled response body and an uncooperative fetch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const fetcher of [
      async () => ({ ok: true, headers: new Headers(), arrayBuffer: () => new Promise(() => {}) }),
      () => new Promise(() => {}),
    ]) {
      const failed = assert.rejects(inventory.readGithubInventory(undefined, fetcher),
        (error) => inventory.githubInventoryFailureCode(error) === "GITHUB_UNAVAILABLE");
      await nextTurn();
      t.mock.timers.tick(inventory.GITHUB_INVENTORY_TIMEOUT_MILLISECONDS);
      await failed;
    }
  } finally { t.mock.timers.reset(); }
});

test("request timeout aborts the mocked fetch after eight seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false;
  try {
    const failed = assert.rejects(inventory.readGithubInventory(undefined, async (_input, init) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => {
        aborted = true; reject(new Error("synthetic upstream error"));
      }, { once: true }))));
    await nextTurn();
    t.mock.timers.tick(8000);
    await failed;
    assert.equal(aborted, true);
  } finally { t.mock.timers.reset(); }
});

test("inventory projection omits drafts, reads asset pagination and supports an optional token without returning it", async () => {
  const release = { id: 1, tag_name: "synthetic-v1", published_at: "2026-10-01T00:00:00Z",
    draft: false, prerelease: false, assets: Array.from({ length: 100 }, (_, id) =>
      ({ id, name: `synthetic-${id}.dmg`, download_count: 1, digest: null })) };
  const calls = [];
  const result = await inventory.readGithubInventory("synthetic-github-credential", async (input, init) => {
    calls.push(String(input));
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-github-credential");
    return Response.json(calls.length === 1 ? [release, { draft: true }]
      : [{ id: 100, name: "synthetic-extra.dmg", download_count: 2, digest: null }]);
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /releases\/1\/assets\?per_page=100&page=2$/u);
  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0].assets.length, 101);
  assert.equal(JSON.stringify(result).includes("synthetic-github-credential"), false);
});

test("storage failures return a closed sync failure; disabled sync opens no pool or network", async () => {
  let connects = 0, fetches = 0;
  const options = { pool: { async connect() { connects++; throw Object.assign(new Error("synthetic credential"),
    { code: "UNREVIEWED_FAILURE" }); } }, schema: "synthetic_github", enabled: false,
    fetcher: async () => { fetches++; throw new Error("unused"); } };
  assert.deepEqual(await writer.syncPostgresGithubDistributionSnapshots(options),
    { code: "DISTRIBUTION_DISABLED", observedAt: null, failureCode: null });
  assert.equal(connects, 0); assert.equal(fetches, 0);
  assert.deepEqual(await writer.syncPostgresGithubDistributionSnapshots({ ...options, enabled: true }),
    { code: "GITHUB_SYNC_FAILED", observedAt: null, failureCode: "GITHUB_UNAVAILABLE" });
  assert.equal(connects, 1); assert.equal(fetches, 0);
});

function env() {
  return { CLOUD_RUN_JOB: "tibotattle-maintenance", DEPLOYMENT_SOURCE_COMMIT: "a".repeat(40),
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-namespace", PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic:us-east1:primary",
    PRIMARY_DATABASE: "synthetic_primary", PRIMARY_SCHEMA: "synthetic_primary", POSTGRES_IAM_USER: "runtime@synthetic.iam",
    GCS_BUCKET_NAME: "synthetic-quarantine", POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled",
    IDENTITY_LINK_SECRET: "synthetic-identity-link-value-0000000001",
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify({ bucket: "synthetic-quarantine", bucketGeneration: "1700000000000001",
      bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0" }) };
}

function dependencies(events, outcome, syncDistribution) {
  return {
    createConnector() { return { async close() { events.push("connector.close"); } }; },
    async createIamPool() { return { async end() { events.push("pool.end"); } }; },
    async createAccessTokenProvider() { return () => "synthetic-access-token"; },
    createObjectStore() { return {}; },
    async runLifecyclePass() { events.push("lifecycle"); return { outcome, code: "SYNTHETIC_PASS" }; },
    syncDistribution,
  };
}

test("GitHub failures cannot fail complete or partial maintenance and run after lifecycle work", async () => {
  for (const outcome of ["complete", "partial"]) {
    const events = [];
    const result = await job.runPostgresMaintenanceJob({ argv: ["--profile=maintenance-job"], env: env(),
      now: () => Date.parse("2026-10-11T12:00:01Z"), dependencies: dependencies(events, outcome, async (options) => {
        events.push("github");
        assert.equal(options.githubApiToken, undefined);
        assert.equal(options.enabled, true);
        assert.equal(options.force, undefined);
        throw Object.assign(new Error("synthetic private failure"), { code: "UNREVIEWED_FAILURE" });
      }) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.receipt.status, outcome);
    assert.deepEqual(result.receipt.githubDistributionSync,
      { code: "GITHUB_SYNC_FAILED", observedAt: null, failureCode: "GITHUB_UNAVAILABLE" });
    assert.deepEqual(events, ["lifecycle", "github", "pool.end", "connector.close"]);
    assert.equal(JSON.stringify(result).includes("synthetic private failure"), false);
  }
});

test("skipped, refused and failed passes never call GitHub", async () => {
  for (const [outcome, exitCode] of [["skipped", 0], ["refused", 1], ["failure", 1]]) {
    const events = [];
    const result = await job.runPostgresMaintenanceJob({ argv: ["--profile=maintenance-job"], env: env(),
      dependencies: dependencies(events, outcome, async () => { throw new Error("must not sync"); }) });
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.receipt.githubDistributionSync, null);
    assert.deepEqual(events, ["lifecycle", "pool.end", "connector.close"]);
  }
});

test("a complete staging pass performs no GitHub work and refuses a job token", async () => {
  const events = [];
  const stagingEnv = { ...env(), CLOUD_RUN_JOB: "tibotattle-staging-maintenance",
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-staging-namespace",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic:us-east1:staging-primary",
    GCS_BUCKET_NAME: "synthetic-staging-quarantine",
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify({ bucket: "synthetic-staging-quarantine",
      bucketGeneration: "1700000000000001", bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0" }),
    PUBLIC_ORIGIN: "https://staging.example.invalid", ADMIN_HOST_ORIGIN: "https://admin.staging.example.invalid",
    ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64),
    ACCESS_ADMIN_EMAIL: "owner@example.invalid", IDENTITY_LINK_SECRET_VERSION: "staging-v1",
    GOOGLE_OIDC_CLIENT_ID: "123456789012-syntheticstaging.apps.googleusercontent.com",
    DISTRIBUTION_GITHUB_API_TOKEN: "synthetic-staging-github-credential" };
  await assert.rejects(job.runPostgresMaintenanceJob({ argv: ["--profile=staging-maintenance-job"], env: stagingEnv,
    dependencies: dependencies(events, "complete", async () => { throw new Error("must not sync staging"); }) }),
  { code: "DISTRIBUTION_GITHUB_API_TOKEN_PROFILE_FORBIDDEN" });
  assert.deepEqual(events, []);
  delete stagingEnv.DISTRIBUTION_GITHUB_API_TOKEN;
  const result = await job.runPostgresMaintenanceJob({ argv: ["--profile=staging-maintenance-job"], env: stagingEnv,
    dependencies: dependencies(events, "complete", async () => { throw new Error("must not sync staging"); }) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.githubDistributionSync, null);
  assert.deepEqual(events, ["lifecycle", "pool.end", "connector.close"]);
});

test("maintenance reveals an optional opaque token only to the sync adapter", async () => {
  const events = [];
  const secret = "synthetic-github-credential";
  const result = await job.runPostgresMaintenanceJob({ argv: ["--profile=maintenance-job"], env: {
    ...env(), DISTRIBUTION_GITHUB_API_TOKEN: secret },
    dependencies: dependencies(events, "complete", async (options) => {
      assert.equal(options.githubApiToken, secret);
      return { code: "GITHUB_SYNC_FRESH", observedAt: null, failureCode: null };
    }) });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
