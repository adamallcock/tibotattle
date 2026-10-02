/**
 * The admin overview's distribution block on the PostgreSQL origin (GCP,
 * C-ADMIN).
 *
 * GitHub: d43c8f92 handleAdminOverview reads readGithubDistributionSnapshot
 * (github-distribution-history.ts) over D1 in production and degrades any
 * failure to githubUnavailable('unavailable', 'GITHUB_SNAPSHOT_UNAVAILABLE').
 * The snapshot tables are primary 0022 and PT-3 imports them. Rather than
 * re-implement the Worker's private summary rules, this module runs the
 * Worker's own exported function over a read-only statement adapter: each of
 * the six exact statements that function issues is answered by its
 * PostgreSQL translation inside one REPEATABLE READ READ ONLY transaction,
 * with D1's value representation (ISO-8601 text, 0/1 booleans, numbers). Any
 * other statement is refused, so a Worker change that adds or edits a
 * statement degrades to the Worker's own unavailable block and fails the
 * pinned parity spec, instead of being answered by a guess.
 *
 * Representation: observed and sync instants were written by the Worker's
 * isoAt (Date#toISOString), so they render with milliseconds. A release's
 * published_at is GitHub's string, which carries whole seconds and no
 * fraction; it renders without a fraction when its milliseconds are zero,
 * and with them otherwise, so a GitHub-sourced value round-trips exactly.
 *
 * Cloudflare: the origin holds no Cloudflare analytics token (CR-3 refuses
 * DISTRIBUTION_ANALYTICS_API_TOKEN and DISTRIBUTION_ANALYTICS_ZONE_ID), so
 * the Worker's readDistributionAnalytics reports the Cloudflare section as not
 * configured, and the edge (EP-4 edge-origin-proxy.ts mergedOverview) replaces
 * it with its own read. The overview passes a fetcher that refuses every
 * call: the origin's overview never reaches the network.
 */
import { readDistributionAnalytics } from "./distribution-analytics";
import {
  githubUnavailable,
  readGithubDistributionSnapshot,
  type GithubDistributionAnalytics,
} from "./github-distribution-history";
import {
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-client";

const READ_TIMEOUT_MILLISECONDS = 5_000;
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/u;

export const POSTGRES_ADMIN_DISTRIBUTION_STATEMENT_UNKNOWN =
  "POSTGRES_ADMIN_DISTRIBUTION_STATEMENT_UNKNOWN";

function normalized(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

function iso(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function githubIso(column: string): string {
  return `CASE WHEN date_trunc('second', ${column}) = ${column}
    THEN to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ELSE ${iso(column)} END`;
}

interface Translation {
  readonly mode: "first" | "all";
  readonly parameters: number;
  readonly sql: (schema: string) => string;
}

/**
 * The Worker's statements (github-distribution-history.ts readSyncState,
 * readGithubDistributionSnapshot, snapshotReleaseRows and snapshotAssetRows),
 * whitespace-normalized, mapped to their PostgreSQL translations.
 */
const TRANSLATIONS: ReadonlyMap<string, Translation> = new Map([
  [normalized(`SELECT last_attempted_at,
            last_success_at,
            last_failure_code,
            last_observed_at,
            lease_token,
            lease_expires_at
       FROM github_distribution_sync_state
      WHERE singleton = 1`), {
    mode: "first",
    parameters: 0,
    sql: (s) => `SELECT ${iso("last_attempted_at")} AS last_attempted_at,
        ${iso("last_success_at")} AS last_success_at,
        last_failure_code,
        ${iso("last_observed_at")} AS last_observed_at,
        lease_token,
        ${iso("lease_expires_at")} AS lease_expires_at
      FROM ${s}."github_distribution_sync_state" WHERE singleton = 1`,
  }],
  [normalized(`SELECT observed_at
       FROM github_distribution_snapshots
      WHERE observed_at = ?`), {
    mode: "first",
    parameters: 1,
    sql: (s) => `SELECT ${iso("observed_at")} AS observed_at
      FROM ${s}."github_distribution_snapshots" WHERE observed_at = $1::timestamptz`,
  }],
  [normalized(`SELECT observed_at,
            release_id,
            release_tag,
            release_published_at,
            release_prerelease
       FROM github_release_snapshots
      WHERE observed_at = ?
      ORDER BY release_published_at DESC, release_id`), {
    mode: "all",
    parameters: 1,
    sql: (s) => `SELECT ${iso("observed_at")} AS observed_at,
        release_id::text AS release_id,
        release_tag,
        ${githubIso("release_published_at")} AS release_published_at,
        release_prerelease
      FROM ${s}."github_release_snapshots"
     WHERE observed_at = $1::timestamptz
     ORDER BY release_published_at DESC, release_id`,
  }],
  [normalized(`SELECT observed_at,
            release_id,
            release_tag,
            release_published_at,
            release_prerelease,
            asset_id,
            asset_name,
            asset_digest,
            asset_download_count,
            is_dmg
       FROM github_release_asset_snapshots
      WHERE observed_at = ?
      ORDER BY release_published_at DESC, release_id, asset_id`), {
    mode: "all",
    parameters: 1,
    sql: (s) => `SELECT ${iso("observed_at")} AS observed_at,
        release_id::text AS release_id,
        release_tag,
        ${githubIso("release_published_at")} AS release_published_at,
        release_prerelease,
        asset_id::text AS asset_id,
        asset_name,
        asset_digest,
        asset_download_count::text AS asset_download_count,
        is_dmg
      FROM ${s}."github_release_asset_snapshots"
     WHERE observed_at = $1::timestamptz
     ORDER BY release_published_at DESC, release_id, asset_id`,
  }],
  [normalized(`SELECT MIN(observed_at) AS observed_at
       FROM github_distribution_snapshots`), {
    mode: "first",
    parameters: 0,
    sql: (s) => `SELECT ${iso("MIN(observed_at)")} AS observed_at
      FROM ${s}."github_distribution_snapshots"`,
  }],
  [normalized(`SELECT MAX(observed_at) AS observed_at
       FROM github_distribution_snapshots
      WHERE observed_at < ?`), {
    mode: "first",
    parameters: 1,
    sql: (s) => `SELECT ${iso("MAX(observed_at)")} AS observed_at
      FROM ${s}."github_distribution_snapshots" WHERE observed_at < $1::timestamptz`,
  }],
]);

/** The number of Worker statements the adapter answers (pinned by the spec). */
export const POSTGRES_ADMIN_DISTRIBUTION_STATEMENT_COUNT = TRANSLATIONS.size;

function unknownStatement(): never {
  throw new Error(POSTGRES_ADMIN_DISTRIBUTION_STATEMENT_UNKNOWN);
}

/** One column as D1 returns it: 0/1 for a boolean, else the value. */
function d1Value(value: unknown): unknown {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

const INTEGER_COLUMNS: ReadonlySet<string> = new Set([
  "release_id",
  "asset_id",
  "asset_download_count",
]);

function d1Row(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    if (INTEGER_COLUMNS.has(name) && typeof value === "string" && DECIMAL.test(value)) {
      const parsed = Number(value);
      // An unsafe integer stays text, so the Worker's rowCount refuses it.
      result[name] = Number.isSafeInteger(parsed) ? parsed : value;
    } else {
      result[name] = d1Value(value);
    }
  }
  return result;
}

/** A read-only D1Database over one PostgreSQL client and schema. */
function statementAdapter(client: PostgresClient, schema: string): D1Database {
  const quoted = quotePostgresIdentifier(schema);
  const prepare = (text: string) => {
    const translation = TRANSLATIONS.get(normalized(String(text)));
    if (translation === undefined) unknownStatement();
    const statement = (values: readonly unknown[]): unknown => {
      const run = async (): Promise<Record<string, unknown>[]> => {
        if (values.length !== translation.parameters
            || values.some((value) => typeof value !== "string")) {
          unknownStatement();
        }
        const result = await client.query<Record<string, unknown>>(
          translation.sql(quoted),
          [...values],
        );
        return result.rows.map(d1Row);
      };
      return {
        bind: (...next: unknown[]) => statement(next),
        async first() {
          if (translation.mode !== "first") unknownStatement();
          const rows = await run();
          return rows[0] ?? null;
        },
        async all() {
          if (translation.mode !== "all") unknownStatement();
          return { results: await run(), success: true, meta: {} };
        },
        async run() {
          return unknownStatement();
        },
        async raw() {
          return unknownStatement();
        },
      };
    };
    return statement([]);
  };
  return {
    prepare,
    async batch() {
      return unknownStatement();
    },
    async exec() {
      return unknownStatement();
    },
    async dump() {
      return unknownStatement();
    },
    withSession() {
      return unknownStatement();
    },
  } as unknown as D1Database;
}

/**
 * The Worker's readGithubDistributionSnapshot over the PostgreSQL snapshot
 * tables. Any failure, including an unknown statement, is the Worker's own
 * githubUnavailable('unavailable', 'GITHUB_SNAPSHOT_UNAVAILABLE').
 */
export async function readPostgresGithubDistributionSnapshot(
  pool: PostgresPool,
  schema: string,
  nowEpoch: number,
): Promise<GithubDistributionAnalytics> {
  try {
    return await withPostgresRead(
      pool,
      (client) => readGithubDistributionSnapshot(statementAdapter(client, schema), nowEpoch),
      {
        operation: "admin_distribution.github_snapshot",
        statementTimeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
        lockTimeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
      },
    );
  } catch {
    return githubUnavailable("unavailable", "GITHUB_SNAPSHOT_UNAVAILABLE");
  }
}

function refusingFetcher(): Promise<Response> {
  return Promise.reject(new Error("the origin admin overview makes no network request"));
}

/**
 * The overview's distribution block exactly as d43c8f92 handleAdminOverview
 * composes it: enabled only when ENVIRONMENT is 'production'; the GitHub
 * snapshot read only then; Cloudflare from the env (absent at the origin).
 */
export async function readPostgresAdminDistribution(
  pool: PostgresPool,
  schema: string,
  env: Readonly<Record<string, unknown>>,
  nowEpoch: number,
): Promise<Awaited<ReturnType<typeof readDistributionAnalytics>>> {
  const distributionEnabled = Reflect.get(env, "ENVIRONMENT") === "production";
  const githubSnapshot = distributionEnabled
    ? await readPostgresGithubDistributionSnapshot(pool, schema, nowEpoch)
    : undefined;
  return readDistributionAnalytics({
    enabled: distributionEnabled,
    cloudflareZoneId: Reflect.get(env, "DISTRIBUTION_ANALYTICS_ZONE_ID"),
    cloudflareApiToken: Reflect.get(env, "DISTRIBUTION_ANALYTICS_API_TOKEN"),
    githubApiToken: Reflect.get(env, "DISTRIBUTION_GITHUB_API_TOKEN"),
    githubSnapshot,
  }, nowEpoch, refusingFetcher as typeof fetch);
}
