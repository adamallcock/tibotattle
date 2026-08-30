import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkLocalTelemetryContractPackage,
} from "./check-local-telemetry-contract-package.mjs";

const SOURCE_ROOT = new URL(
  "../../../packages/telemetry-contract/",
  import.meta.url,
);

test("telemetry contract wrapper validates an exact package copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telemetry-contract-copy-"));
  const installedRoot = join(directory, "installed");
  await cp(SOURCE_ROOT, installedRoot, { recursive: true });
  // npm installs only files declared by the package manifest. Keep the
  // synthetic installed copy faithful when scoped guidance is present.
  await rm(join(installedRoot, "AGENTS.md"));

  const receipt = await checkLocalTelemetryContractPackage({
    sourceRoot: SOURCE_ROOT.pathname,
    installedRoot,
  });

  assert.equal(receipt.packageName, "@app-usagemonitor/telemetry-contract");
  assert.ok(receipt.files.includes("index.d.ts"));
  assert.ok(receipt.files.includes("src/telemetry-v0.1.js"));
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/u);
});

test("telemetry contract wrapper rejects a stale installed source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telemetry-contract-stale-"));
  const installedRoot = join(directory, "installed");
  await cp(SOURCE_ROOT, installedRoot, { recursive: true });
  await rm(join(installedRoot, "AGENTS.md"));
  const selected = join(installedRoot, "src", "constants.js");
  await writeFile(
    selected,
    `${await readFile(selected, "utf8")}\n// stale\n`,
    "utf8",
  );

  await assert.rejects(
    checkLocalTelemetryContractPackage({
      sourceRoot: SOURCE_ROOT.pathname,
      installedRoot,
    }),
    (error) => (
      error?.code === "TELEMETRY_CONTRACT_PACKAGE_STALE"
      && /stale: src\/constants\.js/u.test(error.message)
    ),
  );
});
