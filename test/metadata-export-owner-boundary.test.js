import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isProxy } from "node:util/types";

import { createLocalMetadataExportContext } from "../src/application/index.js";
import {
  CODEX_COLLECTOR_CANDIDATE_VERSION,
  createCodexCheckpointStateContext,
  createSafeRecordsContext,
} from "../src/export/index.js";
import * as legacyCheckpoint from "../src/export-checkpoint-state.js";
import * as legacySafeRecords from "../src/export-safe-records.js";
import * as legacyMetadata from "../src/metadata-exporter.js";
import { createLocalCodexLogPorts } from "../src/platform/index.js";
import { CODEX_COLLECTOR_CANDIDATE_VERSION as collectorCandidateVersion } from "../src/codex-collector-export-source.js";
import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_RECORD_EXPORTS = [
  "createEmptySafeToolClassCounts",
  "diagnosticsFromCodexScan",
  "normalizeActivityMarker",
  "normalizeClaudeStatusQuotaSnapshots",
  "normalizeClaudeTranscriptUsageCandidate",
  "normalizeCodexCollectorQuotaCandidate",
  "normalizeCodexQuotaSnapshot",
  "normalizeCodexUsageEvent",
  "normalizeExportBounds",
  "quotaObservationIdentitySubject",
  "quotaStateIdentitySubject",
  "safeExportModelDeclaration",
  "safeToolCountFieldForScannerToolClass",
  "scanCodexSafeRecords",
  "summarizeActivityMarkerPlan",
  "usageEventIdentitySubject",
].sort();

test("metadata export owners expose only their reviewed factories and exact legacy APIs", () => {
  assert.equal(typeof createLocalMetadataExportContext, "function");
  assert.equal(typeof createSafeRecordsContext, "function");
  assert.equal(typeof createCodexCheckpointStateContext, "function");
  assert.equal(CODEX_COLLECTOR_CANDIDATE_VERSION, collectorCandidateVersion);
  assert.deepEqual(Object.keys(legacySafeRecords).sort(), SAFE_RECORD_EXPORTS);
  assert.deepEqual(Object.keys(legacyCheckpoint).sort(), [
    "EXPORT_CHECKPOINT_PARSER_VERSION",
    "createEmptyCodexCheckpointState",
    "digestCodexCheckpointState",
    "normalizeCodexCheckpointState",
    "serializeCodexCheckpointState",
  ]);
  assert.deepEqual(Object.keys(legacyMetadata).sort(), [
    "buildLocalMetadataBundle",
    "quotaObservationIdentitySubject",
    "quotaStateIdentitySubject",
    "renderMetadataExportPreview",
    "usageEventIdentitySubject",
    "writeLocalMetadataBundle",
  ]);
  const checkpoint = createCodexCheckpointStateContext({ createHash, isProxy });
  assert.equal(
    checkpoint.serializeCodexCheckpointState(checkpoint.createEmptyCodexCheckpointState()),
    legacyCheckpoint.serializeCodexCheckpointState(legacyCheckpoint.createEmptyCodexCheckpointState()),
  );
  assert.equal(typeof createLocalCodexLogPorts().filesystem.openReadOnlyNoFollow, "function");
});

test("new safe-record and metadata option boundaries fail without reflecting private values", () => {
  assert.throws(
    () => createCodexCheckpointStateContext({
      createHash: new Proxy(createHash, {
        apply() {
          throw new Error("PRIVATE-CHECKPOINT-CALLABLE-CANARY");
        },
      }),
      isProxy,
    }),
    (error) => error instanceof TypeError
      && !`${error.stack}${JSON.stringify(error)}`.includes("PRIVATE-CHECKPOINT-CALLABLE-CANARY"),
  );
  assert.throws(
    () => createSafeRecordsContext(new Proxy({}, {
      get() {
        throw new Error("PRIVATE-SAFE-RECORDS-CANARY");
      },
    })),
    (error) => error instanceof TypeError
      && !`${error.stack}${JSON.stringify(error)}`.includes("PRIVATE-SAFE-RECORDS-CANARY"),
  );
  assert.throws(
    () => createLocalCodexLogPorts(new Proxy({}, {
      get() {
        throw new Error("PRIVATE-CODEX-PORTS-CANARY");
      },
    })),
    (error) => error instanceof TypeError
      && !`${error.stack}${JSON.stringify(error)}`.includes("PRIVATE-CODEX-PORTS-CANARY"),
  );
  assert.throws(
    () => createLocalMetadataExportContext(new Proxy({}, {
      get() {
        throw new Error("PRIVATE-METADATA-CANARY");
      },
    })),
    (error) => error instanceof TypeError
      && !`${error.stack}${JSON.stringify(error)}`.includes("PRIVATE-METADATA-CANARY"),
  );
});

test("local Codex ports observe CODEX_HOME at each default-home call and reject hostile values", () => {
  const environment = {};
  const ports = createLocalCodexLogPorts({
    environment,
    homeDirectory: "/fallback-home",
  });
  assert.equal(ports.filesystem.defaultCodexHome(), "/fallback-home/.codex");
  environment.CODEX_HOME = "/first-codex-home";
  assert.equal(ports.filesystem.defaultCodexHome(), "/first-codex-home");
  environment.CODEX_HOME = "/second-codex-home";
  assert.equal(ports.filesystem.defaultCodexHome(), "/second-codex-home");
  delete environment.CODEX_HOME;
  assert.equal(ports.filesystem.defaultCodexHome(), "/fallback-home/.codex");

  Object.defineProperty(environment, "CODEX_HOME", {
    configurable: true,
    get() {
      throw new Error("PRIVATE-CODEX-HOME-CANARY");
    },
  });
  assert.throws(
    () => ports.filesystem.defaultCodexHome(),
    (error) => error instanceof TypeError
      && error.message === "local Codex log ports configuration is invalid"
      && !`${error.stack}${JSON.stringify(error)}`.includes("PRIVATE-CODEX-HOME-CANARY"),
  );
  assert.throws(
    () => createLocalCodexLogPorts({
      environment: new Proxy({}, {
        get() {
          throw new Error("PRIVATE-CODEX-HOME-CANARY");
        },
      }),
      homeDirectory: "/fallback-home",
    }),
    (error) => error instanceof TypeError
      && error.message === "local Codex log ports configuration is invalid"
      && !`${error.stack}${JSON.stringify(error)}`.includes("PRIVATE-CODEX-HOME-CANARY"),
  );
});

test("metadata owner directions stay runtime-neutral and local-review no longer reaches the flat exporter", async () => {
  const source = async (relativePath) => readFile(resolve(REPOSITORY_ROOT, relativePath), "utf8");
  const [safeRecords, checkpointState, application, platformPorts, localReview] = await Promise.all([
    source("src/export/safe-records.js"),
    source("src/export/checkpoint-state.js"),
    source("src/application/local-metadata-export.js"),
    source("src/platform/local-codex-log-ports.js"),
    source("local-review/cli.js"),
  ]);
  for (const sourceText of [safeRecords, checkpointState]) {
    assert.equal(sourceText.includes("node:"), false);
    assert.equal(sourceText.includes("../platform/"), false);
    assert.equal(sourceText.includes("../application/"), false);
    assert.equal(sourceText.includes("../metadata-exporter"), false);
  }
  const applicationImports = await extractEsmImports(application);
  assert.deepEqual(
    applicationImports.map(({ specifier }) => specifier).sort(),
    ["../export/index.js", "../providers/claude/statusline.js", "./local-codex-log-scanner.js", "node:util/types"],
  );
  assert.equal(platformPorts.includes("../export/"), false);
  assert.equal(platformPorts.includes("../application/"), false);
  assert.equal(localReview.includes("../src/metadata-exporter.js"), false);
  assert.match(application, /safeRecords\.scanCodexSafeRecords\(\{[\s\S]*?signal,/u);
  assert.match(safeRecords, /signal = null,/u);
});
