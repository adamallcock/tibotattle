import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkLocalQuotaAnalysisPackage,
  checkLocalWorkspacePackages,
} from "./check-local-workspace-packages.mjs";

function receipt(packageName, fileCount, sha256) {
  return Object.freeze({
    packageName,
    fileCount,
    files: Object.freeze([]),
    sha256,
  });
}

test("checks all local packages in a deterministic order", async () => {
  const calls = [];
  const accounting = receipt(
    "@app-usagemonitor/accounting",
    6,
    "a".repeat(64),
  );
  const telemetryContract = receipt(
    "@app-usagemonitor/telemetry-contract",
    8,
    "b".repeat(64),
  );
  const quotaAnalysis = receipt(
    "@app-usagemonitor/quota-analysis",
    6,
    "c".repeat(64),
  );
  const result = await checkLocalWorkspacePackages({
    checkAccountingPackage: async () => {
      calls.push("accounting");
      return accounting;
    },
    checkQuotaAnalysisPackage: async () => {
      calls.push("quota-analysis");
      return quotaAnalysis;
    },
    checkTelemetryContractPackage: async () => {
      calls.push("telemetry-contract");
      return telemetryContract;
    },
  });

  assert.deepEqual(calls, [
    "accounting",
    "telemetry-contract",
    "quota-analysis",
  ]);
  assert.equal(result.packageCount, 3);
  assert.deepEqual(result.packages, [
    accounting,
    telemetryContract,
    quotaAnalysis,
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.packages), true);
});

test("preserves the stale telemetry package error", async () => {
  const calls = [];
  const stale = new Error("installed telemetry package is stale");
  stale.code = "TELEMETRY_CONTRACT_PACKAGE_STALE";

  await assert.rejects(
    checkLocalWorkspacePackages({
      checkAccountingPackage: async () => {
        calls.push("accounting");
        return receipt(
          "@app-usagemonitor/accounting",
          6,
          "a".repeat(64),
        );
      },
      checkTelemetryContractPackage: async () => {
        calls.push("telemetry-contract");
        throw stale;
      },
      checkQuotaAnalysisPackage: async () => {
        calls.push("quota-analysis");
      },
    }),
    {
      code: "TELEMETRY_CONTRACT_PACKAGE_STALE",
      message: "installed telemetry package is stale",
    },
  );
  assert.deepEqual(calls, ["accounting", "telemetry-contract"]);
});

test("stops after a stale accounting package and validates injected checks", async () => {
  const stale = new Error("installed accounting package is stale");
  stale.code = "ACCOUNTING_PACKAGE_STALE";
  let telemetryChecked = false;
  await assert.rejects(
    checkLocalWorkspacePackages({
      checkAccountingPackage: async () => {
        throw stale;
      },
      checkTelemetryContractPackage: async () => {
        telemetryChecked = true;
      },
      checkQuotaAnalysisPackage: async () => {
        telemetryChecked = true;
      },
    }),
    { code: "ACCOUNTING_PACKAGE_STALE" },
  );
  assert.equal(telemetryChecked, false);
  await assert.rejects(
    checkLocalWorkspacePackages(null),
    /options must be an object/u,
  );
  await assert.rejects(
    checkLocalWorkspacePackages({
      checkAccountingPackage: "not a function",
    }),
    /checkAccountingPackage must be a function/u,
  );
  await assert.rejects(
    checkLocalWorkspacePackages({
      checkAccountingPackage: async () => receipt(
        "@app-usagemonitor/accounting",
        6,
        "a".repeat(64),
      ),
      checkTelemetryContractPackage: async () => receipt(
        "@app-usagemonitor/telemetry-contract",
        8,
        "b".repeat(64),
      ),
      checkQuotaAnalysisPackage: "not a function",
    }),
    /checkQuotaAnalysisPackage must be a function/u,
  );
});

test("quota analysis uses the generic byte-exact workspace package guard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quota-analysis-copy-"));
  const sourceRoot = new URL(
    "../../../packages/quota-analysis/",
    import.meta.url,
  );
  const installedRoot = join(directory, "installed");
  try {
    await cp(sourceRoot, installedRoot, { recursive: true });
    // npm installs only the files declared by the package manifest. Keep the
    // synthetic installed copy faithful when the source package also carries
    // its own unshipped tests and repository guidance.
    await rm(join(installedRoot, "test"), { force: true, recursive: true });
    await rm(join(installedRoot, "AGENTS.md"), { force: true });
    const receiptValue = await checkLocalQuotaAnalysisPackage({
      installedRoot,
      sourceRoot: sourceRoot.pathname,
    });
    assert.equal(
      receiptValue.packageName,
      "@app-usagemonitor/quota-analysis",
    );
    assert.deepEqual(receiptValue.files, [
      "index.d.ts",
      "index.js",
      "package.json",
      "src/model-composition.js",
      "src/quota-calibration.js",
      "src/quota-pace-forecast.js",
      "src/quota-rolling.js",
      "src/quota-tracks.js",
      "src/quota-windows.js",
    ]);
    assert.match(receiptValue.sha256, /^[a-f0-9]{64}$/u);

    const selected = join(
      installedRoot,
      "src",
      "quota-calibration.js",
    );
    await writeFile(
      selected,
      `${await readFile(selected, "utf8")}\n// stale\n`,
      "utf8",
    );
    await assert.rejects(
      checkLocalQuotaAnalysisPackage({
        installedRoot,
        sourceRoot: sourceRoot.pathname,
      }),
      {
        code: "QUOTA_ANALYSIS_PACKAGE_STALE",
        message:
          "installed @app-usagemonitor/quota-analysis package is stale: "
          + "src/quota-calibration.js",
      },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("all direct npm Wrangler entry points run the combined guard first", async () => {
  const workerPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const name of [
    "dev",
    "dev:account-scoped",
    "deploy:dry",
    "staging:check",
  ]) {
    assert.match(
      workerPackage.scripts[name],
      /^npm run workspace-packages:guard && /u,
      `${name} must run the combined workspace package guard first`,
    );
  }
});

test("local lab and acceptance share the guarded backend lab entry point", async () => {
  const workerPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(
    workerPackage.scripts["lab:local"],
    /start-local-backend-lab\.mjs/u,
  );
  assert.match(
    workerPackage.scripts["acceptance:local"],
    /start-local-backend-lab\.mjs --exit-after-receipt/u,
  );
  const labSource = await readFile(
    new URL("./start-local-backend-lab.mjs", import.meta.url),
    "utf8",
  );
  const guardOffset = labSource.indexOf(
    "await checkLocalWorkspacePackages();",
  );
  assert.notEqual(guardOffset, -1);
  assert.ok(
    guardOffset < labSource.indexOf(
      "const lifecycleInvitationFiles = prepareState(",
    ),
    "the combined guard must run before local migration can invoke Wrangler",
  );
});
