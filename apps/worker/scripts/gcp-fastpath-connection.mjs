#!/usr/bin/env node

/**
 * IAM-authenticated connection into the disposable fast-path test database
 * (`tibotattle_fastpath` on the GCP test primary instance), for rehearsal
 * importers and copiers that take a destination pg pool.
 *
 * The caller's gcloud identity impersonates the migrator (or runtime)
 * service account; the access token is minted by gcloud into this process's
 * memory, refreshed the same way, and never printed or written. Cloud SQL
 * IAM database authentication is used, so no database password exists.
 *
 *   import { createGcpFastpathPool } from "./gcp-fastpath-connection.mjs";
 *   const { pool, close } = await createGcpFastpathPool({ as: "migrator" });
 *
 * `measInstance` (tibotattle-meas-prodtier-<YYYYMMDD>) connects to the same
 * database on a disposable production-tier measurement instance instead
 * (cloud-run/origin-fastpath-mode.mjs FASTPATH_MEASUREMENT_CLOUD_TARGET);
 * no other instance can be named.
 *
 *   # Unix-socket proxy for tools that only take a socket directory and port:
 *   node scripts/gcp-fastpath-connection.mjs proxy --as=migrator --socket-dir=<dir> [--port=55499]
 */

import { spawnSync } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fastpathMeasurementInstance } from "../cloud-run/origin-fastpath-mode.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const GCP_FASTPATH_CONNECTION = Object.freeze({
  target: "gcp-fastpath",
  project: "tibotattle",
  instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
  // The only database this module connects to; never the shared `tibotattle`.
  database: "tibotattle_fastpath",
  identities: Object.freeze({
    migrator: Object.freeze({
      serviceAccount: "tibotattle-test-migrator@tibotattle.iam.gserviceaccount.com",
      iamUser: "tibotattle-test-migrator@tibotattle.iam",
    }),
    runtime: Object.freeze({
      serviceAccount: "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com",
      iamUser: "tibotattle-test-runtime@tibotattle.iam",
    }),
  }),
});

// gcloud access tokens last one hour; refresh well before that.
const TOKEN_LIFETIME_MILLISECONDS = 45 * 60_000;

function fail(code, detail) {
  throw Object.assign(new Error(detail === undefined ? code : `${code}: ${detail}`), { code });
}

function identityFor(as) {
  const identity = GCP_FASTPATH_CONNECTION.identities[as];
  if (identity === undefined) fail("GCP_FASTPATH_CONNECTION_IDENTITY_INVALID", String(as));
  return identity;
}

/**
 * The instance connection name a pool or proxy dials: the test primary, or a
 * measurement instance by its validated name.
 */
export function fastpathInstanceConnectionName(measInstance) {
  if (measInstance === undefined || measInstance === null) return GCP_FASTPATH_CONNECTION.instanceConnectionName;
  const instance = fastpathMeasurementInstance(measInstance);
  if (instance === null) fail("GCP_FASTPATH_CONNECTION_INSTANCE_INVALID", String(measInstance));
  return instance.instanceConnectionName;
}

export function validateTarget(target) {
  if (target !== GCP_FASTPATH_CONNECTION.target) fail("GCP_FASTPATH_CONNECTION_TARGET_INVALID", String(target));
  return target;
}

/** Mint one access token for the impersonated identity; stdout is captured, never echoed. */
function mintAccessToken(serviceAccount, spawn) {
  const minted = spawn("gcloud", [
    "auth", "print-access-token",
    `--impersonate-service-account=${serviceAccount}`,
    `--project=${GCP_FASTPATH_CONNECTION.project}`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 });
  const token = minted?.status === 0 ? String(minted.stdout).trim() : "";
  if (token.length === 0 || token.length > 16 * 1024 || !/^[\x21-\x7e]+$/u.test(token)) {
    fail("GCP_FASTPATH_CONNECTION_IMPERSONATION_FAILED", serviceAccount);
  }
  return { access_token: token, expiry_date: Date.now() + TOKEN_LIFETIME_MILLISECONDS };
}

function cloudRunModules() {
  const cloudRunRequire = createRequire(join(WORKER_ROOT, "cloud-run/package.json"));
  return cloudRunRequire;
}

/** A fresh token-creator binding can take minutes to propagate; retry the first mint, bounded. */
async function firstAccessToken(serviceAccount, spawn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return mintAccessToken(serviceAccount, spawn);
    } catch (error) {
      if (attempt >= 11) throw error;
      await new Promise((wait) => setTimeout(wait, 15_000));
    }
  }
}

async function impersonatedConnector(identity, spawn) {
  const cloudRunRequire = cloudRunModules();
  const { Connector } = await import(
    pathToFileURL(cloudRunRequire.resolve("@google-cloud/cloud-sql-connector")).href
  );
  const { OAuth2Client } = cloudRunRequire("google-auth-library");
  const auth = new OAuth2Client();
  auth.setCredentials(await firstAccessToken(identity.serviceAccount, spawn));
  auth.refreshHandler = async () => mintAccessToken(identity.serviceAccount, spawn);
  return { connector: new Connector({ auth }), pg: cloudRunRequire("pg") };
}

/**
 * Open a pg Pool on `tibotattle_fastpath` as the impersonated IAM user.
 * Returns `{ pool, identity, database, close }`.
 */
export async function createGcpFastpathPool({
  as = "migrator",
  max = 4,
  applicationName = "tibotattle-fastpath-seed",
  measInstance,
  spawn = spawnSync,
} = {}) {
  const identity = identityFor(as);
  const instanceConnectionName = fastpathInstanceConnectionName(measInstance);
  if (!Number.isSafeInteger(max) || max < 1 || max > 8) fail("GCP_FASTPATH_CONNECTION_POOL_SIZE_INVALID");
  const { connector, pg } = await impersonatedConnector(identity, spawn);
  let pool;
  try {
    const options = await connector.getOptions({
      instanceConnectionName,
      authType: "IAM",
      ipType: "PUBLIC",
    });
    pool = new pg.Pool({
      ...options,
      user: identity.iamUser,
      database: GCP_FASTPATH_CONNECTION.database,
      max,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
      application_name: applicationName,
    });
    pool.on("error", () => {});
    const probe = await pool.query("SELECT current_user AS who, current_database() AS db");
    if (probe.rows[0]?.who !== identity.iamUser || probe.rows[0]?.db !== GCP_FASTPATH_CONNECTION.database) {
      fail("GCP_FASTPATH_CONNECTION_IDENTITY_UNEXPECTED");
    }
  } catch (error) {
    await pool?.end().catch(() => {});
    connector.close();
    if (typeof error?.code === "string" && error.code.startsWith("GCP_FASTPATH_")) throw error;
    fail("GCP_FASTPATH_CONNECTION_FAILED", identity.iamUser);
  }
  return Object.freeze({
    pool,
    identity: identity.iamUser,
    instanceConnectionName,
    database: GCP_FASTPATH_CONNECTION.database,
    async close() {
      await pool.end().catch(() => {});
      connector.close();
    },
  });
}

/**
 * Listen on `<socketDir>/.s.PGSQL.<port>` and forward to the fast-path
 * database with IAM authentication. Connect with host=<socketDir>, port,
 * user=<iamUser>, database=tibotattle_fastpath and no password.
 */
export async function startGcpFastpathSocketProxy({
  as = "migrator",
  socketDir,
  port = 55499,
  measInstance,
  spawn = spawnSync,
} = {}) {
  const identity = identityFor(as);
  const instanceConnectionName = fastpathInstanceConnectionName(measInstance);
  if (typeof socketDir !== "string" || !isAbsolute(socketDir)) fail("GCP_FASTPATH_CONNECTION_SOCKET_DIR_INVALID");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) fail("GCP_FASTPATH_CONNECTION_PORT_INVALID");
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  const path = join(socketDir, `.s.PGSQL.${port}`);
  if (await lstat(path).catch(() => null)) fail("GCP_FASTPATH_CONNECTION_SOCKET_EXISTS", path);
  const { connector } = await impersonatedConnector(identity, spawn);
  await connector.startLocalProxy({
    instanceConnectionName,
    authType: "IAM",
    ipType: "PUBLIC",
    listenOptions: { path },
  });
  return Object.freeze({
    host: socketDir,
    port,
    path,
    user: identity.iamUser,
    database: GCP_FASTPATH_CONNECTION.database,
    close() { connector.close(); },
  });
}

function parseProxyArgs(argv) {
  const options = { as: "migrator", socketDir: undefined, port: 55499 };
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    const key = separator > 2 ? argument.slice(2, separator) : "";
    const value = separator > 2 ? argument.slice(separator + 1) : "";
    if (!argument.startsWith("--") || value.length === 0) fail("GCP_FASTPATH_CONNECTION_ARGUMENT_INVALID", argument);
    if (key === "as") options.as = value;
    else if (key === "socket-dir") options.socketDir = resolve(value);
    else if (key === "port") options.port = Number(value);
    else if (key === "target") validateTarget(value);
    else if (key === "meas-instance") options.measInstance = value;
    else fail("GCP_FASTPATH_CONNECTION_ARGUMENT_INVALID", argument);
  }
  return options;
}

async function main(argv) {
  if (argv[0] !== "proxy") {
    console.error("Usage: node scripts/gcp-fastpath-connection.mjs proxy [--target=gcp-fastpath] "
      + "--as=migrator|runtime --socket-dir=<absolute dir> [--port=55499] [--meas-instance=<name>]");
    process.exitCode = 2;
    return;
  }
  const proxy = await startGcpFastpathSocketProxy(parseProxyArgs(argv.slice(1)));
  console.log(JSON.stringify({ status: "listening", host: proxy.host, port: proxy.port,
    user: proxy.user, database: proxy.database, password: "none (IAM)" }));
  const stop = () => { proxy.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", code: error?.code ?? "GCP_FASTPATH_CONNECTION_FAILED",
      message: String(error?.message ?? "") }));
    process.exitCode = 1;
  }
}
