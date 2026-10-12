// Synthetic inventory and mocked fetch only, on a disposable local PG17 schema.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, beforeEach } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";

const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "requires local PostgreSQL 17" : false;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const schema = `github_sync_${randomBytes(8).toString("hex")}`;
const q = `"${schema}"`;
let pool, vite, sync, read, host, consoleRoutes, contextStore;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ ...endpoint, ssl: false, max: 4, connectionTimeoutMillis: 2000 });
  assert.match((await pool.query("SHOW server_version")).rows[0].server_version, /^17\./u);
  await pool.query(`CREATE SCHEMA ${q}`);
  await applyPostgresMigrations({ role: "primary", schema, pool });
  vite = await createServer({ root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    configFile: false, logLevel: "silent", appType: "custom", server: { middlewareMode: true, ws: false } });
  sync = (await vite.ssrLoadModule("/src/postgres-github-distribution-history.ts")).syncPostgresGithubDistributionSnapshots;
  read = (await vite.ssrLoadModule("/src/postgres-admin-distribution.ts")).readPostgresGithubDistributionSnapshot;
  host = await vite.ssrLoadModule("/cloud-run/postgres-production-host.mjs");
  consoleRoutes = await vite.ssrLoadModule("/cloud-run/routes/admin-console.mjs");
  contextStore = (await vite.ssrLoadModule("/cloud-run/postgres-request-context.mjs")).createRequestContextStore;
});

beforeEach(async () => {
  if (skip) return;
  await pool.query(`TRUNCATE ${q}.github_release_asset_snapshots, ${q}.github_release_snapshots,
    ${q}.github_distribution_snapshots`);
  await pool.query(`UPDATE ${q}.github_distribution_sync_state SET last_attempted_at = NULL,
    last_success_at = NULL, last_failure_code = NULL, last_observed_at = NULL,
    lease_token = NULL, lease_expires_at = NULL`);
});

after(async () => {
  await vite?.close();
  if (pool) {
    try { await pool.query(`DROP SCHEMA ${q} CASCADE`); } finally { await pool.end(); }
  }
});

function inventory(count = 10) {
  return [26, 28].map((id) => ({ id, tag_name: `v0.1.${id}`,
    published_at: `2026-10-${id === 26 ? "01" : "10"}T00:00:00Z`, draft: false, prerelease: false,
    assets: [{ id: id * 100, name: `TiboTattle-0.1.${id}-mac-arm64.dmg`,
      download_count: count + id, digest: null }], unallowlisted: "omitted" }));
}

function fetcher(rows = inventory()) {
  return async (_input, init) => {
    assert.equal(new Headers(init.headers).has("authorization"), false);
    return Response.json(rows);
  };
}

function run(options = {}) {
  const nowEpoch = options.nowEpoch ?? NOW;
  return sync({ pool, schema, enabled: true, nowEpoch, clock: () => nowEpoch,
    fetcher: fetcher(), ...options });
}

const state = async () => (await pool.query(`SELECT * FROM ${q}.github_distribution_sync_state`)).rows[0];
const counts = async () => (await pool.query(`SELECT
  (SELECT count(*)::int FROM ${q}.github_distribution_snapshots) AS manifests,
  (SELECT count(*)::int FROM ${q}.github_release_snapshots) AS releases,
  (SELECT count(*)::int FROM ${q}.github_release_asset_snapshots) AS assets`)).rows[0];

test("complete public inventory commits all rows and the existing admin reader sees v0.1.28", { skip }, async () => {
  const rows = [...inventory(), { id: 29, tag_name: "v0.1.29-preview", published_at: "2026-10-11T00:00:00Z",
    prerelease: true, draft: false, assets: [] }, { id: 99, draft: true }];
  assert.deepEqual(await run({ fetcher: fetcher(rows) }),
    { code: "GITHUB_SYNCED", observedAt: new Date(NOW).toISOString(), failureCode: null });
  assert.deepEqual(await counts(), { manifests: 1, releases: 3, assets: 2 });
  const snapshot = await read(pool, schema, NOW);
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.release.tag, "v0.1.28");
  assert.deepEqual(snapshot.releases.map((r) => r.tag), ["v0.1.29-preview", "v0.1.28", "v0.1.26"]);
  assert.equal(snapshot.sync.stale, false);
  assert.equal(snapshot.sync.lastFailureCode, null);
  assert.equal(snapshot.summary.dmgDownloads, 74);
  assert.equal(snapshot.releases.find((r) => r.tag === "v0.1.28").installerDownloads.macArm64, 38);
  const latest = await state();
  assert.equal(latest.lease_token, null);
  assert.equal(latest.last_attempted_at.toISOString(), new Date(NOW).toISOString());
});

test("due check, exact forced cooldown and later scheduled snapshot preserve the D1 cadence", { skip }, async () => {
  await run();
  const noFetch = async () => { throw new Error("must not fetch"); };
  assert.equal((await run({ nowEpoch: NOW + 59_999, force: true, fetcher: noFetch })).code, "GITHUB_SYNC_FRESH");
  assert.equal((await run({ nowEpoch: NOW + 60_000, force: true })).code, "GITHUB_SYNCED");
  assert.equal((await run({ nowEpoch: NOW + 60_000 + 15 * 60_000, fetcher: noFetch })).code, "GITHUB_SYNC_FRESH");
  const next = await run({ nowEpoch: NOW + 60_000 + 15 * 60_000 + 1, fetcher: fetcher(inventory(20)) });
  assert.equal(next.code, "GITHUB_SYNCED");
  assert.deepEqual(await counts(), { manifests: 3, releases: 6, assets: 6 });
  const snapshot = await read(pool, schema, NOW + 60_000 + 15 * 60_000 + 1);
  assert.equal(snapshot.history.dmgDownloadsSincePrevious, 20);
});

test("source failures are attempts; neither partial pagination nor arbitrary errors replace last good counters", { skip }, async () => {
  await run();
  const old = await read(pool, schema, NOW);
  const release = inventory(0)[0];
  const assets = (start, length) => Array.from({ length }, (_, index) => ({
    ...release.assets[0], id: start + index,
  }));
  for (const [fetch, expected] of [
    [async (input) => {
      const url = new URL(input);
      if (!url.pathname.endsWith("/assets")) {
        return Response.json([{ ...release, assets: assets(1, 100) }]);
      }
      const page = Number(url.searchParams.get("page"));
      assert.ok(page >= 2 && page <= 4);
      return Response.json(assets((page - 1) * 100 + 1, page === 4 ? 101 : 100),
        page === 4 ? undefined : { headers: { link: '<https://api.github.com/next>; rel="next"' } });
    }, "GITHUB_RELEASES_BOUNDED"],
    [async (input) => {
      assert.equal(new URL(input).pathname.endsWith("/assets"), false,
        "oversized embedded assets are refused without another network read");
      return Response.json([{ ...release, assets: assets(1, 401) }]);
    }, "GITHUB_RELEASES_BOUNDED"],
    [async () => Response.json(inventory(1), { headers: { link: '<https://api.github.com/next>; rel="next"' } }), "GITHUB_RELEASES_BOUNDED"],
    [async () => { throw Object.assign(new Error("synthetic sensitive message"), { code: "UNREVIEWED_FAILURE" }); }, "GITHUB_UNAVAILABLE"],
    [async () => Response.json({ incomplete: true }), "GITHUB_UNAVAILABLE"],
    [async () => Response.json(inventory(0).map((r) => ({ ...r, assets: [{ ...r.assets[0], download_count: -1 }] }))), "GITHUB_UNAVAILABLE"],
    [async () => new Response("", { status: 403 }), "GITHUB_UNAVAILABLE"],
  ]) {
    const result = await run({ nowEpoch: NOW + 16 * 60_000, fetcher: fetch });
    assert.deepEqual(result, { code: "GITHUB_SYNC_FAILED", observedAt: null, failureCode: expected });
    assert.deepEqual(await counts(), { manifests: 1, releases: 2, assets: 2 });
    const latest = await state();
    assert.equal(latest.last_attempted_at.toISOString(), new Date(NOW + 16 * 60_000).toISOString());
    assert.equal(latest.last_success_at.toISOString(), new Date(NOW).toISOString());
    assert.equal(latest.last_failure_code, expected);
    assert.equal(latest.lease_token, null);
    assert.deepEqual((await read(pool, schema, NOW + 16 * 60_000)).summary, old.summary);
  }
});

test("one lease owns the network read; an overlapping owner force cannot poll or publish", { skip }, async () => {
  let release, started;
  const start = new Promise((r) => { started = r; });
  const pending = run({ fetcher: async () => { started(); return new Promise((r) => { release = r; }); } });
  await start;
  let polls = 0;
  assert.equal((await run({ force: true, fetcher: async () => { polls++; return Response.json([]); } })).code,
    "GITHUB_SYNC_IN_PROGRESS");
  assert.equal(polls, 0);
  assert.deepEqual(await counts(), { manifests: 0, releases: 0, assets: 0 });
  release(Response.json(inventory()));
  assert.equal((await pending).code, "GITHUB_SYNCED");
});

test("expired leases are recoverable; an expired or replaced owner cannot publish or clear its successor", { skip }, async () => {
  await pool.query(`UPDATE ${q}.github_distribution_sync_state SET lease_token = 'synthetic-expired',
    lease_expires_at = $1`, [new Date(NOW - 1)]);
  assert.equal((await run()).code, "GITHUB_SYNCED");
  const prior = await read(pool, schema, NOW);
  const lost = await run({ nowEpoch: NOW + 16 * 60_000, fetcher: async () => {
    await pool.query(`UPDATE ${q}.github_distribution_sync_state SET lease_token = 'synthetic-successor',
      lease_expires_at = $1`, [new Date(NOW + 20 * 60_000)]);
    return Response.json(inventory(0));
  } });
  assert.equal(lost.code, "GITHUB_SYNC_FAILED");
  assert.equal((await state()).lease_token, "synthetic-successor");
  assert.deepEqual(await counts(), { manifests: 1, releases: 2, assets: 2 });
  assert.deepEqual((await read(pool, schema, NOW)).summary, prior.summary);
  await pool.query(`UPDATE ${q}.github_distribution_sync_state SET lease_token = NULL, lease_expires_at = NULL`);
  assert.equal((await run({ nowEpoch: NOW + 16 * 60_000, clock: () => NOW + 18 * 60_000 })).code, "GITHUB_SYNC_FAILED");
  assert.deepEqual(await counts(), { manifests: 1, releases: 2, assets: 2 });
});

test("failure after release and asset insertion rolls back every row and records only the failed attempt", { skip }, async () => {
  await run();
  await pool.query(`CREATE FUNCTION ${q}.reject_github_manifest() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic storage failure'; END $$`);
  await pool.query(`CREATE TRIGGER reject_github_manifest BEFORE INSERT ON ${q}.github_distribution_snapshots
    FOR EACH ROW EXECUTE FUNCTION ${q}.reject_github_manifest()`);
  try {
    const result = await run({ nowEpoch: NOW + 16 * 60_000 });
    assert.deepEqual(result, { code: "GITHUB_SYNC_FAILED", observedAt: null, failureCode: "GITHUB_UNAVAILABLE" });
    assert.deepEqual(await counts(), { manifests: 1, releases: 2, assets: 2 });
    assert.equal((await state()).last_failure_code, "GITHUB_UNAVAILABLE");
  } finally {
    await pool.query(`DROP TRIGGER reject_github_manifest ON ${q}.github_distribution_snapshots`);
    await pool.query(`DROP FUNCTION ${q}.reject_github_manifest()`);
  }
});

test("rows and success state remain invisible until publication commits", { skip }, async () => {
  await run();
  let inspected = false;
  const wrappedPool = { async connect() {
    const client = await pool.connect();
    return { release: (discard) => client.release(discard), async query(sql, values) {
      if (sql.startsWith(`INSERT INTO ${q}.github_distribution_snapshots`)) {
        const visible = await read(pool, schema, NOW);
        assert.equal(visible.history.latestObservedAt, new Date(NOW).toISOString());
        assert.equal(visible.summary.dmgDownloads, 74);
        assert.deepEqual(await counts(), { manifests: 1, releases: 2, assets: 2 });
        inspected = true;
      }
      return client.query(sql, values);
    } };
  } };
  assert.equal((await run({ pool: wrappedPool, nowEpoch: NOW + 16 * 60_000, fetcher: fetcher(inventory(20)) })).code,
    "GITHUB_SYNCED");
  assert.equal(inspected, true);
  assert.equal((await read(pool, schema, NOW + 16 * 60_000)).summary.dmgDownloads, 94);
});

test("the injected admin action forces a fresh snapshot and keeps its audit and CSRF boundary", { skip }, async () => {
  await run();
  const at = NOW + 60_000;
  const store = contextStore();
  const handlers = consoleRoutes.createAdminConsoleHandlers({
    requestContext: store.accessor, clock: () => at, env: Object.freeze({ ENVIRONMENT: "production" }),
    pools: { primary: pool }, schemaOptions: { primarySchema: schema },
    maintenance: host.createPostgresOwnerMaintenance({ pool, primarySchema: schema, objectStore: {},
      distributionEnabled: true, clock: () => at, fetcher: fetcher(inventory(20)) }),
  });
  const request = (headers) => new Request("https://admin.example.invalid/api/v1/admin/action", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ action: "sync_distribution" }),
  });
  const register = (r) => { store.register(r, { requestId: "00000000-0000-4000-8000-000000000001",
    routeId: "admin_action", adminIdentityKey: "owner@example.invalid" }); return r; };
  const denied = await handlers.get("admin_action")(register(request({})));
  assert.equal(denied.status, 403);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.admin_action_audit`)).rows[0].n, 0);
  const response = await handlers.get("admin_action")(register(request({ origin: "https://admin.example.invalid",
    "sec-fetch-site": "same-origin", "x-usage-monitor-admin": "1" })));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.code, "GITHUB_SYNCED");
  assert.equal(body.result.observedAt, new Date(at).toISOString());
  const audits = (await pool.query(`SELECT action, outcome, details_json FROM ${q}.admin_action_audit`)).rows;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "sync_distribution");
  assert.equal(audits[0].outcome, "success");
  assert.equal(JSON.parse(audits[0].details_json).code, "GITHUB_SYNCED");

  const failedAt = at + 60_000;
  const failingHandlers = consoleRoutes.createAdminConsoleHandlers({
    requestContext: store.accessor, clock: () => failedAt, env: Object.freeze({ ENVIRONMENT: "production" }),
    pools: { primary: pool }, schemaOptions: { primarySchema: schema },
    maintenance: host.createPostgresOwnerMaintenance({ pool, primarySchema: schema, objectStore: {},
      distributionEnabled: true, clock: () => failedAt,
      fetcher: async () => { throw new Error("synthetic private upstream detail"); } }),
  });
  const failed = await failingHandlers.get("admin_action")(register(request({ origin: "https://admin.example.invalid",
    "sec-fetch-site": "same-origin", "x-usage-monitor-admin": "1" })));
  assert.equal(failed.status, 503);
  const failedBody = await failed.json();
  assert.equal(failedBody.error.code, "DISTRIBUTION_SYNC_UNAVAILABLE");
  assert.equal(JSON.stringify(failedBody).includes("synthetic private upstream detail"), false);
  assert.deepEqual(await counts(), { manifests: 2, releases: 4, assets: 4 });
  const failures = (await pool.query(`SELECT outcome, details_json FROM ${q}.admin_action_audit WHERE outcome = 'failure'`)).rows;
  assert.equal(failures.length, 1);
  assert.equal(JSON.parse(failures[0].details_json).code, "GITHUB_UNAVAILABLE");
  assert.equal((await state()).last_attempted_at.toISOString(), new Date(failedAt).toISOString());
});
