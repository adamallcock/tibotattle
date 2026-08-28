import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as codexLocalUsageAnalysis from "../src/codex-local-usage-analysis.js";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import * as providerNormalization from "../src/providers/codex/log-normalization.js";
import * as providerLogs from "../src/providers/codex/logs.js";
import * as providerSurface from "../src/providers/codex/surface-classification.js";
import * as providerTier from "../src/providers/codex/tier-normalization.js";
import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CODEX_PROVIDER_ROOT = resolve(
  REPOSITORY_ROOT,
  "src/providers/codex",
);

const PROVIDER_PUBLIC_EXPORTS = [
  "CODEX_LOG_SCAN_VERSION",
  "CodexLogSourceChangedError",
  "canonicalComponentAvailability",
  "canonicalComponents",
  "canonicalRateLimitSnapshot",
  "canonicalRateLimitWindows",
  "classifySessionSurface",
  "classifyToolCall",
  "codexRolloutDiscoveryReceipt",
  "codexSessionMetaIdentity",
  "createCodexLogScanner",
  "createLeadingRateLimitGate",
  "createSnapshotLineage",
  "cumulativeSnapshotKey",
  "deltaComponentPresence",
  "extractToolObservations",
  "isCodexSpeedMode",
  "normalizeProviderTier",
  "normalizeTokenUsage",
  "parseCodexRolloutFilename",
  "sameUsage",
  "subtractUsage",
  "tokenComponentPresence",
  "unknownCodexTier",
  "validateTierDeclaration",
].sort();

const RUNTIME_SCANNER_OPERATIONS = [
  "appendedRolloutSourcesAreAfterEnd",
  "codexLogSourceFingerprint",
  "codexRolloutDiscoveryReceipt",
  "discoverCodexRolloutInfos",
  "discoverCodexRollouts",
  "hasForkReplayPrefix",
  "readRolloutLineage",
  "scanCodexLogEvents",
  "summarizeCodexRolloutSources",
].sort();

const BOUND_SCANNER_OPERATIONS = [
  "appendedRolloutSourcesAreAfterEnd",
  "codexLogSourceFingerprint",
  "codexRolloutDiscoveryReceipt",
  "discoverCodexRolloutInfos",
  "discoverCodexRollouts",
  "hasForkReplayPrefix",
  "readRolloutLineage",
  "scanCodexLogEvents",
  "summarizeCodexRolloutSources",
].sort();

const LEGACY_PURE_PROVIDER_BINDINGS = [
  "canonicalComponentAvailability",
  "canonicalComponents",
  "canonicalRateLimitSnapshot",
  "canonicalRateLimitWindows",
  "classifyToolCall",
  "codexSessionMetaIdentity",
  "createLeadingRateLimitGate",
  "createSnapshotLineage",
  "cumulativeSnapshotKey",
  "deltaComponentPresence",
  "extractToolObservations",
  "normalizeTokenUsage",
  "sameUsage",
  "subtractUsage",
  "tokenComponentPresence",
];

const TIER_PROVIDER_BINDINGS = [
  "isCodexSpeedMode",
  "normalizeProviderTier",
  "unknownCodexTier",
  "validateTierDeclaration",
];

function portablePath(value) {
  return value.split(sep).join("/");
}

function inertPort() {
  throw new Error("inert provider boundary-test port must not be invoked");
}

async function productionJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, {
    withFileTypes: true,
  })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await productionJavaScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(path);
    }
  }
  return files.sort();
}

test("Codex provider logs expose only the reviewed public API", () => {
  assert.deepEqual(
    Object.keys(providerLogs).sort(),
    PROVIDER_PUBLIC_EXPORTS,
  );
  for (const applicationBinding of [
    "fastQuotaMultiplier",
    "scanAndPriceCodexLogs",
    "subscriptionSpeedSensitivity",
  ]) {
    assert.equal(
      Object.hasOwn(providerLogs, applicationBinding),
      false,
      `${applicationBinding} is not provider-owned`,
    );
  }
});

test("Codex provider scanner has no hidden Node runtime or built-in-module discovery", async () => {
  const source = await readFile(
    resolve(CODEX_PROVIDER_ROOT, "logs.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /\bglobalThis\.process\b/u);
  assert.doesNotMatch(source, /\bgetBuiltinModule\b/u);
  assert.doesNotMatch(source, /node:/u);
});

test("only the application scanner composition owner references the provider factory", async () => {
  const references = [];
  for (const file of await productionJavaScriptFiles(resolve(REPOSITORY_ROOT, "src"))) {
    if (file === resolve(CODEX_PROVIDER_ROOT, "logs.js")) continue;
    const source = await readFile(file, "utf8");
    if (source.includes("createCodexLogScanner")) {
      references.push(portablePath(relative(REPOSITORY_ROOT, file)));
    }
  }
  assert.deepEqual(references, ["src/application/local-codex-log-scanner.js"]);
});

test("the local Node composition exposes only bound scanner operations", () => {
  assert.deepEqual(
    Object.keys(localCodexLogScanner).sort(),
    RUNTIME_SCANNER_OPERATIONS,
  );
  assert.equal(Object.hasOwn(localCodexLogScanner, "scanAndPriceCodexLogs"), false);
  assert.equal(typeof codexLocalUsageAnalysis.scanAndPriceCodexLogs, "function");
});

test("the Codex log facade re-exports each pure provider binding by identity", () => {
  for (const binding of LEGACY_PURE_PROVIDER_BINDINGS) {
    assert.equal(
      providerLogs[binding],
      providerNormalization[binding],
      `${binding} must be re-exported without a wrapper`,
    );
  }
  assert.equal(
    providerLogs.classifySessionSurface,
    providerSurface.classifySessionSurface,
  );
  for (const binding of TIER_PROVIDER_BINDINGS) {
    assert.equal(
      providerLogs[binding],
      providerTier[binding],
      `${binding} must be re-exported without a wrapper`,
    );
  }
});

test("the Codex log scanner factory binds exactly the nine source operations", () => {
  const filesystem = Object.fromEntries([
    "createSha256",
    "currentUid",
    "defaultCodexHome",
    "joinPath",
    "lstatPath",
    "openDirectory",
    "openReadOnlyNoFollow",
    "readSelectedRolloutNames",
    "readUtf8LinesRange",
    "readUtf8Range",
    "statPath",
  ].map((name) => [name, inertPort]));
  const lineReader = {
    readBoundedUtf8Lines: inertPort,
  };

  const scanner = providerLogs.createCodexLogScanner({
    filesystem,
    lineReader,
  });

  assert.deepEqual(
    Object.keys(scanner).sort(),
    BOUND_SCANNER_OPERATIONS,
  );
  assert.equal(
    Object.hasOwn(scanner, "scanAndPriceCodexLogs"),
    false,
  );
});

test("Codex provider production imports stay inside the provider and approved runtime contracts", async () => {
  const files = await productionJavaScriptFiles(CODEX_PROVIDER_ROOT);
  const forbiddenEdges = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const imports = await extractEsmImports(source);
    for (const { specifier } of imports) {
      if (typeof specifier !== "string") continue;
      let category = null;
      let target = specifier;
      if (
        specifier === "runcost"
        || specifier.startsWith("runcost/")
        || /(?:^|\/)accounting(?:\/|$)/u.test(specifier)
      ) {
        category = "accounting_or_pricing";
      } else if (
        specifier.startsWith("@app-usagemonitor/")
        && specifier !== "@app-usagemonitor/telemetry-contract"
      ) {
        category = "unapproved_first_party_package";
      } else if (specifier.startsWith(".") || specifier.startsWith("/")) {
        target = portablePath(
          relative(
            REPOSITORY_ROOT,
            resolve(dirname(file), specifier),
          ),
        );
        if (target.startsWith("apps/")) {
          category = "application";
        } else if (
          target.startsWith("scripts/")
          || target.startsWith("tools/")
        ) {
          category = "tooling";
        } else if (target.startsWith("src/platform/")) {
          category = "platform";
        } else if (
          target.startsWith("src/")
          && !target.startsWith("src/providers/codex/")
        ) {
          category = /(?:cost-ledger|local-api-pricing|price-registry)/u
            .test(target)
            ? "accounting_or_pricing"
            : "root_legacy";
        }
      }
      if (category !== null) {
        forbiddenEdges.push({
          category,
          importer: portablePath(relative(REPOSITORY_ROOT, file)),
          target,
        });
      }
    }
  }

  assert.deepEqual(forbiddenEdges, []);
});
