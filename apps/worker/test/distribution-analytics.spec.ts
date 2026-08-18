import { describe, expect, it, vi } from "vitest";

import { readDistributionAnalytics } from "../src/distribution-analytics";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const ANALYTICS_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const GITHUB_ENDPOINT =
  "https://api.github.com/repos/adamallcock/tibotattle/releases?per_page=100&page=1";

function analyticsRow({
  count = 1,
  sampleInterval = 1,
  clientIP,
  userAgent,
  edgeResponseStatus = 200,
}: {
  count?: number;
  sampleInterval?: number;
  clientIP: string;
  userAgent: string;
  edgeResponseStatus?: number;
}): object {
  return {
    count,
    avg: { sampleInterval },
    dimensions: { clientIP, userAgent, edgeResponseStatus },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pagedJsonResponse(
  value: unknown,
  link: string | null,
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(link === null ? {} : { link }),
    },
  });
}

function githubRelease(): object[] {
  return [{
    id: 12,
    tag_name: "v0.1.12",
    published_at: "2026-08-15T18:00:00.000Z",
    draft: false,
    prerelease: false,
    assets: [
      { id: 1201, name: "TiboTattle-0.1.12.dmg", download_count: 88 },
      { id: 1202, name: "SHA256SUMS.txt", download_count: 13 },
    ],
  }];
}

describe("owner distribution analytics", () => {
  it("aggregates app call-ins without returning source addresses or user agents", async () => {
    const segmentStarts: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GITHUB_ENDPOINT) return jsonResponse(githubRelease());
      expect(url).toBe(ANALYTICS_ENDPOINT);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer analytics-secret",
      );
      const body = JSON.parse(String(init?.body)) as {
        variables: { start: string; end: string };
      };
      const { start, end } = body.variables;
      segmentStarts.push(start);
      expect(Date.parse(end) - Date.parse(start)).toBe(24 * 60 * 60 * 1_000);
      const isFirst = start === "2026-08-10T12:00:00.000Z";
      const isLast = start === "2026-08-16T12:00:00.000Z";
      const appcast = [
        analyticsRow({
          count: 2,
          sampleInterval: isFirst ? 2 : 1,
          clientIP: "203.0.113.1",
          userAgent: "TiboTattle/0.1.12 CFNetwork/1",
        }),
      ];
      if (isFirst) {
        appcast.push(analyticsRow({
          clientIP: "203.0.113.5",
          userAgent: "TiboTattle/0.1.12 CFNetwork/1",
        }));
      }
      if (isLast) {
        appcast.push(
          analyticsRow({
            count: 3,
            clientIP: "203.0.113.2",
            userAgent: "TiboTattle/0.1.12 Sparkle/2.9.3",
            edgeResponseStatus: 304,
          }),
          analyticsRow({
            clientIP: "203.0.113.4",
            userAgent: "TiboTattle/0.1.11 CFNetwork/1",
          }),
          analyticsRow({
            count: 999,
            clientIP: "203.0.113.99",
            userAgent: "Mozilla/5.0",
          }),
        );
      }
      const releases = isLast
        ? [
          analyticsRow({
            clientIP: "203.0.113.2",
            userAgent: "TiboTattle/0.1.12 Sparkle/2.9.3",
            edgeResponseStatus: 206,
          }),
          analyticsRow({
            count: 20,
            clientIP: "203.0.113.99",
            userAgent: "Mozilla/5.0",
          }),
        ]
        : [];
      return jsonResponse({
        data: { viewer: { zones: [{ appcast, releases }] } },
        errors: null,
      });
    }) as unknown as typeof fetch;

    const overview = await readDistributionAnalytics({
      enabled: true,
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "analytics-secret",
    }, NOW, fetcher);

    expect(segmentStarts.sort()).toEqual([
      "2026-08-10T12:00:00.000Z",
      "2026-08-11T12:00:00.000Z",
      "2026-08-12T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z",
      "2026-08-14T12:00:00.000Z",
      "2026-08-15T12:00:00.000Z",
      "2026-08-16T12:00:00.000Z",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(overview.cloudflare).toMatchObject({
      status: "available",
      sampled: true,
      bounded: false,
      activeSourceAddresses: { last24Hours: 3, last7Days: 4 },
      preflight: {
        requests: { last24Hours: 3, last7Days: 16 },
        sourceAddresses: { last24Hours: 2, last7Days: 3 },
      },
      sparkleChecks: {
        requests: { last24Hours: 3, last7Days: 3 },
        sourceAddresses: { last24Hours: 1, last7Days: 1 },
      },
      sparkleDownloads: {
        requests: { last24Hours: 1, last7Days: 1 },
        sourceAddresses: { last24Hours: 1, last7Days: 1 },
      },
      currentVersion: "0.1.12",
      currentVersionSourceAddresses: { last24Hours: 2, last7Days: 3 },
      observedVersions: [{
        version: "0.1.12",
        requestsLast7Days: 18,
        sourceAddressesLast7Days: 3,
      }, {
        version: "0.1.11",
        requestsLast7Days: 1,
        sourceAddressesLast7Days: 1,
      }],
    });
    expect(overview.github).toMatchObject({
      status: "available",
      repository: "adamallcock/tibotattle",
      release: {
        tag: "v0.1.12",
        dmgDownloads: 88,
        allAssetDownloads: 101,
      },
      summary: {
        dmgDownloads: 88,
        allAssetDownloads: 101,
        dmgAssetCount: 1,
        assetCount: 2,
        releaseCount: 1,
      },
      releases: [{
        id: 12,
        tag: "v0.1.12",
        prerelease: false,
        dmgDownloads: 88,
      }],
    });
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain("203.0.113");
    expect(serialized).not.toContain("CFNetwork");
    expect(serialized).not.toContain("analytics-secret");
  });

  it("does no external work when distribution evidence is disabled", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const overview = await readDistributionAnalytics(
      { enabled: false },
      NOW,
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(overview.cloudflare).toMatchObject({
      status: "not_configured",
      reasonCode: "DISTRIBUTION_DISABLED",
    });
    expect(overview.github.status).toBe("not_configured");
  });

  it("keeps GitHub evidence when Cloudflare analytics is not configured", async () => {
    const fetcher = vi.fn(async () => jsonResponse(githubRelease())) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics(
      { enabled: true, cloudflareZoneId: "zone-id" },
      NOW,
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(overview.cloudflare).toMatchObject({
      status: "not_configured",
      reasonCode: "ANALYTICS_NOT_CONFIGURED",
    });
    expect(overview.github.status).toBe("available");
  });

  it("follows GitHub pagination, excludes drafts, and keeps prereleases distinct", async () => {
    const pageTwo =
      "https://api.github.com/repos/adamallcock/tibotattle/releases?per_page=100&page=2";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === GITHUB_ENDPOINT) {
        return pagedJsonResponse([
          {
            id: 99,
            tag_name: "draft",
            published_at: "2026-08-17T00:00:00.000Z",
            draft: true,
            prerelease: false,
            assets: [],
          },
          {
            id: 12,
            tag_name: "v0.1.12",
            published_at: "2026-08-15T18:00:00.000Z",
            draft: false,
            prerelease: false,
            assets: [{ id: 1201, name: "TiboTattle-0.1.12.dmg", download_count: 88 }],
          },
        ], `<${pageTwo}>; rel="next"`);
      }
      if (String(input) === pageTwo) {
        return pagedJsonResponse([{
          id: 11,
          tag_name: "v0.1.11-rc.1",
          published_at: "2026-08-01T18:00:00.000Z",
          draft: false,
          prerelease: true,
          assets: [{ id: 1101, name: "TiboTattle-0.1.11-rc.1.dmg", download_count: 12 }],
        }], null);
      }
      throw new Error(`unexpected URL: ${String(input)}`);
    }) as unknown as typeof fetch;

    const overview = await readDistributionAnalytics(
      { enabled: true },
      NOW,
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(overview.github).toMatchObject({
      status: "available",
      summary: { releaseCount: 2, dmgDownloads: 100 },
      releases: [{ tag: "v0.1.12", prerelease: false }, {
        tag: "v0.1.11-rc.1", prerelease: true,
      }],
    });
  });

  it("keeps a valid empty analytics window available with explicit zeroes", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === GITHUB_ENDPOINT
        ? jsonResponse(githubRelease())
        : jsonResponse({
          data: { viewer: { zones: [{ appcast: [], releases: [] }] } },
          errors: null,
        })) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics({
      enabled: true,
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "analytics-secret",
    }, NOW, fetcher);
    expect(overview.cloudflare).toMatchObject({
      status: "available",
      sampled: false,
      bounded: false,
      activeSourceAddresses: { last24Hours: 0, last7Days: 0 },
      currentVersion: "0.1.12",
      currentVersionSourceAddresses: { last24Hours: 0, last7Days: 0 },
      observedVersions: [],
    });
  });

  it("degrades failed sources instead of failing the owner overview", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === GITHUB_ENDPOINT
        ? jsonResponse({}, 503)
        : jsonResponse({}, 500)) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics({
      enabled: true,
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "analytics-secret",
    }, NOW, fetcher);
    expect(overview.cloudflare).toMatchObject({
      status: "unavailable",
      reasonCode: "ANALYTICS_UNAVAILABLE",
    });
    expect(overview.github).toMatchObject({
      status: "unavailable",
      reasonCode: "GITHUB_UNAVAILABLE",
    });
  });

  it("fails malformed analytics closed and rejects invalid times", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === GITHUB_ENDPOINT
        ? jsonResponse(githubRelease())
        : jsonResponse({
          data: {
            viewer: {
              zones: [{
                appcast: [{
                  count: 1,
                  avg: { sampleInterval: 1 },
                  dimensions: {
                    clientIP: 123,
                    userAgent: "TiboTattle/0.1.12",
                    edgeResponseStatus: 200,
                  },
                }],
                releases: [],
              }],
            },
          },
          errors: null,
        })) as unknown as typeof fetch;
    const overview = await readDistributionAnalytics({
      enabled: true,
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "analytics-secret",
    }, NOW, fetcher);
    expect(overview.cloudflare).toMatchObject({
      status: "unavailable",
      reasonCode: "ANALYTICS_UNAVAILABLE",
    });
    await expect(readDistributionAnalytics(
      { enabled: false },
      Number.NaN,
      fetcher,
    )).rejects.toThrow("invalid analytics time");
  });
});
