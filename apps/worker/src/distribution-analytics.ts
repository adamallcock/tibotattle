import stableSparkleReleaseContract from "./sparkle-release-contract.json";

const ANALYTICS_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const GITHUB_REPOSITORY = "adamallcock/tibotattle";
const GITHUB_RELEASE_ENDPOINT =
  `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
const UPDATE_HOST = new URL(stableSparkleReleaseContract.updateOrigin).hostname;
const LOOKBACK_DAYS = 7 as const;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const GRAPHQL_ROW_LIMIT = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const FETCH_TIMEOUT_MILLISECONDS = 8_000;
const MAX_RENDERED_VERSIONS = 12;

const ANALYTICS_QUERY = `
  query TiboTattleDistribution($zoneTag: string, $start: Time, $end: Time) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        appcast: httpRequestsAdaptiveGroups(
          limit: ${GRAPHQL_ROW_LIMIT}
          filter: {
            datetime_geq: $start
            datetime_lt: $end
            clientRequestHTTPHost: "${UPDATE_HOST}"
            clientRequestPath: "/appcast.xml"
            requestSource: "eyeball"
          }
        ) {
          count
          avg { sampleInterval }
          dimensions { clientIP userAgent edgeResponseStatus }
        }
        releases: httpRequestsAdaptiveGroups(
          limit: ${GRAPHQL_ROW_LIMIT}
          filter: {
            datetime_geq: $start
            datetime_lt: $end
            clientRequestHTTPHost: "${UPDATE_HOST}"
            clientRequestPath_like: "/releases/%"
            requestSource: "eyeball"
          }
        ) {
          count
          avg { sampleInterval }
          dimensions { clientIP userAgent edgeResponseStatus }
        }
      }
    }
  }
`;

type SourceStatus = "available" | "not_configured" | "unavailable";

export interface DistributionAnalyticsConfiguration {
  /** Disable all external reads outside the production owner console. */
  readonly enabled: boolean;
  readonly cloudflareZoneId?: unknown;
  readonly cloudflareApiToken?: unknown;
  readonly githubApiToken?: unknown;
}

export interface DistributionWindowCounts {
  readonly last24Hours: number;
  readonly last7Days: number;
}

export interface DistributionRequestCounts {
  readonly requests: DistributionWindowCounts;
  readonly sourceAddresses: DistributionWindowCounts;
}

export interface DistributionVersionActivity {
  readonly version: string;
  readonly requestsLast7Days: number;
  readonly sourceAddressesLast7Days: number;
}

export interface CloudflareDistributionAnalytics {
  readonly status: SourceStatus;
  readonly reasonCode: string | null;
  readonly sampled: boolean | null;
  readonly bounded: boolean | null;
  readonly window: {
    readonly startsAt: string;
    readonly endsAt: string;
  } | null;
  readonly activeSourceAddresses: DistributionWindowCounts | null;
  readonly preflight: DistributionRequestCounts | null;
  readonly sparkleChecks: DistributionRequestCounts | null;
  readonly sparkleDownloads: DistributionRequestCounts | null;
  readonly currentVersion: string | null;
  readonly currentVersionSourceAddresses: DistributionWindowCounts | null;
  readonly observedVersions: readonly DistributionVersionActivity[];
  readonly observedVersionsBounded: boolean;
}

export interface GithubDistributionAnalytics {
  readonly status: SourceStatus;
  readonly reasonCode: string | null;
  readonly repository: string;
  readonly release: {
    readonly tag: string;
    readonly publishedAt: string;
    readonly dmgDownloads: number;
    readonly allAssetDownloads: number;
  } | null;
}

export interface DistributionAnalyticsOverview {
  readonly methodology: {
    readonly unit: "distinct_source_ip_addresses";
    readonly lookbackDays: 7;
    readonly storesRawAddresses: false;
  };
  readonly cloudflare: CloudflareDistributionAnalytics;
  readonly github: GithubDistributionAnalytics;
}

interface AnalyticsRow {
  readonly count: number;
  readonly sampleInterval: number;
  readonly clientIP: string;
  readonly userAgent: string;
  readonly edgeResponseStatus: number;
}

interface AnalyticsSegment {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly appcast: readonly AnalyticsRow[];
  readonly releases: readonly AnalyticsRow[];
  readonly bounded: boolean;
}

interface GithubRelease {
  readonly tag: string;
  readonly publishedAt: string;
  readonly dmgDownloads: number;
  readonly allAssetDownloads: number;
}

interface VersionAccumulator {
  requestsLast7Days: number;
  readonly sourceAddressesLast24Hours: Set<string>;
  readonly sourceAddressesLast7Days: Set<string>;
}

function configuredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid external analytics response");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid external analytics response");
  }
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid external analytics response");
  }
  return value;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("invalid external analytics response");
  }
  return Number(value);
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("external analytics count overflow");
  }
  return result;
}

function sourceUnavailable(
  status: Exclude<SourceStatus, "available">,
  reasonCode: string,
): CloudflareDistributionAnalytics {
  return {
    status,
    reasonCode,
    sampled: null,
    bounded: null,
    window: null,
    activeSourceAddresses: null,
    preflight: null,
    sparkleChecks: null,
    sparkleDownloads: null,
    currentVersion: null,
    currentVersionSourceAddresses: null,
    observedVersions: [],
    observedVersionsBounded: false,
  };
}

function githubUnavailable(
  status: Exclude<SourceStatus, "available">,
  reasonCode: string,
): GithubDistributionAnalytics {
  return {
    status,
    reasonCode,
    repository: GITHUB_REPOSITORY,
    release: null,
  };
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("distribution analytics timeout"),
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
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength)
        || parsedLength < 0
        || parsedLength > MAX_RESPONSE_BYTES) {
      throw new Error("external analytics response too large");
    }
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("external analytics response too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid external analytics response");
  }
}

function parseAnalyticsRows(value: unknown): readonly AnalyticsRow[] {
  return array(value).map((item) => {
    const row = record(item);
    const average = record(row.avg);
    const dimensions = record(row.dimensions);
    const sampleInterval = Number(average.sampleInterval);
    const edgeResponseStatus = Number(dimensions.edgeResponseStatus);
    const clientIP = string(dimensions.clientIP);
    const rawUserAgent = dimensions.userAgent;
    if (!Number.isFinite(sampleInterval) || sampleInterval < 1
        || !Number.isSafeInteger(edgeResponseStatus)
        || edgeResponseStatus < 100
        || edgeResponseStatus > 599
        || clientIP.length > 128
        || (rawUserAgent !== null
          && rawUserAgent !== undefined
          && typeof rawUserAgent !== "string")) {
      throw new Error("invalid external analytics response");
    }
    return {
      count: count(row.count),
      sampleInterval,
      clientIP,
      userAgent: typeof rawUserAgent === "string"
        ? rawUserAgent.slice(0, 2_048)
        : "",
      edgeResponseStatus,
    };
  });
}

function parseAnalyticsResponse(
  value: unknown,
  startsAt: string,
  endsAt: string,
): AnalyticsSegment {
  const root = record(value);
  if (root.errors !== undefined
      && root.errors !== null
      && array(root.errors).length > 0) {
    throw new Error("external analytics query failed");
  }
  const data = record(root.data);
  const viewer = record(data.viewer);
  const zones = array(viewer.zones);
  if (zones.length !== 1) {
    throw new Error("invalid external analytics response");
  }
  const zone = record(zones[0]);
  const appcast = parseAnalyticsRows(zone.appcast);
  const releases = parseAnalyticsRows(zone.releases);
  return {
    startsAt,
    endsAt,
    appcast,
    releases,
    bounded:
      appcast.length >= GRAPHQL_ROW_LIMIT
      || releases.length >= GRAPHQL_ROW_LIMIT,
  };
}

async function readAnalyticsSegment(
  zoneId: string,
  apiToken: string,
  startsAt: string,
  endsAt: string,
  fetcher: typeof fetch,
): Promise<AnalyticsSegment> {
  const response = await fetchWithTimeout(fetcher, ANALYTICS_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: ANALYTICS_QUERY,
      variables: { zoneTag: zoneId, start: startsAt, end: endsAt },
    }),
  });
  if (!response.ok) {
    throw new Error("external analytics query failed");
  }
  return parseAnalyticsResponse(await boundedJson(response), startsAt, endsAt);
}

function analyticsSegments(nowEpoch: number): readonly {
  startsAt: string;
  endsAt: string;
}[] {
  const firstStart = nowEpoch - LOOKBACK_DAYS * DAY_MILLISECONDS;
  return Array.from({ length: LOOKBACK_DAYS }, (_, index) => {
    const startsAtEpoch = firstStart + index * DAY_MILLISECONDS;
    return {
      startsAt: new Date(startsAtEpoch).toISOString(),
      endsAt: new Date(startsAtEpoch + DAY_MILLISECONDS).toISOString(),
    };
  });
}

function isSuccessfulCheck(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

function isSuccessfulDownload(status: number): boolean {
  return status >= 200 && status < 300;
}

function appVersion(userAgent: string): string | null {
  return userAgent.match(
    /TiboTattle\/([0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/u,
  )?.[1] ?? null;
}

function releaseVersion(tag: string): string | null {
  const value = tag.startsWith("v") ? tag.slice(1) : tag;
  return /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)
    ? value
    : null;
}

function addRequest(
  row: AnalyticsRow,
  inLast24Hours: boolean,
  accumulator: {
    requestsLast24Hours: number;
    requestsLast7Days: number;
    readonly sourceAddressesLast24Hours: Set<string>;
    readonly sourceAddressesLast7Days: Set<string>;
  },
): void {
  accumulator.requestsLast7Days = safeAdd(
    accumulator.requestsLast7Days,
    row.count,
  );
  accumulator.sourceAddressesLast7Days.add(row.clientIP);
  if (inLast24Hours) {
    accumulator.requestsLast24Hours = safeAdd(
      accumulator.requestsLast24Hours,
      row.count,
    );
    accumulator.sourceAddressesLast24Hours.add(row.clientIP);
  }
}

function requestAccumulator(): {
  requestsLast24Hours: number;
  requestsLast7Days: number;
  readonly sourceAddressesLast24Hours: Set<string>;
  readonly sourceAddressesLast7Days: Set<string>;
} {
  return {
    requestsLast24Hours: 0,
    requestsLast7Days: 0,
    sourceAddressesLast24Hours: new Set(),
    sourceAddressesLast7Days: new Set(),
  };
}

function projectRequestAccumulator(
  value: ReturnType<typeof requestAccumulator>,
): DistributionRequestCounts {
  return {
    requests: {
      last24Hours: value.requestsLast24Hours,
      last7Days: value.requestsLast7Days,
    },
    sourceAddresses: {
      last24Hours: value.sourceAddressesLast24Hours.size,
      last7Days: value.sourceAddressesLast7Days.size,
    },
  };
}

function aggregateAnalytics(
  segments: readonly AnalyticsSegment[],
  currentVersion: string | null,
): CloudflareDistributionAnalytics {
  if (segments.length !== LOOKBACK_DAYS) {
    throw new Error("incomplete external analytics window");
  }
  const activeAddressesLast24Hours = new Set<string>();
  const activeAddressesLast7Days = new Set<string>();
  const preflight = requestAccumulator();
  const sparkleChecks = requestAccumulator();
  const sparkleDownloads = requestAccumulator();
  const versions = new Map<string, VersionAccumulator>();
  let sampled = false;
  let bounded = false;

  segments.forEach((segment, index) => {
    const inLast24Hours = index === segments.length - 1;
    bounded ||= segment.bounded;
    for (const row of [...segment.appcast, ...segment.releases]) {
      sampled ||= row.sampleInterval > 1;
    }
    for (const row of segment.appcast) {
      if (!isSuccessfulCheck(row.edgeResponseStatus)) continue;
      const agent = row.userAgent.toLowerCase();
      const isSparkle = agent.includes("sparkle");
      const isTiboTattle = agent.includes("tibotattle/");
      if (!isSparkle && !isTiboTattle) continue;

      activeAddressesLast7Days.add(row.clientIP);
      if (inLast24Hours) activeAddressesLast24Hours.add(row.clientIP);
      addRequest(row, inLast24Hours, isSparkle ? sparkleChecks : preflight);

      const version = appVersion(row.userAgent);
      if (version !== null) {
        const accumulator = versions.get(version) ?? {
          requestsLast7Days: 0,
          sourceAddressesLast24Hours: new Set<string>(),
          sourceAddressesLast7Days: new Set<string>(),
        };
        accumulator.requestsLast7Days = safeAdd(
          accumulator.requestsLast7Days,
          row.count,
        );
        accumulator.sourceAddressesLast7Days.add(row.clientIP);
        if (inLast24Hours) {
          accumulator.sourceAddressesLast24Hours.add(row.clientIP);
        }
        versions.set(version, accumulator);
      }
    }
    for (const row of segment.releases) {
      if (!isSuccessfulDownload(row.edgeResponseStatus)
          || !row.userAgent.toLowerCase().includes("sparkle")) {
        continue;
      }
      addRequest(row, inLast24Hours, sparkleDownloads);
    }
  });

  const observedVersions = [...versions.entries()]
    .map(([version, value]) => ({
      version,
      requestsLast7Days: value.requestsLast7Days,
      sourceAddressesLast7Days: value.sourceAddressesLast7Days.size,
    }))
    .sort((left, right) =>
      right.sourceAddressesLast7Days - left.sourceAddressesLast7Days
      || right.requestsLast7Days - left.requestsLast7Days
      || left.version.localeCompare(right.version))
    .slice(0, MAX_RENDERED_VERSIONS);
  const current = currentVersion === null ? undefined : versions.get(currentVersion);
  return {
    status: "available",
    reasonCode: null,
    sampled,
    bounded,
    window: {
      startsAt: segments[0]?.startsAt ?? "",
      endsAt: segments.at(-1)?.endsAt ?? "",
    },
    activeSourceAddresses: {
      last24Hours: activeAddressesLast24Hours.size,
      last7Days: activeAddressesLast7Days.size,
    },
    preflight: projectRequestAccumulator(preflight),
    sparkleChecks: projectRequestAccumulator(sparkleChecks),
    sparkleDownloads: projectRequestAccumulator(sparkleDownloads),
    currentVersion,
    currentVersionSourceAddresses: currentVersion === null
      ? null
      : {
        last24Hours: current?.sourceAddressesLast24Hours.size ?? 0,
        last7Days: current?.sourceAddressesLast7Days.size ?? 0,
      },
    observedVersions,
    observedVersionsBounded: versions.size > MAX_RENDERED_VERSIONS,
  };
}

async function readGithubRelease(
  apiToken: string | null,
  fetcher: typeof fetch,
): Promise<GithubRelease> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "TiboTattle-owner-dashboard",
    "x-github-api-version": "2022-11-28",
  };
  if (apiToken !== null) headers.authorization = `Bearer ${apiToken}`;
  const response = await fetchWithTimeout(fetcher, GITHUB_RELEASE_ENDPOINT, {
    method: "GET",
    headers,
  });
  if (!response.ok) throw new Error("GitHub release query failed");
  const body = record(await boundedJson(response));
  const tag = string(body.tag_name);
  const publishedAt = string(body.published_at);
  let dmgDownloads = 0;
  let allAssetDownloads = 0;
  for (const value of array(body.assets)) {
    const asset = record(value);
    const name = string(asset.name);
    const downloads = count(asset.download_count);
    allAssetDownloads = safeAdd(allAssetDownloads, downloads);
    if (name.toLowerCase().endsWith(".dmg")) {
      dmgDownloads = safeAdd(dmgDownloads, downloads);
    }
  }
  return { tag, publishedAt, dmgDownloads, allAssetDownloads };
}

/**
 * Reads only aggregate distribution evidence for the Access-protected owner
 * console. Cloudflare source addresses exist only in this function's transient
 * memory and are reduced to counts before the response is returned.
 */
export async function readDistributionAnalytics(
  configuration: DistributionAnalyticsConfiguration,
  nowEpoch = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<DistributionAnalyticsOverview> {
  if (!Number.isFinite(nowEpoch)) throw new Error("invalid analytics time");
  const methodology = {
    unit: "distinct_source_ip_addresses" as const,
    lookbackDays: LOOKBACK_DAYS,
    storesRawAddresses: false as const,
  };
  if (!configuration.enabled) {
    return {
      methodology,
      cloudflare: sourceUnavailable("not_configured", "DISTRIBUTION_DISABLED"),
      github: githubUnavailable("not_configured", "DISTRIBUTION_DISABLED"),
    };
  }

  const zoneId = configuredString(configuration.cloudflareZoneId);
  const cloudflareApiToken = configuredString(configuration.cloudflareApiToken);
  const githubApiToken = configuredString(configuration.githubApiToken);
  const githubPromise = readGithubRelease(githubApiToken, fetcher)
    .then((release): GithubDistributionAnalytics => ({
      status: "available",
      reasonCode: null,
      repository: GITHUB_REPOSITORY,
      release,
    }))
    .catch(() => githubUnavailable("unavailable", "GITHUB_UNAVAILABLE"));

  const analyticsPromise = zoneId === null || cloudflareApiToken === null
    ? Promise.resolve<readonly AnalyticsSegment[] | null>(null)
    : Promise.all(
      analyticsSegments(nowEpoch).map(({ startsAt, endsAt }) =>
        readAnalyticsSegment(
          zoneId,
          cloudflareApiToken,
          startsAt,
          endsAt,
          fetcher,
        )),
    ).catch(() => [] as readonly AnalyticsSegment[]);

  const [segments, github] = await Promise.all([analyticsPromise, githubPromise]);
  let cloudflare: CloudflareDistributionAnalytics;
  if (segments === null) {
    cloudflare = sourceUnavailable(
      "not_configured",
      "ANALYTICS_NOT_CONFIGURED",
    );
  } else if (segments.length !== LOOKBACK_DAYS) {
    cloudflare = sourceUnavailable("unavailable", "ANALYTICS_UNAVAILABLE");
  } else {
    try {
      cloudflare = aggregateAnalytics(
        segments,
        github.release === null ? null : releaseVersion(github.release.tag),
      );
    } catch {
      cloudflare = sourceUnavailable("unavailable", "ANALYTICS_UNAVAILABLE");
    }
  }
  return { methodology, cloudflare, github };
}
