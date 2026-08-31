import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
} from "../../src/local-companion-data.js";
import {
  ingestLocalUnifiedIndexOffMain,
} from "../../src/local-unified-index-off-main.js";
import {
  LEGACY_LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
  LOCAL_UNIFIED_INDEX_APPLICATION_ID,
  LOCAL_UNIFIED_INDEX_MINIMUM_READER_USER_VERSION,
  LOCAL_UNIFIED_INDEX_MINIMUM_WRITER_USER_VERSION,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
  LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION,
  LOCAL_UNIFIED_INDEX_USER_VERSION,
} from "../../src/local-unified-index.js";
import {
  LocalContributionPreparationError,
} from "../../src/local-contribution-preparation.js";
import {
  claimContributionDevicePairing,
} from "../../src/contribution-device-client.js";
import {
  LocalCompanionClient,
} from "../web/public/data-client.js";
import {
  createDiagnosticReference,
  diagnosticErrorCode,
  diagnosticSurface,
  serviceRequestId,
} from "../web/public/lib.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../../src/platform/export-identity-keychain.js";
import {
  buildTelemetryContributionsFromBundle,
} from "../../src/telemetry-contribution-builder.js";
import { TELEMETRY_SCHEMA_VERSION } from "@app-usagemonitor/telemetry-contract";
import {
  PREVIEW_PRODUCT_BRAND,
  PRODUCT_BRAND,
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../../config/product-brand.js";
import {
  configuredAccountingSourceMode,
  configuredSemanticOpenTarget,
  createCachedLocalUnifiedProjectionReader,
  createCentralOutboundFetch,
  createLocalCompanionServer,
  LOCAL_COMPANION_INCREMENTAL_REFRESH_TIMEOUT_MS,
  localCompanionRefreshTimeoutForUnifiedIndex,
  resolveClaudeDesktopShadowConfiguration,
  startLocalCompanionServer,
} from "./server.js";

const DEVELOPMENT_COVERAGE = Object.freeze({
  startAt: "2026-07-24T21:00:00.000Z",
  endAt: "2026-07-24T23:02:00.000Z",
});
const REVIEW_JOB_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_SHA256 = "a".repeat(64);

function writeTimeoutClassifierIndex(indexFile, {
  applicationId = LOCAL_UNIFIED_INDEX_APPLICATION_ID,
  userVersion,
  schemaVersion,
  compatibility = null,
}) {
  const database = new DatabaseSync(indexFile);
  try {
    database.exec(`
      PRAGMA application_id=${applicationId};
      PRAGMA user_version=${userVersion};
      CREATE TABLE meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
    `);
    database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)")
      .run("schema_version", schemaVersion);
    if (compatibility !== null) {
      const insert = database.prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?)",
      );
      for (const [key, value] of Object.entries(compatibility)) {
        insert.run(key, value);
      }
    }
  } finally {
    database.close();
  }
}

function writeParserUpgradeTimeoutIndex(indexFile, {
  parserVersion = "unified-rollout-typed-v10",
  parserContractVersion = TELEMETRY_SCHEMA_VERSION,
  generation = {},
  metadata = {},
  compatibility = {
    compatibility_format_user_version: String(LOCAL_UNIFIED_INDEX_USER_VERSION),
    compatibility_minimum_reader_user_version:
      String(LOCAL_UNIFIED_INDEX_MINIMUM_READER_USER_VERSION),
    compatibility_minimum_writer_user_version:
      String(LOCAL_UNIFIED_INDEX_MINIMUM_WRITER_USER_VERSION),
  },
} = {}) {
  writeTimeoutClassifierIndex(indexFile, {
    userVersion: LOCAL_UNIFIED_INDEX_USER_VERSION,
    schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
    compatibility,
  });
  const database = new DatabaseSync(indexFile);
  try {
    const insertMeta = database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries({
      source_identity_version: LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION,
      contract_version: TELEMETRY_SCHEMA_VERSION,
      // Published ids are historically stored as SQLite numeric text too.
      current_generation_id: "2.0",
      ...metadata,
    })) {
      if (value !== undefined) insertMeta.run(key, value);
    }
    database.exec(`
      CREATE TABLE parser_version(
        id INTEGER PRIMARY KEY, parser_version TEXT NOT NULL,
        contract_version TEXT NOT NULL) STRICT;
      CREATE TABLE index_generation(
        id INTEGER PRIMARY KEY, parser_version_id INTEGER NOT NULL,
        contract_version TEXT NOT NULL, status TEXT NOT NULL, block_reason TEXT,
        completed_at_ms INTEGER, discovery_complete INTEGER NOT NULL,
        diagnostics_complete INTEGER NOT NULL, usage_provenance_complete INTEGER NOT NULL,
        source_order_complete INTEGER NOT NULL, quota_provenance_complete INTEGER NOT NULL,
        tool_provenance_complete INTEGER NOT NULL, skipped_source_count INTEGER NOT NULL) STRICT;
    `);
    const insertParser = database.prepare("INSERT INTO parser_version VALUES (?, ?, ?)");
    insertParser.run(1, "unified-rollout-typed-v10", TELEMETRY_SCHEMA_VERSION);
    insertParser.run(2, parserVersion, parserContractVersion);
    const insertGeneration = database.prepare(`
      INSERT INTO index_generation VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const defaults = {
      contractVersion: TELEMETRY_SCHEMA_VERSION,
      status: "complete",
      blockReason: null,
      completedAtMs: 1_000,
      discoveryComplete: 1,
      diagnosticsComplete: 1,
      usageProvenanceComplete: 1,
      sourceOrderComplete: 1,
      quotaProvenanceComplete: 1,
      toolProvenanceComplete: 1,
      skippedSourceCount: 0,
    };
    for (const [id, selected] of [[1, defaults], [2, { ...defaults, ...generation }]]) {
      insertGeneration.run(id, id, selected.contractVersion, selected.status,
        selected.blockReason, selected.completedAtMs, selected.discoveryComplete,
        selected.diagnosticsComplete, selected.usageProvenanceComplete,
        selected.sourceOrderComplete, selected.quotaProvenanceComplete,
        selected.toolProvenanceComplete, selected.skippedSourceCount);
    }
  } finally {
    database.close();
  }
}

test("refresh timeout classifier grants the cold window only to missing or proven migratable indexes", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-timeout-classifier-"));
  const freshTimeoutMs = 14_400_000;
  const incrementalTimeoutMs = LOCAL_COMPANION_INCREMENTAL_REFRESH_TIMEOUT_MS;
  try {
    const missing = join(root, "missing.sqlite");
    assert.equal(
      localCompanionRefreshTimeoutForUnifiedIndex(missing),
      freshTimeoutMs,
    );

    const fixtures = [
      {
        name: "schema8-v1.sqlite",
        options: {
          userVersion: 8,
          schemaVersion: LEGACY_LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
        },
        expected: freshTimeoutMs,
      },
      {
        name: "schema9-v2.sqlite",
        options: {
          userVersion: 9,
          schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
        },
        expected: freshTimeoutMs,
      },
      {
        name: "schema10-v2.sqlite",
        options: {
          userVersion: 10,
          schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
          compatibility: {
            compatibility_format_user_version: "10",
            compatibility_minimum_reader_user_version: "10",
            compatibility_minimum_writer_user_version: "10",
          },
        },
        expected: freshTimeoutMs,
      },
      {
        name: "current.sqlite",
        options: {
          userVersion: LOCAL_UNIFIED_INDEX_USER_VERSION,
          schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
        },
        expected: incrementalTimeoutMs,
      },
      {
        name: "foreign.sqlite",
        options: {
          applicationId: 0x12345678,
          userVersion: 9,
          schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
        },
        expected: incrementalTimeoutMs,
      },
      {
        name: "newer.sqlite",
        options: {
          userVersion: LOCAL_UNIFIED_INDEX_USER_VERSION + 1,
          schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
        },
        expected: incrementalTimeoutMs,
      },
      {
        name: "malformed-metadata.sqlite",
        options: {
          userVersion: 9,
          schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
          compatibility: {
            compatibility_format_user_version: "not-a-version",
            compatibility_minimum_reader_user_version: "9",
            compatibility_minimum_writer_user_version: "9",
          },
        },
        expected: incrementalTimeoutMs,
      },
    ];
    for (const fixture of fixtures) {
      const indexFile = join(root, fixture.name);
      writeTimeoutClassifierIndex(indexFile, fixture.options);
      await chmod(indexFile, 0o600);
      const beforeBytes = await readFile(indexFile);
      const beforeNames = await readdir(root);
      assert.equal(
        localCompanionRefreshTimeoutForUnifiedIndex(indexFile),
        fixture.expected,
        fixture.name,
      );
      assert.deepEqual(await readFile(indexFile), beforeBytes, fixture.name);
      assert.deepEqual(await readdir(root), beforeNames, fixture.name);
    }

    const corrupt = join(root, "corrupt.sqlite");
    await writeFile(corrupt, Buffer.from("not a sqlite database", "utf8"), {
      mode: 0o600,
    });
    const corruptBefore = await readFile(corrupt);
    assert.equal(
      localCompanionRefreshTimeoutForUnifiedIndex(corrupt),
      incrementalTimeoutMs,
    );
    assert.deepEqual(await readFile(corrupt), corruptBefore);

    const unreadable = join(root, "unreadable.sqlite");
    writeTimeoutClassifierIndex(unreadable, {
      userVersion: 9,
      schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
    });
    await chmod(unreadable, 0o000);
    assert.equal(
      localCompanionRefreshTimeoutForUnifiedIndex(unreadable),
      incrementalTimeoutMs,
    );

    const directory = join(root, "directory.sqlite");
    await mkdir(directory);
    assert.equal(
      localCompanionRefreshTimeoutForUnifiedIndex(directory),
      incrementalTimeoutMs,
    );

    const symlinkTarget = join(root, "symlink-target.sqlite");
    writeTimeoutClassifierIndex(symlinkTarget, {
      userVersion: 9,
      schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
    });
    await chmod(symlinkTarget, 0o600);
    const linkedIndex = join(root, "linked.sqlite");
    await symlink(symlinkTarget, linkedIndex);
    assert.equal(
      localCompanionRefreshTimeoutForUnifiedIndex(linkedIndex),
      incrementalTimeoutMs,
    );

    const sidecarIndex = join(root, "sidecar.sqlite");
    writeTimeoutClassifierIndex(sidecarIndex, {
      userVersion: 9,
      schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
    });
    await chmod(sidecarIndex, 0o600);
    await writeFile(`${sidecarIndex}-wal`, "", { mode: 0o600 });
    assert.equal(
      localCompanionRefreshTimeoutForUnifiedIndex(sidecarIndex),
      incrementalTimeoutMs,
    );

    assert.throws(
      () => localCompanionRefreshTimeoutForUnifiedIndex(missing, {
        freshTimeoutMs: freshTimeoutMs + 1,
      }),
      /outside the refresh timeout bound/u,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("published v10 parser upgrades receive a cold deadline without extending current or uncertain state", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-timeout-parser-upgrade-"));
  const fixtures = [
    { name: "complete", cold: true },
    { name: "quarantine-partial", cold: true, generation: {
      status: "partial", blockReason: "codex_rollout_sources_quarantined", skippedSourceCount: 14,
    } },
    { name: "tool-partial", cold: true, generation: {
      status: "partial", blockReason: "tool_provenance_incomplete", toolProvenanceComplete: 0,
    } },
    // Every fixture retains an older parser/generation row. Only publication
    // provenance may select the deadline, so this stays an ordinary refresh.
    { name: "current-with-old-history", parserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION },
    { name: "future", parserVersion: "unified-rollout-typed-v12" },
    { name: "unknown", parserVersion: "unknown-parser" },
    { name: "partial-parser", parserVersion: "unified-rollout-typed-v10-partial" },
    { name: "unreviewed-predecessor", parserVersion: "unified-rollout-typed-v9" },
    { name: "missing-publication", metadata: { current_generation_id: undefined } },
    { name: "unknown-publication", metadata: { current_generation_id: "99" } },
    { name: "invalid-publication", metadata: { current_generation_id: "2.5" } },
    { name: "in-progress", generation: { status: "in_progress", completedAtMs: null } },
    { name: "failed", generation: { status: "failed" } },
    { name: "unfinished", generation: { completedAtMs: null } },
    { name: "unexpected-complete-reason", generation: { blockReason: "unexpected" } },
    { name: "unknown-partial", generation: { status: "partial", blockReason: "unexpected" } },
    { name: "empty-quarantine", generation: {
      status: "partial", blockReason: "codex_rollout_sources_quarantined", skippedSourceCount: 0,
    } },
    { name: "contradictory-tools", generation: {
      status: "partial", blockReason: "tool_provenance_incomplete", toolProvenanceComplete: 1,
    } },
    { name: "generation-contract", generation: { contractVersion: "unknown-contract" } },
    { name: "parser-contract", parserContractVersion: "unknown-contract" },
    { name: "metadata-contract", metadata: { contract_version: "unknown-contract" } },
    { name: "source-identity", metadata: { source_identity_version: "unknown-identity" } },
    { name: "absent-compatibility", compatibility: null },
    { name: "unsupported-current-compatibility", compatibility: {
      compatibility_format_user_version: String(LOCAL_UNIFIED_INDEX_USER_VERSION),
      compatibility_minimum_reader_user_version: "9",
      compatibility_minimum_writer_user_version: "9",
    } },
    ...["discoveryComplete", "diagnosticsComplete", "usageProvenanceComplete",
      "sourceOrderComplete", "quotaProvenanceComplete", "toolProvenanceComplete"]
      .map((key) => ({ name: `incomplete-${key}`, generation: { [key]: 0 } })),
  ];
  try {
    for (const fixture of fixtures) {
      const indexFile = join(root, `${fixture.name}.sqlite`);
      writeParserUpgradeTimeoutIndex(indexFile, fixture);
      await chmod(indexFile, 0o600);
      const beforeBytes = await readFile(indexFile);
      const beforeNames = await readdir(root);
      assert.equal(localCompanionRefreshTimeoutForUnifiedIndex(indexFile),
        fixture.cold === true ? 14_400_000 : LOCAL_COMPANION_INCREMENTAL_REFRESH_TIMEOUT_MS,
        fixture.name);
      assert.deepEqual(await readFile(indexFile), beforeBytes, fixture.name);
      assert.deepEqual(await readdir(root), beforeNames, fixture.name);
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("large legacy and parser-upgrade timeout classification never scans integrity or fact collections", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-timeout-large-index-"));
  const indexFile = join(root, "schema9-large.sqlite");
  const sparseSize = 800 * 1024 * 1024;
  try {
    writeTimeoutClassifierIndex(indexFile, {
      userVersion: 9,
      schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
    });
    await chmod(indexFile, 0o600);
    await truncate(indexFile, sparseSize);
    const before = await lstat(indexFile);
    const beforeNames = await readdir(root);
    let integrityScans = 0;
    const openDatabase = (selectedFile) => {
      const immutableUrl = pathToFileURL(selectedFile);
      immutableUrl.searchParams.set("immutable", "1");
      const database = new DatabaseSync(immutableUrl.href, {
        readOnly: true,
        timeout: 1_000,
      });
      return {
        exec: (sql) => database.exec(sql),
        prepare(sql) {
          assert.doesNotMatch(sql, /\b(?:usage_event|generation_issue|source_cursor)\b/u);
          if (/\bFROM meta\b/u.test(sql)) assert.match(sql, /\bWHERE key\b/u);
          if (/\b(?:quick_check|integrity_check)\b/u.test(sql)) {
            integrityScans += 1;
            return {
              all() {
                Atomics.wait(
                  new Int32Array(new SharedArrayBuffer(4)),
                  0,
                  0,
                  750,
                );
                return [{ quick_check: "ok" }];
              },
            };
          }
          return database.prepare(sql);
        },
        close: () => database.close(),
      };
    };
    const startedAt = performance.now();
    assert.equal(
      localCompanionRefreshTimeoutForUnifiedIndex(indexFile, { openDatabase }),
      14_400_000,
    );
    const elapsedMs = performance.now() - startedAt;
    assert.equal(integrityScans, 0);
    assert.equal(elapsedMs < 250, true, `classification took ${elapsedMs}ms`);
    const after = await lstat(indexFile);
    assert.equal(after.size, sparseSize);
    assert.deepEqual(
      {
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
      },
      {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      },
    );
    assert.deepEqual(await readdir(root), beforeNames);

    const parserIndex = join(root, "schema11-parser10-large.sqlite");
    writeParserUpgradeTimeoutIndex(parserIndex);
    await chmod(parserIndex, 0o600);
    await truncate(parserIndex, sparseSize);
    const parserBefore = await lstat(parserIndex);
    const parserNamesBefore = await readdir(root);
    const parserStartedAt = performance.now();
    assert.equal(
      localCompanionRefreshTimeoutForUnifiedIndex(parserIndex, { openDatabase }),
      14_400_000,
    );
    const parserElapsedMs = performance.now() - parserStartedAt;
    assert.equal(integrityScans, 0);
    assert.equal(parserElapsedMs < 250, true,
      `parser classification took ${parserElapsedMs}ms`);
    const parserAfter = await lstat(parserIndex);
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) {
      assert.equal(parserAfter[field], parserBefore[field], field);
    }
    assert.deepEqual(await readdir(root), parserNamesBefore);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("unchanged unified projections reuse only within exact generation, time, and baseline bounds", async () => {
  const generationA = `generation-v2-${"a".repeat(64)}`;
  const generationB = `generation-v2-${"b".repeat(64)}`;
  let selectedGeneration = generationA;
  let reads = 0;
  const validityChecks = [];
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async (options) => {
      reads += 1;
      if (options.mode === "deferred") {
        return { status: "deferred", generation: null };
      }
      return {
        status: "available",
        generation: { fingerprint: selectedGeneration },
        usage: [{ marker: reads }],
      };
    },
    validUntil: async (options) => {
      validityChecks.push(options);
      return options.nowMs + 100;
    },
  });
  const options = (nowMs, baselines, mode = "full") => ({
    indexFile: "/private/index.sqlite",
    nowMs,
    declaredSpeedBaselines: baselines,
    mode,
  });
  const reuse = (generationFingerprint) => ({
    reuse: { generationFingerprint },
  });

  const cold = await reader(options(100, [{ startAt: 1, mode: "standard" }]));
  assert.equal(reads, 1);
  assert.equal(cold.usage[0].marker, 1);

  const unchanged = await reader(
    options(150, [{ startAt: 1, mode: "standard" }]),
    reuse(generationA),
  );
  assert.equal(reads, 1);
  assert.equal(unchanged.usage[0].marker, 1);
  // A caller cannot mutate the retained cache through a returned clone.
  unchanged.usage[0].marker = 999;

  const clockMovedBack = await reader(
    options(99, [{ startAt: 1, mode: "standard" }]),
    reuse(generationA),
  );
  assert.equal(reads, 2);
  assert.equal(clockMovedBack.usage[0].marker, 2);

  const baselineChanged = await reader(
    options(151, [{ startAt: 1, mode: "fast" }]),
    reuse(generationA),
  );
  assert.equal(reads, 3);
  assert.equal(baselineChanged.usage[0].marker, 3);

  const timeBoundaryReached = await reader(
    options(251, [{ startAt: 1, mode: "fast" }]),
    reuse(generationA),
  );
  assert.equal(reads, 4);
  assert.equal(timeBoundaryReached.usage[0].marker, 4);

  selectedGeneration = generationB;
  const changedGeneration = await reader(
    options(252, [{ startAt: 1, mode: "fast" }]),
    reuse(generationB),
  );
  assert.equal(reads, 5);
  assert.equal(changedGeneration.generation.fingerprint, generationB);

  const deferred = await reader(
    options(253, [{ startAt: 1, mode: "fast" }], "deferred"),
    reuse(generationB),
  );
  assert.equal(reads, 6);
  assert.equal(deferred.status, "deferred");
  assert.equal(validityChecks.length, 5);

  const afterDeferred = await reader(
    options(254, [{ startAt: 1, mode: "fast" }]),
    reuse(generationB),
  );
  assert.equal(reads, 6);
  assert.equal(afterDeferred.usage[0].marker, 5);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reader(
      options(255, [{ startAt: 1, mode: "fast" }]),
      { ...reuse(generationB), signal: controller.signal },
    ),
    (error) => error?.code === "local_unified_companion_projection_aborted",
  );
  assert.equal(reads, 6);
});

test("semantic open target is stable by default and accepts only reviewed identities", () => {
  assert.equal(configuredSemanticOpenTarget({}), PRODUCT_BRAND.appOpenURL);
  assert.equal(
    configuredSemanticOpenTarget({
      USAGE_MONITOR_APP_OPEN_URL: PREVIEW_PRODUCT_BRAND.appOpenURL,
    }),
    PREVIEW_PRODUCT_BRAND.appOpenURL,
  );
  for (const value of [
    "",
    "https://attacker.example/open",
    "usagemonitor-preview://other",
  ]) {
    assert.throws(
      () => configuredSemanticOpenTarget({
        USAGE_MONITOR_APP_OPEN_URL: value,
      }),
      /must match a reviewed product identity/u,
    );
  }
});

function exactReviewContribution() {
  return buildTelemetryContributionsFromBundle({
    schemaVersion: "usage-metadata-bundle-v0.1",
    createdAt: "2026-07-26T12:10:00.000Z",
    coveredAt: {
      startAt: "2026-07-26T12:00:00.000Z",
      endAt: "2026-07-26T12:10:00.000Z",
    },
    clientPlatform: "macos",
    records: {
      usageEvents: [{
        schemaVersion: "usage-event-v0.1",
        eventTime: "2026-07-26T12:05:00.000Z",
        provider: "openai_codex",
        modelId: "gpt-5.6-sol",
        modelRecognition: "recognized",
        modelFingerprint: null,
        billingSurface: "chatgpt_subscription",
        speedMode: "standard",
        apiServiceTier: "unknown",
        reasoningEffort: "unknown",
        components: {
          inputUncachedTokens: 100,
          inputCacheReadTokens: 200,
          inputCacheWriteTokens: 0,
          outputTextTokens: 5,
          outputReasoningTokens: 2,
        },
        totalInputContextTokens: 300,
        surface: "extension_or_ide",
        agentScope: "root",
        lineageDisposition: "standalone",
        toolClassCounts: {
          webSearch: 0,
          fileSearch: 0,
          codeInterpreter: 0,
          hostedShell: 0,
          computerUse: 0,
          mcp: 0,
          applyPatch: 0,
          localShell: 0,
          subagent: 0,
          toolGateway: 0,
          other: 0,
          unknown: 0,
        },
        outcome: "unknown",
        eventId: `event:v2:${"a".repeat(64)}`,
        sessionScopeId: `session:v1:${"b".repeat(64)}`,
        accountScopeId: "unattributed",
      }],
      quotaSnapshots: [],
      activityMarkers: [],
    },
  })[0];
}

function fakeStore() {
  let reloads = 0;
  const paceOutlook = {
    schemaVersion: "local-weekly-pace-outlook-v0.1",
    status: "unavailable",
    standing: null,
    critical: false,
    earlyEstimate: false,
    remainingPercent: null,
    resetsAt: null,
    observationCount: 0,
    elapsedHours: null,
    rates: {
      activePercentagePointsPerHour: null,
      overallPercentagePointsPerHour: null,
      headlinePercentagePointsPerHour: null,
      sustainablePercentagePointsPerHour: null,
      ratio: null,
    },
    projection: {
      hoursToReset: null,
      coveredHours: null,
      dryHours: null,
      sparePercent: null,
      projectedExhaustionAt: null,
    },
    track: {
      coveredFraction: null,
      activeExhaustionFraction: null,
    },
  };
  return {
    async initialize() {},
    async reload() {
      reloads += 1;
    },
    getOverview() {
      return {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        mode: "real_local_evidence",
        evidenceStatus: "available",
      };
    },
    getGradient() {
      return { status: "available", datasets: { rolling: [{ quota_change_pp: 3 }] } };
    },
    getWeekly() {
      return { status: "available", datasets: { summary: [{ median_weekly_value_usd: 100 }] } };
    },
    getWeeklyPaceOutlook() {
      return structuredClone(paceOutlook);
    },
    getQuality() {
      return { status: "available", datasets: { summary: [{ known_speed_fraction: 0.8 }] } };
    },
    getReports() {
      return { schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION, reports: [] };
    },
    get reloads() {
      return reloads;
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-companion-server-"));
  const resourceRoot = join(root, "resources");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "home", ".codex");
  const staticRoot = join(resourceRoot, "public");
  await mkdir(staticRoot, { recursive: true });
  await mkdir(join(codexHome, "sessions"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(codexHome, "archived_sessions"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(codexHome, "sessions", "rollout-fixture.jsonl"),
    `${JSON.stringify({ type: "session_meta" })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(staticRoot, "index.html"),
    `<!doctype html><meta name="usage-monitor-semantic-open-target" content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}"><title>TiboTattle</title>`,
  );
  await writeFile(join(staticRoot, "app.js"), "export const app = true;");
  await writeFile(join(staticRoot, "data-client.js"), "export const client = true;");
  await writeFile(join(staticRoot, "lib.js"), "export const lib = true;");
  await writeFile(
    join(staticRoot, "localization.js"),
    "export const localization = true;",
  );
  await writeFile(
    join(staticRoot, "telemetry-shared.generated.js"),
    "export const telemetry = true;",
  );
  await writeFile(
    join(staticRoot, "telemetry-envelope.js"),
    "export const envelope = true;",
  );
  await writeFile(join(staticRoot, "styles.css"), "body { color: black; }");
  await writeFile(
    join(staticRoot, "tibotattle-icon.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  for (const [fileName, title] of [
    ["2026-07-24-simple-quota-gradient-report.html", "Gradient detail"],
    ["2026-07-24-weekly-7-day-calibration-report.html", "Weekly detail"],
    ["2026-07-24-monitoring-quality-report.html", "Quality detail"],
    ["2026-07-24-codex-work-account-usage-report.html", "Multi-surface detail"],
  ]) {
    await writeFile(
      join(resourceRoot, fileName),
      `<!doctype html><title>${title}</title>`,
    );
  }
  return { root, resourceRoot, stateRoot, codexHome, staticRoot };
}

function unifiedIndexRolloutFixture() {
  const threadId = "11111111-1111-4111-8111-111111111111";
  return [
    {
      timestamp: "2026-08-24T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: threadId,
        session_id: threadId,
        thread_source: "user",
        originator: "codex_cli_rs",
      },
    },
    {
      timestamp: "2026-08-24T00:00:01.000Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    },
    {
      timestamp: "2026-08-24T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
          },
          last_token_usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
          },
        },
      },
    },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
}

test("production authority defaults unified and keeps legacy as explicit rollback", () => {
  assert.equal(configuredAccountingSourceMode({}), "unified");
  assert.equal(
    configuredAccountingSourceMode({
      USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
    }),
    "unified",
  );
  assert.equal(
    configuredAccountingSourceMode({
      USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "legacy",
    }),
    "legacy",
  );
  assert.throws(
    () => configuredAccountingSourceMode({
      USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "automatic",
    }),
    /must be legacy or unified/u,
  );
  assert.throws(
    () => configuredAccountingSourceMode({
      USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "",
    }),
    /must be legacy or unified/u,
  );
});

function rawRequest({ port, path, method = "GET", headers = {}, body = "" }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", rejectRequest);
    request.end(body);
  });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("condition was not reached");
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function processIsRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

const WATCHDOG_PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeSync } = require("node:fs");
const child = spawn(
  process.execPath,
  [process.env.WATCHDOG_SERVER_PATH],
  {
    cwd: process.env.USAGE_MONITOR_RESOURCE_ROOT,
    env: {
      ...process.env,
      USAGE_MONITOR_PARENT_PID: String(process.pid),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
writeSync(1, \`WATCHDOG_CHILD_PID=\${child.pid}\\n\`);
let pending = "";
let ready = false;
child.stdout.on("data", (chunk) => {
  writeSync(1, chunk);
  pending += chunk.toString("utf8");
  if (!ready && pending.includes("USAGE_MONITOR_READY")) {
    ready = true;
    setTimeout(() => process.exit(0), 25);
  }
});
child.stderr.on("data", (chunk) => writeSync(2, chunk));
child.once("exit", () => {
  if (!ready) process.exit(2);
});
setTimeout(() => process.exit(3), 15_000);
`;

test("loopback server exposes only fixed API, static, and report routes", async () => {
  const files = await fixture();
  const store = fakeStore();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`);
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).capabilities, {
      localDashboard: true,
      explicitRefresh: true,
      contributionPreparation: true,
      contributionPreparationIdentityMode: "production_keychain",
      contributionSyncStatus: true,
      contributionSyncNext: true,
      contributionDevicePairing: false,
      contributionDeviceDisconnect: false,
      contributionSyncExactReview: true,
      incrementalContributionSync: false,
      centralServiceProxy: false,
      centralParticipantRelay: false,
      arbitraryPathAccess: false,
      remoteProxy: false,
    });
    assert.equal(health.headers.get("access-control-allow-origin"), null);
    assert.match(health.headers.get("content-security-policy"), /default-src 'none'/);
    const retirement = app.automaticContributionRetirement();
    assert.equal(retirement.status, "retired");
    assert.equal(retirement.priorState, "absent");
    assert.equal(retirement.networkActivity, false);
    const tombstone = JSON.parse(await readFile(join(
      files.stateRoot,
      "private",
      "automatic-contribution-v0.1.json",
    ), "utf8"));
    assert.equal(tombstone.schemaVersion, "automatic-contribution-retired-v1");
    assert.equal(tombstone.networkActivity, false);

    const onboarding = await fetch(`${base}/api/local/onboarding`);
    assert.equal(onboarding.status, 200);
    assert.deepEqual(await onboarding.json(), {
      schemaVersion: "local-onboarding-v0.2",
      status: "ready",
      source: {
        status: "ready",
        sessionsReadable: true,
        archivedSessionsReadable: true,
        rolloutFilesPresent: true,
        rolloutFilesObserved: 1,
        rolloutFilesObservedCapped: false,
      },
      state: {
        status: "ready",
        writable: true,
      },
      capabilities: {
        explicitRefresh: true,
        customCodexHomeConfigured: false,
        rawContentExposed: false,
        arbitraryPathAccess: false,
      },
    });
    assert.equal((await fetch(`${base}/api/local/onboarding`, {
      method: "POST",
    })).status, 405);

    const overview = await fetch(`${base}/api/local/overview`);
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).mode, "real_local_evidence");

    const paceOutlook = await fetch(`${base}/api/local/weekly-pace-outlook`);
    assert.equal(paceOutlook.status, 200);
    assert.equal(
      (await paceOutlook.json()).weekly.paceOutlook.schemaVersion,
      "local-weekly-pace-outlook-v0.1",
    );
    assert.equal((await fetch(`${base}/api/local/weekly-pace-outlook`, {
      method: "POST",
    })).status, 405);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const pageBody = await page.text();
    assert.match(pageBody, /TiboTattle/);
    assert.match(
      pageBody,
      new RegExp(
        `content="${PRODUCT_BRAND.appOpenURL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`,
        "u",
      ),
    );
    assert.doesNotMatch(pageBody, new RegExp(SEMANTIC_OPEN_TARGET_PLACEHOLDER, "u"));
    assert.equal((await fetch(`${base}/data-client.js`)).status, 200);
    assert.equal((await fetch(`${base}/localization.js`)).status, 200);
    assert.equal(
      (await fetch(`${base}/telemetry-shared.generated.js`)).status,
      200,
    );
    const telemetryEnvelope = await fetch(`${base}/telemetry-envelope.js`);
    assert.equal(telemetryEnvelope.status, 200);
    assert.equal(
      await telemetryEnvelope.text(),
      "export const envelope = true;",
    );
    const brandIcon = await fetch(`${base}/tibotattle-icon.png`);
    assert.equal(brandIcon.status, 200);
    assert.equal(brandIcon.headers.get("content-type"), "image/png");

    for (const [route, title] of [
      ["gradient", "Gradient detail"],
      ["weekly", "Weekly detail"],
      ["quality", "Quality detail"],
      ["multi-surface", "Multi-surface detail"],
    ]) {
      const report = await fetch(`${base}/reports/${route}`);
      assert.equal(report.status, 200, route);
      assert.match(await report.text(), new RegExp(title, "u"), route);
    }
    const privateReportDirectory = join(
      files.resourceRoot,
      ".usage-monitor",
      "legacy-reports",
    );
    await mkdir(privateReportDirectory, { recursive: true });
    await writeFile(
      join(privateReportDirectory, "2026-07-24-simple-quota-gradient-report.html"),
      "<!doctype html><title>Canonical gradient detail</title>",
      { mode: 0o600 },
    );
    const canonicalReport = await fetch(`${base}/reports/gradient`);
    assert.equal(canonicalReport.status, 200);
    assert.match(await canonicalReport.text(), /Canonical gradient detail/);

    for (const retiredPath of [
      "/api/local/claude/quota",
      "/api/local/reports",
      "/api/local/contribution/preview",
      "/api/local/contribution/sync-once",
      "/api/local/contribution/sync-pause",
      "/api/local/contribution/sync-resume",
      "/api/local/contribution/automatic-settings",
      "/api/local/contribution/automatic-enable",
      "/api/local/contribution/automatic-disable",
    ]) {
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`${base}${retiredPath}`, {
          method,
          ...(method === "POST"
            ? {
              headers: { "Content-Type": "application/json" },
              body: "{}",
            }
            : {}),
        });
        assert.equal(response.status, 404, `${method} ${retiredPath}`);
        assert.equal(
          (await response.json()).error.code,
          "not_found",
          `${method} ${retiredPath}`,
        );
      }
    }

    assert.equal((await fetch(`${base}/reports/gradient`, {
      method: "POST",
    })).status, 405);

    assert.equal((await fetch(`${base}/reports/not-allowed`)).status, 404);
    assert.equal((await fetch(`${base}/api/local/not-allowed`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/local/overview?path=/Users/private`)).status, 400);

    await writeFile(
      join(files.staticRoot, "index.html"),
      "<!doctype html><title>Unstamped</title>",
    );
    assert.equal((await fetch(`${base}/index.html`)).status, 404);
    await writeFile(
      join(files.staticRoot, "index.html"),
      `<meta content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}"><meta content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}">`,
    );
    assert.equal((await fetch(`${base}/index.html`)).status, 404);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("preview companion stamps only the preview semantic-open route", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    environment: {
      ...process.env,
      USAGE_MONITOR_APP_OPEN_URL: PREVIEW_PRODUCT_BRAND.appOpenURL,
    },
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const page = await fetch(`http://127.0.0.1:${app.port}/`);
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.match(body, new RegExp(PREVIEW_PRODUCT_BRAND.appOpenURL, "u"));
    assert.doesNotMatch(body, new RegExp(PRODUCT_BRAND.appOpenURL, "u"));
    assert.doesNotMatch(
      body,
      new RegExp(SEMANTIC_OPEN_TARGET_PLACEHOLDER, "u"),
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("window-breakdown route bounds its range and returns a per-model/speed shape", async () => {
  const files = await fixture();
  const requests = [];
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    // Injected so the route's validation and shaping are exercised without a
    // real unified index on disk. A caller asking for an inverted range is
    // rejected by the reader with a typed code the route maps to 400.
    windowBreakdownProvider: async ({ fromMs, toMs }) => {
      requests.push({ fromMs, toMs });
      if (toMs <= fromMs) {
        const error = new Error("window range is invalid");
        error.code = "window_range_invalid";
        throw error;
      }
      return {
        status: "available",
        errorCode: null,
        schemaVersion: "local-window-breakdown-v0.1",
        from: fromMs,
        to: toMs,
        events: 12,
        unpricedEvents: 0,
        unpricedShare: 0,
        costUsd: 34.5,
        tokens: 6_000,
        fastCostUsd: 0,
        fastEvents: 0,
        byModel: [
          { model: "gpt-5.6-sol", costUsd: 34.5, tokens: 6_000, events: 12, unpricedEvents: 0, unpricedShare: 0, fastModeFamily: "gpt-5.6", fastModeMultiplier: 2.5 },
        ],
        bySpeed: { standard: { speed: "standard", costUsd: 34.5, tokens: 6_000, events: 12, unpricedEvents: 0, unpricedShare: 0 } },
        spark: { events: 0, costUsd: 0 },
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const route = `${base}/api/local/timeline/window-breakdown`;

    // A well-formed bounded window returns the breakdown, and the exact integer
    // parameters reach the provider.
    const ok = await fetch(`${route}?from=1000&to=2000`);
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.schemaVersion, LOCAL_COMPANION_SCHEMA_VERSION);
    assert.equal(payload.breakdown.status, "available");
    assert.equal(payload.breakdown.byModel[0].model, "gpt-5.6-sol");
    assert.deepEqual(requests.at(-1), { fromMs: 1000, toMs: 2000 });

    // Missing, non-integer, and float parameters never reach the provider.
    const before = requests.length;
    assert.equal((await fetch(route)).status, 400);
    assert.equal((await fetch(`${route}?from=1000`)).status, 400);
    assert.equal((await fetch(`${route}?from=1.5&to=2000`)).status, 400);
    assert.equal((await fetch(`${route}?from=abc&to=2000`)).status, 400);
    // An unexpected extra parameter is refused rather than ignored.
    assert.equal((await fetch(`${route}?from=1000&to=2000&path=/x`)).status, 400);
    assert.equal(requests.length, before);

    // A provider that rejects an inverted range maps to a 400 with its code.
    const bad = await fetch(`${route}?from=2000&to=1000`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "window_range_invalid");

    // The route is GET-only.
    assert.equal((await fetch(route, { method: "POST" })).status, 405);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("cache-drop thread links are private, transient, query-free local reads", async () => {
  const files = await fixture();
  const store = fakeStore();
  const requests = [];
  const privateName = "Synthetic local thread name";
  const threadId = "11111111-1111-4111-8111-111111111111";
  let fail = false;
  const overviewBefore = structuredClone(store.getOverview());
  const payload = {
    schemaVersion: "local-cache-drop-thread-links-v1",
    status: "available",
    generation: "7",
    entries: [{ kind: "switch", key: "synthetic-anonymous-pair", thread: {
      id: threadId, name: privateName, nickname: null, parent: null,
    } }],
  };
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => ({}),
    cacheDropThreadLinksProvider: async (options) => {
      requests.push(options);
      if (fail) throw new Error(privateName);
      return payload;
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const route = `${base}/api/local/cache-drop-thread-links`;
    const headers = { "X-Usage-Monitor-Local": "1" };
    // Missing header, foreign origin, arbitrary identifiers/paths and methods
    // are refused before the metadata provider is called.
    assert.equal((await fetch(route)).status, 403);
    assert.equal((await fetch(route, { headers: {
      ...headers, Origin: "https://example.invalid",
    } })).status, 403);
    assert.equal((await fetch(`${route}?id=${threadId}`, { headers })).status, 400);
    assert.equal((await fetch(`${route}?path=elsewhere`, { headers })).status, 400);
    for (const method of ["POST", "DELETE", "OPTIONS"]) {
      const response = await fetch(route, { method, headers });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    const rebind = await rawRequest({
      port: app.port, path: "/api/local/cache-drop-thread-links",
      headers: { ...headers, Host: `example.invalid:${app.port}` },
    });
    assert.equal(rebind.status, 403);
    assert.equal(requests.length, 0);

    // Same-origin browser GETs normally omit Origin; explicit matching Origin
    // is allowed too. Both reads get an independent current snapshot input.
    for (const admitted of [headers, { ...headers, Origin: base }]) {
      const response = await fetch(route, { headers: admitted });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.deepEqual(await response.json(), payload);
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], { overview: overviewBefore });
    assert.deepEqual(store.getOverview(), overviewBefore);
    assert.equal(store.reloads, 0);
    for (const publicRoute of [
      "/api/local/overview", "/api/local/gradient", "/api/local/weekly",
      "/api/local/quality", "/reports/gradient", "/reports/weekly",
    ]) {
      const response = await fetch(`${base}${publicRoute}`);
      assert.equal(response.status, 200, publicRoute);
      const body = await response.text();
      assert.equal(body.includes(privateName), false, publicRoute);
      assert.equal(body.includes(threadId), false, publicRoute);
    }

    // Metadata failures are optional unavailability, not refresh failure or
    // filesystem diagnostics. In particular, do not echo provider errors.
    fail = true;
    const unavailable = await fetch(route, { headers });
    assert.equal(unavailable.status, 200);
    assert.deepEqual(await unavailable.json(), {
      schemaVersion: "local-cache-drop-thread-links-v1",
      status: "unavailable", generation: null, entries: [],
    });
    assert.equal(store.reloads, 0);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("local companion remains usable before Codex is installed", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: join(files.root, "no-codex-home-yet"),
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const onboarding = await fetch(
      `http://127.0.0.1:${app.port}/api/local/onboarding`,
    );
    assert.equal(onboarding.status, 200);
    assert.deepEqual(await onboarding.json(), {
      schemaVersion: "local-onboarding-v0.2",
      status: "needs_attention",
      source: {
        status: "codex_home_missing",
        sessionsReadable: false,
        archivedSessionsReadable: false,
        rolloutFilesPresent: false,
        rolloutFilesObserved: 0,
        rolloutFilesObservedCapped: false,
      },
      state: {
        status: "ready",
        writable: true,
      },
      capabilities: {
        explicitRefresh: true,
        customCodexHomeConfigured: false,
        rawContentExposed: false,
        arbitraryPathAccess: false,
      },
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("startup retires legacy automatic contribution state to an idempotent content-free tombstone", async () => {
  const files = await fixture();
  const privateRoot = join(files.stateRoot, "private");
  const settingsFile = join(
    privateRoot,
    "automatic-contribution-v0.1.json",
  );
  const legacyCanary = "legacy-consent-must-not-survive";
  let first;
  let restarted;
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    settingsFile,
    JSON.stringify({
      schemaVersion: "automatic-contribution-settings-v0.4",
      enabled: true,
      consent: legacyCanary,
      destinationOrigin: "https://legacy.invalid",
    }),
    { mode: 0o600 },
  );
  try {
    first = await startLocalCompanionServer({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: fakeStore(),
      refreshRunner: async () => ({}),
      port: 0,
    });
    await first.snapshotReady;

    const retirement = first.automaticContributionRetirement();
    assert.equal(retirement.status, "retired");
    assert.equal(retirement.priorState, "enabled");
    assert.equal(retirement.networkActivity, false);
    assert.equal(
      retirement.schemaVersion,
      "automatic-contribution-retired-v1",
    );
    assert.equal(
      new Date(retirement.retiredAt).toISOString(),
      retirement.retiredAt,
    );
    const serialized = await readFile(settingsFile, "utf8");
    assert.deepEqual(
      Object.keys(JSON.parse(serialized)).sort(),
      ["networkActivity", "priorState", "retiredAt", "schemaVersion"],
    );
    assert.equal(serialized.includes(legacyCanary), false);
    assert.equal(serialized.includes("legacy.invalid"), false);

    await first.close();
    first = null;
    restarted = await startLocalCompanionServer({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: fakeStore(),
      refreshRunner: async () => ({}),
      port: 0,
    });
    await restarted.snapshotReady;
    const repeated = restarted.automaticContributionRetirement();
    assert.equal(repeated.status, "already_retired");
    assert.equal(repeated.priorState, "enabled");
    assert.equal(repeated.retiredAt, retirement.retiredAt);
    assert.equal(await readFile(settingsFile, "utf8"), serialized);
  } finally {
    await restarted?.close();
    await first?.close();
    await rm(files.root, { recursive: true });
  }
});

test("one state root cannot run concurrently while the retirement lock is held", async () => {
  const files = await fixture();
  let first;
  let restarted;
  const options = {
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  };
  const lockFile = join(
    files.stateRoot,
    "private",
    "automatic-contribution-v0.1.lock",
  );
  try {
    first = await startLocalCompanionServer(options);
    let snapshotSettled = false;
    first.snapshotReady.then(() => {
      snapshotSettled = true;
    });
    await waitFor(() => snapshotSettled);
    await assert.rejects(
      startLocalCompanionServer({
        ...options,
        dataStore: fakeStore(),
      }),
      (error) =>
        error?.code === "automatic_contribution_retirement_instance_active",
    );
    assert.equal((await lstat(lockFile)).isFile(), true);

    await first.close();
    first = null;
    await assert.rejects(
      lstat(lockFile),
      (error) => error?.code === "ENOENT",
    );

    restarted = await startLocalCompanionServer({
      ...options,
      dataStore: fakeStore(),
    });
    await restarted.snapshotReady;
    assert.equal(
      (await fetch(
        `http://127.0.0.1:${restarted.port}/api/local/health`,
      )).status,
      200,
    );
  } finally {
    await restarted?.close();
    await first?.close();
    await rm(files.root, { recursive: true });
  }
});

test("initialization failure retains the retirement lock until idempotent runtime shutdown finishes", async () => {
  const files = await fixture();
  const stopStarted = deferred();
  const cleanupBarrier = deferred();
  const initializationError = new Error("simulated initialization failure");
  let stopCalls = 0;
  let restarted;
  let failedStart;
  let observedFailure;
  const incrementalContributionController = {
    async start() {
      throw new Error("incremental controller must not start after data init fails");
    },
    async stop() {
      stopCalls += 1;
      stopStarted.resolve();
      await cleanupBarrier.promise;
    },
    async inspect() {
      return {};
    },
    async approve() {
      return {};
    },
    async resume() {
      return {};
    },
  };
  const baseOptions = {
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    refreshRunner: async () => ({}),
    port: 0,
  };
  try {
    failedStart = await startLocalCompanionServer({
      ...baseOptions,
      dataStore: {
        ...fakeStore(),
        async initialize() {
          throw initializationError;
        },
      },
      incrementalContributionController,
    });
    observedFailure = assert.rejects(
      failedStart.snapshotReady,
      (error) => error === initializationError,
    );
    await stopStarted.promise;
    assert.equal(stopCalls, 1);

    const failedHealth = await fetch(
      `http://127.0.0.1:${failedStart.port}/api/local/health`,
    ).then((response) => response.json());
    assert.equal(failedHealth.status, "ready");
    assert.equal(failedHealth.snapshot.status, "failed");
    const failedOverview = await fetch(
      `http://127.0.0.1:${failedStart.port}/api/local/overview`,
    );
    assert.equal(failedOverview.status, 503);
    assert.equal((await failedOverview.json()).error.code, "snapshot_unavailable");

    await assert.rejects(
      startLocalCompanionServer({
        ...baseOptions,
        dataStore: fakeStore(),
      }),
      (error) =>
        error?.code === "automatic_contribution_retirement_instance_active",
    );
    assert.equal(stopCalls, 1);

    cleanupBarrier.resolve();
    await observedFailure;
    observedFailure = null;
    await failedStart.close();
    failedStart = null;
    assert.equal(stopCalls, 1);
    await assert.rejects(
      lstat(join(
        files.stateRoot,
        "private",
        "automatic-contribution-v0.1.lock",
      )),
      (error) => error?.code === "ENOENT",
    );

    restarted = await startLocalCompanionServer({
      ...baseOptions,
      dataStore: fakeStore(),
    });
    await restarted.snapshotReady;
    assert.equal(
      (await fetch(
        `http://127.0.0.1:${restarted.port}/api/local/health`,
      )).status,
      200,
    );
  } finally {
    cleanupBarrier.resolve();
    await Promise.allSettled([
      observedFailure,
      failedStart?.close(),
      restarted?.close(),
    ].filter(Boolean));
    await rm(files.root, { recursive: true });
  }
});

test("the port and readiness answer before the first snapshot is built", async () => {
  const files = await fixture();
  const buildStarted = deferred();
  const buildBarrier = deferred();
  const store = fakeStore();
  let app;
  try {
    const startedAt = Date.now();
    app = await startLocalCompanionServer({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: {
        ...store,
        async initialize() {
          buildStarted.resolve();
          await buildBarrier.promise;
        },
      },
      refreshRunner: async () => ({}),
      port: 0,
    });
    const base = `http://127.0.0.1:${app.port}`;
    await buildStarted.promise;

    // Listening, and honest about what is not ready yet. Before the port moved
    // ahead of the build this request could not even be sent: a real install
    // spends seconds here, and a rejected accounting cache spends long enough
    // to exceed the launcher's own startup budget and have the companion
    // killed before it could finish.
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.equal(health.status, "ready");
    assert.deepEqual(health.snapshot, { status: "building", errorCode: null });
    assert.ok(
      Date.now() - startedAt < 5_000,
      "readiness must answer without waiting for the snapshot build",
    );
    assert.equal((await fetch(`${base}/`)).status, 200);

    // A route that reads the snapshot waits for the build rather than
    // projecting a half-built one.
    let overviewSettled = false;
    const overview = fetch(`${base}/api/local/overview`)
      .then((response) => {
        overviewSettled = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(overviewSettled, false);

    buildBarrier.resolve();
    assert.equal((await overview).status, 200);
    await app.snapshotReady;
    assert.deepEqual(
      (await fetch(`${base}/api/local/health`)
        .then((response) => response.json())).snapshot,
      { status: "ready", errorCode: null },
    );
  } finally {
    buildBarrier.resolve();
    await app?.close();
    await rm(files.root, { recursive: true });
  }
});

test("participant relay supports explicit loopback development with exact forwarding", async () => {
  const files = await fixture();
  const forwarded = [];
  const validSetCookie =
    "__Host-usage_monitor_session=um_session_00000000-0000-4000-8000-000000000000.secret; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict";
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: "http://127.0.0.1:8792",
    centralFetch: async (url, options) => {
      forwarded.push({
        url,
        method: options.method,
        headers: { ...options.headers },
        body: options.body?.toString("utf8") ?? null,
        redirect: options.redirect,
      });
      const headers = {
        "Content-Type": "application/json",
        Vary: "Cookie",
      };
      if (url.endsWith("/api/v1/enroll")) headers["Set-Cookie"] = validSetCookie;
      return new Response(JSON.stringify({ status: "ok" }), {
        status: url.endsWith("/api/v1/enroll") ? 201 : 200,
        headers,
      });
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`).then((response) => response.json());
    assert.equal(health.capabilities.centralParticipantRelay, true);

    const enrolled = await fetch(`${base}/api/v1/enroll`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: "unrelated=must-not-pass",
      },
      body: '{"consentVersion":"privacy-safe-telemetry-v0.1","syntheticOnly":false}',
    });
    assert.equal(enrolled.status, 201);
    assert.equal(enrolled.headers.get("set-cookie"), validSetCookie);

    const sessionCookie =
      "__Host-usage_monitor_session=um_session_00000000-0000-4000-8000-000000000000.secret";
    assert.equal((await fetch(`${base}/api/v1/session`, {
      headers: { Cookie: `${sessionCookie}; unrelated=must-not-pass` },
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/me/device-pairings`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: `${sessionCookie}; unrelated=must-not-pass`,
        "X-Usage-Monitor-CSRF": "csrf_token",
      },
      body: "{}",
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/me`, {
      method: "DELETE",
      headers: {
        Origin: base,
        Cookie: sessionCookie,
        "X-Usage-Monitor-CSRF": "csrf_token",
      },
    })).status, 200);
    // Hosted sign-in crosses this relay as a start and a polled result only.
    // Neither carries a code, a verifier, or a redirect: the contribution
    // service owns all three.
    assert.equal((await fetch(`${base}/api/v1/identity/google/start`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
      },
      body: "{}",
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/identity/google/result`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: "S".repeat(64) }),
    })).status, 200);
    // The provider callback is never relayed: it is delivered straight to the
    // contribution service over HTTPS.
    assert.equal((await fetch(`${base}/api/v1/identity/google/callback`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: "{}",
    })).status, 404);

    assert.equal(forwarded[0].url, "http://127.0.0.1:8792/api/v1/enroll");
    assert.equal(forwarded[0].headers.Origin, "http://127.0.0.1:8792");
    assert.equal(Object.hasOwn(forwarded[0].headers, "Cookie"), false);
    assert.deepEqual(forwarded[1].headers, {
      Accept: "application/json",
      Origin: "http://127.0.0.1:8792",
      Cookie: sessionCookie,
    });
    assert.equal(forwarded[2].headers.Cookie, sessionCookie);
    assert.equal(forwarded[2].headers["X-Usage-Monitor-CSRF"], "csrf_token");
    assert.equal(forwarded[2].body, "{}");
    assert.equal(forwarded[3].method, "DELETE");
    assert.equal(forwarded[3].body, null);
    assert.equal(
      forwarded[4].url,
      "http://127.0.0.1:8792/api/v1/identity/google/start",
    );
    assert.equal(Object.hasOwn(forwarded[4].headers, "Cookie"), false);
    assert.equal(forwarded[4].body, "{}");
    assert.equal(
      forwarded[5].url,
      "http://127.0.0.1:8792/api/v1/identity/google/result",
    );
    assert.equal(Object.hasOwn(forwarded[5].headers, "Cookie"), false);
    assert.equal(forwarded[5].body.includes("SSSS"), true);
    assert.equal(forwarded.length, 6);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("participant relay accepts one pinned production HTTPS origin without forwarding ambient authority", async () => {
  const files = await fixture();
  const forwarded = [];
  const centralOrigin = "https://usage-monitor.example";
  const validSetCookie =
    "__Host-usage_monitor_session=um_session_00000000-0000-4000-8000-000000000000.secret; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict";
  const sessionCookie =
    "__Host-usage_monitor_session=um_session_00000000-0000-4000-8000-000000000000.secret";
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin,
    centralFetch: async (url, options) => {
      forwarded.push({
        url,
        method: options.method,
        headers: { ...options.headers },
        body: options.body?.toString("utf8") ?? null,
        redirect: options.redirect,
      });
      return Response.json({ status: "ok" }, {
        status: url.endsWith("/api/v1/enroll") ? 201 : 200,
        headers: url.endsWith("/api/v1/enroll")
          ? { "Set-Cookie": validSetCookie }
          : {},
      });
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.equal(health.capabilities.centralParticipantRelay, true);

    const enrollmentBody =
      '{"consentVersion":"privacy-safe-telemetry-v0.1","syntheticOnly":false}';
    const enrolled = await fetch(`${base}/api/v1/enroll`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: "ambient=must-not-pass",
        "X-Ambient-Authority": "must-not-pass",
      },
      body: enrollmentBody,
    });
    assert.equal(enrolled.status, 201);
    assert.equal(enrolled.headers.get("set-cookie"), validSetCookie);

    const session = await fetch(`${base}/api/v1/session`, {
      headers: {
        Cookie: `${sessionCookie}; ambient=must-not-pass`,
        "X-Ambient-Authority": "must-not-pass",
      },
    });
    assert.equal(session.status, 200);
    assert.deepEqual(forwarded, [
      {
        url: `${centralOrigin}/api/v1/enroll`,
        method: "POST",
        headers: {
          Accept: "application/json",
          Origin: centralOrigin,
          "Content-Type": "application/json",
        },
        body: enrollmentBody,
        redirect: "error",
      },
      {
        url: `${centralOrigin}/api/v1/session`,
        method: "GET",
        headers: {
          Accept: "application/json",
          Origin: centralOrigin,
          Cookie: sessionCookie,
        },
        body: null,
        redirect: "error",
      },
    ]);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("participant relay blocks unknown authority routes and fails closed", async () => {
  const files = await fixture();
  let mode = "ok";
  let forwarded = 0;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: "http://127.0.0.1:8792",
    centralFetch: async () => {
      forwarded += 1;
      if (mode === "throw") throw new Error("private upstream detail");
      if (mode === "html") {
        return new Response("<h1>not json</h1>", {
          headers: { "Content-Type": "text/html" },
        });
      }
      if (mode === "cookie") {
        return Response.json({ status: "ok" }, {
          headers: { "Set-Cookie": "attacker=value; Path=/" },
        });
      }
      return Response.json({ status: "ok" });
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    for (const path of [
      "/api/v1/admin",
      "/api/v1/device-pairings/claim",
      "/api/v1/device/upload-authorizations",
      "/api/v1/contributions/contribution:00000000-0000-4000-8000-000000000000",
      "/api/v1/me/stats",
    ]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404);
    }
    assert.equal(forwarded, 0);
    assert.equal((await fetch(`${base}/api/v1/session`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: "{}",
    })).status, 405);
    assert.equal(forwarded, 0);
    assert.equal((await fetch(`${base}/api/v1/enroll`, {
      method: "POST",
      headers: {
        Origin: "http://attacker.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    })).status, 403);
    assert.equal(forwarded, 0);
    assert.equal((await fetch(`${base}/api/v1/session`, {
      headers: { Authorization: "Bearer must-not-pass" },
    })).status, 400);
    assert.equal(forwarded, 0);

    mode = "throw";
    assert.equal((await fetch(`${base}/api/v1/session`)).status, 502);
    mode = "html";
    assert.equal((await fetch(`${base}/api/v1/session`)).status, 502);
    mode = "cookie";
    assert.equal((await fetch(`${base}/api/v1/session`)).status, 502);
    assert.equal(forwarded, 3);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("participant relay never follows an upstream redirect", async () => {
  const files = await fixture();
  const upstreamRequests = [];
  const upstream = createHttpServer((request, response) => {
    upstreamRequests.push(request.url);
    response.writeHead(302, {
      Location: "/redirected",
      "Content-Type": "application/json",
    });
    response.end('{"status":"redirect"}');
  });
  await new Promise((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", resolveListen);
  });
  const address = upstream.address();
  assert.equal(typeof address, "object");
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: `http://127.0.0.1:${address.port}`,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/api/v1/session`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "central_participant_service_unavailable" },
    });
    assert.deepEqual(upstreamRequests, ["/api/v1/session"]);
  } finally {
    await app.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
    await rm(files.root, { recursive: true });
  }
});

test("server rejects forged hosts and requires same-origin refresh authorization", async () => {
  const files = await fixture();
  const store = fakeStore();
  let resolveRefresh;
  const refreshGate = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => {
      await refreshGate;
      return {
        rolloutRecordsWritten: 2,
        filesDiscovered: 3,
        privatePath: "/Users/private",
        quotaRefresh: { attempted: true, recordWritten: true },
      };
    },
    port: 0,
  });
  try {
    const forgedHost = await rawRequest({
      port: app.port,
      path: "/api/local/health",
      headers: { Host: "attacker.example" },
    });
    assert.equal(forgedHost.status, 403);
    assert.equal(JSON.parse(forgedHost.body).error.code, "host_not_allowed");

    const base = `http://127.0.0.1:${app.port}`;
    const unauthorized = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 403);

    const authorizedHeaders = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify({ reason: "user_request" }),
    });
    assert.equal(started.status, 202);
    const startedPayload = await started.json();
    assert.equal(startedPayload.refresh.status, "running");
    assert.match(
      startedPayload.refresh.refreshId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    const duplicate = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(duplicate.status, 409);
    const duplicatePayload = await duplicate.json();
    assert.equal(
      duplicatePayload.refresh.refreshId,
      startedPayload.refresh.refreshId,
    );
    resolveRefresh();
    await waitFor(async () => {
      const status = await fetch(`${base}/api/local/refresh`).then((response) => response.json());
      return status.refresh.status === "succeeded";
    });
    const completed = await fetch(`${base}/api/local/refresh`).then((response) => response.json());
    assert.equal(completed.refresh.refreshId, startedPayload.refresh.refreshId);
    assert.deepEqual(completed.refresh.result, {
      rolloutRecordsWritten: 2,
      filesDiscovered: 3,
      quotaRefresh: { attempted: true, recordWritten: true, errorCode: null },
    });
    assert.equal(JSON.stringify(completed).includes("/Users/private"), false);
    assert.equal(store.reloads, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("loopback refresh publishes a rollout quarantine as degraded verified coverage", async () => {
  const files = await fixture();
  const generation = {
    id: 9,
    fingerprint: "d".repeat(64),
    status: "partial",
    blockReason: "codex_rollout_sources_quarantined",
    discoveredSourceCount: 3,
    discoveredSourceBytes: 3_000,
    indexedSourceCount: 1,
    indexedSourceBytes: 1_000,
    skippedSourceCount: 2,
    skippedSourceBytes: 2_000,
    skippedThreadCount: 1,
    issueCounts: {
      codex_rollout_generation_ambiguous: {
        threadCount: 1,
        sourceCount: 2,
        sourceBytes: 2_000,
      },
    },
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({
      unifiedIndex: {
        status: "ingested",
        generation,
      },
    }),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: "{}",
    });
    assert.equal(started.status, 202);
    await waitFor(async () => {
      const payload = await fetch(`${base}/api/local/refresh`)
        .then((response) => response.json());
      return payload.refresh.status === "degraded";
    });
    const payload = await fetch(`${base}/api/local/refresh`)
      .then((response) => response.json());
    assert.equal(payload.refresh.status, "degraded");
    assert.equal(payload.refresh.errorCode, "refresh_degraded");
    assert.equal(payload.refresh.failedStep, "unified_index");
    assert.equal(
      payload.refresh.failureCode,
      "codex_rollout_generation_ambiguous",
    );
    assert.deepEqual(payload.refresh.result.unifiedIndex.generation, {
      id: 9,
      fingerprint: "d".repeat(64),
      status: "partial",
      blockReason: "codex_rollout_sources_quarantined",
      schemaVersion: null,
      parserVersion: null,
      contractVersion: null,
      coveredAt: { startAt: null, endAt: null },
      sourceCount: 1,
      sourceBytes: 1_000,
      discoveredSourceCount: 3,
      discoveredSourceBytes: 3_000,
      indexedSourceCount: 1,
      indexedSourceBytes: 1_000,
      skippedSourceCount: 2,
      skippedSourceBytes: 2_000,
      skippedThreadCount: 1,
      reasonCounts: {
        codex_rollout_generation_ambiguous: 1,
      },
      usageEvents: 0,
      quotaOccurrences: 0,
      toolFacts: 0,
      toolFactFingerprint: null,
      discoveryComplete: true,
      diagnosticsComplete: true,
      usageProvenanceComplete: true,
      sourceOrderComplete: true,
      quotaProvenanceComplete: true,
      toolProvenanceComplete: true,
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("server exposes an authorized cancellation without reloading deep state", async () => {
  const files = await fixture();
  const store = fakeStore();
  let observedAbort = false;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: ({ signal, onProgress }) => new Promise((resolve) => {
      onProgress({
        mode: "recent_7d",
        status: "recent_7d_indexing",
        phase: "rollout_index",
        boundedBy: "modified_at_and_collection_start",
        filesDiscovered: 3,
        filesSelected: 3,
        filesProcessed: 1,
        recordsWritten: 2,
        coveredAt: {
          startAt: "2026-07-16T12:00:00.000Z",
          endAt: null,
        },
      });
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({
          rolloutRecordsWritten: 2,
          filesDiscovered: 3,
          indexing: {
            mode: "recent_7d",
            status: "bounded_pause",
            phase: "paused",
            boundedBy: "modified_at_and_collection_start",
            filesDiscovered: 3,
            filesSelected: 3,
            filesProcessed: 1,
            recordsWritten: 2,
            coveredAt: {
              startAt: "2026-07-16T12:00:00.000Z",
              endAt: null,
            },
          },
        });
      }, { once: true });
    }),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const authorizedHeaders = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(started.status, 202);

    const unauthorizedCancel = await fetch(
      `${base}/api/local/refresh/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(unauthorizedCancel.status, 403);

    const cancelled = await fetch(`${base}/api/local/refresh/cancel`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(cancelled.status, 202);
    assert.equal((await cancelled.json()).refresh.status, "cancelling");

    await waitFor(async () => {
      const status = await fetch(`${base}/api/local/refresh`)
        .then((response) => response.json());
      return status.refresh.status === "cancelled";
    });
    const status = await fetch(`${base}/api/local/refresh`)
      .then((response) => response.json());
    assert.equal(observedAbort, true);
    assert.equal(status.refresh.errorCode, "refresh_cancelled");
    assert.equal(status.refresh.progress.status, "bounded_pause");
    assert.equal(store.reloads, 0);

    const duplicateCancel = await fetch(`${base}/api/local/refresh/cancel`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(duplicateCancel.status, 409);
    assert.equal(
      (await duplicateCancel.json()).error.code,
      "refresh_not_running",
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("Darwin loopback stays responsive and cancels a real off-main cold ingest without publication", {
  skip: process.platform !== "darwin",
  timeout: 15_000,
}, async () => {
  const files = await fixture();
  const store = fakeStore();
  const progressReached = deferred();
  const releaseProgress = deferred();
  const indexFile = join(files.stateRoot, "local-unified-index-v1.sqlite");
  const secretFile = join(
    files.stateRoot,
    "local-unified-index-device-salt-v1",
  );
  const sessions = join(files.codexHome, "sessions", "2026", "08", "24");
  const rolloutFile = join(
    sessions,
    "rollout-2026-08-24T00-00-00-11111111-1111-4111-8111-111111111111.jsonl",
  );
  let heldProgress = false;
  let app;
  try {
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    await writeFile(rolloutFile, unifiedIndexRolloutFixture(), { mode: 0o600 });
    app = await startLocalCompanionServer({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: store,
      refreshRunner: ({ signal, onProgress }) => (
        ingestLocalUnifiedIndexOffMain({
          codexHome: files.codexHome,
          indexFile,
          secretFile,
          contractVersion: TELEMETRY_SCHEMA_VERSION,
          signal,
          onProgress: async (progress) => {
            await onProgress(progress);
            if (heldProgress) return;
            heldProgress = true;
            progressReached.resolve();
            await releaseProgress.promise;
          },
        })
      ),
      port: 0,
    });
    await app.snapshotReady;
    const base = `http://127.0.0.1:${app.port}`;
    const authorizedHeaders = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(started.status, 202);
    await progressReached.promise;
    await waitFor(async () => (await readdir(files.stateRoot))
      .some((name) => name.startsWith(
        "local-unified-index-v1.sqlite.building-",
      )), 3_000);

    const health = await fetch(`${base}/api/local/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ready");
    const whileRunning = await fetch(`${base}/api/local/refresh`, {
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(whileRunning.status, 200);
    const runningPayload = await whileRunning.json();
    assert.equal(runningPayload.refresh.status, "running");
    assert.equal(runningPayload.refresh.progress.kind, "unified_index");
    await assert.rejects(
      lstat(indexFile),
      (error) => error?.code === "ENOENT",
    );

    const cancelling = await fetch(`${base}/api/local/refresh/cancel`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(cancelling.status, 202);
    assert.equal((await cancelling.json()).refresh.status, "cancelling");
    await waitFor(async () => {
      const payload = await fetch(`${base}/api/local/refresh`)
        .then((response) => response.json());
      return payload.refresh.status === "cancelled";
    }, 5_000);
    const terminal = await fetch(`${base}/api/local/refresh`)
      .then((response) => response.json());
    assert.equal(terminal.refresh.errorCode, "refresh_cancelled");
    assert.equal(store.reloads, 0);
    await assert.rejects(
      lstat(indexFile),
      (error) => error?.code === "ENOENT",
    );
    assert.deepEqual(
      (await readdir(files.stateRoot)).filter((name) => (
        name.startsWith("local-unified-index-v1.sqlite.building-")
        || name.startsWith("local-unified-index-v1.sqlite.incremental-")
      )),
      [],
    );
  } finally {
    releaseProgress.resolve();
    await app?.close();
    await rm(files.root, { recursive: true });
  }
});

test("retired contribution preview is absent for every method", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    for (const method of ["GET", "POST"]) {
      const response = await fetch(
        `${base}/api/local/contribution/preview`,
        {
          method,
          ...(method === "POST"
            ? {
              headers: { "Content-Type": "application/json" },
              body: "{}",
            }
            : {}),
        },
      );
      assert.equal(response.status, 404, method);
      assert.equal((await response.json()).error.code, "not_found", method);
    }
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.equal(
      Object.hasOwn(health.capabilities, "contributionPreview"),
      false,
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("development file override drives the real default preparation runner without Keychain", async (t) => {
  if (process.platform === "win32") {
    return t.skip("development file identity requires the deferred Windows ACL contract");
  }
  const files = await fixture();
  const privateCanary = "private-session-that-must-not-leak";
  const secretCanary = Buffer.alloc(32, 37).toString("base64url");
  const secretFile = join(files.root, "development-export-identity");
  const codexHome = join(files.root, "codex-home");
  const sessionDirectory = join(codexHome, "sessions");
  const preparedDirectory = join(files.stateRoot, "prepared");
  const reviewDirectory = join(files.stateRoot, "reviews");
  const queueFile = join(files.stateRoot, "queue.sqlite3");
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await writeFile(secretFile, `${secretCanary}\n`, { mode: 0o600 });
  const tokenUsage = {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 8,
    total_tokens: 120,
  };
  const rows = [
    {
      timestamp: "2026-07-24T23:00:00.000Z",
      type: "session_meta",
      payload: {
        id: privateCanary,
        source: "user",
      },
    },
    {
      timestamp: "2026-07-24T23:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    },
    {
      timestamp: "2026-07-24T23:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: tokenUsage,
          last_token_usage: tokenUsage,
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 20,
            window_minutes: 10_080,
            resets_at: 1_785_438_000,
          },
        },
      },
    },
  ];
  await writeFile(
    join(sessionDirectory, "rollout-current.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
  const store = fakeStore();
  store.getOverview = () => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    evidenceStatus: "available",
    collector: {
      exportableCoveredAt: DEVELOPMENT_COVERAGE,
    },
  });
  let keychainConstructions = 0;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => ({}),
    environment: {
      USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: secretFile,
      USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
    },
    contributionQueueFile: queueFile,
    preparedContributionDirectory: preparedDirectory,
    contributionPreparationCreateKeychainBackend() {
      keychainConstructions += 1;
      throw new Error("Keychain must not be constructed");
    },
    contributionPreparationOptions: {
      codexHome,
      activityFile: join(
        files.stateRoot,
        "missing-activity-markers.jsonl",
      ),
      reviewArchiveDirectory: reviewDirectory,
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.equal(
      health.capabilities.contributionPreparationIdentityMode,
      "development_file_override",
    );
    assert.equal(JSON.stringify(health).includes(secretFile), false);
    assert.equal(JSON.stringify(health).includes(secretCanary), false);

    const prepared = await fetch(
      `${base}/api/local/contribution/prepare`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: "{}",
      },
    );
    assert.equal(prepared.status, 200);
    const result = await prepared.json();
    assert.equal(result.status, "prepared");
    assert.equal(result.prepared.batchCount, 1);
    assert.equal(result.networkActivity, false);
    assert.equal(JSON.stringify(result).includes(files.root), false);
    assert.equal(JSON.stringify(result).includes(privateCanary), false);
    assert.equal(JSON.stringify(result).includes(secretCanary), false);
    assert.equal(keychainConstructions, 0);

    const next = await fetch(
      `${base}/api/local/contribution/sync-next`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: "{}",
      },
    ).then((response) => response.json());
    assert.equal(next.status, "available");
    assert.equal(next.state, "ready");
    assert.equal(next.networkActivity, false);

    const unauthorizedReview = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      { method: "POST" },
    );
    assert.equal(unauthorizedReview.status, 403);
    const exactReviewResponse = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: "{}",
      },
    );
    assert.equal(exactReviewResponse.status, 200);
    const exactReview = await exactReviewResponse.json();
    assert.equal(exactReview.status, "available");
    assert.equal(exactReview.state, "ready");
    assert.equal(exactReview.networkActivity, false);
    assert.equal(exactReview.includesExactRetainedFields, true);
    assert.equal(exactReview.includesRawContent, false);
    assert.equal(exactReview.includesPaths, false);
    assert.equal(exactReview.includesDirectIdentifiers, false);
    assert.equal(exactReview.includesCredentials, false);
    assert.equal(exactReview.payload.schemaVersion, "telemetry-contribution-v0.1");
    assert.ok(exactReview.payload.usageEvents.length > 0);
    assert.ok(exactReview.payloadBytes > 0);
    assert.match(exactReview.reviewToken, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(JSON.stringify(exactReview).includes(files.root), false);
    assert.equal(JSON.stringify(exactReview).includes(privateCanary), false);
    assert.equal(JSON.stringify(exactReview).includes(secretCanary), false);
    assert.equal(
      (await fetch(
        `${base}/api/local/contribution/sync-inspect-exact`,
      )).status,
      405,
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("development identity configuration fails before listen without disclosing its path", async () => {
  const files = await fixture();
  const secretFile = join(files.root, "development-export-identity");
  const secretLink = join(files.root, "development-export-identity-link");
  const directory = join(files.root, "identity-directory");
  await writeFile(
    secretFile,
    `${Buffer.alloc(32, 41).toString("base64url")}\n`,
    { mode: 0o600 },
  );
  await symlink(secretFile, secretLink);
  await mkdir(directory, { mode: 0o700 });

  const assertInvalid = async (options) => {
    await assert.rejects(
      startLocalCompanionServer({
        resourceRoot: files.resourceRoot,
        stateRoot: files.stateRoot,
        codexHome: files.codexHome,
        staticRoot: files.staticRoot,
        dataStore: fakeStore(),
        refreshRunner: async () => ({}),
        environment: {},
        port: 0,
        ...options,
      }),
      (error) => error?.code
          === "USAGE_MONITOR_DEVELOPMENT_IDENTITY_INVALID"
        && error.message
          === "Development identity override configuration is invalid"
        && !error.message.includes(files.root)
        && !JSON.stringify(error).includes(files.root),
    );
  };

  try {
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: secretFile,
      },
    });
    await assertInvalid({
      environment: {
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      },
    });
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE:
          "relative-export-identity",
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      },
    });
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: directory,
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      },
    });
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: secretLink,
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      },
    });

    await chmod(secretFile, 0o644);
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: secretFile,
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      },
    });
    await chmod(secretFile, 0o600);
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: secretFile,
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
        APP_USAGEMONITOR_EXPORT_SECRET: "must-not-be-read",
      },
    });
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("contribution preparation is an explicit, bounded, local-only action", async () => {
  const files = await fixture();
  let preparationCalls = 0;
  const preparationRequests = [];
  let releasePreparation;
  const preparationGate = new Promise((resolvePreparation) => {
    releasePreparation = resolvePreparation;
  });
  const privateCanary = "/Users/private/source/session.jsonl";
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionPreparationRunner: async (preparationRequest) => {
      preparationCalls += 1;
      preparationRequests.push(preparationRequest);
      await preparationGate;
      return {
        schemaVersion: "local-contribution-preparation-result-v0.1",
        status: "prepared",
        coveredAt: preparationRequest.lookbackHours === 7 * 24
          ? {
            startAt: "2026-07-20T12:30:00.000Z",
            endAt: "2026-07-26T12:30:00.000Z",
          }
          : {
            startAt: "2026-07-26T12:00:00.000Z",
            endAt: "2026-07-26T12:30:00.000Z",
          },
        recordCounts: {
          usageEvents: 2,
          quotaSnapshots: 1,
          activityMarkers: 0,
        },
        privacy: {
          verdict: "passed",
          checksPassed: 6,
          checksFailed: 0,
          sourceTransportReady: false,
          provenanceRetained: true,
        },
        prepared: {
          schemaVersion: "prepared-contribution-set-v0.1",
          eligibleSchemaVersion: "telemetry-contribution-v0.1",
          batchCount: 1,
          bytes: 4_096,
          privatePath: privateCanary,
        },
        networkActivity: false,
        includesContent: false,
        includesPaths: false,
        includesIdentifiers: false,
        includesCredentials: false,
        privateContent: "must not cross the loopback boundary",
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const authorizedHeaders = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };

    assert.equal((await fetch(`${base}/api/local/contribution/prepare`)).status, 405);
    assert.equal((await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).status, 403);
    assert.equal((await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: '{"reason":"user_request"}',
    })).status, 400);
    assert.equal((await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: '{"path":"/Users/private"}',
    })).status, 400);
    assert.equal((await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: '{"lookbackHours":2}',
    })).status, 400);
    assert.equal((await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: '{"lookbackHours":24,"path":"/Users/private"}',
    })).status, 400);
    const oversized = await rawRequest({
      port: app.port,
      path: "/api/local/contribution/prepare",
      method: "POST",
      headers: {
        ...authorizedHeaders,
        "Content-Length": 1_025,
      },
      body: " ".repeat(1_025),
    });
    assert.equal(oversized.status, 413);
    assert.equal(preparationCalls, 0);

    const first = fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    await waitFor(() => preparationCalls === 1);
    assert.deepEqual(preparationRequests, [{ lookbackHours: 24 }]);
    const overlap = await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(overlap.status, 409);
    assert.deepEqual(await overlap.json(), {
      schemaVersion: "local-contribution-preparation-error-v0.1",
      status: "failed",
      errorCode: "preparation_in_progress",
      networkActivity: false,
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
      includesCredentials: false,
    });

    releasePreparation();
    const response = await first;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schemaVersion: "local-contribution-preparation-result-v0.1",
      status: "prepared",
      coveredAt: {
        startAt: "2026-07-26T12:00:00.000Z",
        endAt: "2026-07-26T12:30:00.000Z",
      },
      recordCounts: {
        usageEvents: 2,
        quotaSnapshots: 1,
        activityMarkers: 0,
      },
      privacy: {
        verdict: "passed",
        checksPassed: 6,
        checksFailed: 0,
        sourceTransportReady: false,
        provenanceRetained: true,
      },
      prepared: {
        schemaVersion: "prepared-contribution-set-v0.1",
        eligibleSchemaVersion: "telemetry-contribution-v0.1",
        batchCount: 1,
        bytes: 4_096,
      },
      networkActivity: false,
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
      includesCredentials: false,
    });

    const sevenDayResponse = await fetch(
      `${base}/api/local/contribution/prepare`,
      {
        method: "POST",
        headers: authorizedHeaders,
        body: '{"lookbackHours":168}',
      },
    );
    assert.equal(sevenDayResponse.status, 200);
    assert.deepEqual(
      (await sevenDayResponse.json()).coveredAt,
      {
        startAt: "2026-07-20T12:30:00.000Z",
        endAt: "2026-07-26T12:30:00.000Z",
      },
    );
    assert.deepEqual(
      preparationRequests,
      [{ lookbackHours: 24 }, { lookbackHours: 7 * 24 }],
    );
    const oneHourResponse = await fetch(
      `${base}/api/local/contribution/prepare`,
      {
        method: "POST",
        headers: authorizedHeaders,
        body: '{"lookbackHours":1}',
      },
    );
    assert.equal(oneHourResponse.status, 200);
    assert.deepEqual(
      preparationRequests,
      [
        { lookbackHours: 24 },
        { lookbackHours: 7 * 24 },
        { lookbackHours: 1 },
      ],
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("contribution preparation failures expose only fixed safe projections", async () => {
  const files = await fixture();
  let mode = "known_error";
  const privateCanary = "/Users/private/source/session.jsonl";
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionPreparationRunner: async () => {
      if (mode === "known_error") {
        const error = new LocalContributionPreparationError(
          "export_too_large",
        );
        error.privatePath = privateCanary;
        throw error;
      }
      if (mode === "identity_migration_required") {
        const error = new LocalContributionPreparationError(
          "identity_migration_required",
        );
        error.privatePath = privateCanary;
        throw error;
      }
      return {
        schemaVersion: "local-contribution-preparation-result-v0.1",
        status: "prepared",
        coveredAt: {
          startAt: "2026-07-26T12:00:00.000Z",
          endAt: "2026-07-26T12:30:00.000Z",
        },
        recordCounts: {
          usageEvents: 2,
          quotaSnapshots: 1,
          activityMarkers: 0,
        },
        privacy: {
          verdict: "passed",
          checksPassed: 6,
          checksFailed: 0,
          sourceTransportReady: false,
          provenanceRetained: true,
        },
        prepared: {
          schemaVersion: "prepared-contribution-set-v0.1",
          eligibleSchemaVersion: "telemetry-contribution-v0.1",
          batchCount: 1,
          bytes: 4_096,
        },
        networkActivity: false,
        includesContent: false,
        includesPaths: true,
        includesIdentifiers: false,
        includesCredentials: false,
        privatePath: privateCanary,
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const request = () => fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: "{}",
    });

    const knownError = await request();
    assert.equal(knownError.status, 413);
    assert.deepEqual(await knownError.json(), {
      schemaVersion: "local-contribution-preparation-error-v0.1",
      status: "failed",
      errorCode: "export_too_large",
      networkActivity: false,
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
      includesCredentials: false,
    });

    mode = "identity_migration_required";
    const migrationRequired = await request();
    assert.equal(migrationRequired.status, 503);
    const migrationBody = await migrationRequired.json();
    assert.equal(migrationBody.errorCode, "identity_migration_required");
    assert.equal(JSON.stringify(migrationBody).includes(privateCanary), false);

    mode = "invalid_result";
    const invalidResult = await request();
    assert.equal(invalidResult.status, 500);
    const projected = await invalidResult.json();
    assert.equal(projected.errorCode, "preparation_failed");
    assert.equal(projected.includesPaths, false);
    assert.equal(JSON.stringify(projected).includes(privateCanary), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("a resource-bounded preparation names its bound on the wire and in the log", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  const privateCanary = "/Users/private/source/session.jsonl";
  const boundCode = "export_resource_expanded_record_bytes";
  let detail = { code: boundCode, observed: 33_554_645, limit: 33_554_432 };
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile,
    clock: () => Date.parse("2026-08-20T07:56:00.000Z"),
    contributionPreparationRunner: async () => {
      const error = new LocalContributionPreparationError("export_too_large");
      error.detail = detail;
      error.privatePath = privateCanary;
      throw error;
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const prepare = () => fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers,
      body: "{}",
    });

    const bounded = await prepare();
    assert.equal(bounded.status, 413);
    const body = await bounded.json();
    // The coarse classification the page's copy is keyed on is unchanged, and
    // the bound that actually stopped the run rides alongside it.
    assert.equal(body.errorCode, "export_too_large");
    assert.deepEqual(body.detail, {
      code: boundCode,
      observed: 33_554_645,
      limit: 33_554_432,
    });
    assert.equal(JSON.stringify(body).includes(privateCanary), false);

    // Outside the closed vocabulary is outside the wire, however the value
    // reached the error.
    detail = { code: `leaked_${privateCanary}`, observed: 2, limit: 1 };
    const forged = await prepare();
    assert.equal(forged.status, 413);
    const forgedBody = await forged.json();
    assert.equal(Object.hasOwn(forgedBody, "detail"), false);
    assert.equal(JSON.stringify(forgedBody).includes(privateCanary), false);

    // The reference the reader copies is only worth quoting if looking it up
    // answers which bound refused the preparation.
    const recorded = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        reference: "TT-4HJ7M2",
        surface: "contribution_prepare",
        code: "export_too_large",
        detail: boundCode,
        requestId: "",
      }),
    });
    assert.equal(recorded.status, 200);
    assert.deepEqual(
      (await readFile(diagnosticsLogFile, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [{
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-20T07:56:00.000Z",
        reference: "TT-4HJ7M2",
        surface: "contribution_prepare",
        code: "export_too_large",
        requestId: "",
        detail: boundCode,
      }],
    );

    // A caller may name a bound; it may not write a sentence, a path, or a
    // label of its own choosing.
    for (const invalid of [
      "arbitrary_detail",
      "Failed reading /Users/private/state.json",
      "export_resource_not_a_bound",
    ]) {
      const rejected = await fetch(`${base}/api/local/diagnostics/note`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          reference: "TT-4HJ7M3",
          surface: "contribution_prepare",
          code: "export_too_large",
          detail: invalid,
          requestId: "",
        }),
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, "invalid_request");
    }
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("contribution sync status exposes bounded queue counts only", async () => {
  const files = await fixture();
  const privatePath = "/Users/private/prepared-set";
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionSyncStatusProvider: async () => ({
      schemaVersion: "contribution-sync-status-v0.1",
      paused: false,
      counts: {
        pending: 2,
        in_flight: 1,
        accepted: 9,
        retryable: 3,
        rejected: 4,
      },
      dueNow: 2,
      nextAttemptAt: "2026-07-26T13:00:00.000Z",
      lastAcceptedAt: "2026-07-26T12:00:00.000Z",
      queuePath: privatePath,
      credential: "um_device_private",
    }),
    port: 0,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${app.port}/api/local/contribution/sync-status`,
    );
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(value.counts, {
      pending: 2,
      inFlight: 1,
      accepted: 9,
      retryable: 3,
      rejected: 4,
    });
    assert.equal(value.includesContent, false);
    assert.equal(value.includesPaths, false);
    assert.equal(value.includesCredentials, false);
    assert.equal(JSON.stringify(value).includes(privatePath), false);
    assert.equal(JSON.stringify(value).includes("um_device_"), false);
    assert.equal(
      (await fetch(
        `http://127.0.0.1:${app.port}/api/local/contribution/sync-status`,
        { method: "POST" },
      )).status,
      405,
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("next inspection, exact review, and device pairing use fixed same-origin routes", async () => {
  const files = await fixture();
  const privateCanary = "/Users/private/prepared/telemetry-secret.json";
  const queueStatus = (paused = false) => ({
    schemaVersion: "contribution-sync-status-v0.1",
    paused,
    counts: {
      pending: paused ? 1 : 0,
      in_flight: 0,
      accepted: paused ? 0 : 1,
      retryable: 0,
      rejected: 0,
    },
    dueNow: paused ? 1 : 0,
    nextAttemptAt: paused ? "2026-07-26T13:00:00.000Z" : null,
    lastAcceptedAt: paused ? null : "2026-07-26T13:00:00.000Z",
  });
  let previewCalls = 0;
  let previewValid = true;
  let reviewCalls = 0;
  let pausedState = false;
  let pairedCode = null;
  const reviewedPayload = exactReviewContribution();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionSyncStatusProvider: async () => queueStatus(pausedState),
    contributionDevicePairingProvider: async ({ pairingCode }) => {
      pairedCode = pairingCode;
      return {
        status: "paired",
        scope: "upload_registration",
        expiresAt: "2026-07-26T14:00:00.000Z",
        deviceId: "00000000-0000-4000-8000-000000000000",
        origin: "https://private.example",
      };
    },
    contributionSyncNextProvider: async () => {
      previewCalls += 1;
      if (!previewValid) throw new Error("prepared set invalid");
      return {
        schemaVersion: "contribution-sync-preview-v0.1",
        state: "ready",
        networkActivity: false,
        discoveredSets: 1,
        enqueued: 1,
        item: {
          schemaVersion: "telemetry-contribution-v0.1",
          clientPlatform: "macos",
          providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
          coveredAt: {
            startAt: "2026-07-26T12:00:00.000Z",
            endAt: "2026-07-26T12:30:00.000Z",
          },
          recordCounts: {
            usageEvents: 2,
            quotaSnapshots: 1,
            activityMarkers: 0,
            total: 3,
          },
          accounting: {
            estimatedApiCostUsd: "1.250000",
            pricedEventCoveragePercent: 100,
            unknownModelEventCount: 0,
            unknownBillableUnits: 0,
            priceBasis: "current_api_prices",
            verification: "client_declared_unverified",
          },
          preparedBytes: 4_096,
          reservedUploadBytes: 16_384,
          attemptCount: 0,
          nextAttemptAt: "2026-07-26T13:00:00.000Z",
          privatePath: privateCanary,
        },
      };
    },
    contributionSyncExactReviewProvider: async () => {
      reviewCalls += 1;
      return {
        schemaVersion: "contribution-sync-exact-review-v0.1",
        state: "ready",
        networkActivity: false,
        discoveredSets: 1,
        enqueued: 0,
        payloadBytes: Buffer.byteLength(
          JSON.stringify(reviewedPayload),
          "utf8",
        ),
        payload: reviewedPayload,
        reviewBinding: {
          jobId: REVIEW_JOB_ID,
          contributionSha256: REVIEW_SHA256,
        },
      };
    },
    contributionSyncPauseSetter: async ({ paused }) => {
      pausedState = paused;
      return queueStatus(paused);
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.equal(health.capabilities.contributionSyncNext, true);
    assert.equal(health.capabilities.contributionSyncExactReview, true);
    assert.equal(health.capabilities.contributionDevicePairing, true);
    assert.equal(
      Object.hasOwn(health.capabilities, "contributionSyncActions"),
      false,
    );

    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const unauthorizedPreview = await fetch(
      `${base}/api/local/contribution/sync-next`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(unauthorizedPreview.status, 403);
    assert.equal(previewCalls, 0);

    const unauthorizedReview = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(unauthorizedReview.status, 403);
    assert.equal(reviewCalls, 0);

    const pairingCode =
      "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    pausedState = true;
    const unauthorizedPairing = await fetch(
      `${base}/api/local/contribution/device-pair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingCode }),
      },
    );
    assert.equal(unauthorizedPairing.status, 403);
    assert.equal(pairedCode, null);
    assert.equal(pausedState, true);
    const paired = await fetch(
      `${base}/api/local/contribution/device-pair`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ pairingCode }),
      },
    ).then((response) => response.json());
    assert.equal(pairedCode, pairingCode);
    assert.equal(pausedState, false);
    assert.deepEqual(paired, {
      schemaVersion: "local-contribution-device-pairing-v0.1",
      status: "paired",
      scope: "upload_registration",
      expiresAt: "2026-07-26T14:00:00.000Z",
      includesCredentials: false,
      includesIdentifiers: false,
    });
    assert.equal(JSON.stringify(paired).includes("00000000"), false);
    assert.equal(JSON.stringify(paired).includes("private.example"), false);

    const inspected = await fetch(
      `${base}/api/local/contribution/sync-next`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    assert.equal(previewCalls, 1);
    assert.equal(inspected.status, "available");
    assert.equal(inspected.deliveryConfigured, false);
    assert.equal(inspected.item.recordCounts.total, 3);
    assert.equal(inspected.networkActivity, false);
    assert.equal(JSON.stringify(inspected).includes(privateCanary), false);

    previewValid = false;
    const invalidPreview = await fetch(
      `${base}/api/local/contribution/sync-next`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    assert.equal(invalidPreview.status, "unavailable");

    const review = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    assert.equal(reviewCalls, 1);
    assert.equal(review.status, "available");
    assert.equal(review.state, "ready");
    assert.equal(review.networkActivity, false);
    assert.equal(review.includesExactRetainedFields, true);
    assert.deepEqual(review.payload, reviewedPayload);
    assert.match(review.reviewToken, /^[A-Za-z0-9_-]{43}$/u);

    for (const path of [
      "/api/local/contribution/sync-next",
      "/api/local/contribution/sync-inspect-exact",
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 405, path);
      assert.equal(
        (await response.json()).error.code,
        "method_not_allowed",
        path,
      );
    }
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("stale contribution-device credentials return fixed recovery guidance without mutation", async () => {
  const files = await fixture();
  const privateCanary =
    "DO-NOT-LEAK-stale-device-credential-conflict";
  const stateFile = join(
    files.stateRoot,
    "missing-device-binding-v1.json",
  );
  let reads = 0;
  let creates = 0;
  let deletes = 0;
  let networkRequests = 0;
  const backend = {
    async read() {
      reads += 1;
      return Buffer.alloc(32, 77);
    },
    async createIfMissing() {
      creates += 1;
      return "created";
    },
    async deleteExact() {
      deletes += 1;
      return "deleted";
    },
  };
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDevicePairingProvider: ({ pairingCode }) =>
      claimContributionDevicePairing({
        origin: "https://central.example",
        pairingCode,
        capabilityOptions: { backend, stateFile },
        fetchImpl: async () => {
          networkRequests += 1;
          throw new Error(privateCanary);
        },
      }),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const pairingCode =
      "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const client = new LocalCompanionClient({
      fetchImpl: (url, options = {}) => fetch(`${base}${url}`, {
        ...options,
        headers: {
          ...options.headers,
          Origin: base,
        },
      }),
    });
    await assert.rejects(
      client.pairContributionDevice(pairingCode),
      (error) => error?.status === 409
        && error?.code === "contribution_device_recovery_required",
    );

    // The browser client preserves only the fixed recovery code. The raw
    // route still carries the same minimal payload, with no credential value
    // or provider failure detail.
    const response = await fetch(
      `${base}/api/local/contribution/device-pair`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ pairingCode }),
      },
    );
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.deepEqual(payload, {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: {
        code: "contribution_device_recovery_required",
      },
    });
    assert.equal(JSON.stringify(payload).includes(privateCanary), false);

    // Integrated rendered-state contract: this exact client error reaches the
    // narrow recovery renderer, which offers reset and never generic fallback.
    const appSource = await readFile(
      new URL("../web/public/app.js", import.meta.url),
      "utf8",
    );
    const htmlSource = await readFile(
      new URL("../web/public/index.html", import.meta.url),
      "utf8",
    );
    // Re-pinned 2026-08-08 (owner-directed one-step flow): the pairing steps
    // live inside the merged Review-and-approve ceremony now, and they report
    // on the merged surface's own status line — the separate connect card and
    // its #community-connect-status are gone.
    const connectSource = appSource.match(
      /async function approveIncrementalContribution\(\) \{([\s\S]*?)\n\}\n/u,
    )?.[1] ?? "";
    // Failure handling was centralized: every connect failure routes through
    // reportContributionConnectFailure, and the recovery contract lives there.
    const reportFailureSource = appSource.match(
      /async function reportContributionConnectFailure\([\s\S]*?\) \{([\s\S]*?)\n\}\n/u,
    )?.[1] ?? "";
    const recoverySource = appSource.match(
      /async function renderContributionDeviceRecovery\(status, \{ error \} = \{\}\) \{([\s\S]*?)\n\}\n\nconst DEVICE_CREDENTIAL_RESET_CONFIRMATION/u,
    )?.[1] ?? "";
    assert.doesNotMatch(htmlSource, /id="community-connect-status"/u);
    assert.match(htmlSource, /id="incremental-consent-status"/u);
    assert.match(htmlSource, /id="community"[^>]*data-dashboard-page="community"/u);
    assert.doesNotMatch(htmlSource, /id="data"[^>]*data-dashboard-page/u);
    assert.doesNotMatch(htmlSource, /data-nav="data"/u);
    assert.match(connectSource, /reportContributionConnectFailure\(status, error/u);
    assert.match(reportFailureSource, /if \(contributionDeviceRecoveryIsRequired\(error\)\) \{\s*\n\s*await renderContributionDeviceRecovery\(status, \{ error \}\);/u);
    assert.match(recoverySource, /id = "reset-device-credential"/u);
    assert.match(recoverySource, /leftover contribution-device credential/u);
    assert.doesNotMatch(recoverySource, /showFailure\(/u);
    assert.doesNotMatch(appSource, /DO-NOT-LEAK-stale-device-credential-conflict/u);
    assert.equal(reads, 2);
    assert.equal(creates, 0);
    assert.equal(deletes, 0);
    assert.equal(networkRequests, 0);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

// Regression: a device credential that a signed update left unreadable (its
// Keychain ACL no longer grants the re-signed companion read access, observed
// live 2026-08-10) surfaces as credential_locked/denied — and a corrupt or
// read-back-mismatched secret as credential_unavailable. Before the recovery
// classifier learned these codes, the pairing mint's up-front capability read
// (claimContributionDevicePairing -> ensureContributionDeviceCapability ->
// readContributionDeviceCapability) threw one of them, the route mapped it to a
// generic 502 pairing_failed with no reset surface, and every retry re-hit the
// same unreadable item — a silent forever-loop. Each must now reach a 409
// recovery code that renders the local reset ceremony. Two keep their own code
// because the reset ceremony is the wrong instruction for them. Denied
// (2026-08-19): the user caused it by answering Deny in the macOS access
// dialog, and the dashboard says which dialog to answer differently on the
// retry; the cure — the reset ceremony — is identical. Locked (2026-08-20):
// nothing on this Mac is broken, so the cure is unlocking the login keychain
// and the reset ceremony would force a needless re-pair.
for (const { label, thrown, routeCode } of [
  { label: "locked keychain", thrown: { code: "export_identity_keychain_locked" }, routeCode: "contribution_device_keychain_locked" },
  { label: "denied", thrown: { code: "export_identity_keychain_denied" }, routeCode: "contribution_device_keychain_access_denied" },
  { label: "unavailable (unreadable/corrupt secret)", thrown: { code: "export_identity_keychain_wedged" }, routeCode: "contribution_device_recovery_required" },
]) {
  test(`an unreadable device credential (${label}) routes pairing to local recovery, not a dead-end 502`, async () => {
    const files = await fixture();
    const privateCanary = "DO-NOT-LEAK-unreadable-device-credential";
    const stateFile = join(files.stateRoot, "missing-device-binding-v1.json");
    let reads = 0;
    let creates = 0;
    let deletes = 0;
    let networkRequests = 0;
    const backend = {
      async read() {
        reads += 1;
        const error = new Error(privateCanary);
        error.code = thrown.code;
        throw error;
      },
      async createIfMissing() {
        creates += 1;
        return "created";
      },
      async deleteExact() {
        deletes += 1;
        return "deleted";
      },
    };
    const app = await startLocalCompanionServer({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: fakeStore(),
      refreshRunner: async () => ({}),
      contributionDevicePairingProvider: ({ pairingCode }) =>
        claimContributionDevicePairing({
          origin: "https://central.example",
          pairingCode,
          capabilityOptions: { backend, stateFile },
          fetchImpl: async () => {
            networkRequests += 1;
            throw new Error(privateCanary);
          },
        }),
      port: 0,
    });
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const headers = {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      };
      const pairingCode =
        "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const client = new LocalCompanionClient({
        fetchImpl: (url, options = {}) => fetch(`${base}${url}`, {
          ...options,
          headers: { ...options.headers, Origin: base },
        }),
      });
      await assert.rejects(
        client.pairContributionDevice(pairingCode),
        (error) => error?.status === 409 && error?.code === routeCode,
      );
      const response = await fetch(
        `${base}/api/local/contribution/device-pair`,
        { method: "POST", headers, body: JSON.stringify({ pairingCode }) },
      );
      assert.equal(response.status, 409);
      const payload = await response.json();
      assert.deepEqual(payload, {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        error: { code: routeCode },
      });
      // The broken secret is never read out, minted over, or leaked: recovery is
      // the sole outcome and it discloses nothing about the failed credential.
      assert.equal(JSON.stringify(payload).includes(privateCanary), false);
      assert.equal(creates, 0);
      assert.equal(deletes, 0);
      assert.equal(networkRequests, 0);
    } finally {
      await app.close();
      await rm(files.root, { recursive: true });
    }
  });
}

test("a declined legacy Keychain migration is preserved and never routed to reset", async () => {
  const files = await fixture();
  const privateCanary = "DO-NOT-LEAK-keychain-migration-declined";
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDevicePairingProvider: async () => {
      const error = new Error(privateCanary);
      error.code = "contribution_device_credential_migration_required";
      throw error;
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const pairingCode =
      "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const client = new LocalCompanionClient({
      fetchImpl: (url, options = {}) => fetch(`${base}${url}`, {
        ...options,
        headers: { ...options.headers, Origin: base },
      }),
    });
    await assert.rejects(
      client.pairContributionDevice(pairingCode),
      (error) => error?.status === 409
        && error?.code === "contribution_device_keychain_migration_required",
    );

    const response = await fetch(
      `${base}/api/local/contribution/device-pair`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: JSON.stringify({ pairingCode }),
      },
    );
    assert.equal(response.status, 409);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "contribution_device_keychain_migration_required" },
    });
    assert.equal(body.includes(privateCanary), false);

    const appSource = await readFile(
      new URL("../web/public/app.js", import.meta.url),
      "utf8",
    );
    const recoveryClassifier = appSource.match(
      /function contributionDeviceRecoveryIsRequired\(error\) \{([\s\S]*?)\n\}/u,
    )?.[1] ?? "";
    assert.doesNotMatch(
      recoveryClassifier,
      /contribution_device_keychain_migration_required/u,
    );
    assert.match(
      appSource,
      /contribution_device_keychain_migration_required:[\s\S]{0,500}Quit and reopen TiboTattle[\s\S]{0,500}Do not reset or delete the credential/u,
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("optional HTTPS central proxy exposes health only without leaking authority headers", async () => {
  const files = await fixture();
  const forwarded = [];
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: "https://central.example",
    centralFetch: async (url, options) => {
      forwarded.push({
        url,
        method: options.method,
        headers: { ...options.headers },
        body: options.body?.toString("utf8") ?? null,
      });
      return new Response(JSON.stringify({
        status: "ok",
        suppressed: true,
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Replayed": "true",
          "X-Private-Upstream": "must-not-pass",
          "Set-Cookie": "__Host-usage_monitor_session=must-not-pass; Secure; HttpOnly",
        },
      });
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`).then((response) => response.json());
    assert.equal(health.capabilities.centralServiceProxy, true);
    assert.equal(health.capabilities.centralParticipantRelay, true);

    const response = await fetch(`${base}/api/health`, {
      headers: {
        Origin: base,
        Authorization: "Bearer must-not-pass",
        Cookie: "__Host-usage_monitor_session=must-not-pass",
        "X-Usage-Monitor-CSRF": "must-not-pass",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("idempotency-replayed"), "true");
    assert.equal(response.headers.get("x-private-upstream"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0], {
      url: "https://central.example/api/health",
      method: "GET",
      headers: { Accept: "application/json" },
      body: null,
    });
    assert.equal((await fetch(`${base}/api/ready`)).status, 404);
    assert.equal((await fetch(`${base}/api/v1/stats/aggregate`)).status, 404);
    assert.equal((await fetch(`${base}/api/v1/stats/aggregate?next=https://attacker.example`)).status, 400);
    assert.equal((await fetch(`${base}/api/v1/admin`)).status, 404);
    assert.equal(forwarded.length, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("production root environment keeps writable queue state outside resources", async () => {
  const files = await fixture();
  const environment = {
    HOME: join(files.root, "home"),
    USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
  };
  const resourceEntriesBefore = await readdir(files.resourceRoot);
  const app = await startLocalCompanionServer({
    environment,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    assert.equal(
      (await fetch(
        `${base}/api/local/contribution/sync-status`,
      )).status,
      200,
    );
    assert.deepEqual(
      await readdir(files.resourceRoot),
      resourceEntriesBefore,
    );
    assert.deepEqual(
      await readdir(join(files.stateRoot, "private")),
      [
        "automatic-contribution-v0.1.json",
        "automatic-contribution-v0.1.lock",
        "contribution-sync-v0.1.sqlite3",
      ],
    );
    if (process.platform !== "win32") {
      assert.equal((await lstat(files.stateRoot)).mode & 0o777, 0o700);
    }
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("Claude shadow roots follow provider configuration and a real project, not installed resources", async () => {
  const files = await fixture();
  const home = join(files.root, "claude-home");
  const config = join(home, "custom-config");
  const project = join(files.root, "real-claude-project");
  await mkdir(config, { recursive: true, mode: 0o700 });
  await mkdir(project, { recursive: true, mode: 0o700 });
  try {
    const fromEnvironment = resolveClaudeDesktopShadowConfiguration({
      environment: {
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_PROJECT_DIR: project,
      },
      fallbackProjectDirectory: files.resourceRoot,
    });
    assert.deepEqual(fromEnvironment, {
      claudeConfigDirectory: config,
      claudeProjectDirectory: project,
    });
    assert.notEqual(fromEnvironment.claudeProjectDirectory, files.resourceRoot);

    const fromOptions = resolveClaudeDesktopShadowConfiguration({
      options: {
        claudeConfigDirectory: join(files.root, "option-config"),
        claudeProjectDirectory: join(files.root, "option-project"),
      },
      environment: {
        CLAUDE_CONFIG_DIR: join(files.root, "environment-config"),
        CLAUDE_PROJECT_DIR: join(files.root, "environment-project"),
      },
      fallbackProjectDirectory: files.resourceRoot,
    });
    assert.equal(fromOptions.claudeConfigDirectory, join(files.root, "option-config"));
    assert.equal(fromOptions.claudeProjectDirectory, join(files.root, "option-project"));

    const defaultConfig = resolveClaudeDesktopShadowConfiguration({
      environment: { HOME: home },
      fallbackProjectDirectory: project,
    });
    assert.equal(defaultConfig.claudeConfigDirectory, undefined);
    assert.equal(defaultConfig.claudeProjectDirectory, project);
    assert.throws(
      () => resolveClaudeDesktopShadowConfiguration({
        environment: { CLAUDE_CONFIG_DIR: "relative-config" },
        fallbackProjectDirectory: project,
      }),
      (error) => error?.code === "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID",
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("Claude shadow wiring ignores malformed env when disabled and forwards roots when enabled", async () => {
  const disabledFiles = await fixture();
  try {
    const disabledApp = createLocalCompanionServer({
      environment: {
        HOME: join(disabledFiles.root, "home"),
        USERPROFILE: join(disabledFiles.root, "home"),
        CLAUDE_CONFIG_DIR: "relative-config",
        CLAUDE_PROJECT_DIR: "relative-project",
      },
      resourceRoot: disabledFiles.resourceRoot,
      stateRoot: disabledFiles.stateRoot,
      codexHome: disabledFiles.codexHome,
      staticRoot: disabledFiles.staticRoot,
      dataStore: fakeStore(),
      refreshRunner: async () => ({}),
    });
    assert.equal(disabledApp.server.listening, false);
  } finally {
    await rm(disabledFiles.root, { recursive: true });
  }

  const enabledFiles = await fixture();
  const home = join(enabledFiles.root, "claude-home");
  const config = join(home, "custom-config");
  const project = join(enabledFiles.root, "real-claude-project");
  await mkdir(config, { recursive: true, mode: 0o700 });
  await mkdir(project, { recursive: true, mode: 0o700 });
  let received;
  try {
    const enabledApp = createLocalCompanionServer({
      environment: {
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_PROJECT_DIR: project,
      },
      resourceRoot: enabledFiles.resourceRoot,
      stateRoot: enabledFiles.stateRoot,
      codexHome: enabledFiles.codexHome,
      staticRoot: enabledFiles.staticRoot,
      dataStore: fakeStore(),
      refreshRunner: async () => ({}),
      claudeShadowEnabled: true,
      claudeShadowControllerFactory(configuration) {
        received = configuration;
        return { async refresh() { return { status: "disabled" }; } };
      },
    });
    assert.equal(enabledApp.server.listening, false);
    assert.deepEqual(received, {
      enabled: true,
      stateRoot: enabledFiles.stateRoot,
      homeDirectory: home,
      projectDirectory: project,
      claudeConfigDirectory: config,
    });
  } finally {
    await rm(enabledFiles.root, { recursive: true });
  }
});

test("production root environment rejects unsafe roots before listen", async () => {
  const files = await fixture();
  const resourceLink = join(files.root, "resource-link");
  const stateTarget = join(files.root, "state-target");
  const stateLink = join(files.root, "state-link");
  await symlink(files.resourceRoot, resourceLink);
  await mkdir(stateTarget, { mode: 0o700 });
  await symlink(stateTarget, stateLink);
  const assertInvalid = async (environment) => {
    await assert.rejects(
      startLocalCompanionServer({
        environment,
        dataStore: fakeStore(),
        refreshRunner: async () => ({}),
        port: 0,
      }),
      (error) => error?.code
          === "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID"
        && error.message
          === "Local installation configuration is invalid"
        && !error.message.includes(files.root)
        && !JSON.stringify(error).includes(files.root),
    );
  };
  try {
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: "relative-resource",
      USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    });
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
      USAGE_MONITOR_STATE_ROOT: "relative-state",
    });
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: resourceLink,
      USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    });
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
      USAGE_MONITOR_STATE_ROOT: stateLink,
    });
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("parent watchdog accepts only the exact live parent PID", async () => {
  const files = await fixture();
  const invalidValues = [
    "",
    "0",
    "1",
    "01",
    "+2",
    ` ${process.ppid}`,
    `${process.ppid} `,
    "2147483648",
    String(process.pid),
    null,
    123,
  ];
  try {
    for (const [index, value] of invalidValues.entries()) {
      const stateRoot = join(files.root, `invalid-parent-${index}`);
      await assert.rejects(
        startLocalCompanionServer({
          environment: {
            HOME: join(files.root, "home"),
            USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
            USAGE_MONITOR_STATE_ROOT: stateRoot,
            USAGE_MONITOR_PARENT_PID: value,
          },
          codexHome: files.codexHome,
          staticRoot: files.staticRoot,
          dataStore: fakeStore(),
          refreshRunner: async () => ({}),
          port: 0,
        }),
        (error) => error?.code === "USAGE_MONITOR_PARENT_PID_INVALID"
          && error.message === "Parent watchdog configuration is invalid"
          && (String(value).length === 0
            || (!error.message.includes(String(value))
              && !JSON.stringify(error).includes(String(value)))),
      );
      await assert.rejects(lstat(stateRoot));
    }

    const app = await startLocalCompanionServer({
      environment: {
        HOME: join(files.root, "home"),
        USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
        USAGE_MONITOR_STATE_ROOT: files.stateRoot,
        USAGE_MONITOR_PARENT_PID: String(process.ppid),
      },
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: fakeStore(),
      refreshRunner: async () => ({}),
      port: 0,
    });
    try {
      const healthUrl =
        `http://127.0.0.1:${app.port}/api/local/health`;
      assert.equal((await fetch(healthUrl)).status, 200);
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
      assert.equal((await fetch(healthUrl)).status, 200);
    } finally {
      await app.close();
    }
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("configured CLI exits after its declared parent disappears", async () => {
  const files = await fixture();
  const parentEnvironment = {
    ...process.env,
    WATCHDOG_SERVER_PATH: resolve("apps/local/server.js"),
    USAGE_MONITOR_PORT: "0",
    USAGE_MONITOR_RESOURCE_ROOT: process.cwd(),
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    HOME: join(files.root, "home"),
    CODEX_HOME: files.codexHome,
  };
  delete parentEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN;
  delete parentEnvironment.USAGE_MONITOR_PARENT_PID;
  const parent = spawn(
    process.execPath,
    ["--input-type=commonjs", "-e", WATCHDOG_PARENT_SCRIPT],
    {
      cwd: files.root,
      env: parentEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  let childPid = null;
  parent.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
    const observed = Number(
      output.match(/WATCHDOG_CHILD_PID=([1-9][0-9]*)/u)?.[1],
    );
    if (Number.isSafeInteger(observed)) childPid = observed;
  });
  parent.stderr.on("data", (chunk) => {
    errors += chunk.toString("utf8");
  });
  try {
    const [code, signal] = await once(parent, "exit");
    assert.equal(signal, null);
    assert.equal(code, 0, errors);
    assert.equal(Number.isSafeInteger(childPid), true);
    const url = output.match(
      /USAGE_MONITOR_READY (http:\/\/127\.0\.0\.1:\d+\/)/u,
    )?.[1];
    assert.ok(url);
    await waitFor(() => !processIsRunning(childPid), 5_000);
    await assert.rejects(fetch(url, {
      signal: AbortSignal.timeout(1_000),
    }));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      parent.kill("SIGKILL");
      await once(parent, "exit");
    }
    if (Number.isSafeInteger(childPid) && processIsRunning(childPid)) {
      process.kill(childPid, "SIGKILL");
    }
    await rm(files.root, { recursive: true });
  }
});

// Hosted sign-in used to redirect back to a loopback callback served here,
// which handed the one-time code to the dashboard through localStorage. Both
// providers now redirect to the contribution service's own callback, so this
// origin must receive no provider redirect at all: the route is gone, and the
// blanket refusal of query strings — which that route was the sole exception
// to — covers every path again.
test("no provider redirect can land on the loopback companion", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const carrying = await fetch(
      `${base}/oauth/google/callback?code=CANARY-code&state=CANARY-state`,
    );
    assert.equal(carrying.status, 400);
    assert.equal((await carrying.text()).includes("CANARY"), false);
    assert.equal(
      (await fetch(`${base}/oauth/google/callback`)).status,
      404,
    );
    assert.equal((await fetch(`${base}/oauth/google/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).status, 404);
    assert.equal(
      (await fetch(`${base}/oauth/google/callback/extra`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/api/v1/identity/google/callback?code=CANARY-code`))
        .status,
      400,
    );
    assert.equal((await fetch(`${base}/?code=CANARY-code`)).status, 400);
    assert.equal(
      (await fetch(`${base}/api/local/health?code=CANARY-code`)).status,
      400,
    );

    // Nothing served by this companion mentions the retired localStorage relay
    // key, so no page here can complete a sign-in out of browser storage.
    const source = await readFile(
      new URL("./server.js", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("tibotattle-google-oauth-result"), false);
    assert.equal(source.includes("/oauth/google/callback"), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("CLI port zero prints its actual ready URL and honors explicit roots", async () => {
  const files = await fixture();
  const childEnvironment = {
    ...process.env,
    USAGE_MONITOR_PORT: "0",
    USAGE_MONITOR_RESOURCE_ROOT: process.cwd(),
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    HOME: join(files.root, "home"),
    CODEX_HOME: files.codexHome,
  };
  delete childEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN;
  delete childEnvironment.USAGE_MONITOR_PARENT_PID;
  const child = spawn(process.execPath, [resolve("apps/local/server.js")], {
    cwd: files.root,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  try {
    await waitFor(() => output.includes("USAGE_MONITOR_READY"), 15_000);
    const url = output.match(
      /USAGE_MONITOR_READY (http:\/\/127\.0\.0\.1:\d+\/)/u,
    )?.[1];
    assert.ok(url);
    assert.notEqual(new URL(url).port, "0");
    const health = await fetch(new URL("/api/local/health", url));
    assert.equal(health.status, 200);
    const onboarding = await fetch(
      new URL("/api/local/onboarding", url),
    ).then((response) => response.json());
    assert.equal(onboarding.status, "ready");
    assert.equal(JSON.stringify(onboarding).includes(files.root), false);
    child.kill("SIGINT");
    const [code, signal] = await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("local companion did not exit after SIGINT")),
          2_000,
        );
      }),
    ]);
    assert.ok(code === 0 || signal === "SIGINT");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(files.root, { recursive: true });
  }
});

test("diagnostic notes are bounded, fixed-vocabulary, and land in a local log", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  let now = Date.parse("2026-08-01T09:00:00.000Z");
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile,
    clock: () => now,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const note = {
      reference: "TT-7QF3K2",
      surface: "contribution_connect",
      code: "contribution_device_recovery_required",
      requestId: "",
    };

    // Loopback alone is not authority: the dashboard header and same origin
    // are both required before anything is written.
    const unauthorized = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(note),
    });
    assert.equal(unauthorized.status, 403);
    assert.deepEqual(await unauthorized.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "diagnostic_note_not_authorized" },
    });
    assert.equal((await fetch(`${base}/api/local/diagnostics/note`)).status, 405);

    const recorded = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers,
      body: JSON.stringify(note),
    });
    assert.equal(recorded.status, 200);
    assert.deepEqual(await recorded.json(), {
      schemaVersion: "local-diagnostic-note-v0.1",
      status: "recorded",
      reference: "TT-7QF3K2",
    });

    now = Date.parse("2026-08-01T09:05:00.000Z");
    await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        reference: "TT-ZZ0011",
        surface: "contribution_send",
        code: "INTERNAL_ERROR",
        requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
      }),
    });

    const lines = (await readFile(diagnosticsLogFile, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      {
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-01T09:00:00.000Z",
        reference: "TT-7QF3K2",
        surface: "contribution_connect",
        code: "contribution_device_recovery_required",
        requestId: "",
      },
      {
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-01T09:05:00.000Z",
        reference: "TT-ZZ0011",
        surface: "contribution_send",
        code: "INTERNAL_ERROR",
        requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
      },
    ]);
    if (process.platform !== "win32") {
      assert.equal((await lstat(diagnosticsLogFile)).mode & 0o777, 0o600);
    }

    // Only the fixed vocabulary is accepted, so a free-form label, a sentence
    // masquerading as a code, or an extra member can never be logged.
    for (const invalid of [
      { ...note, surface: "arbitrary_journey" },
      { ...note, reference: "TT-ILLEGAL" },
      { ...note, reference: "not-a-reference" },
      { ...note, code: "Failed reading /Users/private/state.json" },
      { ...note, requestId: "not-a-uuid" },
      { ...note, extra: "unexpected" },
    ]) {
      const rejected = await fetch(`${base}/api/local/diagnostics/note`, {
        method: "POST",
        headers,
        body: JSON.stringify(invalid),
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, "invalid_request");
    }
    const oversized = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...note, code: "a".repeat(4_096) }),
    });
    assert.equal(oversized.status, 413);
    const recordedText = await readFile(diagnosticsLogFile, "utf8");
    assert.equal(recordedText.includes("/Users/private"), false);
    assert.equal(recordedText.includes("arbitrary_journey"), false);
    assert.equal(recordedText.split("\n").filter(Boolean).length, 2);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("a terminal refresh failure files one bounded, rate-limited diagnostics note", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  const now = Date.parse("2026-08-11T09:00:00.000Z");
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => {
      // The incident shape: a typed accounting resource stop escaping the
      // accounting step with content in its message that must never land in
      // the log.
      const error = new Error("private failure detail /Users/private");
      error.code = "accounting_transition_rss_limit_exceeded";
      error.refreshStep = "accounting";
      throw error;
    },
    diagnosticsLogFile,
    clock: () => now,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const runOnce = async () => {
      const started = await fetch(`${base}/api/local/refresh`, {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(started.status, 202);
      const { refresh } = await started.json();
      await waitFor(async () => {
        const status = await fetch(`${base}/api/local/refresh`)
          .then((response) => response.json());
        return status.refresh.refreshId === refresh.refreshId
          && status.refresh.status === "failed";
      });
    };

    await runOnce();
    await waitFor(async () => {
      try {
        return (await readFile(diagnosticsLogFile, "utf8")).includes("\n");
      } catch {
        return false;
      }
    });
    const status = await fetch(`${base}/api/local/refresh`)
      .then((response) => response.json());
    assert.equal(status.refresh.errorCode, "refresh_resource_limited");

    const lines = (await readFile(diagnosticsLogFile, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0].reference, /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u);
    assert.deepEqual({ ...lines[0], reference: null }, {
      schemaVersion: "local-diagnostic-note-v0.1",
      recordedAt: "2026-08-11T09:00:00.000Z",
      reference: null,
      surface: "local_refresh",
      code: "refresh_resource_limited",
      requestId: "",
      step: "accounting",
      detail: "accounting_transition_rss_limit_exceeded",
    });

    // The identical failure again inside the hour: the terminal state is
    // fully reported, but the log gains no second line — a failure loop can
    // never grow it unboundedly.
    await runOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const repeated = await readFile(diagnosticsLogFile, "utf8");
    assert.equal(repeated.trimEnd().split("\n").length, 1);
    assert.equal(repeated.includes("private failure detail"), false);
    assert.equal(repeated.includes("/Users/private"), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the dashboard's own sign-in failure note lands in the diagnostics log", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  let now = Date.parse("2026-08-07T10:00:00.000Z");
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile,
    clock: () => now,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    // Browser-faithful fetch: receiver-sensitive exactly like Window.fetch
    // (Blink throws "Illegal invocation", WebKit "Can only call Window.fetch
    // on instances of Window" when it is invoked as a property of anything),
    // resolving the dashboard's relative route against this server and
    // stamping the Origin header a browser adds to every same-origin POST.
    // A client that regresses to calling its stored fetch as a method fails
    // here before any request is made — exactly as it would on a real page.
    function browserFetch(url, options = {}) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return fetch(`${base}${url}`, {
        ...options,
        headers: {
          ...options.headers,
          Origin: base,
        },
      });
    }
    const client = new LocalCompanionClient({ fetchImpl: browserFetch });

    // The exact note describeFailure files for a failed hosted sign-in whose
    // error never got a service answer: a page-minted reference, the fixed
    // hosted_identity surface, and empty validated code and request id (the
    // client replaces the empty code with its fixed "unknown").
    const offlineReference = createDiagnosticReference();
    const offline = await client.recordDiagnosticNote({
      reference: offlineReference,
      surface: diagnosticSurface("hosted_identity"),
      code: diagnosticErrorCode(undefined),
      requestId: serviceRequestId(undefined),
    });
    assert.deepEqual(offline, {
      status: "recorded",
      reference: offlineReference,
    });

    // The same journey when the service answered with its fixed error shape:
    // the code and request id travel exactly as validated from that answer.
    now = Date.parse("2026-08-07T10:01:00.000Z");
    const answeredReference = createDiagnosticReference();
    const answered = await client.recordDiagnosticNote({
      reference: answeredReference,
      surface: diagnosticSurface("hosted_identity"),
      code: diagnosticErrorCode("INTERNAL_ERROR"),
      requestId: serviceRequestId("0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b"),
    });
    assert.deepEqual(answered, {
      status: "recorded",
      reference: answeredReference,
    });

    const lines = (await readFile(diagnosticsLogFile, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      {
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-07T10:00:00.000Z",
        reference: offlineReference,
        surface: "hosted_identity",
        code: "unknown",
        requestId: "",
      },
      {
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-07T10:01:00.000Z",
        reference: answeredReference,
        surface: "hosted_identity",
        code: "INTERNAL_ERROR",
        requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
      },
    ]);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("failed diagnostic note writes return a fixed error without leaking recorder details", async () => {
  const files = await fixture();
  let calls = 0;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile: join(files.stateRoot, "diagnostics-v0.1.log"),
    diagnosticNoteRecorder: async () => {
      calls += 1;
      throw new Error("private diagnostic recorder detail");
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: JSON.stringify({
        reference: "TT-7QF3K2",
        surface: "contribution_connect",
        code: "contribution_device_recovery_required",
        requestId: "",
      }),
    });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.deepEqual(payload, {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "diagnostic_note_not_recorded" },
    });
    assert.equal(JSON.stringify(payload).includes("private diagnostic recorder detail"), false);
    assert.equal(calls, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the diagnostics log is bounded and keeps one previous generation", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  await mkdir(files.stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(diagnosticsLogFile, "x".repeat(256 * 1024), { mode: 0o600 });
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const recorded = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: JSON.stringify({
        reference: "TT-ABCDEF",
        surface: "local_refresh",
        code: "refresh_in_progress",
        requestId: "",
      }),
    });
    assert.equal(recorded.status, 200);
    const rotated = await lstat(`${diagnosticsLogFile}.previous`);
    assert.equal(rotated.size, 256 * 1024);
    const current = await readFile(diagnosticsLogFile, "utf8");
    assert.equal(current.split("\n").filter(Boolean).length, 1);
    assert.equal(JSON.parse(current).reference, "TT-ABCDEF");
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("device credential reset removes only the contribution-device entry and its binding", async () => {
  const files = await fixture();
  const stateFile = join(files.stateRoot, "contribution-device-binding-v1.json");
  const unrelatedFile = join(files.stateRoot, "export-participant-secret");
  await mkdir(files.stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    stateFile,
    `${JSON.stringify({
      schemaVersion: "contribution-device-binding-v1",
      origin: "https://contribute.example.test",
      deviceId: "00000000-0000-4000-8000-000000000000",
      createdAt: "2026-07-30T10:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(unrelatedFile, "unrelated-local-secret", { mode: 0o600 });
  const capabilities = [];
  let stored = Buffer.alloc(32, 7);
  const backend = {
    async read(capability) {
      capabilities.push(capability);
      return stored === null ? null : Buffer.from(stored);
    },
    async createIfMissing() {
      return "existing";
    },
    async deleteExact(capability, expected) {
      capabilities.push(capability);
      if (stored === null) return "missing";
      if (!stored.equals(expected)) return "conflict";
      stored = null;
      return "deleted";
    },
    async describe() {
      return { backend: "test", status: "available" };
    },
  };
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDeviceBackendFactory: () => backend,
    port: 0,
  });
  const path = "/api/local/contribution/device-credential-reset";
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const body = JSON.stringify({ confirm: "reset_device_credential" });

    const unauthorized = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(unauthorized.status, 403);
    assert.equal(
      (await unauthorized.json()).error.code,
      "device_credential_reset_not_authorized",
    );
    assert.equal((await fetch(`${base}${path}`)).status, 405);

    // The repair is destructive, so it runs only for the one fixed
    // confirmation; an empty or differently shaped body changes nothing.
    for (const invalid of ["{}", JSON.stringify({ confirm: "yes" })]) {
      const rejected = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: invalid,
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, "invalid_request");
    }
    assert.notEqual(stored, null);

    const reset = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), {
      schemaVersion: "local-contribution-device-reset-v0.1",
      status: "reset",
      credential: "deleted",
      binding: "removed",
      hostedDataDeleted: false,
      includesIdentifiers: false,
    });
    assert.equal(stored, null);
    // Exactly one Keychain capability is ever touched.
    assert.equal(capabilities.length, 2);
    for (const capability of capabilities) {
      assert.equal(
        capability,
        EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice,
      );
      assert.equal(capability.service, "app-usagemonitor.contribution-device.v1");
      assert.equal(capability.account, "installation");
    }
    await assert.rejects(lstat(stateFile), { code: "ENOENT" });
    assert.equal(await readFile(unrelatedFile, "utf8"), "unrelated-local-secret");

    // Repeating the repair is safe and says plainly that nothing was left.
    const repeated = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), {
      schemaVersion: "local-contribution-device-reset-v0.1",
      status: "already_absent",
      credential: "already_missing",
      binding: "already_missing",
      hostedDataDeleted: false,
      includesIdentifiers: false,
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("a failed device credential reset reports one fixed code and deletes nothing", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDeviceCredentialResetRunner: async () => {
      const error = new Error("/Users/private/keychain denied for adamallcock");
      error.code = "export_identity_keychain_denied";
      throw error;
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const failed = await fetch(
      `${base}/api/local/contribution/device-credential-reset`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: JSON.stringify({ confirm: "reset_device_credential" }),
      },
    );
    assert.equal(failed.status, 500);
    const payload = await failed.text();
    assert.deepEqual(JSON.parse(payload), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "device_credential_reset_failed" },
    });
    assert.equal(payload.includes("/Users/private"), false);
    assert.equal(payload.includes("adamallcock"), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("disconnecting this Mac requires a local confirmation and returns no device identifier", async () => {
  const files = await fixture();
  let calls = 0;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDeviceDisconnectRunner: async () => {
      calls += 1;
      return {
        status: "disconnected",
        deliveryPaused: true,
        localCredential: "deleted",
        localBinding: "removed",
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const path = "/api/local/contribution/device-disconnect";
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const health = await fetch(`${base}/api/local/health`).then((response) => response.json());
    assert.equal(health.capabilities.contributionDeviceDisconnect, true);

    const unauthorized = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "disconnect_this_mac" }),
    });
    assert.equal(unauthorized.status, 403);
    assert.equal((await unauthorized.json()).error.code, "contribution_device_disconnect_not_authorized");

    for (const body of ["{}", JSON.stringify({ confirm: "yes" })]) {
      const rejected = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, "invalid_request");
    }
    assert.equal(calls, 0);

    const disconnected = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "disconnect_this_mac" }),
    });
    assert.equal(disconnected.status, 200);
    const body = await disconnected.text();
    assert.deepEqual(JSON.parse(body), {
      schemaVersion: "local-contribution-device-disconnect-v0.1",
      status: "disconnected",
      deliveryPaused: true,
      localCredential: "deleted",
      localBinding: "removed",
      includesIdentifiers: false,
      includesCredentials: false,
      hostedDataDeleted: false,
    });
    assert.equal(calls, 1);
    assert.equal(body.includes("00000000-0000"), false);
    assert.equal((await fetch(`${base}${path}`)).status, 405);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("disconnect serializes duplicate revocation while retired delivery routes stay absent", async () => {
  const files = await fixture();
  const disconnectStarted = deferred();
  const releaseDisconnect = deferred();
  let disconnectCalls = 0;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDeviceDisconnectRunner: async () => {
      disconnectCalls += 1;
      disconnectStarted.resolve();
      await releaseDisconnect.promise;
      return {
        status: "disconnected",
        deliveryPaused: true,
        localCredential: "deleted",
        localBinding: "removed",
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const disconnect = fetch(
      `${base}/api/local/contribution/device-disconnect`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: "disconnect_this_mac" }),
      },
    );
    await disconnectStarted.promise;

    const retiredSync = await fetch(
      `${base}/api/local/contribution/sync-once`,
      {
        method: "POST",
        headers,
        body: "{}",
      },
    );
    assert.equal(retiredSync.status, 404);
    assert.deepEqual(await retiredSync.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "not_found" },
    });

    const duplicate = await fetch(
      `${base}/api/local/contribution/device-disconnect`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: "disconnect_this_mac" }),
      },
    );
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "sync_in_progress" },
    });
    assert.equal(disconnectCalls, 1);

    releaseDisconnect.resolve();
    assert.equal((await disconnect).status, 200);
  } finally {
    releaseDisconnect.resolve();
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("device disconnect failures expose one fixed code without leaking details", async () => {
  const files = await fixture();
  const privateCanary =
    "DO-NOT-LEAK-device-disconnect-capability-conflict";
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDeviceDisconnectRunner: async () => {
      const error = new Error(privateCanary);
      error.code = "contribution_device_credential_conflict";
      throw error;
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const failed = await fetch(
      `${base}/api/local/contribution/device-disconnect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: JSON.stringify({ confirm: "disconnect_this_mac" }),
      },
    );
    assert.equal(failed.status, 502);
    const body = await failed.text();
    assert.deepEqual(JSON.parse(body), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "contribution_device_disconnect_failed" },
    });
    assert.equal(body.includes(privateCanary), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("central outbound fetch pre-warms only the real production service", async () => {
  // The outbound twin of v0.1.6's keep-alive fix (owner-reported 15.23s cold
  // call, 2026-08-10): a startup pre-warm engaged only for the real HTTPS
  // service when the process uses Node's own fetch.

  // Eligible: production HTTPS + the process default fetch. The pre-warm issues
  // exactly one GET to /api/health on the central origin.
  const productionCalls = [];
  const production = createCentralOutboundFetch({
    baseFetch: async (url, options = {}) => {
      productionCalls.push({ url, method: options.method ?? "GET" });
      return new Response("{}", { status: 200 });
    },
    centralOrigin: "https://usage-monitor.example",
    enabled: true,
  });
  await production.warmUp();
  assert.deepEqual(productionCalls, [
    { url: "https://usage-monitor.example/api/health", method: "GET" },
  ]);

  // An injected (non-default) fetch is never pre-warmed, so tests and any
  // custom transport are undisturbed.
  const injectedCalls = [];
  const injected = createCentralOutboundFetch({
    baseFetch: async (url) => {
      injectedCalls.push(url);
      return new Response("{}", { status: 200 });
    },
    centralOrigin: "https://usage-monitor.example",
    enabled: false,
  });
  await injected.warmUp();
  assert.equal(injectedCalls.length, 0, "an injected fetch is never pre-warmed");

  // A development loopback origin is not the cold-TLS case, so it is left alone
  // even with the default fetch.
  const loopbackCalls = [];
  const loopback = createCentralOutboundFetch({
    baseFetch: async (url) => {
      loopbackCalls.push(url);
      return new Response("{}", { status: 200 });
    },
    centralOrigin: "http://127.0.0.1:8792",
    enabled: true,
  });
  await loopback.warmUp();
  assert.equal(loopbackCalls.length, 0, "a loopback origin is never pre-warmed");
});
