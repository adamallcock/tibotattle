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
        query: string;
        variables: { start: string; end: string };
      };
      expect(body.query).toContain("/intel/appcast.xml");
      expect(body.query).toContain("/intel/releases/%");
      expect(body.query).toContain("/electron/stable/darwin-arm64/latest-mac.yml");
      expect(body.query).toContain("/electron/stable/win32-x64/latest.yml");
      expect(body.query).toContain("/electron/stable/linux-x64/latest-linux.yml");
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
      const electronMacArm64 = isLast ? [analyticsRow({
        count: 4,
        clientIP: "203.0.113.6",
        userAgent: "TiboTattle/0.1.23 electron-updater",
      })] : [];
      const electronMacX64 = isLast ? [analyticsRow({
        clientIP: "203.0.113.9",
        userAgent: "TiboTattle/0.1.23 electron-updater",
      })] : [];
      const electronWindowsX64 = isLast ? [analyticsRow({
        count: 2,
        clientIP: "203.0.113.7",
        userAgent: "TiboTattle/0.1.22 electron-updater",
      })] : [];
      const electronLinuxX64 = isLast ? [analyticsRow({
        clientIP: "203.0.113.8",
        userAgent: "Electron/39.0.0 electron-updater",
      })] : [];
      return jsonResponse({
        data: { viewer: { zones: [{
          nativeArm64: appcast,
          nativeX64: [],
          electronMacArm64,
          electronMacX64,
          electronWindowsX64,
          electronLinuxX64,
          releases,
          intelReleases: isLast ? [
            analyticsRow({
              count: 2,
              clientIP: "203.0.113.10",
              userAgent: "TiboTattle/0.1.12 Sparkle/2.9.3",
              edgeResponseStatus: 206,
            }),
            analyticsRow({
              count: 50,
              clientIP: "203.0.113.11",
              userAgent: "TiboTattle/0.1.12 Sparkle/2.9.3",
              edgeResponseStatus: 500,
            }),
          ] : [],
        }] } },
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
      activeSourceAddresses: { last24Hours: 7, last7Days: 8 },
      preflight: {
        requests: { last24Hours: 3, last7Days: 16 },
        sourceAddresses: { last24Hours: 2, last7Days: 3 },
      },
      sparkleChecks: {
        requests: { last24Hours: 3, last7Days: 3 },
        sourceAddresses: { last24Hours: 1, last7Days: 1 },
      },
      electronChecks: {
        requests: { last24Hours: 8, last7Days: 8 },
        sourceAddresses: { last24Hours: 4, last7Days: 4 },
      },
      sparkleDownloads: {
        requests: { last24Hours: 3, last7Days: 3 },
        sourceAddresses: { last24Hours: 2, last7Days: 2 },
      },
      currentVersion: "0.1.12",
      currentVersionSourceAddresses: { last24Hours: 2, last7Days: 3 },
      observedVersions: [{
        client: "native",
        operatingSystem: "macos",
        version: "0.1.12",
        requestsLast7Days: 18,
        sourceAddressesLast7Days: 3,
      }, {
        client: "electron",
        operatingSystem: "macos",
        version: "0.1.23",
        requestsLast7Days: 5,
        sourceAddressesLast7Days: 2,
      }, {
        client: "electron",
        operatingSystem: "windows",
        version: "0.1.22",
        requestsLast7Days: 2,
        sourceAddressesLast7Days: 1,
      }, {
        client: "electron",
        operatingSystem: "linux",
        version: null,
        requestsLast7Days: 1,
        sourceAddressesLast7Days: 1,
      }, {
        client: "native",
        operatingSystem: "macos",
        version: "0.1.11",
        requestsLast7Days: 1,
        sourceAddressesLast7Days: 1,
      }],
      observedTotals: {
        platforms: [{
          operatingSystem: "macos",
          requestsLast7Days: 24,
          sourceAddressesLast7Days: 6,
        }, {
          operatingSystem: "windows",
          requestsLast7Days: 2,
          sourceAddressesLast7Days: 1,
        }, {
          operatingSystem: "linux",
          requestsLast7Days: 1,
          sourceAddressesLast7Days: 1,
        }],
        overall: {
          requestsLast7Days: 27,
          sourceAddressesLast7Days: 8,
        },
      },
    });
    expect(overview.cloudflare.bySegment).toHaveLength(7);
    expect(overview.cloudflare.bySegment.slice(0, 2)).toEqual([{
      startsAt: "2026-08-10T12:00:00.000Z",
      endsAt: "2026-08-11T12:00:00.000Z",
      activeSourceAddresses: 2,
      preflightRequests: 3,
      sparkleCheckRequests: 0,
      electronCheckRequests: 0,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: 2,
    }, {
      startsAt: "2026-08-11T12:00:00.000Z",
      endsAt: "2026-08-12T12:00:00.000Z",
      activeSourceAddresses: 1,
      preflightRequests: 2,
      sparkleCheckRequests: 0,
      electronCheckRequests: 0,
      sparkleDownloadRequests: 0,
      currentVersionSourceAddresses: 1,
    }]);
    expect(overview.cloudflare.bySegment.at(-1)).toEqual({
      startsAt: "2026-08-16T12:00:00.000Z",
      endsAt: "2026-08-17T12:00:00.000Z",
      activeSourceAddresses: 7,
      preflightRequests: 3,
      sparkleCheckRequests: 3,
      electronCheckRequests: 8,
      sparkleDownloadRequests: 3,
      currentVersionSourceAddresses: 2,
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

  it("deduplicates observed totals across apps, versions, platforms, and segments before the version cap", async () => {
    const dayMilliseconds = 24 * 60 * 60 * 1_000;
    const segmentStarts = Array.from({ length: 7 }, (_, index) =>
      new Date(NOW - 7 * dayMilliseconds + index * dayMilliseconds).toISOString());
    const segmentStart = (index: number): string => {
      const value = segmentStarts[index];
      if (value === undefined) throw new Error("missing analytics segment");
      return value;
    };
    const rowsBySegment = new Map(segmentStarts.map((startsAt) => [
      startsAt,
      {
        nativeArm64: [] as object[],
        nativeX64: [] as object[],
        electronMacArm64: [] as object[],
        electronMacX64: [] as object[],
        electronWindowsX64: [] as object[],
        electronLinuxX64: [] as object[],
      },
    ]));
    rowsBySegment.get(segmentStart(0))?.nativeArm64.push(analyticsRow({
      count: 2,
      clientIP: "198.51.100.1",
      userAgent: "TiboTattle/1.0.0 CFNetwork/1",
    }));
    rowsBySegment.get(segmentStart(1))?.nativeX64.push(analyticsRow({
      count: 3,
      clientIP: "198.51.100.1",
      userAgent: "TiboTattle/1.1.0 CFNetwork/1",
    }));
    rowsBySegment.get(segmentStart(2))?.electronMacArm64.push(analyticsRow({
      count: 4,
      clientIP: "198.51.100.1",
      userAgent: "TiboTattle/2.0.0 electron-updater",
    }));
    rowsBySegment.get(segmentStart(3))?.electronWindowsX64.push(analyticsRow({
      count: 5,
      clientIP: "198.51.100.1",
      userAgent: "TiboTattle/3.0.0 electron-updater",
    }));
    rowsBySegment.get(segmentStart(4))?.electronLinuxX64.push(analyticsRow({
      count: 6,
      clientIP: "198.51.100.1",
      userAgent: "Electron/39.0.0 electron-updater",
    }));
    rowsBySegment.get(segmentStart(6))?.nativeArm64.push(...Array.from(
      { length: 20 },
      (_, index) => analyticsRow({
        clientIP: `198.51.100.${index + 2}`,
        userAgent: `TiboTattle/9.${index}.0 CFNetwork/1`,
      }),
    ));

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GITHUB_ENDPOINT) return jsonResponse(githubRelease());
      expect(url).toBe(ANALYTICS_ENDPOINT);
      const body = JSON.parse(String(init?.body)) as {
        variables: { start: string };
      };
      const rows = rowsBySegment.get(body.variables.start);
      if (rows === undefined) throw new Error("unexpected analytics segment");
      return jsonResponse({
        data: { viewer: { zones: [{
          ...rows,
          releases: [],
          intelReleases: [],
        }] } },
        errors: null,
      });
    }) as unknown as typeof fetch;

    const overview = await readDistributionAnalytics({
      enabled: true,
      cloudflareZoneId: "zone-id",
      cloudflareApiToken: "analytics-secret",
    }, NOW, fetcher);

    expect(overview.cloudflare).toMatchObject({
      status: "available",
      observedVersionsBounded: true,
      observedTotals: {
        platforms: [{
          operatingSystem: "macos",
          requestsLast7Days: 29,
          sourceAddressesLast7Days: 21,
        }, {
          operatingSystem: "windows",
          requestsLast7Days: 5,
          sourceAddressesLast7Days: 1,
        }, {
          operatingSystem: "linux",
          requestsLast7Days: 6,
          sourceAddressesLast7Days: 1,
        }],
        overall: {
          requestsLast7Days: 40,
          sourceAddressesLast7Days: 21,
        },
      },
    });
    expect(overview.cloudflare.observedVersions).toHaveLength(12);
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
      observedTotals: null,
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
          data: { viewer: { zones: [{
            nativeArm64: [],
            nativeX64: [],
            electronMacArm64: [],
            electronMacX64: [],
            electronWindowsX64: [],
            electronLinuxX64: [],
            releases: [],
            intelReleases: [],
          }] } },
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
      observedTotals: {
        platforms: [{
          operatingSystem: "macos",
          requestsLast7Days: 0,
          sourceAddressesLast7Days: 0,
        }, {
          operatingSystem: "windows",
          requestsLast7Days: 0,
          sourceAddressesLast7Days: 0,
        }, {
          operatingSystem: "linux",
          requestsLast7Days: 0,
          sourceAddressesLast7Days: 0,
        }],
        overall: { requestsLast7Days: 0, sourceAddressesLast7Days: 0 },
      },
    });
    expect(overview.cloudflare.bySegment).toHaveLength(7);
    expect(overview.cloudflare.bySegment.every((segment) => (
      segment.activeSourceAddresses === 0
      && segment.preflightRequests === 0
      && segment.sparkleCheckRequests === 0
      && segment.electronCheckRequests === 0
      && segment.sparkleDownloadRequests === 0
      && segment.currentVersionSourceAddresses === 0
    ))).toBe(true);
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
      bySegment: [],
      observedTotals: null,
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
                nativeArm64: [{
                  count: 1,
                  avg: { sampleInterval: 1 },
                  dimensions: {
                    clientIP: 123,
                    userAgent: "TiboTattle/0.1.12",
                    edgeResponseStatus: 200,
                  },
                }],
                nativeX64: [],
                electronMacArm64: [],
                electronMacX64: [],
                electronWindowsX64: [],
                electronLinuxX64: [],
                releases: [],
                intelReleases: [],
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
