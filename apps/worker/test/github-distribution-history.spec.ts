import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  readGithubDistributionSnapshot,
  syncGithubDistributionSnapshots,
} from "../src/github-distribution-history";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

const FIRST_SYNC = Date.parse("2026-08-17T12:00:00.000Z");
const SECOND_SYNC = FIRST_SYNC + 16 * 60 * 1_000;

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
}

function migrationsBefore0037(): D1Migration[] {
  const migrations = (env as TestBindings).TEST_MIGRATIONS;
  const index = migrations.findIndex((migration) =>
    migration.name.startsWith("0037"),
  );
  expect(index).toBeGreaterThan(0);
  return migrations.slice(0, index);
}

function inventory(downloadCount: number): object[] {
  return [{
    id: 12,
    tag_name: "v0.1.12",
    published_at: "2026-08-15T18:00:00.000Z",
    draft: false,
    prerelease: false,
    assets: [{
      id: 1201,
      name: "TiboTattle-0.1.12.dmg",
      digest: "sha256:asset-1201",
      download_count: downloadCount,
    }],
  }, {
    // A release can exist before its artifacts are attached. The history must
    // retain the version rather than treating an empty asset list as missing.
    id: 11,
    tag_name: "v0.1.11",
    published_at: "2026-08-01T18:00:00.000Z",
    draft: false,
    prerelease: false,
    assets: [],
  }];
}

function githubFetcher(body: object[], status = 200): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(
      "https://api.github.com/repos/adamallcock/tibotattle/releases?per_page=100&page=1",
    );
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(async () => {
  await reset();
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
});

describe("GitHub distribution snapshot history", () => {
  it("widens the append-only owner audit without weakening its existing guards", async () => {
    await reset();
    const bindings = env as TestBindings;
    await applyD1Migrations(db(), migrationsBefore0037());
    await db().prepare(
      `INSERT INTO admin_action_audit (
        operation_id, action, actor_identity_digest, outcome, details_json, created_at
      ) VALUES (?, 'run_maintenance', ?, 'success', '{"code":"OK"}', ?)`,
    ).bind(
      "11111111-1111-4111-8111-111111111111",
      "a".repeat(64),
      "2026-08-17T12:00:00.000Z",
    ).run();

    await applyD1Migrations(db(), bindings.TEST_MIGRATIONS);
    const preserved = await db().prepare(
      "SELECT action FROM admin_action_audit",
    ).all<{ action: string }>();
    expect(preserved.results).toEqual([{ action: "run_maintenance" }]);
    await db().prepare(
      `INSERT INTO admin_action_audit (
        operation_id, action, actor_identity_digest, outcome, details_json, created_at
      ) VALUES (?, 'sync_distribution', ?, 'success', '{"code":"GITHUB_SYNCED"}', ?)`,
    ).bind(
      "22222222-2222-4222-8222-222222222222",
      "b".repeat(64),
      "2026-08-17T12:00:00.000Z",
    ).run();
    await expect(db().prepare(
      `INSERT INTO admin_action_audit (
        operation_id, action, actor_identity_digest, outcome, details_json, created_at
      ) VALUES (?, 'unknown_action', ?, 'success', '{}', ?)`,
    ).bind(
      "33333333-3333-4333-8333-333333333333",
      "c".repeat(64),
      "2026-08-17T12:00:00.000Z",
    ).run()).rejects.toThrow();
  });

  it("retains every released version and derives only future non-negative deltas", async () => {
    const first = await syncGithubDistributionSnapshots(
      db(),
      { enabled: true },
      FIRST_SYNC,
      githubFetcher(inventory(10)),
    );
    expect(first).toEqual({
      code: "GITHUB_SYNCED",
      observedAt: "2026-08-17T12:00:00.000Z",
      failureCode: null,
    });

    const initial = await readGithubDistributionSnapshot(db(), FIRST_SYNC);
    expect(initial).toMatchObject({
      status: "available",
      summary: {
        releaseCount: 2,
        dmgDownloads: 10,
        dmgAssetCount: 1,
        assetCount: 1,
      },
      history: {
        firstObservedAt: "2026-08-17T12:00:00.000Z",
        previousObservedAt: null,
        dmgDownloadsSincePrevious: null,
      },
    });
    expect(initial.releases.map((release) => release.tag)).toEqual([
      "v0.1.12",
      "v0.1.11",
    ]);
    expect(initial.releases[0]?.installerDownloads).toEqual({
      macArm64: null,
      macX64: null,
      windowsX64: null,
      linuxX64: null,
    });

    const second = await syncGithubDistributionSnapshots(
      db(),
      { enabled: true },
      SECOND_SYNC,
      githubFetcher(inventory(17)),
    );
    expect(second.code).toBe("GITHUB_SYNCED");

    const updated = await readGithubDistributionSnapshot(db(), SECOND_SYNC);
    expect(updated).toMatchObject({
      status: "available",
      summary: { dmgDownloads: 17 },
      history: {
        firstObservedAt: "2026-08-17T12:00:00.000Z",
        previousObservedAt: "2026-08-17T12:00:00.000Z",
        latestObservedAt: "2026-08-17T12:16:00.000Z",
        dmgDownloadsSincePrevious: 7,
        counterRegressions: 0,
      },
    });
  });

  it("attributes only named installer assets and keeps absent variants distinct from zero", async () => {
    const releases = [{
      id: 24,
      tag_name: "v0.1.24",
      published_at: "2026-09-23T10:00:00.000Z",
      draft: false,
      prerelease: false,
      assets: [
        { id: 1, name: "TiboTattle-0.1.24-mac-arm64.dmg", download_count: 20 },
        { id: 2, name: "TiboTattle-0.1.24-mac-x64.dmg", download_count: 0 },
        { id: 3, name: "TiboTattle-0.1.24-Windows-x64.exe", download_count: 15 },
        { id: 4, name: "TiboTattle-0.1.24-linux-x86_64.AppImage", download_count: 17 },
        { id: 5, name: "TiboTattle-0.1.24-mac-arm64.zip", download_count: 13 },
        { id: 6, name: "TiboTattle-0.1.24-mac-arm64.dmg.blockmap", download_count: 14 },
        { id: 7, name: "TiboTattle-0.1.24-unclassified.dmg", download_count: 3 },
      ],
    }, {
      id: 18,
      tag_name: "v0.1.18",
      published_at: "2026-09-05T10:00:00.000Z",
      draft: false,
      prerelease: false,
      assets: [
        { id: 8, name: "TiboTattle-0.1.18-macOS-arm64.dmg", download_count: 4 },
        { id: 9, name: "TiboTattle-0.1.18-macOS-x64.dmg", download_count: 5 },
      ],
    }];
    const synced = await syncGithubDistributionSnapshots(
      db(), { enabled: true }, FIRST_SYNC, githubFetcher(releases),
    );
    expect(synced.code).toBe("GITHUB_SYNCED");
    const snapshot = await readGithubDistributionSnapshot(db(), FIRST_SYNC);
    expect(snapshot.releases[0]).toMatchObject({
      installerDownloads: {
        macArm64: 20,
        macX64: 0,
        windowsX64: 15,
        linuxX64: 17,
      },
      dmgDownloads: 23,
      allAssetDownloads: 82,
    });
    expect(snapshot.releases[1]?.installerDownloads).toEqual({
      macArm64: 4,
      macX64: 5,
      windowsX64: null,
      linuxX64: null,
    });
    expect(snapshot.summary?.dmgDownloads).toBe(32);
  });

  it("keeps the last complete snapshot visible after a GitHub failure", async () => {
    await syncGithubDistributionSnapshots(
      db(),
      { enabled: true },
      FIRST_SYNC,
      githubFetcher(inventory(10)),
    );
    const failed = await syncGithubDistributionSnapshots(
      db(),
      { enabled: true },
      SECOND_SYNC,
      githubFetcher([], 503),
    );
    expect(failed).toEqual({
      code: "GITHUB_SYNC_FAILED",
      observedAt: null,
      failureCode: "GITHUB_UNAVAILABLE",
    });

    const retained = await readGithubDistributionSnapshot(db(), SECOND_SYNC);
    expect(retained).toMatchObject({
      status: "available",
      summary: { dmgDownloads: 10 },
      history: {
        latestObservedAt: "2026-08-17T12:00:00.000Z",
        dmgDownloadsSincePrevious: null,
      },
      sync: {
        lastFailureCode: "GITHUB_UNAVAILABLE",
      },
    });
  });
});
