// Pure current-D7 comparator checks. Synthetic DTOs only; no Worker, database,
// PostgreSQL, network, historical golden, or computeAnalyticsV2 import.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as comparatorModule from "./analytics-v2-current-d7-compare.mjs";
import {
  ANALYTICS_V2_CURRENT_D7_NORMALIZATIONS,
  CURRENT_Q1_D7_DTO_AUTHORITY,
  CURRENT_Q1_D7_DTO_SOURCE_SHA256,
  CURRENT_Q1_D7_VITE_SERVER_POLICY,
  compareCurrentQ1D7Contract,
  compareCurrentQ1D7CaseDTOs,
  normalizeCurrentD7Response,
  parseCurrentQ1D7CompareArgs,
} from "./analytics-v2-current-d7-compare.mjs";
import {
  currentQ1D7ConflictAssociationSha256,
  currentQ1D7JsonSha256,
  validateCurrentQ1D7SourceConflictProof,
} from "../postgres-test/fixtures/current-q1-d7-contract.mjs";
import { currentQ1D7SyntheticFixture } from "./current-q1-d7-contract.check.mjs";

const CHECK_WORKER_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECK_REPOSITORY_ROOT = resolve(CHECK_WORKER_ROOT, "../..");
const CHECK_NODE_MODULES_ROOT = join(CHECK_WORKER_ROOT, "node_modules");
const SOURCE_MIRROR_SUPPORT_PATHS = Object.freeze([
  "apps/worker/package.json",
  "apps/worker/postgres-test/fixtures/current-q1-d7-contract.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d1-recompute.mjs",
  "apps/worker/scripts/analytics-v2-current-d7-compare.mjs",
]);
const COMPARATOR_SOURCE_SHA256 = Object.freeze({
  ...CURRENT_Q1_D7_DTO_SOURCE_SHA256,
  "packages/telemetry-contract/index.js": CURRENT_Q1_D7_DTO_SOURCE_SHA256[
    "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/index.js"],
  "packages/telemetry-contract/src/admin-model-history.js": CURRENT_Q1_D7_DTO_SOURCE_SHA256[
    "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/admin-model-history.js"],
  "packages/telemetry-contract/src/model-catalog.js": CURRENT_Q1_D7_DTO_SOURCE_SHA256[
    "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/model-catalog.js"],
});

const {
  ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  projectAdminModelHistoryDay,
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  buildCurrentPublicModelMetadata,
  isPublicModelMetadataBlock,
  COMMUNITY_DAILY_SPEND_BASIS,
  COMMUNITY_DAILY_SPEND_PRICING_METHOD,
  COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
  CACHE_RETENTION_METHOD,
  CACHE_RETENTION_METRIC_ID,
  CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
  CACHE_RETENTION_WINDOWS,
  CACHE_RETENTION_BAND_IDS,
  publicCacheRetentionCurve,
  publicCacheRetentionWindow,
} = CURRENT_Q1_D7_DTO_AUTHORITY;

const days = Array.from({ length: 70 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 6, 24 + index));
  return date.toISOString().slice(0, 10);
});
const withheld = new Set([days[10], days[11]]);
const allRefusedDay = days[10];
const pinnedNowMs = Date.parse("2026-10-01T12:00:00.000Z");
const generatedAt = new Date(pinnedNowMs).toISOString();
const CURRENT_ALLOWANCE_BASIS = "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_promax25";
const CURRENT_ALLOWANCE_NORMALIZATION = "pro_x1_prolite_x4_promax_x0_8_plus_x20";
const CURRENT_QUALIFICATION = "shared_reset_fit_gates_25pp_span_floor";
const CURRENT_MODEL_BASIS = "seven_day_codex_pro20x_equivalent_per_model_composition_promax25";
const CURRENT_MODEL_GATE = "shared_composition_kernel_identification";
const CURRENT_METADATA = buildCurrentPublicModelMetadata().map((entry) => ({ ...entry }));
const PREVIEW_PLANS = [
  { planType: "pro", label: "Pro 20x", multiplier: 1 },
  { planType: "prolite", label: "Pro 5x", multiplier: 4 },
  { planType: "promax", label: "Pro Max 25x", multiplier: 0.8 },
  { planType: "plus", label: "Plus", multiplier: 20 },
];
const emptyCacheBands = publicCacheRetentionCurve([], CACHE_RETENTION_METHOD.version).bands;

test("public Vite authorities remain callable after the source loader is closed", () => {
  assert.equal(Object.isFrozen(CURRENT_Q1_D7_DTO_AUTHORITY), true);
  const metadata = buildCurrentPublicModelMetadata();
  assert.equal(isPublicModelMetadataBlock(metadata), true);
  const modelId = ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG.find((entry) =>
    entry.allowanceTrack === "primary" && entry.pricingStatus === "published")?.modelId;
  assert.equal(typeof modelId, "string");
  const day = {
    day: "2026-10-01", catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
    values: [[modelId, 1, 1]], fittedParticipantCount: 1, unstableParticipantCount: 0,
    staleParticipantCount: 0, refusedParticipantCount: 0, v1ParticipantCount: 1,
    unsupportedSourceParticipantCount: 0,
  };
  assert.deepEqual(projectAdminModelHistoryDay(day), day);
  assert.equal(publicCacheRetentionCurve([], CACHE_RETENTION_METHOD.version).bands.length, CACHE_RETENTION_BAND_IDS.length);
});

function currentAuthoritySha256() {
  const projection = Object.fromEntries(Object.entries(CURRENT_Q1_D7_DTO_AUTHORITY).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => [key,
    typeof value === "function" ? Function.prototype.toString.call(value) : value]));
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

function orderedSourceHashes(sourceHashes) {
  return Object.fromEntries(Object.entries(sourceHashes).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0));
}

async function capturePinnedSourceHashes(repositoryRoot) {
  const sourceHashes = {};
  for (const path of Object.keys(CURRENT_Q1_D7_DTO_SOURCE_SHA256)) {
    const bytes = await readFile(join(repositoryRoot, ...path.split("/")));
    sourceHashes[path] = createHash("sha256").update(bytes).digest("hex");
  }
  return orderedSourceHashes(sourceHashes);
}

async function assertRealPinnedSourcesUntouched() {
  const actual = await capturePinnedSourceHashes(CHECK_REPOSITORY_ROOT);
  assert.deepEqual(actual, orderedSourceHashes(CURRENT_Q1_D7_DTO_SOURCE_SHA256),
    "the real pinned DTO source tree must remain byte-for-byte unchanged during mirror probes");
}

function isWorkerNodeModulePath(path) {
  return path.startsWith("apps/worker/node_modules/");
}

function sourceMirrorCopyPaths() {
  const pinnedPaths = Object.keys(CURRENT_Q1_D7_DTO_SOURCE_SHA256).filter((path) => !isWorkerNodeModulePath(path));
  return [...new Set([...pinnedPaths, ...SOURCE_MIRROR_SUPPORT_PATHS])].sort();
}

async function removePrivateSourceMirror(mirror) {
  const rootAfter = await lstat(mirror.root);
  assert.equal(rootAfter.isDirectory(), true);
  assert.equal(rootAfter.isSymbolicLink(), false);
  assert.equal(rootAfter.uid, process.getuid());
  assert.equal(rootAfter.dev, mirror.rootIdentity.dev);
  assert.equal(rootAfter.ino, mirror.rootIdentity.ino);
  assert.equal(rootAfter.mode & 0o077, 0);

  const dependencyLink = await lstat(mirror.nodeModulesLink);
  assert.equal(dependencyLink.isSymbolicLink(), true);
  assert.equal(dependencyLink.uid, process.getuid());
  assert.equal(dependencyLink.nlink, 1);
  assert.equal(await readlink(mirror.nodeModulesLink), CHECK_NODE_MODULES_ROOT);
  await rm(mirror.nodeModulesLink);
  await rm(mirror.root, { recursive: true });
}

async function assertRealSourcesThenRemoveMirror(mirror) {
  try {
    await assertRealPinnedSourcesUntouched();
  } finally {
    await removePrivateSourceMirror(mirror);
  }
}

async function createPrivateSourceMirror() {
  const expectedHashes = orderedSourceHashes(CURRENT_Q1_D7_DTO_SOURCE_SHA256);
  await assertRealPinnedSourcesUntouched();

  const root = await mkdtemp(join(tmpdir(), "tibotattle-current-d7-source-mirror-"));
  await chmod(root, 0o700);
  const rootIdentity = await lstat(root);
  assert.equal(rootIdentity.isDirectory(), true);
  assert.equal(rootIdentity.isSymbolicLink(), false);
  assert.equal(rootIdentity.uid, process.getuid());
  assert.equal(rootIdentity.mode & 0o077, 0);
  const nodeModulesLink = join(root, "apps", "worker", "node_modules");
  const mirror = {
    root,
    rootIdentity,
    repositoryRoot: root,
    workerRoot: join(root, "apps", "worker"),
    nodeModulesLink,
    comparatorUrl: pathToFileURL(join(root, "apps", "worker", "scripts", "analytics-v2-current-d7-compare.mjs")).href,
  };

  try {
    for (const path of sourceMirrorCopyPaths()) {
      assert.equal(isWorkerNodeModulePath(path), false, "never copy files through the dependency symlink");
      const sourcePath = join(CHECK_REPOSITORY_ROOT, ...path.split("/"));
      const sourceIdentity = await lstat(sourcePath);
      assert.equal(sourceIdentity.isFile(), true, path);
      assert.equal(sourceIdentity.isSymbolicLink(), false, path);
      const bytes = await readFile(sourcePath);
      const expectedHash = expectedHashes[path];
      if (expectedHash !== undefined) {
        assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, path);
      }

      const mirrorPath = join(root, ...path.split("/"));
      await mkdir(resolve(mirrorPath, ".."), { recursive: true, mode: 0o700 });
      await writeFile(mirrorPath, bytes, { flag: "wx", mode: 0o600 });
      const mirrorIdentity = await lstat(mirrorPath);
      assert.equal(mirrorIdentity.isFile(), true, path);
      assert.equal(mirrorIdentity.isSymbolicLink(), false, path);
      assert.equal(mirrorIdentity.uid, process.getuid(), path);
      assert.equal(mirrorIdentity.nlink, 1, path);
      assert.equal(mirrorIdentity.mode & 0o077, 0, path);
      assert.deepEqual(await readFile(mirrorPath), bytes, path);
    }

    await assertRealPinnedSourcesUntouched();
    const nodeModulesIdentity = await lstat(CHECK_NODE_MODULES_ROOT);
    assert.equal(nodeModulesIdentity.isDirectory(), true);
    assert.equal(nodeModulesIdentity.isSymbolicLink(), false);
    await symlink(CHECK_NODE_MODULES_ROOT, nodeModulesLink, "dir");
    const dependencyLink = await lstat(nodeModulesLink);
    assert.equal(dependencyLink.isSymbolicLink(), true);
    assert.equal(dependencyLink.uid, process.getuid());
    assert.equal(dependencyLink.nlink, 1);
    assert.equal(await readlink(nodeModulesLink), CHECK_NODE_MODULES_ROOT);

    assert.deepEqual(await capturePinnedSourceHashes(root), expectedHashes,
      "the isolated mirror must expose the exact pinned source graph before each mutation");
    await assertRealPinnedSourcesUntouched();
    return mirror;
  } catch (error) {
    const link = await lstat(nodeModulesLink).catch((candidateError) => {
      if (candidateError?.code === "ENOENT") return null;
      throw candidateError;
    });
    if (link?.isSymbolicLink() && await readlink(nodeModulesLink) === CHECK_NODE_MODULES_ROOT) {
      await rm(nodeModulesLink);
    }
    const currentRoot = await lstat(root).catch((candidateError) => {
      if (candidateError?.code === "ENOENT") return null;
      throw candidateError;
    });
    if (currentRoot?.isDirectory() && !currentRoot.isSymbolicLink()
        && currentRoot.dev === rootIdentity.dev && currentRoot.ino === rootIdentity.ino) {
      await rm(root, { recursive: true });
    }
    throw error;
  }
}

async function createPrivateTestFile(path, contents) {
  try {
    await lstat(path);
    throw new Error("ANALYTICS_V2_CURRENT_D7_ENV_ISOLATION_PATH_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  const identity = await lstat(path);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.uid !== process.getuid()
      || (identity.mode & 0o077) !== 0 || identity.nlink !== 1) {
    throw new Error("ANALYTICS_V2_CURRENT_D7_ENV_ISOLATION_FILE_INVALID");
  }
  return identity;
}

async function removePrivateTestFile(path, identity) {
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.uid !== identity.uid
      || after.dev !== identity.dev || after.ino !== identity.ino || after.nlink !== 1
      || (after.mode & 0o077) !== 0) {
    throw new Error("ANALYTICS_V2_CURRENT_D7_ENV_ISOLATION_CLEANUP_FAILED");
  }
  await rm(path);
}

test("a fresh public-Vite worker loader ignores injected .env files and preserves source authority", async () => {
  const sentinelName = `VITE_CURRENT_D7_ENV_ISOLATION_${process.pid}`;
  assert.equal(Object.hasOwn(process.env, sentinelName), false);
  const sourceMirror = await createPrivateSourceMirror();
  const envPath = join(sourceMirror.workerRoot, ".env");
  const localEnvPath = join(sourceMirror.workerRoot, ".env.local");
  const probeName = `.current-d7-env-probe-${process.pid}.mjs`;
  const probePath = join(sourceMirror.workerRoot, probeName);
  const identities = [];
  try {
    await assertRealPinnedSourcesUntouched();
    identities.push([envPath, await createPrivateTestFile(envPath, `${sentinelName}=first-marker\n`)]);
    identities.push([localEnvPath, await createPrivateTestFile(localEnvPath, `${sentinelName}=second-marker\n`)]);
    identities.push([probePath, await createPrivateTestFile(probePath,
      `export const sentinel = import.meta.env.${sentinelName};\n`)]);

    const comparatorUrl = sourceMirror.comparatorUrl;
    const childCode = `
      import { createHash } from "node:crypto";
      import { chmod, mkdtemp, rm } from "node:fs/promises";
      import { createRequire } from "node:module";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      import { pathToFileURL } from "node:url";
      const comparator = await import(${JSON.stringify(comparatorUrl)});
      const projection = Object.fromEntries(Object.entries(comparator.CURRENT_Q1_D7_DTO_AUTHORITY).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,value]) => [key, typeof value === "function" ? Function.prototype.toString.call(value) : value]));
      const authoritySha256 = createHash("sha256").update(JSON.stringify(projection)).digest("hex");
      const workerRoot = ${JSON.stringify(sourceMirror.workerRoot)};
      const workerRequire = createRequire(join(workerRoot, "package.json"));
      const { createServer } = await import(pathToFileURL(workerRequire.resolve("vite")).href);
      const cacheRoot = await mkdtemp(join(tmpdir(), "tibotattle-current-d7-env-probe-"));
      await chmod(cacheRoot, 0o700);
      let vite;
      let sentinel;
      try {
        vite = await createServer({ root: workerRoot, cacheDir: cacheRoot, ...comparator.CURRENT_Q1_D7_VITE_SERVER_POLICY,
          server: { ...comparator.CURRENT_Q1_D7_VITE_SERVER_POLICY.server } });
        const probe = await vite.ssrLoadModule(${JSON.stringify(`/${probeName}`)});
        sentinel = probe.sentinel ?? null;
      } finally {
        await vite?.close();
        await rm(cacheRoot, { recursive: true });
      }
      process.stdout.write(JSON.stringify({ authoritySha256, sourceSha256: comparator.CURRENT_Q1_D7_DTO_SOURCE_SHA256, sentinel }));
    `;
    let stdout;
    try {
      stdout = execFileSync(process.execPath, ["--input-type=module", "-e", childCode], {
        cwd: sourceMirror.workerRoot, env: { ...process.env }, encoding: "utf8", timeout: 30000, maxBuffer: 256 * 1024,
      });
    } catch {
      throw new Error("ANALYTICS_V2_CURRENT_D7_ENV_ISOLATION_CHILD_FAILED");
    }
    let result;
    try { result = JSON.parse(stdout); }
    catch { throw new Error("ANALYTICS_V2_CURRENT_D7_ENV_ISOLATION_RESULT_INVALID"); }
    assert.deepEqual(Object.keys(result).sort(), ["authoritySha256", "sentinel", "sourceSha256"]);
    assert.equal(result.authoritySha256, currentAuthoritySha256());
    assert.deepEqual(JSON.parse(JSON.stringify(result.sourceSha256)), JSON.parse(JSON.stringify(CURRENT_Q1_D7_DTO_SOURCE_SHA256)));
    assert.equal(result.sentinel, null);
  } finally {
    try {
      for (const [path, identity] of identities.reverse()) await removePrivateTestFile(path, identity);
    } finally {
      await assertRealSourcesThenRemoveMirror(sourceMirror);
    }
  }
});

test("a broken current authority source returns only the fixed loader error", async () => {
  const sourceMirror = await createPrivateSourceMirror();
  const sourcePath = join(sourceMirror.workerRoot, "src/admin-community-allowance.ts");
  const marker = `CURRENT_D7_LOADER_FAILURE_SENTINEL_${process.pid}`;
  const originalBytes = await readFile(sourcePath);
  const original = await lstat(sourcePath);
  assert.equal(original.isFile(), true);
  assert.equal(original.isSymbolicLink(), false);
  const originalMode = original.mode & 0o777;
  try {
    await assertRealPinnedSourcesUntouched();
    await chmod(sourcePath, originalMode | 0o200);
    await writeFile(sourcePath, `// ${marker}\nexport const invalid = ;\n`);
    const afterWrite = await lstat(sourcePath);
    assert.equal(afterWrite.dev, original.dev);
    assert.equal(afterWrite.ino, original.ino);
    assert.equal(afterWrite.uid, original.uid);
    await assertRealPinnedSourcesUntouched();

    const comparatorUrl = sourceMirror.comparatorUrl;
    const childCode = `
      try { await import(${JSON.stringify(comparatorUrl)}); process.exitCode = 1; }
      catch (error) { process.stdout.write(String(error?.message ?? "UNKNOWN_LOADER_ERROR")); }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
      cwd: sourceMirror.workerRoot, env: { ...process.env }, encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.equal(child.stdout, "ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_FAILED");
    const emitted = `${child.stdout}\n${child.stderr}`;
    assert.equal(emitted.includes(marker), false);
    assert.equal(emitted.includes("admin-community-allowance.ts"), false);
  } finally {
    try {
      const beforeRestore = await lstat(sourcePath);
      assert.equal(beforeRestore.isFile(), true);
      assert.equal(beforeRestore.isSymbolicLink(), false);
      assert.equal(beforeRestore.dev, original.dev);
      assert.equal(beforeRestore.ino, original.ino);
      await writeFile(sourcePath, originalBytes);
      await chmod(sourcePath, originalMode);
      assert.deepEqual(await readFile(sourcePath), originalBytes);
    } finally {
      await assertRealSourcesThenRemoveMirror(sourceMirror);
    }
  }
});

test("the staged controller-relative dynamic import resolves the comparator API", async () => {
  // The pinned controller is copied beside this check; inspect its exact import
  // expression without importing or executing the controller module.
  const controllerUrl = new URL("./gcp-fastpath-rehearsal.mjs", import.meta.url);
  const controllerSource = await readFile(fileURLToPath(controllerUrl), "utf8");
  assert.ok(controllerSource.includes('const comparator = await import("./analytics-v2-current-d7-compare.mjs");'));
  const comparatorUrl = new URL("./analytics-v2-current-d7-compare.mjs", controllerUrl);
  assert.equal(new URL("./", controllerUrl).href, new URL("./", import.meta.url).href);
  const controllerImport = await import(comparatorUrl);
  assert.strictEqual(controllerImport, comparatorModule);
  assert.equal(typeof controllerImport.compareCurrentQ1D7Contract, "function");
  assert.equal(controllerImport.ANALYTICS_V2_CURRENT_D7_MODE, "current-worker-d1-d7");
});
function cacheRetention() {
  return {
    schemaVersion: CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
    metric: CACHE_RETENTION_METRIC_ID,
    methodVersion: CACHE_RETENTION_METHOD.version,
    measures: "consecutive_requests",
    gapBasis: "response_end_to_response_end",
    windows: CACHE_RETENTION_WINDOWS.map(({ id: window, days: span }) =>
      publicCacheRetentionWindow({ window, days: span, pooled: emptyCacheBands, modelRows: [] })),
  };
}

function summary(overrides = {}) {
  return { fitCount: 4, participantCount: 4, centralUsd: 1,
    band80Usd: { lowerUsd: 0.5, upperUsd: 2 }, ...overrides };
}

function previewDay(day) {
  const perPlan = summary({ fitCount: 1, participantCount: 1, centralUsd: 0.25, band80Usd: null });
  return { day, combined: summary(),
    byPlanType: Object.fromEntries(PREVIEW_PLANS.map((plan) => [plan.planType, structuredClone(perPlan)])) };
}

function modelDTO(day, overrides = {}) {
  return {
    day,
    catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
    values: [["gpt-6-sol", 2.5, 4]],
    fittedParticipantCount: 4,
    unstableParticipantCount: 0,
    staleParticipantCount: 0,
    refusedParticipantCount: 0,
    v1ParticipantCount: 4,
    unsupportedSourceParticipantCount: 0,
    ...overrides,
  };
}

const expectedByDate = new Map(days.map((day) => [day, modelDTO(day)]));
expectedByDate.set(allRefusedDay, modelDTO(allRefusedDay, {
  values: [], fittedParticipantCount: 0, refusedParticipantCount: 4, v1ParticipantCount: 4,
}));

function publicResponse(modelValues, revision = 1, extra = {}) {
  const publicDays = days.slice(0, -1);
  return {
    schemaVersion: "community-daily-read-v1.0",
    from: days[0],
    to: days.at(-1),
    allowanceState: "ready",
    allowanceReadState: "confirmed",
    allowanceBreakdowns: {
      schemaVersion: "community-allowance-breakdowns-v1.5",
      basis: CURRENT_ALLOWANCE_BASIS,
      referencePlanType: "pro",
      normalization: CURRENT_ALLOWANCE_NORMALIZATION,
      modelBasis: CURRENT_MODEL_BASIS,
      modelGate: CURRENT_MODEL_GATE,
      generatedAt,
      days: publicDays.map((day) => ({ ...previewDay(day), models: structuredClone(modelValues.get(day) ?? []) })),
      modelConfig: structuredClone(CURRENT_METADATA),
      ...extra.allowanceBreakdowns,
    },
    cacheRetention: cacheRetention(),
    days: days.map((day) => {
      const releasedAt = `${day}T12:00:00.000Z`;
      const totals = {
        contributingParticipants: 4, contributingDevices: 4, usageEvents: 4, quotaObservations: 4,
        sessionDimensions: 4, inputUncachedTokens: 16, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
        outputTextTokens: 16, outputReasoningTokens: 0, outputCombinedTokens: 16,
      };
      return {
        day, revision, releasedAt,
        payload: {
          schemaVersion: "community-daily-aggregate-v1.0", aggregateId: `community-daily:${day}:r${revision}`,
          day, revision, releasedAt, immutableRevision: true, recomputesOnLateData: true,
          policyVersion: "community-daily-v1.0", suppression: "none_daily_grain_by_owner_decision",
          apiEquivalentSpend: {
            basis: COMMUNITY_DAILY_SPEND_BASIS, currency: "USD", knownCostUsd: 1,
            coverage: "complete", usageEvents: 4, fullyPricedUsageEvents: 4, partiallyPricedUsageEvents: 0,
            unpricedUsageEvents: 0, pricingMethodVersion: COMMUNITY_DAILY_SPEND_PRICING_METHOD,
            registrySha256: COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
          },
          totals,
          cellsTruncated: false,
          cells: [{ provider: "openai_codex", modelId: "gpt-6-sol", usageEvents: 4,
            inputUncachedTokens: 16, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
            outputTextTokens: 16, outputReasoningTokens: 0, outputCombinedTokens: 16 }],
          ...extra.payload,
        },
      };
    }),
  };
}

function preview(modelDates, modelMap = expectedByDate) {
  return {
    schemaVersion: "admin-community-allowance-preview-v0.5",
    generatedAt,
    from: days[0], to: days.at(-1), basis: `${CURRENT_ALLOWANCE_BASIS}_preview`, referencePlanType: "pro",
    trailingDays: 30, qualification: CURRENT_QUALIFICATION, spanFloorPp: 25,
    plans: structuredClone(PREVIEW_PLANS),
    coverage: { uploadingParticipantCount: 4, cachedParticipantCount: 4, recentFittedParticipantCount: 4,
      mergeEligibleParticipantCount: 4, noQualifyingFitParticipantCount: 0, noRecentFitParticipantCount: 0,
      unsupportedPlanParticipantCount: 0 },
    days: days.map((day) => previewDay(day)),
    models: { basis: CURRENT_MODEL_BASIS, gate: CURRENT_MODEL_GATE,
      modelConfig: structuredClone(ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG), days: modelDates.map((day) => structuredClone(modelMap.get(day))) },
  };
}

function fixture({ caseId = "conflictPreserving" } = {}) {
  const caseWithheld = caseId === "conflictPreserving" ? withheld : new Set();
  const baselineValues = new Map(days.map((day) => [day,
    caseWithheld.has(day) ? [] : structuredClone(expectedByDate.get(day).values)]));
  const reference = {
    caseId,
    graphDays: [...days],
    publicationInventory: days.map((day) => ({ day,
      state: caseWithheld.has(day) ? "withheld" : "published",
      sha256: "a".repeat(64),
    })),
    snapshot: {
      publicResponse: { status: 200, body: publicResponse(baselineValues) },
      adminPreview: preview(days.filter((day) => !caseWithheld.has(day))),
    },
  };
  const expectation = { days: [...expectedByDate.values()].map((entry) => structuredClone(entry)) };
  const candidateValues = new Map(days.map((day) => [day, structuredClone(expectedByDate.get(day).values)]));
  return {
    caseId, reference, expectation,
    actualResponse: publicResponse(candidateValues, 7),
    actualPreview: preview(days),
    currentDay: days.at(-1),
  };
}

function hasUnexpected(result) {
  return result.equal === false && result.diffCount > 0;
}

function assertDtoInvalidWithoutLeak(run, ...privateMarkers) {
  let failure;
  assert.throws(run, (error) => {
    failure = error;
    return error?.message === "ANALYTICS_V2_CURRENT_D7_DTO_INVALID";
  });
  const diagnostic = `${failure.message}\n${failure.stack ?? ""}`;
  for (const marker of privateMarkers) assert.equal(diagnostic.includes(marker), false);
}

function resealCaseReference(input, caseId) {
  const reference = input.cases.find((entry) => entry.caseId === caseId).reference;
  reference.snapshotSha256 = currentQ1D7JsonSha256(reference.snapshot);
  input.producerAcceptance.caseReceipts[caseId].referenceSha256 = currentQ1D7JsonSha256(reference);
}

test("v3 normalization list is the existing five-field scheduler set", () => {
  assert.deepEqual(ANALYTICS_V2_CURRENT_D7_NORMALIZATIONS, [
    "days[].revision", "days[].releasedAt", "payload.revision", "payload.releasedAt",
    "payload.aggregateId :r<revision> suffix",
  ]);
  const original = publicResponse(new Map(), 1);
  const shifted = publicResponse(new Map(), 7);
  assert.deepEqual(normalizeCurrentD7Response(original), normalizeCurrentD7Response(shifted));

  const impossibleDay = structuredClone(original);
  impossibleDay.days[0].day = "2026-02-30";
  impossibleDay.days[0].payload.day = impossibleDay.days[0].day;
  impossibleDay.days[0].payload.aggregateId = `community-daily:${impossibleDay.days[0].day}:r1`;
  assert.throws(() => normalizeCurrentD7Response(impossibleDay), /SCHEDULE_INVALID/u);

  const duplicateDay = structuredClone(original);
  duplicateDay.days.push(structuredClone(duplicateDay.days[0]));
  assert.throws(() => normalizeCurrentD7Response(duplicateDay), /SCHEDULE_INVALID/u);

  const unorderedDays = structuredClone(original);
  const second = structuredClone(unorderedDays.days[0]);
  second.day = days[1]; second.revision = 2; second.releasedAt = "2026-10-02T12:00:00.000Z";
  second.payload.day = second.day; second.payload.revision = second.revision;
  second.payload.releasedAt = second.releasedAt; second.payload.aggregateId = `community-daily:${second.day}:r2`;
  unorderedDays.days = [second, unorderedDays.days[0]];
  assert.throws(() => normalizeCurrentD7Response(unorderedDays), /SCHEDULE_INVALID/u);
});

test("negative D7 accepts only the independently expected withheld model dates", () => {
  const result = compareCurrentQ1D7CaseDTOs(fixture());
  assert.equal(result.equal, true);
  assert.equal(result.comparedDates, 70);
  assert.deepEqual(result.d1WithheldDates, [...withheld].sort());
});

test("negative D7 rejects changed non-model and shared-date fields", () => {
  const changedNonModel = fixture();
  changedNonModel.actualResponse.days[0].payload.totals.quotaObservations += 1;
  assert.ok(hasUnexpected(compareCurrentQ1D7CaseDTOs(changedNonModel)));

  const changedShared = fixture();
  changedShared.actualResponse.allowanceBreakdowns.days[0].models[0][1] += 1;
  changedShared.actualPreview.models.days.find((entry) => entry.day === days[0]).values[0][1] += 1;
  assert.ok(hasUnexpected(compareCurrentQ1D7CaseDTOs(changedShared)));
});

test("negative D7 rejects model values, owner counts, refused counts, and date-set mutations", () => {
  const changedModel = fixture();
  const changedModelDay = days[11];
  changedModel.actualResponse.allowanceBreakdowns.days[11].models[0][1] = 9;
  changedModel.actualPreview.models.days.find((entry) => entry.day === changedModelDay).values[0][1] = 9;
  assert.ok(hasUnexpected(compareCurrentQ1D7CaseDTOs(changedModel)));

  const changedOwnerCount = fixture();
  const ownerDay = changedOwnerCount.actualPreview.models.days.find((entry) => entry.day === allRefusedDay);
  ownerDay.v1ParticipantCount = 3;
  ownerDay.refusedParticipantCount = 3;
  assert.ok(hasUnexpected(compareCurrentQ1D7CaseDTOs(changedOwnerCount)));

  const changedRefusedCount = fixture();
  const refusedDay = changedRefusedCount.actualPreview.models.days.find((entry) => entry.day === allRefusedDay);
  refusedDay.v1ParticipantCount = 3;
  refusedDay.refusedParticipantCount = 3;
  assert.ok(hasUnexpected(compareCurrentQ1D7CaseDTOs(changedRefusedCount)));

  const missingPublicDate = fixture();
  missingPublicDate.actualResponse.allowanceBreakdowns.days.pop();
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(missingPublicDate));

  const extraPreviewDate = fixture();
  extraPreviewDate.actualPreview.models.days.push(modelDTO("2026-04-01"));
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(extraPreviewDate));
});

test("D1 withholding evidence remains visible and current-fit preview fields stay exact", () => {
  const changedD1 = fixture();
  changedD1.reference.snapshot.publicResponse.body.allowanceBreakdowns.days[10].models = [["gpt-6-sol", 2.5, 4]];
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(changedD1));

  const withheldFit = fixture();
  withheldFit.actualPreview.coverage.noRecentFitParticipantCount = 1;
  withheldFit.actualPreview.models.days.pop();
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(withheldFit));
});

test("the current-day public projection stays excluded and date-array order stays exact", () => {
  const insertedToday = fixture();
  insertedToday.actualResponse.allowanceBreakdowns.days.push({
    day: days.at(-1), combined: { participantCount: 4 }, byPlanType: { pro: { participantCount: 4 } },
    models: structuredClone(expectedByDate.get(days.at(-1)).values),
  });
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(insertedToday));

  const reorderedPublic = fixture();
  [reorderedPublic.actualResponse.allowanceBreakdowns.days[0], reorderedPublic.actualResponse.allowanceBreakdowns.days[1]] =
    [reorderedPublic.actualResponse.allowanceBreakdowns.days[1], reorderedPublic.actualResponse.allowanceBreakdowns.days[0]];
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(reorderedPublic));

  const reorderedPreview = fixture();
  [reorderedPreview.actualPreview.models.days[0], reorderedPreview.actualPreview.models.days[1]] =
    [reorderedPreview.actualPreview.models.days[1], reorderedPreview.actualPreview.models.days[0]];
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(reorderedPreview));
});

test("all-refused D7 date keeps four owners counted and publishes the exact empty-valued DTO", () => {
  const allRefused = fixture();
  const dayIndex = days.indexOf(allRefusedDay);
  allRefused.actualResponse.allowanceBreakdowns.days[dayIndex].models = [];
  const result = compareCurrentQ1D7CaseDTOs(allRefused);
  assert.equal(result.equal, true);
  const refused = allRefused.expectation.days.find((entry) => entry.day === allRefusedDay);
  assert.deepEqual({ v1: refused.v1ParticipantCount, refused: refused.refusedParticipantCount,
    fitted: refused.fittedParticipantCount, unstable: refused.unstableParticipantCount,
    stale: refused.staleParticipantCount, unsupported: refused.unsupportedSourceParticipantCount,
    values: refused.values }, { v1: 4, refused: 4, fitted: 0, unstable: 0, stale: 0, unsupported: 0, values: [] });
  const changed = fixture();
  const changedRefused = changed.actualPreview.models.days.find((entry) => entry.day === allRefusedDay);
  changedRefused.refusedParticipantCount = 3;
  changedRefused.v1ParticipantCount = 3;
  assert.ok(hasUnexpected(compareCurrentQ1D7CaseDTOs(changed)));
});

function contractCaseInputs(sourceSha256ByPath = COMPARATOR_SOURCE_SHA256) {
  const evidence = currentQ1D7SyntheticFixture({ sourceSha256ByPath });
  const graphDays = evidence.binding.cases.conflictPreserving.modelDays;
  const currentDay = new Date(evidence.binding.runtime.pinnedNowMs).toISOString().slice(0, 10);
  const cases = [];
  for (const caseId of ["conflictPreserving", "conflictFreePositive"]) {
    const reference = evidence.cases[caseId];
    const expectation = evidence.expectations[caseId];
    const expected = new Map(expectation.days.map((dto) => [dto.day, structuredClone(dto)]));
    const withheldDates = new Set(reference.publicationInventory.filter((entry) => entry.state === "withheld")
      .map((entry) => entry.day));
    const baselineValues = new Map(graphDays.map((day) => [day,
      withheldDates.has(day) ? [] : structuredClone(expected.get(day).values)]));
    const candidateValues = new Map(graphDays.map((day) => [day, structuredClone(expected.get(day).values)]));
    reference.snapshot = {
      publicResponse: { status: 200, body: publicResponse(baselineValues, 1) },
      adminPreview: preview(graphDays.filter((day) => !withheldDates.has(day)), expected),
    };
    reference.snapshotSha256 = currentQ1D7JsonSha256(reference.snapshot);
    cases.push({ caseId, reference, expectation,
      actualResponse: publicResponse(candidateValues, 7), actualPreview: preview(graphDays, expected), currentDay });
  }
  for (const caseId of ["conflictPreserving", "conflictFreePositive"]) {
    evidence.acceptance.caseReceipts[caseId].referenceSha256 = currentQ1D7JsonSha256(evidence.cases[caseId]);
  }
  return { ...evidence, cases };
}

function contractInput(fixtureValue = contractCaseInputs()) {
  const { inputBinding, binding, expectations, expectationSha256, pgInputs, acceptance, expectedController, cases } = fixtureValue;
  return { inputBinding, binding, expectations, expectationSha256, pgInputs, producerAcceptance: acceptance,
    expectedController, cases };
}

test("aggregate comparator requires both accepted cases and emits a closed saved-comparison report", () => {
  const input = contractInput();
  const report = compareCurrentQ1D7Contract(input);
  assert.equal(report.schemaVersion, "analytics-v2-current-d7-contract-report-v3");
  assert.equal(report.comparisonMode, "current-worker-d1-d7");
  assert.equal(report.evidenceScope, "saved-comparison-only");
  assert.equal(report.decisionId, "D7");
  assert.equal(report.establishesNativeExecution, false);
  assert.equal(report.accepted, true);
  assert.deepEqual(report.acceptedCaseIds, ["conflictPreserving", "conflictFreePositive"]);
  assert.deepEqual(report.acceptedD7DateSet, input.cases[0].reference.publicationInventory
    .filter((entry) => entry.state === "withheld").map((entry) => entry.day));
  assert.equal(report.strictUnaffectedEqual, true);
  assert.equal(report.exactPerDateEqual, true);
  assert.equal(report.positive70DateEqual, true);
  assert.equal(report.unexpectedDiffs, 0);
  assert.deepEqual(report.unresolved, []);
});

test("aggregate comparison rejects missing, reordered, unbound, stale-hash, wrong-case and source-drift evidence", () => {
  const missingPositive = contractInput();
  missingPositive.cases.pop();
  assert.throws(() => compareCurrentQ1D7Contract(missingPositive), /CASE_SET_INVALID/u);

  const wrongCase = contractInput();
  [wrongCase.cases[0], wrongCase.cases[1]] = [wrongCase.cases[1], wrongCase.cases[0]];
  assert.throws(() => compareCurrentQ1D7Contract(wrongCase), /CASE_SET_INVALID/u);

  const unbound = contractInput();
  unbound.cases[0].reference = structuredClone(unbound.cases[1].reference);
  assert.throws(() => compareCurrentQ1D7Contract(unbound), /(?:CURRENT_Q1_D7_CONTRACT_INVALID|ANALYTICS_V2_CURRENT_D7_EVIDENCE_INCOMPLETE)/u);

  const staleExpectation = contractInput();
  staleExpectation.expectations.conflictPreserving.days[0].values[0][1] += 1;
  assert.throws(() => compareCurrentQ1D7Contract(staleExpectation), /(?:CURRENT_Q1_D7_CONTRACT_INVALID|ANALYTICS_V2_CURRENT_D7_EVIDENCE_INCOMPLETE)/u);

  const sourceDrift = contractInput();
  sourceDrift.binding.source.files[0].sha256 = "f".repeat(64);
  assert.throws(() => compareCurrentQ1D7Contract(sourceDrift), /CURRENT_Q1_D7_CONTRACT_INVALID/u);
});

test("aggregate comparison rejects retained factories when current source pins change", () => {
  const changedPins = { ...COMPARATOR_SOURCE_SHA256 };
  const path = "apps/worker/src/admin-community-allowance.ts";
  changedPins[path] = changedPins[path] === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
  const staleAuthority = contractInput(contractCaseInputs(changedPins));
  assert.throws(() => compareCurrentQ1D7Contract(staleAuthority), /SOURCE_BINDING_INVALID/u);
});

test("a reused process rejects newly pinned source after its DTO authority was loaded", async () => {
  const childMode = "CURRENT_Q1_D7_STALE_AUTHORITY_CHILD";
  if (process.env[childMode] !== "1") {
    const child = spawnSync(process.execPath, ["--test",
      "--test-name-pattern=a reused process rejects newly pinned source after its DTO authority was loaded",
      "scripts/analytics-v2-current-d7-compare.check.mjs"], {
      cwd: CHECK_WORKER_ROOT, env: { ...process.env, [childMode]: "1" }, encoding: "utf8",
      timeout: 30000, maxBuffer: 256 * 1024,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(`${child.stdout}\n${child.stderr}`.includes("CURRENT_D7_STALE_AUTHORITY_SENTINEL"), false);
    return;
  }

  const sourceMirror = await createPrivateSourceMirror();
  const relativePath = "apps/worker/src/admin-community-allowance.ts";
  const sourcePath = join(sourceMirror.workerRoot, "src/admin-community-allowance.ts");
  const originalBytes = await readFile(sourcePath);
  const originalStat = await lstat(sourcePath);
  assert.equal(originalStat.isFile(), true);
  assert.equal(originalStat.isSymbolicLink(), false);
  const marker = `CURRENT_D7_STALE_AUTHORITY_SENTINEL_${process.pid}`;
  const changedBytes = Buffer.concat([originalBytes, Buffer.from(`\n// ${marker}\n`)]);
  try {
    await assertRealPinnedSourcesUntouched();
    const mirrorComparator = await import(sourceMirror.comparatorUrl);
    assert.deepEqual(JSON.parse(JSON.stringify(mirrorComparator.CURRENT_Q1_D7_DTO_SOURCE_SHA256)),
      JSON.parse(JSON.stringify(CURRENT_Q1_D7_DTO_SOURCE_SHA256)));
    const baselineReport = mirrorComparator.compareCurrentQ1D7Contract(contractInput());
    assert.equal(baselineReport.accepted, true);
    assert.equal(baselineReport.establishesNativeExecution, false);

    await writeFile(sourcePath, changedBytes);
    await assertRealPinnedSourcesUntouched();
    const changedPins = { ...COMPARATOR_SOURCE_SHA256,
      [relativePath]: createHash("sha256").update(changedBytes).digest("hex") };
    const reboundEvidence = contractInput(contractCaseInputs(changedPins));
    assert.throws(() => mirrorComparator.compareCurrentQ1D7Contract(reboundEvidence), /SOURCE_BINDING_INVALID/u);
  } finally {
    try {
      await writeFile(sourcePath, originalBytes);
      await chmod(sourcePath, originalStat.mode & 0o777);
      const restored = await readFile(sourcePath);
      assert.deepEqual(restored, originalBytes);
      const restoredStat = await lstat(sourcePath);
      assert.equal(restoredStat.dev, originalStat.dev);
      assert.equal(restoredStat.ino, originalStat.ino);
      assert.equal(restoredStat.uid, originalStat.uid);
    } finally {
      await assertRealSourcesThenRemoveMirror(sourceMirror);
    }
  }
});

test("aggregate comparison requires independently captured initial pins and the source-pinned controller", () => {
  const missingInputBinding = contractInput();
  delete missingInputBinding.inputBinding;
  assert.throws(() => compareCurrentQ1D7Contract(missingInputBinding), /INPUT_INVALID/u);

  const mismatchedInputBinding = contractInput();
  mismatchedInputBinding.inputBinding.source.head = "0".repeat(40);
  assert.throws(() => compareCurrentQ1D7Contract(mismatchedInputBinding), /CURRENT_Q1_D7_CONTRACT_INVALID/u);

  const unboundAcceptance = contractInput();
  unboundAcceptance.producerAcceptance.inputBindingSha256 = "0".repeat(64);
  assert.throws(() => compareCurrentQ1D7Contract(unboundAcceptance), /CURRENT_Q1_D7_CONTRACT_INVALID/u);

  const selfSelectedController = contractInput();
  selfSelectedController.expectedController = { path: "apps/worker/scripts/other-controller.mjs", sha256: "f".repeat(64) };
  assert.throws(() => compareCurrentQ1D7Contract(selfSelectedController), /CURRENT_Q1_D7_CONTRACT_INVALID/u);
});

test("current conflict proof comparison preserves page, source-day, window and cursor associations", () => {
  const input = contractInput();
  const expectation = input.expectations.conflictPreserving;
  const proof = expectation.sourceConflictProofs[0];
  const context = { sourceWitnesses: expectation.sourceWitnesses, windowProofs: expectation.windowProofs };
  assert.equal(validateCurrentQ1D7SourceConflictProof(proof, input.binding, context), proof);
  assert.throws(() => validateCurrentQ1D7SourceConflictProof(proof, input.binding), /CURRENT_Q1_D7_CONTRACT_INVALID/u);

  const donor = expectation.sourceConflictProofs.find((candidate) => candidate.reader.sourceDay !== proof.reader.sourceDay);
  assert.ok(donor, "fixture has a second source day for association mutation coverage");
  const sourceDaySwap = structuredClone(proof);
  Object.assign(sourceDaySwap.reader, { sourceDay: donor.reader.sourceDay,
    sourceWitnessSha256: donor.reader.sourceWitnessSha256, pageSha256: donor.reader.pageSha256 });
  const swappedWitness = context.sourceWitnesses.find((witness) => witness.day === sourceDaySwap.reader.sourceDay
    && witness.stream === "usage");
  sourceDaySwap.reader.associationSha256 = currentQ1D7ConflictAssociationSha256(sourceDaySwap, swappedWitness);
  assert.throws(() => validateCurrentQ1D7SourceConflictProof(sourceDaySwap, input.binding, context), /CURRENT_Q1_D7_CONTRACT_INVALID/u);

  const cursorSwap = structuredClone(proof);
  cursorSwap.scope.cursorSha256 = donor.scope.cursorSha256;
  const originalWitness = context.sourceWitnesses.find((witness) => witness.day === proof.reader.sourceDay && witness.stream === "usage");
  cursorSwap.reader.associationSha256 = currentQ1D7ConflictAssociationSha256(cursorSwap, originalWitness);
  assert.throws(() => validateCurrentQ1D7SourceConflictProof(cursorSwap, input.binding, context), /CURRENT_Q1_D7_CONTRACT_INVALID/u);

  const pageSwap = structuredClone(proof);
  pageSwap.reader.pageSha256 = donor.reader.pageSha256;
  pageSwap.reader.associationSha256 = currentQ1D7ConflictAssociationSha256(pageSwap, originalWitness);
  assert.throws(() => validateCurrentQ1D7SourceConflictProof(pageSwap, input.binding, context), /CURRENT_Q1_D7_CONTRACT_INVALID/u);

  const windowSwap = { ...context, windowProofs: [...context.windowProofs].reverse() };
  assert.throws(() => validateCurrentQ1D7SourceConflictProof(proof, input.binding, windowSwap), /CURRENT_Q1_D7_CONTRACT_INVALID/u);
});

test("aggregate comparison reports model, owner/refused, missing/extra, ordering and current-fit mutations", () => {
  const changedModel = contractInput();
  const modelDate = changedModel.cases[0].reference.publicationInventory
    .find((entry) => entry.state === "withheld" && changedModel.expectations.conflictPreserving.days
      .find((dto) => dto.day === entry.day)?.values.length > 0).day;
  const publicIndex = days.indexOf(modelDate);
  changedModel.cases[0].actualPreview.models.days.find((entry) => entry.day === modelDate).values[0][1] += 1;
  changedModel.cases[0].actualResponse.allowanceBreakdowns.days[publicIndex].models[0][1] += 1;
  const modelReport = compareCurrentQ1D7Contract(changedModel);
  assert.equal(modelReport.accepted, false);
  assert.equal(modelReport.strictUnaffectedEqual, true);
  assert.equal(modelReport.exactPerDateEqual, false);
  assert.equal(modelReport.positive70DateEqual, true);
  assert.ok(modelReport.unexpectedDiffs > 0);

  const changedNonModel = contractInput();
  changedNonModel.cases[0].actualResponse.days[0].payload.totals.quotaObservations += 1;
  const nonModelReport = compareCurrentQ1D7Contract(changedNonModel);
  assert.equal(nonModelReport.strictUnaffectedEqual, false);
  assert.equal(nonModelReport.exactPerDateEqual, true);

  const changedDateSummary = contractInput();
  changedDateSummary.cases[0].actualResponse.allowanceBreakdowns.days[0].combined.centralUsd += 0.25;
  changedDateSummary.cases[0].actualPreview.days[0].combined.centralUsd += 0.25;
  const dateSummaryReport = compareCurrentQ1D7Contract(changedDateSummary);
  assert.equal(dateSummaryReport.strictUnaffectedEqual, false);
  assert.equal(dateSummaryReport.exactPerDateEqual, true);

  const changedOwner = contractInput();
  changedOwner.cases[0].reference.nativeEvidence[0].owner = "unbound-owner";
  changedOwner.cases[0].reference.nativeEvidence.sort((a, b) => `${a.owner}/${a.day}`.localeCompare(`${b.owner}/${b.day}`));
  changedOwner.cases[0].reference.snapshotSha256 = currentQ1D7JsonSha256(changedOwner.cases[0].reference.snapshot);
  changedOwner.producerAcceptance.caseReceipts.conflictPreserving.referenceSha256 =
    currentQ1D7JsonSha256(changedOwner.cases[0].reference);
  assert.throws(() => compareCurrentQ1D7Contract(changedOwner), /(?:CURRENT_Q1_D7_CONTRACT_INVALID|ANALYTICS_V2_CURRENT_D7_EVIDENCE_INCOMPLETE)/u);

  const changedRefused = contractInput();
  const refusedDate = changedRefused.cases[0].reference.publicationInventory
    .find((entry) => entry.state === "withheld" && changedRefused.expectations.conflictPreserving.days
      .find((dto) => dto.day === entry.day)?.refusedParticipantCount > 0).day;
  const refusedDto = changedRefused.cases[0].actualPreview.models.days.find((entry) => entry.day === refusedDate);
  refusedDto.refusedParticipantCount -= 1;
  refusedDto.v1ParticipantCount -= 1;
  assert.equal(compareCurrentQ1D7Contract(changedRefused).accepted, false);

  const missingPreview = contractInput();
  missingPreview.cases[0].actualPreview.models.days.pop();
  assert.equal(compareCurrentQ1D7Contract(missingPreview).accepted, false);

  const extraPreview = contractInput();
  extraPreview.cases[0].actualPreview.models.days.push(structuredClone(extraPreview.cases[0].actualPreview.models.days.at(-1)));
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7Contract(extraPreview));

  const currentFits = contractInput();
  currentFits.cases[0].actualPreview.coverage.noRecentFitParticipantCount = 1;
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7Contract(currentFits));

  const unordered = contractInput();
  [unordered.cases[0].actualPreview.models.days[0], unordered.cases[0].actualPreview.models.days[1]] =
    [unordered.cases[0].actualPreview.models.days[1], unordered.cases[0].actualPreview.models.days[0]];
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7Contract(unordered));
});

test("both D7 DTOs reject mirrored unknown fields without exposing private keys or values", () => {
  const mirroredPublicUnknown = contractInput();
  const caseEntry = mirroredPublicUnknown.cases[0];
  const secret = "untrusted-private-value-8f3c";
  caseEntry.reference.snapshot.publicResponse.body.days[0].payload.extraRevision = secret;
  caseEntry.actualResponse.days[0].payload.extraRevision = secret;
  resealCaseReference(mirroredPublicUnknown, caseEntry.caseId);
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7Contract(mirroredPublicUnknown), "extraRevision", secret);

  const mirroredPreviewUnknown = contractInput();
  const previewCase = mirroredPreviewUnknown.cases[0];
  const pathSpecial = "private.owner]/token";
  previewCase.reference.snapshot.adminPreview.models.days[0][pathSpecial] = secret;
  previewCase.actualPreview.models.days[0][pathSpecial] = secret;
  resealCaseReference(mirroredPreviewUnknown, previewCase.caseId);
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7Contract(mirroredPreviewUnknown), pathSpecial, secret);

  const mirroredMetadataUnknown = contractInput();
  const metadataCase = mirroredMetadataUnknown.cases[1];
  metadataCase.reference.snapshot.publicResponse.body.allowanceBreakdowns.modelConfig[0].unknownCatalogField = secret;
  metadataCase.actualResponse.allowanceBreakdowns.modelConfig[0].unknownCatalogField = secret;
  resealCaseReference(mirroredMetadataUnknown, metadataCase.caseId);
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7Contract(mirroredMetadataUnknown), "unknownCatalogField", secret);
});

test("v3 command requires its explicit mode and one input file", () => {
  assert.deepEqual(parseCurrentQ1D7CompareArgs(["--comparison-mode", "current-worker-d1-d7", "--input", "/tmp/input.json"]),
    { inputPath: "/tmp/input.json" });
  assert.throws(() => parseCurrentQ1D7CompareArgs(["--input", "/tmp/input.json"]), /ARGUMENTS_INVALID/u);
  assert.throws(() => parseCurrentQ1D7CompareArgs(["--comparison-mode", "historical", "--input", "/tmp/input.json"]), /ARGUMENTS_INVALID/u);
  assert.throws(() => parseCurrentQ1D7CompareArgs(["--comparison-mode", "current-worker-d1-d7", "--input", "/tmp/input.json",
    "--golden", "/tmp/golden.json"]), /ARGUMENTS_INVALID/u);
});

test("positive control requires strict full DTO equality across all 70 dates", () => {
  const positive = fixture({ caseId: "conflictFreePositive" });
  positive.reference.snapshot.publicResponse.body = publicResponse(
    new Map(days.map((day) => [day, structuredClone(expectedByDate.get(day).values)])));
  positive.reference.snapshot.adminPreview = preview(days);
  positive.actualResponse = publicResponse(
    new Map(days.map((day) => [day, structuredClone(expectedByDate.get(day).values)])), 7);
  positive.actualPreview = preview(days);
  assert.equal(compareCurrentQ1D7CaseDTOs(positive).equal, true);
  positive.actualPreview.days[0].combined.centralUsd += 0.25;
  positive.actualResponse.allowanceBreakdowns.days[0].combined.centralUsd += 0.25;
  assert.ok(hasUnexpected(compareCurrentQ1D7CaseDTOs(positive)));
});

test("unknown normalization and inconsistent scheduler state are rejected", () => {
  const unknown = fixture();
  unknown.actualResponse.days[0].payload.extraRevision = 7;
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(unknown));

  const inconsistent = fixture();
  inconsistent.actualResponse.days[0].payload.revision += 1;
  assert.throws(() => compareCurrentQ1D7CaseDTOs(inconsistent), /SCHEDULE_INVALID/u);

  const wrongCase = fixture();
  assert.throws(() => compareCurrentQ1D7CaseDTOs({ ...wrongCase, caseId: "conflictFreePositive" }),
    /POSITIVE_INVENTORY_INVALID/u);
});

test("direct comparison rejects mirrored unknown DTO fields including path-special keys", () => {
  const secret = "same-unknown-value-6f20";
  const mirroredPayload = fixture();
  mirroredPayload.reference.snapshot.publicResponse.body.days[0].payload.extraRevision = secret;
  mirroredPayload.actualResponse.days[0].payload.extraRevision = secret;
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(mirroredPayload), "extraRevision", secret);

  const mirroredPrivatePreview = fixture();
  const pathSpecial = "private.owner]/token";
  mirroredPrivatePreview.reference.snapshot.adminPreview.models.days[0][pathSpecial] = secret;
  mirroredPrivatePreview.actualPreview.models.days[0][pathSpecial] = secret;
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(mirroredPrivatePreview), pathSpecial, secret);

  const mirroredCache = fixture();
  mirroredCache.reference.snapshot.publicResponse.body.cacheRetention.windows[0].bands[0].futureField = secret;
  mirroredCache.actualResponse.cacheRetention.windows[0].bands[0].futureField = secret;
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(mirroredCache), "futureField", secret);

  const candidateUnknown = fixture();
  candidateUnknown.actualPreview.models.days[0].surprise = secret;
  assertDtoInvalidWithoutLeak(() => compareCurrentQ1D7CaseDTOs(candidateUnknown), "surprise", secret);
});
