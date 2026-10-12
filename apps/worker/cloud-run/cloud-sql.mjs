import { Connector } from "@google-cloud/cloud-sql-connector";
import { GoogleAuth } from "google-auth-library";
import pg from "pg";

const { Pool } = pg;
const IAM_ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,62}$/u;
const INSTANCE_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/u;
const DATABASE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

export function normalizeIamUser(value, label = "POSTGRES_IAM_USER") {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}_MISSING`);
  }
  const user = value.endsWith(".gserviceaccount.com")
    ? value.slice(0, -".gserviceaccount.com".length)
    : value;
  if (!IAM_ROLE_PATTERN.test(user) || Buffer.byteLength(user, "utf8") > 63) {
    throw new Error(`${label}_INVALID`);
  }
  return user;
}

function required(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label}_INVALID`);
  return value;
}

export async function createIamPool({
  connector,
  instanceConnectionName,
  database,
  user,
  max,
  applicationName = "tibotattle-cloud-run-host",
}) {
  const instance = required(instanceConnectionName, "INSTANCE_CONNECTION_NAME", INSTANCE_PATTERN);
  const db = required(database, "POSTGRES_DATABASE", DATABASE_PATTERN);
  const role = normalizeIamUser(user);
  let options;
  try {
    options = await connector.getOptions({
      instanceConnectionName: instance,
      authType: "IAM",
      ipType: "PUBLIC",
    });
  } catch {
    throw new Error("CLOUD_SQL_CONNECTOR_OPTIONS_FAILED");
  }
  let pool;
  try {
    pool = new Pool({
      ...options,
      user: role,
      database: db,
      max,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: applicationName,
    });
    pool.on("error", () => {});
    await pool.query("SELECT 1 AS connected");
    return pool;
  } catch {
    try { await pool?.end(); } catch { /* closed outer error */ }
    throw new Error("POSTGRES_CONNECTION_FAILED");
  }
}

export async function createGoogleAccessTokenProvider() {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  let client;
  try {
    client = await auth.getClient();
  } catch {
    throw new Error("GOOGLE_AUTH_CLIENT_FAILED");
  }
  return async function accessToken() {
    try {
      const result = await client.getAccessToken();
      if (typeof result?.token !== "string" || result.token.length === 0) {
        throw new Error("missing token");
      }
      return result.token;
    } catch {
      throw new Error("GOOGLE_ACCESS_TOKEN_FAILED");
    }
  };
}

export async function closeCloudSqlResources({ pools = [], connector }) {
  let failure = null;
  for (const pool of [...pools].reverse()) {
    try { await pool?.end(); } catch { failure ??= "POSTGRES_POOL_CLOSE_FAILED"; }
  }
  try { await connector?.close(); } catch { failure ??= "CLOUD_SQL_CONNECTOR_CLOSE_FAILED"; }
  if (failure !== null) throw new Error(failure);
}
