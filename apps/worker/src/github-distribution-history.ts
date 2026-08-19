/**
 * Owner-only GitHub release evidence.
 *
 * GitHub's release-asset API exposes a cumulative counter, not installs or a
 * historical time series. This module therefore treats the live API as an
 * inventory of public assets and writes bounded, content-free snapshots only
 * after a complete read. A failed or bounded read never overwrites the last
 * known good snapshot with zeroes or a partial total.
 */

export type DistributionSourceStatus =
  | "available"
  | "not_configured"
  | "unavailable";

const GITHUB_REPOSITORY = "adamallcock/tibotattle";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_RELEASES_ENDPOINT =
  `${GITHUB_API_ORIGIN}/repos/${GITHUB_REPOSITORY}/releases`;
const GITHUB_PAGE_SIZE = 100;
const MAX_GITHUB_RELEASE_PAGES = 4;
const MAX_GITHUB_RELEASES = GITHUB_PAGE_SIZE * MAX_GITHUB_RELEASE_PAGES;
const MAX_GITHUB_ASSET_PAGES_PER_RELEASE = 4;
const MAX_GITHUB_ASSETS_PER_RELEASE =
  GITHUB_PAGE_SIZE * MAX_GITHUB_ASSET_PAGES_PER_RELEASE;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const FETCH_TIMEOUT_MILLISECONDS = 8_000;
const SNAPSHOT_INTERVAL_MILLISECONDS = 15 * 60 * 1_000;
const FORCED_SYNC_COOLDOWN_MILLISECONDS = 60 * 1_000;
const SYNC_LEASE_MILLISECONDS = 2 * 60 * 1_000;
const D1_BATCH_SIZE = 50;

export interface GithubDistributionRelease {
  readonly id: number;
  readonly tag: string;
  readonly publishedAt: string;
  readonly prerelease: boolean;
  readonly dmgDownloads: number;
  readonly allAssetDownloads: number;
  readonly dmgAssetCount: number;
  readonly assetCount: number;
}

export interface GithubDistributionSummary {
  readonly dmgDownloads: number;
  readonly allAssetDownloads: number;
  readonly dmgAssetCount: number;
  readonly assetCount: number;
  readonly releaseCount: number;
}

export interface GithubDistributionHistory {
  readonly firstObservedAt: string | null;
  readonly previousObservedAt: string | null;
  readonly latestObservedAt: string | null;
  /** `null` until two complete snapshots exist. */
  readonly dmgDownloadsSincePrevious: number | null;
  /** Asset counters that decreased; never rendered as a negative download delta. */
  readonly counterRegressions: number;
}

export interface GithubDistributionSync {
  readonly lastAttemptedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureCode: string | null;
  readonly stale: boolean;
}

export interface GithubDistributionAnalytics {
  readonly status: DistributionSourceStatus;
  readonly reasonCode: string | null;
  readonly repository: string;
  /** Latest stable release when present; retained for the summary card. */
  readonly release: {
    readonly tag: string;
    readonly publishedAt: string;
    readonly dmgDownloads: number;
    readonly allAssetDownloads: number;
  } | null;
  readonly summary: GithubDistributionSummary | null;
  readonly releases: readonly GithubDistributionRelease[];
  readonly releasesBounded: boolean;
  readonly history: GithubDistributionHistory;
  readonly sync: GithubDistributionSync;
}

export interface GithubDistributionSyncResult {
  readonly code:
    | "DISTRIBUTION_DISABLED"
    | "GITHUB_SYNC_FRESH"
    | "GITHUB_SYNC_IN_PROGRESS"
    | "GITHUB_SYNCED"
    | "GITHUB_SYNC_FAILED";
  readonly observedAt: string | null;
  readonly failureCode: string | null;
}

interface GithubAsset {
  readonly id: number;
  readonly name: string;
  readonly digest: string | null;
  readonly downloadCount: number;
}

interface GithubReleaseInventoryRecord {
  readonly id: number;
  readonly tag: string;
  readonly publishedAt: string;
  readonly prerelease: boolean;
  readonly assets: readonly GithubAsset[];
}

interface GithubInventory {
  readonly releases: readonly GithubReleaseInventoryRecord[];
}

interface GithubSyncStateRow {
  readonly last_attempted_at: string | null;
  readonly last_success_at: string | null;
  readonly last_failure_code: string | null;
  readonly last_observed_at: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: string | null;
}

interface GithubSnapshotAssetRow {
  readonly observed_at: string;
  readonly release_id: number;
  readonly release_tag: string;
  readonly release_published_at: string;
  readonly release_prerelease: number;
  readonly asset_id: number;
  readonly asset_name: string;
  readonly asset_digest: string | null;
  readonly asset_download_count: number;
  readonly is_dmg: number;
}

interface GithubSnapshotReleaseRow {
  readonly observed_at: string;
  readonly release_id: number;
  readonly release_tag: string;
  readonly release_published_at: string;
  readonly release_prerelease: number;
}

class GithubInventoryError extends Error {
  readonly code: "GITHUB_RELEASES_BOUNDED" | "GITHUB_UNAVAILABLE";

  constructor(code: "GITHUB_RELEASES_BOUNDED" | "GITHUB_UNAVAILABLE") {
    super(code);
    this.name = "GithubInventoryError";
    this.code = code;
  }
}

function configuredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GithubInventoryError("GITHUB_UNAVAILABLE");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new GithubInventoryError("GITHUB_UNAVAILABLE");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GithubInventoryError("GITHUB_UNAVAILABLE");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return string(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new GithubInventoryError("GITHUB_UNAVAILABLE");
  return value;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new GithubInventoryError("GITHUB_UNAVAILABLE");
  }
  return Number(value);
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new GithubInventoryError("GITHUB_UNAVAILABLE");
  }
  return result;
}

function isDmg(name: string): boolean {
  return name.toLowerCase().endsWith(".dmg");
}

function githubHeaders(apiToken: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "TiboTattle-owner-dashboard",
    "x-github-api-version": "2022-11-28",
  };
  if (apiToken !== null) headers.authorization = `Bearer ${apiToken}`;
  return headers;
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("GitHub distribution timeout"),
    FETCH_TIMEOUT_MILLISECONDS,
  );
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_RESPONSE_BYTES) {
      throw new GithubInventoryError("GITHUB_UNAVAILABLE");
    }
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new GithubInventoryError("GITHUB_UNAVAILABLE");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GithubInventoryError("GITHUB_UNAVAILABLE");
  }
}

function hasNextPage(response: Response): boolean {
  const links = response.headers.get("link");
  return links !== null
    && links.split(",").some((entry) => /;\s*rel="next"\s*$/u.test(entry.trim()));
}

function parseAsset(value: unknown): GithubAsset {
  const asset = record(value);
  return {
    id: count(asset.id),
    name: string(asset.name),
    digest: nullableString(asset.digest),
    downloadCount: count(asset.download_count),
  };
}

function parseRelease(value: unknown): GithubReleaseInventoryRecord | null {
  const release = record(value);
  // Draft releases are private/unpublished inventory. They must never become
  // part of a public-download total even when an owner token can read them.
  if (boolean(release.draft)) {
    return null;
  }
  const assets = array(release.assets).map(parseAsset);
  return {
    id: count(release.id),
    tag: string(release.tag_name),
    publishedAt: string(release.published_at),
    prerelease: boolean(release.prerelease),
    assets,
  };
}

async function readAdditionalReleaseAssets(
  release: GithubReleaseInventoryRecord,
  apiToken: string | null,
  fetcher: typeof fetch,
): Promise<readonly GithubAsset[]> {
  // GitHub embeds the first asset page on the release record. Only ask the
  // dedicated asset endpoint when that page is full, which keeps the normal
  // small-release path to one request while still handling pagination safely.
  if (release.assets.length < GITHUB_PAGE_SIZE) return release.assets;
  const assets = [...release.assets];
  for (let page = 2; page <= MAX_GITHUB_ASSET_PAGES_PER_RELEASE; page += 1) {
    const url = `${GITHUB_RELEASES_ENDPOINT}/${release.id}/assets?per_page=${GITHUB_PAGE_SIZE}&page=${page}`;
    const response = await fetchWithTimeout(fetcher, url, {
      method: "GET",
      headers: githubHeaders(apiToken),
    });
    if (!response.ok) throw new GithubInventoryError("GITHUB_UNAVAILABLE");
    const pageAssets = array(await boundedJson(response)).map(parseAsset);
    assets.push(...pageAssets);
    const next = hasNextPage(response);
    if (!next) return assets;
    if (assets.length >= MAX_GITHUB_ASSETS_PER_RELEASE
        || page === MAX_GITHUB_ASSET_PAGES_PER_RELEASE) {
      throw new GithubInventoryError("GITHUB_RELEASES_BOUNDED");
    }
  }
  throw new GithubInventoryError("GITHUB_RELEASES_BOUNDED");
}

async function readGithubInventory(
  apiToken: string | null,
  fetcher: typeof fetch,
): Promise<GithubInventory> {
  const releases: GithubReleaseInventoryRecord[] = [];
  for (let page = 1; page <= MAX_GITHUB_RELEASE_PAGES; page += 1) {
    const response = await fetchWithTimeout(
      fetcher,
      `${GITHUB_RELEASES_ENDPOINT}?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
      { method: "GET", headers: githubHeaders(apiToken) },
    );
    if (!response.ok) throw new GithubInventoryError("GITHUB_UNAVAILABLE");
    const candidates = array(await boundedJson(response));
    for (const candidate of candidates) {
      const parsed = parseRelease(candidate);
      if (parsed === null) continue;
      const assets = await readAdditionalReleaseAssets(
        parsed,
        apiToken,
        fetcher,
      );
      releases.push({ ...parsed, assets });
      if (releases.length > MAX_GITHUB_RELEASES) {
        throw new GithubInventoryError("GITHUB_RELEASES_BOUNDED");
      }
    }
    const next = hasNextPage(response);
    if (!next) break;
    if (page === MAX_GITHUB_RELEASE_PAGES) {
      throw new GithubInventoryError("GITHUB_RELEASES_BOUNDED");
    }
  }
  return { releases };
}

function releaseSummary(release: GithubReleaseInventoryRecord): GithubDistributionRelease {
  let dmgDownloads = 0;
  let allAssetDownloads = 0;
  let dmgAssetCount = 0;
  for (const asset of release.assets) {
    allAssetDownloads = safeAdd(allAssetDownloads, asset.downloadCount);
    if (isDmg(asset.name)) {
      dmgAssetCount += 1;
      dmgDownloads = safeAdd(dmgDownloads, asset.downloadCount);
    }
  }
  return {
    id: release.id,
    tag: release.tag,
    publishedAt: release.publishedAt,
    prerelease: release.prerelease,
    dmgDownloads,
    allAssetDownloads,
    dmgAssetCount,
    assetCount: release.assets.length,
  };
}

function summarizeReleases(
  releases: readonly GithubDistributionRelease[],
): GithubDistributionSummary {
  let dmgDownloads = 0;
  let allAssetDownloads = 0;
  let dmgAssetCount = 0;
  let assetCount = 0;
  for (const release of releases) {
    dmgDownloads = safeAdd(dmgDownloads, release.dmgDownloads);
    allAssetDownloads = safeAdd(allAssetDownloads, release.allAssetDownloads);
    dmgAssetCount = safeAdd(dmgAssetCount, release.dmgAssetCount);
    assetCount = safeAdd(assetCount, release.assetCount);
  }
  return {
    dmgDownloads,
    allAssetDownloads,
    dmgAssetCount,
    assetCount,
    releaseCount: releases.length,
  };
}

function compareReleases(
  left: GithubDistributionRelease,
  right: GithubDistributionRelease,
): number {
  return right.publishedAt.localeCompare(left.publishedAt)
    || left.tag.localeCompare(right.tag)
    || left.id - right.id;
}

function emptyHistory(): GithubDistributionHistory {
  return {
    firstObservedAt: null,
    previousObservedAt: null,
    latestObservedAt: null,
    dmgDownloadsSincePrevious: null,
    counterRegressions: 0,
  };
}

function emptySync(): GithubDistributionSync {
  return {
    lastAttemptedAt: null,
    lastSuccessAt: null,
    lastFailureCode: null,
    stale: false,
  };
}

export function githubUnavailable(
  status: Exclude<DistributionSourceStatus, "available">,
  reasonCode: string,
  sync: GithubDistributionSync = emptySync(),
): GithubDistributionAnalytics {
  return {
    status,
    reasonCode,
    repository: GITHUB_REPOSITORY,
    release: null,
    summary: null,
    releases: [],
    releasesBounded: false,
    history: emptyHistory(),
    sync,
  };
}

function analyticsFromInventory(
  inventory: GithubInventory,
  history: GithubDistributionHistory = emptyHistory(),
  sync: GithubDistributionSync = emptySync(),
): GithubDistributionAnalytics {
  const releases = inventory.releases.map(releaseSummary).sort(compareReleases);
  const latest = releases.find((release) => !release.prerelease) ?? releases[0];
  return {
    status: "available",
    reasonCode: null,
    repository: GITHUB_REPOSITORY,
    release: latest
      ? {
        tag: latest.tag,
        publishedAt: latest.publishedAt,
        dmgDownloads: latest.dmgDownloads,
        allAssetDownloads: latest.allAssetDownloads,
      }
      : null,
    summary: summarizeReleases(releases),
    releases,
    releasesBounded: false,
    history,
    sync,
  };
}

/**
 * Live inventory used as a safe fallback outside the snapshot-backed owner
 * route and by focused tests. Production overview reads snapshots instead so
 * opening a tab never turns into a GitHub polling loop.
 */
export async function readGithubDistributionInventory(
  githubApiToken: unknown,
  fetcher: typeof fetch = fetch,
): Promise<GithubDistributionAnalytics> {
  try {
    return analyticsFromInventory(
      await readGithubInventory(configuredString(githubApiToken), fetcher),
    );
  } catch (error) {
    const code = error instanceof GithubInventoryError
      ? error.code
      : "GITHUB_UNAVAILABLE";
    return githubUnavailable("unavailable", code);
  }
}

function isoAt(nowEpoch: number): string {
  if (!Number.isFinite(nowEpoch)) throw new Error("invalid GitHub sync time");
  return new Date(nowEpoch).toISOString();
}

function rowIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("invalid GitHub distribution state");
  }
  return value;
}

function rowCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("invalid GitHub distribution state");
  }
  return Number(value);
}

function rowBoolean(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw new Error("invalid GitHub distribution state");
  return value === 1;
}

function syncFromRow(row: GithubSyncStateRow, nowEpoch: number): GithubDistributionSync {
  const lastAttemptedAt = rowIso(row.last_attempted_at);
  const lastSuccessAt = rowIso(row.last_success_at);
  const lastFailureCode = row.last_failure_code === null
    ? null
    : string(row.last_failure_code);
  const stale = lastSuccessAt !== null
    && Date.parse(lastSuccessAt) < nowEpoch - SNAPSHOT_INTERVAL_MILLISECONDS * 3;
  return { lastAttemptedAt, lastSuccessAt, lastFailureCode, stale };
}

async function readSyncState(db: D1Database): Promise<GithubSyncStateRow> {
  const row = await db.prepare(
    `SELECT last_attempted_at,
            last_success_at,
            last_failure_code,
            last_observed_at,
            lease_token,
            lease_expires_at
       FROM github_distribution_sync_state
      WHERE singleton = 1`,
  ).first<GithubSyncStateRow>();
  if (!row) throw new Error("missing GitHub distribution sync state");
  return row;
}

type SnapshotReleaseBinding = readonly [string, number, string, string, number];
type SnapshotAssetBinding = readonly [
  string,
  number,
  string,
  string,
  number,
  number,
  string,
  string | null,
  number,
  number,
];

function releaseSnapshotRows(
  inventory: GithubInventory,
  observedAt: string,
): SnapshotReleaseBinding[] {
  return inventory.releases.map((release) => [
    observedAt,
    release.id,
    release.tag,
    release.publishedAt,
    Number(release.prerelease),
  ]);
}

function assetSnapshotRows(
  inventory: GithubInventory,
  observedAt: string,
): SnapshotAssetBinding[] {
  const rows: SnapshotAssetBinding[] = [];
  for (const release of inventory.releases) {
    for (const asset of release.assets) {
      rows.push([
        observedAt,
        release.id,
        release.tag,
        release.publishedAt,
        Number(release.prerelease),
        asset.id,
        asset.name,
        asset.digest,
        asset.downloadCount,
        Number(isDmg(asset.name)),
      ]);
    }
  }
  return rows;
}

async function writeSnapshot(
  db: D1Database,
  inventory: GithubInventory,
  observedAt: string,
): Promise<void> {
  // A manifest is deliberately inserted last. If a D1 batch fails part-way
  // through, the orphaned rows are invisible to all reader queries and cannot
  // replace the last complete snapshot with a partial total.
  await db.batch([
    db.prepare(
      "DELETE FROM github_release_asset_snapshots WHERE observed_at = ?",
    ).bind(observedAt),
    db.prepare("DELETE FROM github_release_snapshots WHERE observed_at = ?")
      .bind(observedAt),
    db.prepare("DELETE FROM github_distribution_snapshots WHERE observed_at = ?")
      .bind(observedAt),
  ]);
  const releases = releaseSnapshotRows(inventory, observedAt);
  for (let offset = 0; offset < releases.length; offset += D1_BATCH_SIZE) {
    const statements = releases.slice(offset, offset + D1_BATCH_SIZE).map((row) =>
      db.prepare(
        `INSERT INTO github_release_snapshots (
          observed_at,
          release_id,
          release_tag,
          release_published_at,
          release_prerelease
        ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(...row),
    );
    if (statements.length > 0) await db.batch(statements);
  }
  const assets = assetSnapshotRows(inventory, observedAt);
  for (let offset = 0; offset < assets.length; offset += D1_BATCH_SIZE) {
    const statements = assets.slice(offset, offset + D1_BATCH_SIZE).map((row) =>
      db.prepare(
        `INSERT OR REPLACE INTO github_release_asset_snapshots (
          observed_at,
          release_id,
          release_tag,
          release_published_at,
          release_prerelease,
          asset_id,
          asset_name,
          asset_digest,
          asset_download_count,
          is_dmg
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(...row),
    );
    if (statements.length > 0) await db.batch(statements);
  }
  await db.prepare(
    `INSERT INTO github_distribution_snapshots (observed_at, completed_at)
     VALUES (?, ?)`,
  ).bind(observedAt, observedAt).run();
}

async function releaseSyncLease(
  db: D1Database,
  token: string,
  details: {
    readonly attemptedAt: string;
    readonly successAt?: string | null;
    readonly observedAt?: string | null;
    readonly failureCode?: string | null;
  },
): Promise<void> {
  await db.prepare(
    `UPDATE github_distribution_sync_state
        SET last_attempted_at = ?,
            last_success_at = COALESCE(?, last_success_at),
            last_failure_code = ?,
            last_observed_at = COALESCE(?, last_observed_at),
            lease_token = NULL,
            lease_expires_at = NULL
      WHERE singleton = 1 AND lease_token = ?`,
  ).bind(
    details.attemptedAt,
    details.successAt ?? null,
    details.failureCode ?? null,
    details.observedAt ?? null,
    token,
  ).run();
}

/**
 * Collects an all-release GitHub inventory only when due (or owner-forced),
 * then records an atomic per-asset snapshot. An incomplete inventory is
 * represented as a failed attempt and leaves the last successful snapshot in
 * place, preventing false download drops.
 */
export async function syncGithubDistributionSnapshots(
  db: D1Database,
  {
    enabled,
    githubApiToken,
  }: {
    readonly enabled: boolean;
    readonly githubApiToken?: unknown;
  },
  nowEpoch = Date.now(),
  fetcher: typeof fetch = fetch,
  { force = false }: { readonly force?: boolean } = {},
): Promise<GithubDistributionSyncResult> {
  if (!enabled) {
    return {
      code: "DISTRIBUTION_DISABLED",
      observedAt: null,
      failureCode: null,
    };
  }
  const now = isoAt(nowEpoch);
  const beforeLease = await readSyncState(db);
  const lastAttemptedEpoch = beforeLease.last_attempted_at === null
    ? null
    : Date.parse(beforeLease.last_attempted_at);
  const lastSuccessEpoch = beforeLease.last_success_at === null
    ? null
    : Date.parse(beforeLease.last_success_at);
  if (lastSuccessEpoch !== null
      && lastSuccessEpoch >= nowEpoch - SNAPSHOT_INTERVAL_MILLISECONDS
      && !force) {
    return {
      code: "GITHUB_SYNC_FRESH",
      observedAt: beforeLease.last_observed_at,
      failureCode: beforeLease.last_failure_code,
    };
  }
  if (force && lastAttemptedEpoch !== null
      && lastAttemptedEpoch > nowEpoch - FORCED_SYNC_COOLDOWN_MILLISECONDS) {
    return {
      code: "GITHUB_SYNC_FRESH",
      observedAt: beforeLease.last_observed_at,
      failureCode: beforeLease.last_failure_code,
    };
  }

  const token = crypto.randomUUID();
  const expiresAt = isoAt(nowEpoch + SYNC_LEASE_MILLISECONDS);
  const acquired = await db.prepare(
    `UPDATE github_distribution_sync_state
        SET lease_token = ?, lease_expires_at = ?
      WHERE singleton = 1
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  ).bind(token, expiresAt, now).run();
  if (acquired.meta.changes !== 1) {
    return {
      code: "GITHUB_SYNC_IN_PROGRESS",
      observedAt: beforeLease.last_observed_at,
      failureCode: beforeLease.last_failure_code,
    };
  }

  try {
    const afterLease = await readSyncState(db);
    const afterLeaseSuccessEpoch = afterLease.last_success_at === null
      ? null
      : Date.parse(afterLease.last_success_at);
    if (!force && afterLeaseSuccessEpoch !== null
        && afterLeaseSuccessEpoch >= nowEpoch - SNAPSHOT_INTERVAL_MILLISECONDS) {
      await releaseSyncLease(db, token, { attemptedAt: now });
      return {
        code: "GITHUB_SYNC_FRESH",
        observedAt: afterLease.last_observed_at,
        failureCode: afterLease.last_failure_code,
      };
    }
    const inventory = await readGithubInventory(
      configuredString(githubApiToken),
      fetcher,
    );
    const observedAt = now;
    await writeSnapshot(db, inventory, observedAt);
    await releaseSyncLease(db, token, {
      attemptedAt: now,
      successAt: now,
      observedAt,
      failureCode: null,
    });
    return { code: "GITHUB_SYNCED", observedAt, failureCode: null };
  } catch (error) {
    const failureCode = error instanceof GithubInventoryError
      ? error.code
      : "GITHUB_UNAVAILABLE";
    try {
      await releaseSyncLease(db, token, {
        attemptedAt: now,
        failureCode,
      });
    } catch {
      // The lease expiry remains a fail-open availability backstop. Preserve
      // the original source failure rather than masking it with lease cleanup.
    }
    return {
      code: "GITHUB_SYNC_FAILED",
      observedAt: null,
      failureCode,
    };
  }
}

function parseSnapshotInventory(
  releaseRows: readonly GithubSnapshotReleaseRow[],
  assetRows: readonly GithubSnapshotAssetRow[],
): GithubInventory {
  const releases = new Map<number, {
    id: number;
    tag: string;
    publishedAt: string;
    prerelease: boolean;
    assets: GithubAsset[];
  }>();
  for (const row of releaseRows) {
    const releaseId = rowCount(row.release_id);
    if (releases.has(releaseId)) {
      throw new Error("duplicate GitHub release snapshot");
    }
    releases.set(releaseId, {
      id: releaseId,
      tag: string(row.release_tag),
      publishedAt: string(row.release_published_at),
      prerelease: rowBoolean(row.release_prerelease),
      assets: [],
    });
  }
  for (const row of assetRows) {
    const releaseId = rowCount(row.release_id);
    const assetId = rowCount(row.asset_id);
    const release = releases.get(releaseId);
    if (!release) {
      throw new Error("GitHub asset snapshot has no release");
    }
    const assetName = string(row.asset_name);
    const persistedDmg = rowBoolean(row.is_dmg);
    if (persistedDmg !== isDmg(assetName)) {
      throw new Error("inconsistent GitHub asset snapshot");
    }
    release.assets.push({
      id: assetId,
      name: assetName,
      digest: row.asset_digest === null ? null : string(row.asset_digest),
      downloadCount: rowCount(row.asset_download_count),
    });
  }
  return { releases: [...releases.values()] };
}

function snapshotAssetMap(
  rows: readonly GithubSnapshotAssetRow[],
): Map<number, GithubSnapshotAssetRow> {
  const assets = new Map<number, GithubSnapshotAssetRow>();
  for (const row of rows) assets.set(rowCount(row.asset_id), row);
  return assets;
}

async function snapshotReleaseRows(
  db: D1Database,
  observedAt: string,
): Promise<readonly GithubSnapshotReleaseRow[]> {
  const result = await db.prepare(
    `SELECT observed_at,
            release_id,
            release_tag,
            release_published_at,
            release_prerelease
       FROM github_release_snapshots
      WHERE observed_at = ?
      ORDER BY release_published_at DESC, release_id`,
  ).bind(observedAt).all<GithubSnapshotReleaseRow>();
  return result.results;
}

async function snapshotAssetRows(
  db: D1Database,
  observedAt: string,
): Promise<readonly GithubSnapshotAssetRow[]> {
  const result = await db.prepare(
    `SELECT observed_at,
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
      ORDER BY release_published_at DESC, release_id, asset_id`,
  ).bind(observedAt).all<GithubSnapshotAssetRow>();
  return result.results;
}

/** Reads the last complete snapshot without making any third-party request. */
export async function readGithubDistributionSnapshot(
  db: D1Database,
  nowEpoch = Date.now(),
): Promise<GithubDistributionAnalytics> {
  const state = await readSyncState(db);
  const sync = syncFromRow(state, nowEpoch);
  const latestObservedAt = rowIso(state.last_observed_at);
  if (latestObservedAt === null || sync.lastSuccessAt === null) {
    return githubUnavailable(
      "unavailable",
      state.last_failure_code === null
        ? "GITHUB_SNAPSHOT_PENDING"
        : string(state.last_failure_code),
      sync,
    );
  }
  const manifest = await db.prepare(
    `SELECT observed_at
       FROM github_distribution_snapshots
      WHERE observed_at = ?`,
  ).bind(latestObservedAt).first<{ observed_at: string }>();
  if (!manifest) {
    return githubUnavailable("unavailable", "GITHUB_SNAPSHOT_MISSING", sync);
  }
  const [currentReleaseRows, currentAssetRows] = await Promise.all([
    snapshotReleaseRows(db, latestObservedAt),
    snapshotAssetRows(db, latestObservedAt),
  ]);
  const first = await db.prepare(
    `SELECT MIN(observed_at) AS observed_at
       FROM github_distribution_snapshots`,
  ).first<{ observed_at: string | null }>();
  const previous = await db.prepare(
    `SELECT MAX(observed_at) AS observed_at
       FROM github_distribution_snapshots
      WHERE observed_at < ?`,
  ).bind(latestObservedAt).first<{ observed_at: string | null }>();
  const firstObservedAt = rowIso(first?.observed_at ?? null);
  const previousObservedAt = rowIso(previous?.observed_at ?? null);
  let dmgDownloadsSincePrevious: number | null = null;
  let counterRegressions = 0;
  if (previousObservedAt !== null) {
    const previousAssets = snapshotAssetMap(
      await snapshotAssetRows(db, previousObservedAt),
    );
    let delta = 0;
    for (const row of currentAssetRows) {
      if (!rowBoolean(row.is_dmg)) continue;
      const currentCount = rowCount(row.asset_download_count);
      const prior = previousAssets.get(rowCount(row.asset_id));
      if (prior === undefined) {
        delta = safeAdd(delta, currentCount);
      } else {
        const previousCount = rowCount(prior.asset_download_count);
        if (currentCount < previousCount) counterRegressions += 1;
        else delta = safeAdd(delta, currentCount - previousCount);
      }
    }
    dmgDownloadsSincePrevious = delta;
  }
  return analyticsFromInventory(
    parseSnapshotInventory(currentReleaseRows, currentAssetRows),
    {
      firstObservedAt,
      previousObservedAt,
      latestObservedAt,
      dmgDownloadsSincePrevious,
      counterRegressions,
    },
    sync,
  );
}

export const GITHUB_DISTRIBUTION_SNAPSHOT_INTERVAL_MILLISECONDS =
  SNAPSHOT_INTERVAL_MILLISECONDS;
