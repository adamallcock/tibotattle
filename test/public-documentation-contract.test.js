import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

function exactStringLiterals(source) {
  return [...source.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/gu)]
    .map(([, value]) => value);
}

test("maintained Markdown retires self-service promises without implying history loss", async () => {
  const paths = [
    "README.md",
    "SUPPORT.md",
    "apps/local/README.md",
    "apps/macos/README.md",
    "apps/worker/README.md",
    "docs/user-guide.md",
    "docs/reference/local-data-and-privacy.md",
  ];
  for (const path of paths) {
    const markdown = await text(path);
    assert.match(markdown, /Disconnect this Mac/u, `${path} names device disconnect`);
    assert.doesNotMatch(
      markdown,
      /Hosted deletion is always available|request deletion through the product controls|Full deletion control from the app|disclosure retains complete hosted deletion/u,
      `${path} must not restore a self-service deletion promise`,
    );
  }
  const guide = await text("docs/user-guide.md");
  assert.match(guide, /It preserves previously contributed hosted\s+history, other devices, and local analysis/u);
  assert.match(guide, /source change, not a deployed-service or installed-release/u);
});

test("owner erasure runbook preserves the exact request, retry, and audit contract", async () => {
  const runbook = await text("docs/runbooks/production-operations.md");
  const requestBodies = [...runbook.matchAll(/```json\s+([\s\S]*?)\s*```/gu)];
  assert.equal(requestBodies.length, 1, "the minimal owner procedure has one explicit request body");
  assert.deepEqual(JSON.parse(requestBodies[0][1]), {
    action: "run_maintenance",
    participantErasure: {
      participantId: "participant:00000000-0000-4000-8000-000000000000",
      confirmation: "erase_hosted_participant",
    },
  });
  for (const marker of [
    "POST /api/v1/admin/action",
    "Cloudflare Access",
    "pinned owner identity",
    "x-usage-monitor-admin: 1",
    'schemaVersion: "admin-action-v0.1"',
    'task: "participant_erasure"',
    "operationId",
    "deleted: true",
    "alreadyDeleted: false",
    "alreadyDeleted: true",
    "contributionsDeleted: null",
    "unknown historical count, not zero",
    "unexpired tombstone",
    "409 PARTICIPANT_DELETING",
    "older than five minutes",
    "SHA256('app-usagemonitor/admin-participant-erasure/v1\\0' + participantId)",
    "participantDeletion: false",
    "deletionSafeRestoreReplay: true",
  ]) {
    assert.ok(runbook.includes(marker), `owner procedure retains ${marker}`);
  }
  assert.match(runbook, /without\s+`participantErasure` performs ordinary maintenance only/u);
  assert.match(runbook, /stale attempt cannot complete after takeover/u);
  assert.match(runbook, /Restore replay owns `state: 'deleting'` with `deletion_session_id: null`/u);
  assert.match(runbook, /Cron\s+must not resume non-null owner or legacy deletion fences/u);
  assert.match(runbook, /restore replay atomically claims only active\s+rows or interrupted restores/u);
  assert.match(runbook, /Final removal\s+must match the null restore fence or the owner operation UUID/u);
  assert.match(runbook, /not a claim that production has changed/u);
});

test("public templates retain security routing without self-service deletion promises", async () => {
  const issueDirectory = ".github/ISSUE_TEMPLATE/";
  const issuePaths = (await readdir(new URL(issueDirectory, ROOT), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:md|ya?ml)$/iu.test(entry.name))
    .map((entry) => `${issueDirectory}${entry.name}`);
  const templates = new Map(await Promise.all([
    ...issuePaths,
    ".github/PULL_REQUEST_TEMPLATE.md",
  ].map(async (path) => [path, await text(path)])));
  for (const [path, template] of templates) {
    assert.doesNotMatch(
      template,
      /upload\/deletion endpoints|Hosted deletion is always available|request deletion through the product controls|Full deletion control from the app/iu,
      `${path} must not restore self-service deletion guidance`,
    );
  }
  const hosted = templates.get(`${issueDirectory}hosted_service.yml`);
  assert.match(hosted, /For security\s+problems/u);
  assert.match(hosted, /private GitHub Security Advisory,\s+not a public issue \(see SECURITY\.md\)/u);
  for (const boundary of ["contribution uploads", "device disconnect", "private owner erasure", "deletion-safe restore"]) {
    assert.ok(hosted.includes(boundary), `hosted security guidance covers ${boundary}`);
  }
  assert.deepEqual(
    [...hosted.matchAll(/^    id: ([a-z-]+)$/gmu)].map(([, id]) => id),
    ["page", "when", "what-happened", "no-session-content"],
    "the hosted bug form must not gain privacy-intake fields",
  );
  assert.match(
    templates.get(`${issueDirectory}config.yml`),
    /url: https:\/\/github\.com\/adamallcock\/tibotattle\/security\/advisories\/new/u,
  );
});

test("local operation docs preserve owner preflight and durable disconnect intent", async () => {
  const [runbook, workerReadme, localReadme, workerManifest] = await Promise.all([
    text("docs/runbooks/production-operations.md"),
    text("apps/worker/README.md"),
    text("apps/local/README.md"),
    text("apps/worker/package.json").then(JSON.parse),
  ]);
  for (const command of [
    "smoke:http", "smoke:account-scoped:http", "smoke:queue:http",
    "smoke:incident:http", "load:http",
  ]) {
    assert.equal(typeof workerManifest.scripts[command], "string");
    assert.ok(runbook.includes(`\`${command}\``), `local procedure covers ${command}`);
  }
  for (const marker of [
    "--owner-access-file",
    "LOCAL_OWNER_ACCESS_REQUIRED",
    "local-backend-owner-access-v0.1",
    "ADMIN_IDENTITY_LINK_KEY",
    "ownerAccessFileContainsSecret: true",
    "ownerErasureVerified",
  ]) {
    assert.ok(runbook.includes(marker), `local owner procedure retains ${marker}`);
  }
  assert.match(runbook, /admin overview authorization before\s+participant enrollment, ingestion, or incident-control writes/u);
  assert.match(runbook, /`--profile-only` remains offline\s+and requires no owner file/u);
  assert.match(runbook, /does not bypass\s+production Cloudflare Access/u);
  const localAcceptance = runbook.split("### Disposable local HTTP acceptance\n")[1]
    ?.split("\n## ")[0];
  assert.ok(localAcceptance, "the runbook has a distinct local acceptance boundary");
  assert.match(localAcceptance, /serves `apps\/web\/public` directly under `--local`/u);
  assert.doesNotMatch(localAcceptance, /production:stage-assets/u);
  assert.match(localAcceptance, /does not change production\/staging asset paths, guarded wrappers/u);
  for (const readme of [workerReadme, localReadme]) {
    assert.ok(readme.includes("--owner-access-file"));
    assert.doesNotMatch(readme, /npm run product:keys:local/u, "the lab provisions isolated keys itself");
  }
  for (const marker of ['paused: true', 'pausedReason: "device_disconnected"', 'nextAttemptAt: null']) {
    assert.ok(localReadme.includes(marker), `local docs disclose ${marker}`);
  }
  assert.match(localReadme, /before remote\s+revocation or local credential cleanup/u);
  assert.match(localReadme, /must not resume delivery/u);
  assert.match(localReadme, /preserves\s+the credential\/binding for retry/u);
  assert.match(localReadme, /real Codex home and production credential\s+backend/u);
});

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
  assert.equal(localRoutes.length, 27, "review local route-count changes");
  for (const route of localRoutes) {
    assert.ok(apiReference.includes(route), `API reference covers local ${route}`);
  }

  const workerRoutesList = [
    ...workerRoutes.matchAll(/pathname:\s*"([^"]+)"/gu),
  ].map(([, route]) => route);
  assert.equal(workerRoutesList.length, 37, "review Worker route-count changes");
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
