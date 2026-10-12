import { describe, expect, it } from "vitest";

import {
  cloudflareDistributionFromSegments,
  readCloudflareDistributionSegments,
  readDistributionAnalytics,
  type CloudflareDistributionAnalytics,
  type CloudflareDistributionSegment,
  type DistributionAnalyticsConfiguration,
  type DistributionAnalyticsOverview,
} from "../src/distribution-analytics";
import type { GithubDistributionAnalytics } from "../src/github-distribution-history";

/*
 * Behaviour pins for splitting the Cloudflare half of the owner distribution
 * analytics into edge-reusable functions (work item EP-3).
 *
 * PRE_SPLIT_FIXTURES were recorded from readDistributionAnalytics BEFORE the
 * split, at a0fc9e39, by running the synthetic scenarios below. They pin the
 * fetch sequence and the exact overview (including key order, because the
 * admin overview serializes it verbatim). Never regenerate them from
 * refactored code: a fixture change is a behaviour change.
 *
 * The split tests then prove that readCloudflareDistributionSegments plus
 * cloudflareDistributionFromSegments (the pair the edge uses) reproduce the
 * same Cloudflare value, and that no source address or user agent from the
 * fake rows reaches any returned analytics value.
 *
 * Every address is from a documentation range (RFC 5737 / RFC 3849) and every
 * user agent, zone id and token is synthetic.
 */

const NOW = Date.parse("2026-09-20T06:00:00.000Z");
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
/** The seven 24-hour analytics windows the Cloudflare aggregate reads. */
const LOOKBACK_WINDOWS = 7;
const ANALYTICS_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const GITHUB_RELEASES_PAGE_ONE =
  "https://api.github.com/repos/adamallcock/tibotattle/releases?per_page=100&page=1";
const ZONE_ID = "fixture-zone-0001";
const API_TOKEN = "fixture-analytics-token";

const ZONE_GROUPS = [
  "nativeArm64",
  "nativeX64",
  "electronMacArm64",
  "electronMacX64",
  "electronWindowsX64",
  "electronLinuxX64",
  "releases",
  "intelReleases",
] as const;

type ZoneGroup = typeof ZONE_GROUPS[number];

interface FakeRow {
  readonly count?: number;
  readonly sampleInterval?: number;
  readonly clientIP: string;
  readonly userAgent: string | null;
  readonly edgeResponseStatus?: number;
}

type SegmentRows = Partial<Record<ZoneGroup, readonly FakeRow[]>>;

const UA_NATIVE_CURRENT = "TiboTattle/0.1.23 CFNetwork/1 Darwin/25 fixture";
const UA_SPARKLE_CURRENT = "TiboTattle/0.1.23 Sparkle/2.9.3 fixture";
const UA_SPARKLE_PREVIOUS = "TiboTattle/0.1.22 Sparkle/2.9.3 fixture";
const UA_SPARKLE_ONLY = "Sparkle/2.9.3 fixture-downloader";
const UA_ELECTRON_CURRENT = "TiboTattle/0.1.23 electron-updater fixture";
const UA_ELECTRON_PREVIOUS = "TiboTattle/0.1.22 electron-updater fixture";
const UA_ELECTRON_UNVERSIONED = "Electron/39.0.0 electron-updater fixture";
const UA_ELECTRON_BUILDER = "electron-builder fixture-client";
const UA_BROWSER = "Mozilla/5.0 fixture-browser";
const UA_UNRELATED = "curl/8.0 fixture-probe";

/** Seven 24-hour windows, oldest first; the last one is the trailing day. */
const ENABLED_ROWS: readonly SegmentRows[] = [
  {
    nativeArm64: [
      { count: 2, sampleInterval: 2, clientIP: "192.0.2.1", userAgent: UA_NATIVE_CURRENT },
      { clientIP: "192.0.2.2", userAgent: UA_SPARKLE_PREVIOUS, edgeResponseStatus: 304 },
    ],
  },
  {
    nativeArm64: [
      { clientIP: "192.0.2.2", userAgent: UA_SPARKLE_PREVIOUS, edgeResponseStatus: 304 },
    ],
    releases: [
      { clientIP: "192.0.2.4", userAgent: UA_SPARKLE_ONLY },
    ],
  },
  {
    nativeArm64: [
      { clientIP: "192.0.2.2", userAgent: UA_SPARKLE_PREVIOUS, edgeResponseStatus: 304 },
    ],
    electronWindowsX64: [
      { count: 2, clientIP: "198.51.100.7", userAgent: UA_ELECTRON_PREVIOUS },
    ],
  },
  {
    nativeX64: [
      { count: 3, clientIP: "2001:db8::1", userAgent: UA_SPARKLE_CURRENT },
    ],
  },
  {
    nativeArm64: [
      { clientIP: "203.0.113.12", userAgent: null },
      { clientIP: "192.0.2.1", userAgent: UA_NATIVE_CURRENT },
    ],
  },
  {
    electronMacArm64: [
      { count: 4, clientIP: "198.51.100.6", userAgent: UA_ELECTRON_CURRENT },
    ],
  },
  {
    nativeArm64: [
      { clientIP: "192.0.2.2", userAgent: UA_SPARKLE_PREVIOUS, edgeResponseStatus: 304 },
      { count: 999, clientIP: "192.0.2.99", userAgent: UA_BROWSER },
      { count: 5, clientIP: "192.0.2.3", userAgent: UA_SPARKLE_CURRENT, edgeResponseStatus: 500 },
      { count: 3, sampleInterval: 1.5, clientIP: "192.0.2.5", userAgent: UA_NATIVE_CURRENT },
    ],
    electronMacArm64: [
      { count: 4, clientIP: "198.51.100.6", userAgent: UA_ELECTRON_CURRENT },
    ],
    electronMacX64: [
      { clientIP: "198.51.100.9", userAgent: UA_ELECTRON_BUILDER },
    ],
    electronLinuxX64: [
      { clientIP: "198.51.100.8", userAgent: UA_ELECTRON_UNVERSIONED },
      { count: 7, clientIP: "198.51.100.10", userAgent: UA_UNRELATED },
    ],
    releases: [
      { clientIP: "192.0.2.2", userAgent: UA_SPARKLE_PREVIOUS, edgeResponseStatus: 206 },
      { count: 20, clientIP: "192.0.2.99", userAgent: UA_BROWSER },
    ],
    intelReleases: [
      { count: 2, clientIP: "2001:db8::1", userAgent: UA_SPARKLE_CURRENT, edgeResponseStatus: 206 },
      { count: 50, clientIP: "203.0.113.11", userAgent: UA_SPARKLE_CURRENT, edgeResponseStatus: 500 },
    ],
  },
];

/** Two rows whose summed count leaves the safe-integer range. */
const OVERFLOW_ROWS: readonly SegmentRows[] = ENABLED_ROWS.map((rows, index) =>
  index === 6
    ? {
      ...rows,
      nativeX64: [
        { count: 2 ** 52, clientIP: "192.0.2.20", userAgent: UA_SPARKLE_CURRENT },
        { count: 2 ** 52, clientIP: "192.0.2.21", userAgent: UA_SPARKLE_CURRENT },
      ],
    }
    : rows);

const GITHUB_RELEASES = [
  {
    id: 24,
    tag_name: "v0.1.24-rc.1",
    published_at: "2026-09-19T09:00:00.000Z",
    draft: false,
    prerelease: true,
    assets: [
      { id: 2401, name: "TiboTattle-0.1.24-rc.1-mac-arm64.dmg", download_count: 5 },
    ],
  },
  {
    id: 23,
    tag_name: "v0.1.23",
    published_at: "2026-09-12T09:00:00.000Z",
    draft: false,
    prerelease: false,
    assets: [
      { id: 2301, name: "TiboTattle-0.1.23-mac-arm64.dmg", download_count: 40 },
      { id: 2302, name: "TiboTattle-0.1.23-mac-x64.dmg", download_count: 6 },
      { id: 2303, name: "TiboTattle-0.1.23-Windows-x64.exe", download_count: 9 },
      { id: 2304, name: "SHA256SUMS.txt", download_count: 3 },
    ],
  },
];

/** The shape index.ts passes when the snapshot read fails. */
const GITHUB_SNAPSHOT_WITHOUT_RELEASE: GithubDistributionAnalytics = {
  status: "unavailable",
  reasonCode: "GITHUB_SNAPSHOT_UNAVAILABLE",
  repository: "adamallcock/tibotattle",
  release: null,
  summary: null,
  releases: [],
  releasesBounded: false,
  history: {
    firstObservedAt: null,
    previousObservedAt: null,
    latestObservedAt: null,
    dmgDownloadsSincePrevious: null,
    counterRegressions: 0,
  },
  sync: {
    lastAttemptedAt: null,
    lastSuccessAt: null,
    lastFailureCode: null,
    stale: false,
  },
};

type AnalyticsBehaviour =
  | { readonly kind: "rows"; readonly rows: readonly SegmentRows[] }
  | { readonly kind: "graphql_errors" }
  | { readonly kind: "http_status"; readonly status: number }
  | {
    readonly kind: "fail_one_segment";
    readonly failingIndex: number;
    readonly rows: readonly SegmentRows[];
  };

type GithubBehaviour =
  | { readonly kind: "releases" }
  | { readonly kind: "http_status"; readonly status: number }
  | { readonly kind: "never_called" };

interface Scenario {
  readonly name: string;
  readonly configuration: DistributionAnalyticsConfiguration;
  readonly analytics: AnalyticsBehaviour;
  readonly github: GithubBehaviour;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "enabled",
    configuration: {
      enabled: true,
      cloudflareZoneId: `  ${ZONE_ID}  `,
      cloudflareApiToken: ` ${API_TOKEN}\n`,
    },
    analytics: { kind: "rows", rows: ENABLED_ROWS },
    github: { kind: "releases" },
  },
  {
    name: "enabled with a GitHub snapshot that has no release",
    configuration: {
      enabled: true,
      cloudflareZoneId: ZONE_ID,
      cloudflareApiToken: API_TOKEN,
      githubSnapshot: GITHUB_SNAPSHOT_WITHOUT_RELEASE,
    },
    analytics: { kind: "rows", rows: ENABLED_ROWS },
    github: { kind: "never_called" },
  },
  {
    name: "disabled",
    configuration: {
      enabled: false,
      cloudflareZoneId: ZONE_ID,
      cloudflareApiToken: API_TOKEN,
      githubApiToken: "fixture-github-token",
    },
    analytics: { kind: "rows", rows: ENABLED_ROWS },
    github: { kind: "releases" },
  },
  {
    name: "not configured: blank API token",
    configuration: {
      enabled: true,
      cloudflareZoneId: ZONE_ID,
      cloudflareApiToken: "   ",
    },
    analytics: { kind: "rows", rows: ENABLED_ROWS },
    github: { kind: "releases" },
  },
  {
    name: "not configured: missing zone with a GitHub snapshot",
    configuration: {
      enabled: true,
      cloudflareApiToken: API_TOKEN,
      githubSnapshot: GITHUB_SNAPSHOT_WITHOUT_RELEASE,
    },
    analytics: { kind: "rows", rows: ENABLED_ROWS },
    github: { kind: "never_called" },
  },
  {
    name: "GraphQL failure: query errors",
    configuration: {
      enabled: true,
      cloudflareZoneId: ZONE_ID,
      cloudflareApiToken: API_TOKEN,
    },
    analytics: { kind: "graphql_errors" },
    github: { kind: "releases" },
  },
  {
    name: "GraphQL failure: HTTP 500 with GitHub HTTP 503",
    configuration: {
      enabled: true,
      cloudflareZoneId: ZONE_ID,
      cloudflareApiToken: API_TOKEN,
    },
    analytics: { kind: "http_status", status: 500 },
    github: { kind: "http_status", status: 503 },
  },
  {
    name: "segment count mismatch: one of seven windows fails",
    configuration: {
      enabled: true,
      cloudflareZoneId: ZONE_ID,
      cloudflareApiToken: API_TOKEN,
    },
    analytics: { kind: "fail_one_segment", failingIndex: 3, rows: ENABLED_ROWS },
    github: { kind: "releases" },
  },
  {
    name: "aggregation failure: count overflow",
    configuration: {
      enabled: true,
      cloudflareZoneId: ZONE_ID,
      cloudflareApiToken: API_TOKEN,
    },
    analytics: { kind: "rows", rows: OVERFLOW_ROWS },
    github: { kind: "releases" },
  },
];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeRow(row: FakeRow): object {
  return {
    count: row.count ?? 1,
    avg: { sampleInterval: row.sampleInterval ?? 1 },
    dimensions: {
      clientIP: row.clientIP,
      userAgent: row.userAgent,
      edgeResponseStatus: row.edgeResponseStatus ?? 200,
    },
  };
}

function zoneResponse(rows: SegmentRows | undefined): Response {
  if (rows === undefined) throw new Error("unexpected analytics window");
  return jsonResponse({
    data: {
      viewer: {
        zones: [Object.fromEntries(ZONE_GROUPS.map((group) => [
          group,
          (rows[group] ?? []).map(fakeRow),
        ]))],
      },
    },
    errors: null,
  });
}

/** Index of an analytics window in the seven-day lookback; 0 is the oldest. */
function lookbackIndex(start: string): number {
  return (Date.parse(start) - (NOW - 7 * DAY_MILLISECONDS)) / DAY_MILLISECONDS;
}

function windowIndex(start: string): number {
  const index = lookbackIndex(start);
  if (!Number.isInteger(index) || index < 0 || index > 6) {
    throw new Error("unexpected analytics window");
  }
  return index;
}

function analyticsResponse(behaviour: AnalyticsBehaviour, start: string): Response {
  const index = windowIndex(start);
  switch (behaviour.kind) {
    case "rows":
      return zoneResponse(behaviour.rows[index]);
    case "graphql_errors":
      return jsonResponse({ data: null, errors: [{ message: "fixture failure" }] });
    case "http_status":
      return jsonResponse({}, behaviour.status);
    case "fail_one_segment":
      return index === behaviour.failingIndex
        ? jsonResponse({ data: null, errors: [{ message: "fixture failure" }] })
        : zoneResponse(behaviour.rows[index]);
  }
}

function githubResponse(behaviour: GithubBehaviour): Response {
  switch (behaviour.kind) {
    case "releases":
      return jsonResponse(GITHUB_RELEASES);
    case "http_status":
      return jsonResponse({}, behaviour.status);
    case "never_called":
      throw new Error("GitHub must not be read in this scenario");
  }
}

/** One line per outbound request, in call order. */
function describeWindow(start: string, end: string): string {
  const index = lookbackIndex(start);
  return Number.isInteger(index) && Date.parse(end) - Date.parse(start) === DAY_MILLISECONDS
    ? String(index)
    : `invalid(${start},${end})`;
}

function fakeFetcher(scenario: Pick<Scenario, "analytics" | "github">): {
  readonly fetcher: typeof fetch;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "(default)";
    const authorization = new Headers(init?.headers).get("authorization") ?? "none";
    if (url === ANALYTICS_ENDPOINT) {
      const body = JSON.parse(String(init?.body)) as {
        readonly variables: {
          readonly zoneTag: string;
          readonly start: string;
          readonly end: string;
        };
      };
      const { zoneTag, start, end } = body.variables;
      calls.push(
        `${method} graphql window=${describeWindow(start, end)} zone=${zoneTag} auth=${authorization}`,
      );
      return analyticsResponse(scenario.analytics, start);
    }
    if (url === GITHUB_RELEASES_PAGE_ONE) {
      calls.push(`${method} github-releases page=1 auth=${authorization}`);
      return githubResponse(scenario.github);
    }
    throw new Error("unexpected fetch target");
  }) as typeof fetch;
  return { fetcher, calls };
}

// ---------------------------------------------------------------------------
// Recorded pre-split outputs (a0fc9e39). Generated once from the scenarios
// above; identical overview parts are shared by reference only.
// ---------------------------------------------------------------------------

interface PreSplitFixture {
  readonly calls: readonly string[];
  readonly overview: DistributionAnalyticsOverview;
}

const RECORDED_METHODOLOGY: DistributionAnalyticsOverview["methodology"] = {
  unit: "distinct_source_ip_addresses",
  lookbackDays: 7,
  storesRawAddresses: false,
};

const RECORDED_CLOUDFLARE_AVAILABLE_CURRENT_VERSION: CloudflareDistributionAnalytics = {
  status: "available",
  reasonCode: null,
  sampled: true,
  bounded: false,
  window: { startsAt: "2026-09-13T06:00:00.000Z", endsAt: "2026-09-20T06:00:00.000Z" },
  activeSourceAddresses: { last24Hours: 5, last7Days: 8 },
  preflight: {
    requests: { last24Hours: 3, last7Days: 6 },
    sourceAddresses: { last24Hours: 1, last7Days: 2 },
  },
  sparkleChecks: {
    requests: { last24Hours: 1, last7Days: 7 },
    sourceAddresses: { last24Hours: 1, last7Days: 2 },
  },
  electronChecks: {
    requests: { last24Hours: 6, last7Days: 12 },
    sourceAddresses: { last24Hours: 3, last7Days: 4 },
  },
  sparkleDownloads: {
    requests: { last24Hours: 3, last7Days: 4 },
    sourceAddresses: { last24Hours: 2, last7Days: 3 },
  },
  currentVersion: "0.1.23",
  currentVersionSourceAddresses: { last24Hours: 2, last7Days: 4 },
  bySegment: [
    {
      startsAt: "2026-09-13T06:00:00.000Z",
      endsAt: "2026-09-14T06:00:00.000Z",
      activeSourceAddresses: 2,
      preflightRequests: 2,
      sparkleCheckRequests: 1,
      electronCheckRequests: 0,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: 1,
    },
    {
      startsAt: "2026-09-14T06:00:00.000Z",
      endsAt: "2026-09-15T06:00:00.000Z",
      activeSourceAddresses: 1,
      preflightRequests: 0,
      sparkleCheckRequests: 1,
      electronCheckRequests: 0,
      sparkleDownloadRequests: 1,
      currentVersionSourceAddresses: 0,
    },
    {
      startsAt: "2026-09-15T06:00:00.000Z",
      endsAt: "2026-09-16T06:00:00.000Z",
      activeSourceAddresses: 2,
      preflightRequests: 0,
      sparkleCheckRequests: 1,
      electronCheckRequests: 2,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: 0,
    },
    {
      startsAt: "2026-09-16T06:00:00.000Z",
      endsAt: "2026-09-17T06:00:00.000Z",
      activeSourceAddresses: 1,
      preflightRequests: 0,
      sparkleCheckRequests: 3,
      electronCheckRequests: 0,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: 1,
    },
    {
      startsAt: "2026-09-17T06:00:00.000Z",
      endsAt: "2026-09-18T06:00:00.000Z",
      activeSourceAddresses: 1,
      preflightRequests: 1,
      sparkleCheckRequests: 0,
      electronCheckRequests: 0,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: 1,
    },
    {
      startsAt: "2026-09-18T06:00:00.000Z",
      endsAt: "2026-09-19T06:00:00.000Z",
      activeSourceAddresses: 1,
      preflightRequests: 0,
      sparkleCheckRequests: 0,
      electronCheckRequests: 4,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: 1,
    },
    {
      startsAt: "2026-09-19T06:00:00.000Z",
      endsAt: "2026-09-20T06:00:00.000Z",
      activeSourceAddresses: 5,
      preflightRequests: 3,
      sparkleCheckRequests: 1,
      electronCheckRequests: 6,
      sparkleDownloadRequests: 3,
      currentVersionSourceAddresses: 2,
    },
  ],
  observedVersions: [
    {
      client: "native",
      operatingSystem: "macos",
      architecture: "arm64",
      version: "0.1.23",
      requestsLast7Days: 6,
      sourceAddressesLast7Days: 2,
    },
    {
      client: "electron",
      operatingSystem: "macos",
      architecture: "arm64",
      version: "0.1.23",
      requestsLast7Days: 8,
      sourceAddressesLast7Days: 1,
    },
    {
      client: "native",
      operatingSystem: "macos",
      architecture: "arm64",
      version: "0.1.22",
      requestsLast7Days: 4,
      sourceAddressesLast7Days: 1,
    },
    {
      client: "native",
      operatingSystem: "macos",
      architecture: "x64",
      version: "0.1.23",
      requestsLast7Days: 3,
      sourceAddressesLast7Days: 1,
    },
    {
      client: "electron",
      operatingSystem: "windows",
      architecture: "x64",
      version: "0.1.22",
      requestsLast7Days: 2,
      sourceAddressesLast7Days: 1,
    },
    {
      client: "electron",
      operatingSystem: "linux",
      architecture: "x64",
      version: null,
      requestsLast7Days: 1,
      sourceAddressesLast7Days: 1,
    },
    {
      client: "electron",
      operatingSystem: "macos",
      architecture: "x64",
      version: null,
      requestsLast7Days: 1,
      sourceAddressesLast7Days: 1,
    },
  ],
  observedVersionsBounded: false,
  observedTotals: {
    platforms: [
      { operatingSystem: "macos", requestsLast7Days: 22, sourceAddressesLast7Days: 6 },
      { operatingSystem: "windows", requestsLast7Days: 2, sourceAddressesLast7Days: 1 },
      { operatingSystem: "linux", requestsLast7Days: 1, sourceAddressesLast7Days: 1 },
    ],
    macosArchitectures: [
      { architecture: "arm64", requestsLast7Days: 18, sourceAddressesLast7Days: 4 },
      { architecture: "x64", requestsLast7Days: 4, sourceAddressesLast7Days: 2 },
    ],
    overall: { requestsLast7Days: 25, sourceAddressesLast7Days: 8 },
  },
};

const RECORDED_GITHUB_LIVE_RELEASES: GithubDistributionAnalytics = {
  status: "available",
  reasonCode: null,
  repository: "adamallcock/tibotattle",
  release: {
    tag: "v0.1.23",
    publishedAt: "2026-09-12T09:00:00.000Z",
    dmgDownloads: 46,
    allAssetDownloads: 58,
  },
  summary: {
    dmgDownloads: 51,
    allAssetDownloads: 63,
    dmgAssetCount: 3,
    assetCount: 5,
    releaseCount: 2,
  },
  releases: [
    {
      id: 24,
      tag: "v0.1.24-rc.1",
      publishedAt: "2026-09-19T09:00:00.000Z",
      prerelease: true,
      dmgDownloads: 5,
      allAssetDownloads: 5,
      dmgAssetCount: 1,
      assetCount: 1,
      installerDownloads: { macArm64: 5, macX64: null, windowsX64: null, linuxX64: null },
    },
    {
      id: 23,
      tag: "v0.1.23",
      publishedAt: "2026-09-12T09:00:00.000Z",
      prerelease: false,
      dmgDownloads: 46,
      allAssetDownloads: 58,
      dmgAssetCount: 2,
      assetCount: 4,
      installerDownloads: { macArm64: 40, macX64: 6, windowsX64: 9, linuxX64: null },
    },
  ],
  releasesBounded: false,
  history: {
    firstObservedAt: null,
    previousObservedAt: null,
    latestObservedAt: null,
    dmgDownloadsSincePrevious: null,
    counterRegressions: 0,
  },
  sync: { lastAttemptedAt: null, lastSuccessAt: null, lastFailureCode: null, stale: false },
};

const RECORDED_CLOUDFLARE_AVAILABLE_NO_CURRENT_VERSION: CloudflareDistributionAnalytics = {
  status: "available",
  reasonCode: null,
  sampled: true,
  bounded: false,
  window: { startsAt: "2026-09-13T06:00:00.000Z", endsAt: "2026-09-20T06:00:00.000Z" },
  activeSourceAddresses: { last24Hours: 5, last7Days: 8 },
  preflight: {
    requests: { last24Hours: 3, last7Days: 6 },
    sourceAddresses: { last24Hours: 1, last7Days: 2 },
  },
  sparkleChecks: {
    requests: { last24Hours: 1, last7Days: 7 },
    sourceAddresses: { last24Hours: 1, last7Days: 2 },
  },
  electronChecks: {
    requests: { last24Hours: 6, last7Days: 12 },
    sourceAddresses: { last24Hours: 3, last7Days: 4 },
  },
  sparkleDownloads: {
    requests: { last24Hours: 3, last7Days: 4 },
    sourceAddresses: { last24Hours: 2, last7Days: 3 },
  },
  currentVersion: null,
  currentVersionSourceAddresses: null,
  bySegment: [
    {
      startsAt: "2026-09-13T06:00:00.000Z",
      endsAt: "2026-09-14T06:00:00.000Z",
      activeSourceAddresses: 2,
      preflightRequests: 2,
      sparkleCheckRequests: 1,
      electronCheckRequests: 0,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: null,
    },
    {
      startsAt: "2026-09-14T06:00:00.000Z",
      endsAt: "2026-09-15T06:00:00.000Z",
      activeSourceAddresses: 1,
      preflightRequests: 0,
      sparkleCheckRequests: 1,
      electronCheckRequests: 0,
      sparkleDownloadRequests: 1,
      currentVersionSourceAddresses: null,
    },
    {
      startsAt: "2026-09-15T06:00:00.000Z",
      endsAt: "2026-09-16T06:00:00.000Z",
      activeSourceAddresses: 2,
      preflightRequests: 0,
      sparkleCheckRequests: 1,
      electronCheckRequests: 2,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: null,
    },
    {
      startsAt: "2026-09-16T06:00:00.000Z",
      endsAt: "2026-09-17T06:00:00.000Z",
      activeSourceAddresses: 1,
      preflightRequests: 0,
      sparkleCheckRequests: 3,
      electronCheckRequests: 0,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: null,
    },
    {
      startsAt: "2026-09-17T06:00:00.000Z",
      endsAt: "2026-09-18T06:00:00.000Z",
      activeSourceAddresses: 1,
      preflightRequests: 1,
      sparkleCheckRequests: 0,
      electronCheckRequests: 0,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: null,
    },
    {
      startsAt: "2026-09-18T06:00:00.000Z",
      endsAt: "2026-09-19T06:00:00.000Z",
      activeSourceAddresses: 1,
      preflightRequests: 0,
      sparkleCheckRequests: 0,
      electronCheckRequests: 4,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: null,
    },
    {
      startsAt: "2026-09-19T06:00:00.000Z",
      endsAt: "2026-09-20T06:00:00.000Z",
      activeSourceAddresses: 5,
      preflightRequests: 3,
      sparkleCheckRequests: 1,
      electronCheckRequests: 6,
      sparkleDownloadRequests: 3,
      currentVersionSourceAddresses: null,
    },
  ],
  observedVersions: [
    {
      client: "native",
      operatingSystem: "macos",
      architecture: "arm64",
      version: "0.1.23",
      requestsLast7Days: 6,
      sourceAddressesLast7Days: 2,
    },
    {
      client: "electron",
      operatingSystem: "macos",
      architecture: "arm64",
      version: "0.1.23",
      requestsLast7Days: 8,
      sourceAddressesLast7Days: 1,
    },
    {
      client: "native",
      operatingSystem: "macos",
      architecture: "arm64",
      version: "0.1.22",
      requestsLast7Days: 4,
      sourceAddressesLast7Days: 1,
    },
    {
      client: "native",
      operatingSystem: "macos",
      architecture: "x64",
      version: "0.1.23",
      requestsLast7Days: 3,
      sourceAddressesLast7Days: 1,
    },
    {
      client: "electron",
      operatingSystem: "windows",
      architecture: "x64",
      version: "0.1.22",
      requestsLast7Days: 2,
      sourceAddressesLast7Days: 1,
    },
    {
      client: "electron",
      operatingSystem: "linux",
      architecture: "x64",
      version: null,
      requestsLast7Days: 1,
      sourceAddressesLast7Days: 1,
    },
    {
      client: "electron",
      operatingSystem: "macos",
      architecture: "x64",
      version: null,
      requestsLast7Days: 1,
      sourceAddressesLast7Days: 1,
    },
  ],
  observedVersionsBounded: false,
  observedTotals: {
    platforms: [
      { operatingSystem: "macos", requestsLast7Days: 22, sourceAddressesLast7Days: 6 },
      { operatingSystem: "windows", requestsLast7Days: 2, sourceAddressesLast7Days: 1 },
      { operatingSystem: "linux", requestsLast7Days: 1, sourceAddressesLast7Days: 1 },
    ],
    macosArchitectures: [
      { architecture: "arm64", requestsLast7Days: 18, sourceAddressesLast7Days: 4 },
      { architecture: "x64", requestsLast7Days: 4, sourceAddressesLast7Days: 2 },
    ],
    overall: { requestsLast7Days: 25, sourceAddressesLast7Days: 8 },
  },
};

const RECORDED_GITHUB_SNAPSHOT_WITHOUT_RELEASE: GithubDistributionAnalytics = {
  status: "unavailable",
  reasonCode: "GITHUB_SNAPSHOT_UNAVAILABLE",
  repository: "adamallcock/tibotattle",
  release: null,
  summary: null,
  releases: [],
  releasesBounded: false,
  history: {
    firstObservedAt: null,
    previousObservedAt: null,
    latestObservedAt: null,
    dmgDownloadsSincePrevious: null,
    counterRegressions: 0,
  },
  sync: { lastAttemptedAt: null, lastSuccessAt: null, lastFailureCode: null, stale: false },
};

const RECORDED_CLOUDFLARE_DISABLED: CloudflareDistributionAnalytics = {
  status: "not_configured",
  reasonCode: "DISTRIBUTION_DISABLED",
  sampled: null,
  bounded: null,
  window: null,
  activeSourceAddresses: null,
  preflight: null,
  sparkleChecks: null,
  electronChecks: null,
  sparkleDownloads: null,
  currentVersion: null,
  currentVersionSourceAddresses: null,
  bySegment: [],
  observedVersions: [],
  observedVersionsBounded: false,
  observedTotals: null,
};

const RECORDED_GITHUB_DISABLED: GithubDistributionAnalytics = {
  status: "not_configured",
  reasonCode: "DISTRIBUTION_DISABLED",
  repository: "adamallcock/tibotattle",
  release: null,
  summary: null,
  releases: [],
  releasesBounded: false,
  history: {
    firstObservedAt: null,
    previousObservedAt: null,
    latestObservedAt: null,
    dmgDownloadsSincePrevious: null,
    counterRegressions: 0,
  },
  sync: { lastAttemptedAt: null, lastSuccessAt: null, lastFailureCode: null, stale: false },
};

const RECORDED_CLOUDFLARE_NOT_CONFIGURED: CloudflareDistributionAnalytics = {
  status: "not_configured",
  reasonCode: "ANALYTICS_NOT_CONFIGURED",
  sampled: null,
  bounded: null,
  window: null,
  activeSourceAddresses: null,
  preflight: null,
  sparkleChecks: null,
  electronChecks: null,
  sparkleDownloads: null,
  currentVersion: null,
  currentVersionSourceAddresses: null,
  bySegment: [],
  observedVersions: [],
  observedVersionsBounded: false,
  observedTotals: null,
};

const RECORDED_CLOUDFLARE_UNAVAILABLE: CloudflareDistributionAnalytics = {
  status: "unavailable",
  reasonCode: "ANALYTICS_UNAVAILABLE",
  sampled: null,
  bounded: null,
  window: null,
  activeSourceAddresses: null,
  preflight: null,
  sparkleChecks: null,
  electronChecks: null,
  sparkleDownloads: null,
  currentVersion: null,
  currentVersionSourceAddresses: null,
  bySegment: [],
  observedVersions: [],
  observedVersionsBounded: false,
  observedTotals: null,
};

const RECORDED_GITHUB_UNAVAILABLE: GithubDistributionAnalytics = {
  status: "unavailable",
  reasonCode: "GITHUB_UNAVAILABLE",
  repository: "adamallcock/tibotattle",
  release: null,
  summary: null,
  releases: [],
  releasesBounded: false,
  history: {
    firstObservedAt: null,
    previousObservedAt: null,
    latestObservedAt: null,
    dmgDownloadsSincePrevious: null,
    counterRegressions: 0,
  },
  sync: { lastAttemptedAt: null, lastSuccessAt: null, lastFailureCode: null, stale: false },
};

const PRE_SPLIT_FIXTURES: Readonly<Record<string, PreSplitFixture>> = {
  "enabled": {
    calls: [
      "GET github-releases page=1 auth=none",
      "POST graphql window=0 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=1 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=2 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=3 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=4 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=5 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=6 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
    ],
    overview: {
      methodology: RECORDED_METHODOLOGY,
      cloudflare: RECORDED_CLOUDFLARE_AVAILABLE_CURRENT_VERSION,
      github: RECORDED_GITHUB_LIVE_RELEASES,
    },
  },
  "enabled with a GitHub snapshot that has no release": {
    calls: [
      "POST graphql window=0 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=1 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=2 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=3 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=4 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=5 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=6 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
    ],
    overview: {
      methodology: RECORDED_METHODOLOGY,
      cloudflare: RECORDED_CLOUDFLARE_AVAILABLE_NO_CURRENT_VERSION,
      github: RECORDED_GITHUB_SNAPSHOT_WITHOUT_RELEASE,
    },
  },
  "disabled": {
    calls: [],
    overview: {
      methodology: RECORDED_METHODOLOGY,
      cloudflare: RECORDED_CLOUDFLARE_DISABLED,
      github: RECORDED_GITHUB_DISABLED,
    },
  },
  "not configured: blank API token": {
    calls: ["GET github-releases page=1 auth=none"],
    overview: {
      methodology: RECORDED_METHODOLOGY,
      cloudflare: RECORDED_CLOUDFLARE_NOT_CONFIGURED,
      github: RECORDED_GITHUB_LIVE_RELEASES,
    },
  },
  "not configured: missing zone with a GitHub snapshot": {
    calls: [],
    overview: {
      methodology: RECORDED_METHODOLOGY,
      cloudflare: RECORDED_CLOUDFLARE_NOT_CONFIGURED,
      github: RECORDED_GITHUB_SNAPSHOT_WITHOUT_RELEASE,
    },
  },
  "GraphQL failure: query errors": {
    calls: [
      "GET github-releases page=1 auth=none",
      "POST graphql window=0 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=1 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=2 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=3 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=4 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=5 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=6 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
    ],
    overview: {
      methodology: RECORDED_METHODOLOGY,
      cloudflare: RECORDED_CLOUDFLARE_UNAVAILABLE,
      github: RECORDED_GITHUB_LIVE_RELEASES,
    },
  },
  "GraphQL failure: HTTP 500 with GitHub HTTP 503": {
    calls: [
      "GET github-releases page=1 auth=none",
      "POST graphql window=0 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=1 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=2 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=3 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=4 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=5 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=6 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
    ],
    overview: {
      methodology: RECORDED_METHODOLOGY,
      cloudflare: RECORDED_CLOUDFLARE_UNAVAILABLE,
      github: RECORDED_GITHUB_UNAVAILABLE,
    },
  },
  "segment count mismatch: one of seven windows fails": {
    calls: [
      "GET github-releases page=1 auth=none",
      "POST graphql window=0 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=1 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=2 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=3 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=4 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=5 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=6 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
    ],
    overview: {
      methodology: RECORDED_METHODOLOGY,
      cloudflare: RECORDED_CLOUDFLARE_UNAVAILABLE,
      github: RECORDED_GITHUB_LIVE_RELEASES,
    },
  },
  "aggregation failure: count overflow": {
    calls: [
      "GET github-releases page=1 auth=none",
      "POST graphql window=0 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=1 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=2 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=3 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=4 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=5 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
      "POST graphql window=6 zone=fixture-zone-0001 auth=Bearer fixture-analytics-token",
    ],
    overview: {
      methodology: RECORDED_METHODOLOGY,
      cloudflare: RECORDED_CLOUDFLARE_UNAVAILABLE,
      github: RECORDED_GITHUB_LIVE_RELEASES,
    },
  },
};

function preSplitFixture(name: string): PreSplitFixture {
  const fixture = PRE_SPLIT_FIXTURES[name];
  if (fixture === undefined) throw new Error(`no pre-split fixture for ${name}`);
  return fixture;
}

describe("readDistributionAnalytics keeps its pre-split behaviour", () => {
  it("has exactly one recorded fixture per scenario", () => {
    expect(Object.keys(PRE_SPLIT_FIXTURES)).toStrictEqual(
      SCENARIOS.map((candidate) => candidate.name),
    );
  });

  for (const current of SCENARIOS) {
    it(`matches the recorded fetch sequence and overview: ${current.name}`, async () => {
      const expected = preSplitFixture(current.name);
      const { fetcher, calls } = fakeFetcher(current);
      const overview = await readDistributionAnalytics(current.configuration, NOW, fetcher);
      expect(calls).toStrictEqual(expected.calls);
      expect(overview).toStrictEqual(expected.overview);
      // The owner overview serializes this object verbatim, so key order is
      // part of the byte-level contract as well.
      expect(JSON.stringify(overview)).toBe(JSON.stringify(expected.overview));
    });
  }
});

// ---------------------------------------------------------------------------
// The edge-reusable split.
// ---------------------------------------------------------------------------

function scenario(name: string): Scenario {
  const found = SCENARIOS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`unknown scenario ${name}`);
  return found;
}

async function readSegments(
  current: Pick<Scenario, "analytics" | "github">,
): Promise<readonly CloudflareDistributionSegment[]> {
  const segments = await readCloudflareDistributionSegments(
    ZONE_ID,
    API_TOKEN,
    NOW,
    fakeFetcher(current).fetcher,
  );
  if (segments === null) throw new Error("expected configured analytics");
  return segments;
}

function rowStrings(rows: readonly SegmentRows[]): string[] {
  return rows.flatMap((segment) => Object.values(segment).flatMap((groupRows) =>
    groupRows.flatMap((row) => [
      row.clientIP,
      ...(row.userAgent === null ? [] : [row.userAgent]),
    ])));
}

/** Raw values that must never leave the analytics module's transient memory. */
const FORBIDDEN_OUTPUT_STRINGS = [
  ...new Set([...rowStrings(ENABLED_ROWS), ...rowStrings(OVERFLOW_ROWS), ZONE_ID, API_TOKEN]),
];

function expectNoRawAnalyticsValues(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_OUTPUT_STRINGS) {
    expect(serialized).not.toContain(forbidden);
  }
}

describe("readCloudflareDistributionSegments + cloudflareDistributionFromSegments", () => {
  const configuredScenarios = SCENARIOS.filter((candidate) => candidate.configuration.enabled);

  for (const current of configuredScenarios) {
    it(`compose to readDistributionAnalytics(...).cloudflare: ${current.name}`, async () => {
      const overview = await readDistributionAnalytics(
        current.configuration,
        NOW,
        fakeFetcher(current).fetcher,
      );
      const { fetcher, calls } = fakeFetcher(current);
      const segments = await readCloudflareDistributionSegments(
        current.configuration.cloudflareZoneId,
        current.configuration.cloudflareApiToken,
        NOW,
        fetcher,
      );
      const composed = cloudflareDistributionFromSegments(
        segments,
        overview.github.release === null ? null : overview.github.release.tag,
      );
      const recorded = preSplitFixture(current.name);
      expect(composed).toStrictEqual(overview.cloudflare);
      expect(composed).toStrictEqual(recorded.overview.cloudflare);
      expect(JSON.stringify(composed)).toBe(JSON.stringify(recorded.overview.cloudflare));
      // The reader issues exactly the recorded GraphQL requests, in order.
      expect(calls).toStrictEqual(recorded.calls.filter((call) => call.includes(" graphql ")));
    });
  }

  it("reads nothing and returns null unless both the zone id and API token are configured", async () => {
    const unconfigured: readonly (readonly [unknown, unknown])[] = [
      [undefined, API_TOKEN],
      [ZONE_ID, undefined],
      ["", API_TOKEN],
      [ZONE_ID, " \n\t "],
      [null, API_TOKEN],
      [ZONE_ID, 42],
      [{ zone: ZONE_ID }, API_TOKEN],
      [undefined, undefined],
    ];
    for (const [zoneId, apiToken] of unconfigured) {
      const { fetcher, calls } = fakeFetcher(scenario("enabled"));
      await expect(readCloudflareDistributionSegments(zoneId, apiToken, NOW, fetcher))
        .resolves.toBeNull();
      expect(calls).toStrictEqual([]);
    }
    expect(cloudflareDistributionFromSegments(null, "v0.1.23"))
      .toStrictEqual(RECORDED_CLOUDFLARE_NOT_CONFIGURED);
    expect(cloudflareDistributionFromSegments(null, null))
      .toStrictEqual(RECORDED_CLOUDFLARE_NOT_CONFIGURED);
  });

  it("returns the seven lookback windows oldest first", async () => {
    const segments = await readSegments(scenario("enabled"));
    expect(segments.map(({ startsAt, endsAt }) => [startsAt, endsAt])).toStrictEqual(
      Array.from({ length: 7 }, (_, index) => [
        new Date(NOW - (7 - index) * DAY_MILLISECONDS).toISOString(),
        new Date(NOW - (6 - index) * DAY_MILLISECONDS).toISOString(),
      ]),
    );
  });

  it("collapses any failed window read to an empty list instead of rejecting", async () => {
    const failures: readonly AnalyticsBehaviour[] = [
      { kind: "graphql_errors" },
      { kind: "http_status", status: 500 },
      { kind: "http_status", status: 429 },
      { kind: "fail_one_segment", failingIndex: 0, rows: ENABLED_ROWS },
      { kind: "fail_one_segment", failingIndex: 6, rows: ENABLED_ROWS },
    ];
    for (const analytics of failures) {
      await expect(readSegments({ analytics, github: { kind: "never_called" } }))
        .resolves.toStrictEqual([]);
    }
    const networkFailure = (async () => {
      throw new TypeError("fixture network failure");
    }) as typeof fetch;
    await expect(readCloudflareDistributionSegments(ZONE_ID, API_TOKEN, NOW, networkFailure))
      .resolves.toStrictEqual([]);
  });

  it("rejects an invalid time before making any request", async () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { fetcher, calls } = fakeFetcher(scenario("enabled"));
      await expect(readCloudflareDistributionSegments(ZONE_ID, API_TOKEN, invalid, fetcher))
        .rejects.toThrow("invalid analytics time");
      expect(calls).toStrictEqual([]);
    }
  });

  it("maps window counts and release tags exactly like the pre-split branch", async () => {
    const segments = await readSegments(scenario("enabled"));
    const unchanged = structuredClone(segments);
    const cases: readonly (readonly [
      readonly CloudflareDistributionSegment[],
      string | null,
      CloudflareDistributionAnalytics,
    ])[] = [
      [segments, "v0.1.23", RECORDED_CLOUDFLARE_AVAILABLE_CURRENT_VERSION],
      [segments, "0.1.23", RECORDED_CLOUDFLARE_AVAILABLE_CURRENT_VERSION],
      [segments, null, RECORDED_CLOUDFLARE_AVAILABLE_NO_CURRENT_VERSION],
      [segments, "nightly", RECORDED_CLOUDFLARE_AVAILABLE_NO_CURRENT_VERSION],
      [[], "v0.1.23", RECORDED_CLOUDFLARE_UNAVAILABLE],
      [segments.slice(0, 6), "v0.1.23", RECORDED_CLOUDFLARE_UNAVAILABLE],
      [segments.slice(1), null, RECORDED_CLOUDFLARE_UNAVAILABLE],
      [[...segments, ...segments.slice(0, 1)], "v0.1.23", RECORDED_CLOUDFLARE_UNAVAILABLE],
      [await readSegments(scenario("aggregation failure: count overflow")), "v0.1.23",
        RECORDED_CLOUDFLARE_UNAVAILABLE],
    ];
    for (const [input, tag, expected] of cases) {
      const cloudflare = cloudflareDistributionFromSegments(input, tag);
      expect(cloudflare).toStrictEqual(expected);
      expect(JSON.stringify(cloudflare)).toBe(JSON.stringify(expected));
    }
    // A pure reduction: the raw windows are not modified.
    expect(segments).toStrictEqual(unchanged);
  });

  it("never returns a fake source address, user agent, zone id or token", async () => {
    expect(FORBIDDEN_OUTPUT_STRINGS.length).toBeGreaterThan(20);
    // Non-vacuous: the enabled scenario really counted the fake addresses.
    expect(RECORDED_CLOUDFLARE_AVAILABLE_CURRENT_VERSION.activeSourceAddresses?.last7Days)
      .toBeGreaterThan(0);
    for (const current of SCENARIOS) {
      const overview = await readDistributionAnalytics(
        current.configuration,
        NOW,
        fakeFetcher(current).fetcher,
      );
      expectNoRawAnalyticsValues(overview);
      const segments = await readCloudflareDistributionSegments(
        current.configuration.cloudflareZoneId,
        current.configuration.cloudflareApiToken,
        NOW,
        fakeFetcher(current).fetcher,
      );
      for (const tag of ["v0.1.23", "v0.1.22", null]) {
        expectNoRawAnalyticsValues(cloudflareDistributionFromSegments(segments, tag));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency: all seven window reads start together (and alongside the GitHub
// read in the overview), so the Cloudflare half costs one GraphQL round trip,
// not seven. The edge relies on this to overlap the reads with its forward.
// ---------------------------------------------------------------------------

/**
 * Below the 5 s Vitest test timeout and the 8 s per-request fetch timeout, so a
 * sequential reader fails as an assertion rather than as a hung test.
 */
const BARRIER_DEADLINE_MILLISECONDS = 2_000;

interface BarrierFetcher {
  readonly fetcher: typeof fetch;
  readonly calls: string[];
  /** The most requests that were held at the barrier at one time. */
  readonly maxWaiting: () => number;
  readonly dispose: () => void;
}

/**
 * Holds every request until `expected` requests have all been issued, then
 * releases them together to fakeFetcher. A reader that awaits one request
 * before issuing the next can never fill the barrier: its held request fails at
 * the deadline, or when the reader's own abort signal fires, and the readers
 * then report the source as unavailable.
 */
function barrierFetcher(
  current: Pick<Scenario, "analytics" | "github">,
  expected: number,
  deadlineMilliseconds = BARRIER_DEADLINE_MILLISECONDS,
): BarrierFetcher {
  const inner = fakeFetcher(current);
  let arrived = 0;
  let waiting = 0;
  let maxWaiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let expire!: (error: Error) => void;
  const expired = new Promise<never>((_, reject) => {
    expire = reject;
  });
  // Handled here as well, so an expiry with no held request is not reported
  // as an unhandled rejection.
  expired.catch(() => undefined);
  const deadline = setTimeout(
    () => expire(new Error("barrier not filled: requests were issued one after another")),
    deadlineMilliseconds,
  );
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    arrived += 1;
    waiting += 1;
    maxWaiting = Math.max(maxWaiting, waiting);
    if (arrived === expected) release();
    const aborted = new Promise<never>((_, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new Error("fixture request aborted")),
        { once: true },
      );
    });
    try {
      await Promise.race([released, expired, aborted]);
    } finally {
      waiting -= 1;
    }
    return inner.fetcher(input, init);
  }) as typeof fetch;
  return {
    fetcher,
    calls: inner.calls,
    maxWaiting: () => maxWaiting,
    dispose: () => clearTimeout(deadline),
  };
}

describe("the distribution reads run concurrently", () => {
  it("the barrier fetcher fails a reader that waits for each request before the next", async () => {
    const barrier = barrierFetcher(scenario("enabled"), LOOKBACK_WINDOWS, 50);
    try {
      await expect(barrier.fetcher(ANALYTICS_ENDPOINT, { method: "POST" }))
        .rejects.toThrow("barrier not filled");
      expect(barrier.maxWaiting()).toBe(1);
      expect(barrier.calls).toStrictEqual([]);
    } finally {
      barrier.dispose();
    }
  });

  it("readCloudflareDistributionSegments issues all seven window reads before any completes", async () => {
    const current = scenario("enabled");
    const barrier = barrierFetcher(current, LOOKBACK_WINDOWS);
    try {
      const segments = await readCloudflareDistributionSegments(
        ZONE_ID,
        API_TOKEN,
        NOW,
        barrier.fetcher,
      );
      expect(barrier.maxWaiting()).toBe(LOOKBACK_WINDOWS);
      expect(barrier.calls).toHaveLength(LOOKBACK_WINDOWS);
      expect(segments).toHaveLength(LOOKBACK_WINDOWS);
      expect(segments).toStrictEqual(await readSegments(current));
    } finally {
      barrier.dispose();
    }
  });

  const overviewCases: readonly (readonly [string, number])[] = [
    // Seven GraphQL windows plus the first GitHub releases page.
    ["enabled", LOOKBACK_WINDOWS + 1],
    // A supplied GitHub snapshot makes no GitHub request.
    ["enabled with a GitHub snapshot that has no release", LOOKBACK_WINDOWS],
  ];
  for (const [name, expected] of overviewCases) {
    it(`readDistributionAnalytics issues the GitHub and window reads together: ${name}`, async () => {
      const current = scenario(name);
      const recorded = preSplitFixture(name);
      expect(recorded.calls).toHaveLength(expected);
      const barrier = barrierFetcher(current, expected);
      try {
        const overview = await readDistributionAnalytics(
          current.configuration,
          NOW,
          barrier.fetcher,
        );
        expect(barrier.maxWaiting()).toBe(expected);
        // Call order is pinned by the pre-split fixture test; this one checks
        // only that the same requests were all outstanding at once.
        expect([...barrier.calls].sort()).toStrictEqual([...recorded.calls].sort());
        expect(overview).toStrictEqual(recorded.overview);
      } finally {
        barrier.dispose();
      }
    });
  }
});
