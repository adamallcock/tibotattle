import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

function exactStringLiterals(source) {
  return [...source.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/gu)]
    .map(([, value]) => value);
}

test("shipping local data sources remain disclosed in every maintained user surface", async () => {
  const [
    collector,
    threadStore,
    localServer,
    appServer,
    rootReadme,
    localReadme,
    macosReadme,
    publicDocs,
    publicPrivacy,
    swiftFallback,
    nativeApp,
    ...catalogs
  ] = await Promise.all([
    text("src/passive-collector.js"),
    text("src/platform/local-codex-thread-store.js"),
    text("apps/local/server.js"),
    text("src/providers/codex/app-server.js"),
    text("README.md"),
    text("apps/local/README.md"),
    text("apps/macos/README.md"),
    text("apps/web/public/docs.html"),
    text("apps/web/public/privacy.html"),
    text("apps/macos/Sources/Localization.swift"),
    text("apps/macos/UsageMonitorApp.swift"),
    text("apps/macos/Resources/en.lproj/Localizable.strings"),
    text("apps/macos/Resources/es.lproj/Localizable.strings"),
    text("apps/macos/Resources/zh-Hans.lproj/Localizable.strings"),
  ]);

  const sourceContracts = [
    [collector, "sessions"],
    [collector, "archived_sessions"],
    [threadStore, "state_5.sqlite"],
    [localServer, "config.toml"],
    [appServer, "account/read"],
    [appServer, "account/rateLimits/read"],
    [appServer, "account/usage/read"],
  ];
  for (const [source, marker] of sourceContracts) {
    assert.ok(source.includes(marker), `source still owns ${marker}`);
  }

  for (const [surface, name] of [
    [rootReadme, "root README"],
    [localReadme, "local companion README"],
    [macosReadme, "macOS README"],
    [publicDocs, "public docs"],
    [publicPrivacy, "public privacy page"],
    [swiftFallback, "Swift localization fallback"],
    ...catalogs.map((catalog, index) => [catalog, `native catalog ${index}`]),
  ]) {
    for (const [, marker] of sourceContracts) {
      assert.ok(surface.includes(marker), `${name} discloses ${marker}`);
    }
    assert.doesNotMatch(
      surface,
      /plan-usage-history\.json/u,
      `${name} does not disclose the retired Claude Desktop plan-history source`,
    );
  }

  assert.match(
    nativeApp,
    /alert\.informativeText = TiboTattleLocalization\.format\([\s\S]*?\.launcherFirstRunDisclosure/u,
  );
  assert.doesNotMatch(
    nativeApp,
    /Reads: timestamps, model and speed labels/u,
    "the runtime alert must not bypass the maintained localized disclosure",
  );
});

test("component READMEs delegate executable route inventories to the canonical reference", async () => {
  const [localServer, localReadme, workerRoutes, workerReadme, apiReference] =
    await Promise.all([
      text("apps/local/server.js"),
      text("apps/local/README.md"),
      text("apps/worker/src/route-registry.ts"),
      text("apps/worker/README.md"),
      text("docs/reference/api-surface.md"),
    ]);

  const apiRoutesBlock = localServer.match(
    /const API_ROUTES = new Set\(\[([\s\S]*?)\]\);/u,
  )?.[1];
  assert.ok(apiRoutesBlock, "local API_ROUTES inventory exists");
  const localRoutes = exactStringLiterals(apiRoutesBlock)
    .filter((value) => value.startsWith("/api/"));
  assert.equal(localRoutes.length, 22, "review local route-count changes");
  for (const route of localRoutes) {
    assert.ok(apiReference.includes(route), `API reference covers local ${route}`);
  }

  const workerRoutesList = [
    ...workerRoutes.matchAll(/pathname:\s*"([^"]+)"/gu),
  ].map(([, route]) => route);
  assert.equal(workerRoutesList.length, 32, "review Worker route-count changes");
  for (const route of workerRoutesList) {
    assert.ok(apiReference.includes(route), `API reference covers Worker ${route}`);
  }
  assert.match(localReadme, /docs\/reference\/api-surface\.md/u);
  assert.match(workerReadme, /docs\/reference\/api-surface\.md/u);
  assert.doesNotMatch(localReadme, /2026-08-26-api-surface-reference\.md/u);
  assert.doesNotMatch(workerReadme, /2026-08-26-api-surface-reference\.md/u);
});

test("maintained public docs reject known pre-release and wrong-location claims", async () => {
  const [
    rootReadme,
    localReadme,
    macosReadme,
    workerReadme,
    contributing,
    security,
    support,
    issueConfig,
    pullRequestTemplate,
    rootPackage,
    localizationFallback,
    ...localizationCatalogs
  ] = await Promise.all([
    text("README.md"),
    text("apps/local/README.md"),
    text("apps/macos/README.md"),
    text("apps/worker/README.md"),
    text("CONTRIBUTING.md"),
    text("SECURITY.md"),
    text("SUPPORT.md"),
    text(".github/ISSUE_TEMPLATE/config.yml"),
    text(".github/PULL_REQUEST_TEMPLATE.md"),
    text("package.json"),
    text("apps/macos/Sources/Localization.swift"),
    text("apps/macos/Resources/en.lproj/Localizable.strings"),
    text("apps/macos/Resources/es.lproj/Localizable.strings"),
    text("apps/macos/Resources/zh-Hans.lproj/Localizable.strings"),
  ]);

  assert.doesNotMatch(rootReadme, /product-reference\.md|2026-07-29-end-to-end-pilot/u);
  assert.doesNotMatch(rootReadme, /apps\/cloud-run|plan-usage-history\.json/u);
  assert.doesNotMatch(localReadme, /usage-monitor\.example|Application Support\/TiboTattle/u);
  assert.doesNotMatch(localReadme, /plan-usage-history\.json/u);
  assert.doesNotMatch(localReadme, /GET \/api\/local\/contribution\/sync-next/u);
  assert.doesNotMatch(
    macosReadme,
    /Automatic\s+updates[\s\S]{0,100}Settings…?\*\* → \*\*General/u,
  );
  assert.doesNotMatch(macosReadme, /plan-usage-history\.json/u);
  assert.doesNotMatch(macosReadme, /quit Usage Monitor/u);
  assert.doesNotMatch(
    workerReadme,
    /Worker is development-only|public production is not authorized/u,
  );
  assert.match(contributing, /npm run docs:check/u);
  assert.match(contributing, /Use `git rm` for obsolete instructions/u);
  assert.match(security, /Supported versions/u);
  assert.doesNotMatch(security, /apps\/cloud-run|plan-usage-history\.json/u);
  assert.match(support, /Safe recovery boundary/u);
  assert.doesNotMatch(issueConfig, /adamallcock\/app-usagemonitor/u);
  assert.match(pullRequestTemplate, /npm run docs:check/u);
  assert.doesNotMatch(rootPackage, /Local-only quota and standard API-price usage triangulation experiment/u);
  for (const surface of [localizationFallback, ...localizationCatalogs]) {
    assert.doesNotMatch(surface, /settings\.previewUpdatesPending/u);
    assert.doesNotMatch(surface, /first signed release has not been published/u);
  }
});
