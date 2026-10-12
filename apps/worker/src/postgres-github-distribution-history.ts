/**
 * GitHub snapshot writer for the PostgreSQL origin. Network I/O holds no
 * connection or database lock. Claiming the singleton lease rechecks due
 * state under a row lock; publishing rechecks ownership and expiry and commits
 * releases, assets, manifest and success state together. A failed attempt
 * preserves every last-good value. No migration or analytics kernel is needed.
 */
import {
  assetSnapshotRows,
  GITHUB_DISTRIBUTION_FORCED_SYNC_COOLDOWN_MILLISECONDS,
  GITHUB_DISTRIBUTION_SNAPSHOT_INTERVAL_MILLISECONDS,
  GITHUB_DISTRIBUTION_SYNC_LEASE_MILLISECONDS,
  githubInventoryFailureCode,
  readGithubInventory,
  releaseSnapshotRows,
  type GithubDistributionSyncResult,
  type GithubInventory,
} from "./github-distribution-history";
import {
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-client";

const TRANSACTION_OPTIONS = Object.freeze({
  operation: "github_distribution.sync",
  statementTimeoutMilliseconds: 5_000,
  lockTimeoutMilliseconds: 500,
});

interface SyncState {
  readonly last_attempted_at: string | null;
  readonly last_success_at: string | null;
  readonly last_failure_code: string | null;
  readonly last_observed_at: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: string | null;
}

function iso(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("GITHUB_UNAVAILABLE");
  return new Date(value).toISOString();
}

function timestamp(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`;
}

function failure(code: unknown): "GITHUB_RELEASES_BOUNDED" | "GITHUB_UNAVAILABLE" | null {
  if (code === null) return null;
  return code === "GITHUB_RELEASES_BOUNDED" ? code : "GITHUB_UNAVAILABLE";
}

async function lockedState(client: PostgresClient, schema: string): Promise<SyncState> {
  const result = await client.query<SyncState>(`SELECT
    ${timestamp("last_attempted_at")}, ${timestamp("last_success_at")},
    last_failure_code, ${timestamp("last_observed_at")},
    lease_token, ${timestamp("lease_expires_at")}
    FROM ${schema}.github_distribution_sync_state WHERE singleton = 1 FOR UPDATE`);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) throw new Error("GITHUB_UNAVAILABLE");
  return row;
}

function existing(code: "GITHUB_SYNC_FRESH" | "GITHUB_SYNC_IN_PROGRESS", state: SyncState): GithubDistributionSyncResult {
  return { code, observedAt: state.last_observed_at, failureCode: failure(state.last_failure_code) };
}

async function writeSnapshot(client: PostgresClient, schema: string, inventory: GithubInventory, observedAt: string) {
  // These reviewed bindings are also the D1 writer's projection. No upstream
  // fields beyond the public snapshot contract can enter PostgreSQL.
  const releases = releaseSnapshotRows(inventory, observedAt).map((row) => ({
    release_id: row[1], release_tag: row[2], release_published_at: row[3], release_prerelease: row[4] === 1,
  }));
  const assets = assetSnapshotRows(inventory, observedAt).map((row) => ({
    release_id: row[1], release_tag: row[2], release_published_at: row[3], release_prerelease: row[4] === 1,
    asset_id: row[5], asset_name: row[6], asset_digest: row[7], asset_download_count: row[8], is_dmg: row[9] === 1,
  }));
  await client.query(`DELETE FROM ${schema}.github_release_asset_snapshots WHERE observed_at = $1::timestamptz`, [observedAt]);
  await client.query(`DELETE FROM ${schema}.github_release_snapshots WHERE observed_at = $1::timestamptz`, [observedAt]);
  await client.query(`DELETE FROM ${schema}.github_distribution_snapshots WHERE observed_at = $1::timestamptz`, [observedAt]);
  await client.query(`INSERT INTO ${schema}.github_release_snapshots
    (observed_at, release_id, release_tag, release_published_at, release_prerelease)
    SELECT $1::timestamptz, r.* FROM jsonb_to_recordset($2::jsonb) AS r(
      release_id bigint, release_tag text, release_published_at timestamptz, release_prerelease boolean)`,
  [observedAt, JSON.stringify(releases)]);
  await client.query(`INSERT INTO ${schema}.github_release_asset_snapshots
    (observed_at, release_id, release_tag, release_published_at, release_prerelease,
      asset_id, asset_name, asset_digest, asset_download_count, is_dmg)
    SELECT $1::timestamptz, r.* FROM jsonb_to_recordset($2::jsonb) AS r(
      release_id bigint, release_tag text, release_published_at timestamptz, release_prerelease boolean,
      asset_id bigint, asset_name text, asset_digest text, asset_download_count bigint, is_dmg boolean)`,
  [observedAt, JSON.stringify(assets)]);
  await client.query(`INSERT INTO ${schema}.github_distribution_snapshots (observed_at, completed_at)
    VALUES ($1::timestamptz, $1::timestamptz)`, [observedAt]);
}

/** The D1 result and timing contract, with PostgreSQL transactional visibility. */
export async function syncPostgresGithubDistributionSnapshots({
  pool, schema, enabled, githubApiToken, nowEpoch = Date.now(), fetcher = fetch,
  force = false, clock = Date.now,
}: {
  readonly pool: PostgresPool;
  readonly schema: string;
  readonly enabled: boolean;
  readonly githubApiToken?: unknown;
  readonly nowEpoch?: number;
  readonly fetcher?: typeof fetch;
  readonly force?: boolean;
  readonly clock?: () => number;
}): Promise<GithubDistributionSyncResult> {
  if (!enabled) return { code: "DISTRIBUTION_DISABLED", observedAt: null, failureCode: null };
  const token = crypto.randomUUID();
  let quoted = "";
  let now = "";
  let claimed = false;
  try {
    quoted = quotePostgresIdentifier(schema);
    now = iso(nowEpoch);
    const expiresAt = iso(nowEpoch + GITHUB_DISTRIBUTION_SYNC_LEASE_MILLISECONDS);
    const result = await withPostgresMutation(pool, async (client) => {
      const state = await lockedState(client, quoted);
      if ((!force && state.last_success_at !== null
          && Date.parse(state.last_success_at) >= nowEpoch - GITHUB_DISTRIBUTION_SNAPSHOT_INTERVAL_MILLISECONDS)
          || (force && state.last_attempted_at !== null
          && Date.parse(state.last_attempted_at) > nowEpoch - GITHUB_DISTRIBUTION_FORCED_SYNC_COOLDOWN_MILLISECONDS)) {
        return existing("GITHUB_SYNC_FRESH", state);
      }
      if (state.lease_expires_at !== null && Date.parse(state.lease_expires_at) > nowEpoch) {
        return existing("GITHUB_SYNC_IN_PROGRESS", state);
      }
      await client.query(`UPDATE ${quoted}.github_distribution_sync_state
        SET lease_token = $1, lease_expires_at = $2::timestamptz WHERE singleton = 1`, [token, expiresAt]);
      return null;
    }, TRANSACTION_OPTIONS);
    if (result !== null) return result;
    claimed = true;
    const inventory = await readGithubInventory(githubApiToken, fetcher);
    return await withPostgresMutation(pool, async (client) => {
      const state = await lockedState(client, quoted);
      if (state.lease_token !== token || state.lease_expires_at === null
          || Date.parse(state.lease_expires_at) <= clock()) throw new Error("GITHUB_UNAVAILABLE");
      await writeSnapshot(client, quoted, inventory, now);
      // Check expiry again after the bounded writes. Holding the singleton
      // row lock prevents a successor from claiming between this and COMMIT.
      if (Date.parse(state.lease_expires_at) <= clock()) throw new Error("GITHUB_UNAVAILABLE");
      await client.query(`UPDATE ${quoted}.github_distribution_sync_state
        SET last_attempted_at = $1::timestamptz, last_success_at = $1::timestamptz,
          last_observed_at = $1::timestamptz, last_failure_code = NULL,
          lease_token = NULL, lease_expires_at = NULL WHERE singleton = 1 AND lease_token = $2`, [now, token]);
      return { code: "GITHUB_SYNCED" as const, observedAt: now, failureCode: null };
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    const failureCode = githubInventoryFailureCode(error);
    if (claimed) {
      try {
        await withPostgresMutation(pool, async (client) => {
          await client.query(`UPDATE ${quoted}.github_distribution_sync_state
            SET last_attempted_at = $1::timestamptz, last_failure_code = $2,
              lease_token = NULL, lease_expires_at = NULL
            WHERE singleton = 1 AND lease_token = $3`, [now, failureCode, token]);
        }, TRANSACTION_OPTIONS);
      } catch {
        // Storage may itself be unavailable; the lease expires without a
        // new manifest. Never replace the source failure with driver details.
      }
    }
    return { code: "GITHUB_SYNC_FAILED", observedAt: null, failureCode };
  }
}
