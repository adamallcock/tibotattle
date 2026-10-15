import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, promises as fsPromises } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  invokeElectronWindowsSigning,
  parseElectronWindowsSigningArguments,
  prepareElectronWindowsBuilderHost,
  preflightElectronWindowsSigning,
} from "../scripts/finalize-electron-windows-signing.mjs";
import { productionElectronCandidatePlan } from "../scripts/package-electron-production.mjs";

const SOURCE_REVISION = "a".repeat(40);
const BUILD_NUMBER = "20260909";
const RETIRED = "ELECTRON_WINDOWS_SIGNING_LEGACY_BUILDER_SIGNING_RETIRED";
const SCRIPT = fileURLToPath(new URL("../scripts/finalize-electron-windows-signing.mjs", import.meta.url));

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-signing-"));
  try {
    const candidatePath = join(root, ".release-build", "electron-production", "win32-x64",
      "production-source-candidate.json");
    const candidate = {
      ...productionElectronCandidatePlan({
        target: "win32-x64", sourceRevision: SOURCE_REVISION, buildNumber: BUILD_NUMBER,
        hostPlatform: "win32", hostArchitecture: "x64",
      }),
      status: "production_source_staged",
      stagedManifest: "app/package.json",
      runtimeManifest: "app/electron-runtime-manifest.json",
    };
    await mkdir(dirname(candidatePath), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    await writeFile(candidatePath, bytes, { flag: "wx", mode: 0o600 });
    return await run({ bytes, candidate, candidatePath, root });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

// Exclude access times, which an inspection may legitimately update.
async function snapshot(root) {
  const entries = [];
  async function visit(path, relativePath) {
    const metadata = await lstat(path);
    entries.push({ relativePath, mode: metadata.mode, size: metadata.size, nlink: metadata.nlink,
      mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs,
      sha256: metadata.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : null });
    if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relativePath}/${name}`);
    }
  }
  await visit(root, ".");
  return entries;
}

function dependencies(repositoryRoot, { platform = "win32", architecture = "x64", version = "v26.2.0" } = {}) {
  return {
    repositoryRoot, platform, architecture, version,
    get environment() { throw new Error("credential environment must not be inspected"); },
    get run() { throw new Error("child command adapter must not be inspected"); },
    get builderCli() { throw new Error("builder must not be resolved"); },
  };
}

test("Windows source preflight validates the exact candidate without commands, credential reads, or writes", async () => {
  await withFixture(async ({ bytes, candidate, candidatePath, root }) => {
    const before = await snapshot(root);
    const receipt = await preflightElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies(root));
    assert.deepEqual(receipt, {
      schemaVersion: "tibotattle-electron-windows-signing-preflight-v1",
      status: "candidate_validated_signing_pipeline_required",
      scope: "candidate_validation_only_no_signing_or_packaging_performed",
      candidate: {
        buildNumber: BUILD_NUMBER,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceRevision: SOURCE_REVISION,
        target: "win32-x64",
        version: candidate.version,
      },
      signingPipeline: "isolated_signing_pipeline_required",
      azureResourceConfiguration: "not_evaluated",
      host: "windows_x64_node_26_2_0",
      nativeModuleFinalization: "not_performed",
      windowsRuntimeQualification: "required",
    });
    assert.deepEqual(await snapshot(root), before);
  });
});

test("Windows source preflight never claims signing readiness on any observed host", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    for (const host of [{ platform: "darwin" }, { architecture: "arm64" }, { version: "v22.13.0" }]) {
      const receipt = await preflightElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies(root, host));
      assert.equal(receipt.status, "candidate_validated_signing_pipeline_required");
      assert.equal(receipt.signingPipeline, "isolated_signing_pipeline_required");
      assert.equal(receipt.host, "windows_x64_node_26_2_0_required");
    }
  });
});

test("retired signing APIs reject before touching arbitrary argument or dependency objects", async () => {
  const poison = new Proxy({}, { get() { assert.fail("retired signer accessed its arguments"); } });
  await withFixture(async ({ candidatePath, root }) => {
    const before = await snapshot(root);
    for (const operation of [prepareElectronWindowsBuilderHost, invokeElectronWindowsSigning]) {
      for (const options of [undefined, null, 1, poison, {}, { candidateReceiptPath: candidatePath },
        { candidateReceiptPath: "\0", captureEncryptedBuilderDiagnostic: true }]) {
        await assert.rejects(operation(options, poison), { code: RETIRED, message: RETIRED });
      }
    }
    assert.deepEqual(await snapshot(root), before);
  });
});

test("argument parser rejects retired flags before interpreting malformed or conflicting options", () => {
  assert.deepEqual(parseElectronWindowsSigningArguments(["--candidate-receipt", "candidate.json"]), {
    candidateReceiptPath: "candidate.json", prepareBuilderHost: false, sign: false,
  });
  for (const flag of ["--sign", "--prepare-builder-host"]) {
    for (const arguments_ of [[flag], [flag, "--candidate-receipt", "\0"],
      ["--invalid", flag], ["--candidate-receipt", "candidate.json", flag],
      [flag, "--confirm-azure-trusted-signing", "--capture-encrypted-builder-diagnostic",
        "--candidate-receipt", "candidate.json"]]) {
      assert.throws(() => parseElectronWindowsSigningArguments(arguments_), { code: RETIRED });
    }
  }
  for (const arguments_ of [undefined, null, {}, [], ["--candidate-receipt"],
    ["--candidate-receipt", ""], ["--candidate-receipt", "\0"],
    ["--candidate-receipt", "candidate.json", "extra"], ["--unknown"]]) {
    assert.throws(() => parseElectronWindowsSigningArguments(arguments_), {
      code: "ELECTRON_WINDOWS_SIGNING_ARGUMENT_INVALID",
    });
  }
});

test("retired CLI modes load no candidate or builder modules and emit only the fixed refusal", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    const loader = join(root, "guard.mjs");
    const marker = join(root, "unexpected-module-import");
    // Node's real module resolver catches a regression to an eager package or
    // candidate import before CLI parsing, even when its initializer is quiet.
    await writeFile(loader, [
      'import { registerHooks } from "node:module";',
      'import { writeFileSync } from "node:fs";',
      'import { pathToFileURL } from "node:url";',
      `const entry = ${JSON.stringify(SCRIPT)};`,
      `const marker = ${JSON.stringify(marker)};`,
      'registerHooks({ resolve(specifier, context, nextResolve) {',
      '  if (specifier !== entry && specifier !== pathToFileURL(entry).href && !specifier.startsWith("node:")) {',
      '    writeFileSync(marker, "unexpected import"); throw new Error("UNEXPECTED_IMPORT");',
      '  }',
      '  return nextResolve(specifier, context);',
      '} });',
    ].join("\n"));
    const before = await snapshot(root);
    for (const flag of ["--sign", "--prepare-builder-host"]) {
      for (const suffix of [[], ["--candidate-receipt", candidatePath],
        ["--confirm-azure-trusted-signing", "--capture-encrypted-builder-diagnostic", "--malformed"]]) {
        const result = spawnSync(process.execPath, ["--import", loader, SCRIPT, flag, ...suffix], {
          encoding: "utf8", timeout: 15_000,
          env: { ...process.env, AZURE_CONFIG_DIR: join(root, "unavailable"),
            TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: "invalid", CSC_LINK: "must-not-be-used" },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, `${RETIRED}\n`);
      }
    }
    assert.deepEqual(await snapshot(root), before);
  });
});

test("candidate preflight rejects malformed, oversized, or changed contracts without mutation", async () => {
  await withFixture(async ({ candidate, candidatePath, root }) => {
    const invalidCandidates = [null, [], {}, { ...candidate, unexpected: true },
      { ...candidate, sourceRevision: "not-a-revision" }, { ...candidate, buildNumber: "0" },
      { ...candidate, version: "0.0.0" }, { ...candidate, target: "linux-x64" },
      { ...candidate, stagedManifest: "other/package.json" },
      { ...candidate, status: "signed" }];
    const cases = invalidCandidates.map((value) => [JSON.stringify(value), "CANDIDATE_INVALID"]);
    cases.push(["{", "CANDIDATE_INVALID"], ["", "CANDIDATE_UNAVAILABLE"],
      [" ".repeat(128 * 1024 + 1), "CANDIDATE_UNAVAILABLE"]);
    for (const [text, code] of cases) {
      await writeFile(candidatePath, text);
      const before = await snapshot(root);
      await assert.rejects(preflightElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies(root)), {
        code: `ELECTRON_WINDOWS_SIGNING_${code}`,
      });
      assert.deepEqual(await snapshot(root), before);
    }
    for (const path of [undefined, null, "\0", join(root, "outside.json")]) {
      await assert.rejects(preflightElectronWindowsSigning({ candidateReceiptPath: path }, dependencies(root)), {
        code: "ELECTRON_WINDOWS_SIGNING_ARGUMENT_INVALID",
      });
    }
  });
});

test("candidate preflight rejects missing files, linked files, and linked path components", async () => {
  for (const variant of ["missing", "directory", "hardlink", "file-symlink", "parent-symlink", "root-symlink"]) {
    await withFixture(async ({ candidatePath, root }) => {
      let selectedRoot = root;
      let selectedPath = candidatePath;
      if (variant === "missing") await rm(candidatePath);
      if (variant === "directory") { await rm(candidatePath); await mkdir(candidatePath); }
      if (variant === "hardlink") await link(candidatePath, join(root, "linked-receipt.json"));
      if (variant === "file-symlink") {
        const target = join(root, "target.json");
        await rename(candidatePath, target);
        await symlink(target, candidatePath);
      }
      if (variant === "parent-symlink") {
        const parent = dirname(candidatePath);
        const target = join(root, "target-directory");
        await rename(parent, target);
        await symlink(target, parent, "junction");
      }
      if (variant === "root-symlink") {
        selectedRoot = join(root, "root-link");
        await symlink(root, selectedRoot, "junction");
        selectedPath = join(selectedRoot, ".release-build", "electron-production", "win32-x64",
          "production-source-candidate.json");
      }
      const before = await snapshot(root);
      await assert.rejects(preflightElectronWindowsSigning({ candidateReceiptPath: selectedPath }, dependencies(selectedRoot)), {
        code: `ELECTRON_WINDOWS_SIGNING_${["directory", "hardlink"].includes(variant)
          ? "CANDIDATE_UNAVAILABLE" : "CANDIDATE_PATH_INVALID"}`,
      });
      assert.deepEqual(await snapshot(root), before);
    });
  }
});

test("candidate preflight opens nonblocking and rejects a replacement special file before reading", async (t) => {
  await withFixture(async ({ candidatePath, root }) => {
    const before = await snapshot(root);
    let closed = false;
    let opens = 0;
    // Model the descriptor obtained when a regular path is exchanged for a
    // special file after lstat. No FIFO is opened by the test process itself.
    const replacement = {
      stat: async () => ({ isFile: () => false }),
      read: async () => assert.fail("special-file descriptor must never be read"),
      close: async () => { closed = true; },
    };
    const mockedOpen = t.mock.method(fsPromises, "open", async (path, flags) => {
      opens += 1;
      assert.equal(path, candidatePath);
      assert.equal(flags & (constants.O_NONBLOCK ?? 0), constants.O_NONBLOCK ?? 0);
      assert.equal(flags & (constants.O_NOFOLLOW ?? 0), constants.O_NOFOLLOW ?? 0);
      return replacement;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(preflightElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies(root)), {
        code: "ELECTRON_WINDOWS_SIGNING_CANDIDATE_CHANGED",
      });
      assert.equal(opens, 1);
      assert.equal(closed, true);
    } finally {
      mockedOpen.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await snapshot(root), before);
  });
});
