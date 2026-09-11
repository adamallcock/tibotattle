import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LOCAL_REVIEW_IDENTITY_CORE_RUNTIME_FILES,
  LOCAL_REVIEW_WORKSPACE_RUNTIME_FILES,
  assertLocalReviewIdentityCoreRuntimeInventory,
  assertLocalReviewWorkspaceRuntimeInventory,
  calculateLocalReviewSourceInputDigest,
  captureLocalReviewIdentityCoreRuntime,
  captureLocalReviewWorkspaceRuntime,
  collectStaticGraph,
  isForbiddenLocalReviewSource,
  localReviewArtifactPackageMetadata,
  stageLocalReviewIdentityCoreRuntime,
  stageLocalReviewWorkspaceRuntime,
} from "../scripts/build-local-review-artifact.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("local-review source policy excludes the provider-owned Codex app server", async () => {
  assert.equal(
    isForbiddenLocalReviewSource("src/providers/codex/app-server.js"),
    true,
  );
  assert.equal(
    isForbiddenLocalReviewSource("src/providers/codex/app-server/protocol.js"),
    true,
  );
  assert.equal(
    isForbiddenLocalReviewSource("src/providers/codex/app-server.mjs"),
    true,
  );
  assert.equal(
    isForbiddenLocalReviewSource("src/providers/codex/app-server.ts"),
    true,
  );
  assert.equal(
    isForbiddenLocalReviewSource("src/providers/codex/account.js"),
    false,
  );

  const facade = fileURLToPath(
    new URL("../src/providers/codex/account.js", import.meta.url),
  );
  await assert.rejects(
    collectStaticGraph(facade),
    /Forbidden local-review source module is reachable: src\/providers\/codex\/app-server\.js/u,
  );
});

test("local-review graph follows trailing-comma import.meta URL artifacts", async () => {
  const fixtureParent = join(REPOSITORY_ROOT, ".release-build");
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, "static-graph-fixture-"));
  try {
    const entrypoint = join(root, "entry.js");
    const artifact = join(root, "artifact.json");
    await Promise.all([
      writeFile(
        entrypoint,
        "export const artifact = new URL('./artifact.json', import.meta.url,);\n",
      ),
      writeFile(artifact, "{}\n"),
    ]);

    const graph = await collectStaticGraph(entrypoint, {
      expectedExternalSpecifiers: [],
    });
    assert.deepEqual(graph.files, [artifact, entrypoint].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-review graph fails closed on non-literal dynamic imports", async () => {
  const fixtureParent = join(REPOSITORY_ROOT, ".release-build");
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, "dynamic-graph-fixture-"));
  try {
    const entrypoint = join(root, "entry.js");
    await writeFile(
      entrypoint,
      "const name = 'dependency.js';\nexport default import('./' + name);\n",
    );
    await assert.rejects(
      collectStaticGraph(entrypoint, {
        expectedExternalSpecifiers: [],
      }),
      /Non-literal dynamic import is forbidden/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-review graph closes over every live compatibility input", async () => {
  const graph = await collectStaticGraph(
    join(REPOSITORY_ROOT, "local-review", "cli.js"),
  );
  const sourceFiles = graph.files.map(
    (path) => relative(REPOSITORY_ROOT, path),
  );
  assert.equal(
    sourceFiles.includes("src/platform/participant-identity.js"),
    true,
  );
  for (const ownedFile of [
    "src/application/local-export-set-verification.js",
    "src/export/compression.js",
    "src/export/set-schema.js",
    "src/export/set-verification.js",
    "src/platform/export-set-verification-storage.js",
  ]) {
    assert.equal(sourceFiles.includes(ownedFile), true, ownedFile);
  }
  const relevant = graph.files
    .map((path) => relative(REPOSITORY_ROOT, path))
    .filter((path) =>
      /^(?:contracts\/telemetry-v0\.1|generated\/telemetry-v0\.1|package\.json|schemas\/telemetry-v0\.1)/u
        .test(path));

  assert.deepEqual(relevant, [
    "contracts/telemetry-v0.1/consent-status.json",
    "contracts/telemetry-v0.1/contract-status.json",
    "generated/telemetry-v0.1-compatibility.json",
    "generated/telemetry-v0.1-field-dictionary.json",
    "package.json",
    "schemas/telemetry-v0.1/activity-marker.schema.json",
    "schemas/telemetry-v0.1/bundle.schema.json",
    "schemas/telemetry-v0.1/compatibility.schema.json",
    "schemas/telemetry-v0.1/privacy-receipt.schema.json",
    "schemas/telemetry-v0.1/quota-snapshot.schema.json",
    "schemas/telemetry-v0.1/usage-event.schema.json",
  ]);
  // The closure grew by two workspace packages when the collector projection
  // and the replay-safe cache stopped reaching into src/export/registries.js
  // and started entering the export owner through its reviewed facade, as
  // `source_owner_public_api` requires. Importing a facade pulls that facade's
  // whole graph, not the single module that was wanted, so quota-analysis and
  // telemetry-contract came with it. Both are pure computation packages, and
  // the property this artifact actually exists to guarantee - that nothing in
  // it can reach the network - is enforced separately and unconditionally by
  // the FORBIDDEN_BUILTINS check in scripts/build-local-review-artifact.js.
  // This list stays exact so any further growth still has to be argued for.
  assert.deepEqual(graph.external, [
    "@app-usagemonitor/identity-core",
    "@app-usagemonitor/quota-analysis",
    "@app-usagemonitor/telemetry-contract",
    "@github/keytar",
    "ajv",
  ]);
  assert.equal(
    graph.files.some((path) => path.includes("/node_modules/runcost/")),
    false,
  );
});

test("local-review identity-core capture binds exact staged bytes, inventory, and source digest", async () => {
  const fixtureParent = join(REPOSITORY_ROOT, ".release-build");
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, "identity-core-capture-"));
  const packageRoot = join(root, "identity-core");
  const sourceRoot = join(REPOSITORY_ROOT, "packages", "identity-core");
  try {
    for (const relativeFile of LOCAL_REVIEW_IDENTITY_CORE_RUNTIME_FILES) {
      const destination = join(packageRoot, ...relativeFile.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(sourceRoot, ...relativeFile.split("/")), destination);
    }
    const capture = await captureLocalReviewIdentityCoreRuntime({
      packageRoot,
      resolvePackageEntrypoint: () => join(packageRoot, "index.js"),
    });
    assert.equal(Object.isFrozen(capture), true);
    assert.equal(Object.isFrozen(capture.files), true);
    assert.deepEqual(
      capture.files.map(({ relativeFile }) => relativeFile),
      LOCAL_REVIEW_IDENTITY_CORE_RUNTIME_FILES,
    );
    const digestOptions = {
      graph: { files: [] },
      identityCoreRuntime: capture,
      readSource: async (path) => {
        assert.equal(
          path.startsWith(packageRoot),
          false,
          "the source digest must not reread captured package files",
        );
        return readFile(path);
      },
    };
    const capturedDigest = await calculateLocalReviewSourceInputDigest(
      digestOptions,
    );
    await writeFile(
      join(packageRoot, "src", "pseudonym.js"),
      "// physically mutated after capture\n",
    );
    assert.equal(
      await calculateLocalReviewSourceInputDigest(digestOptions),
      capturedDigest,
    );

    const stagedRoot = join(root, "staged");
    const stagedRows = await stageLocalReviewIdentityCoreRuntime(
      stagedRoot,
      capture,
    );
    assert.equal(stagedRows.length, 3);
    assert.equal(
      assertLocalReviewIdentityCoreRuntimeInventory(stagedRows, capture),
      true,
    );
    for (const file of capture.files) {
      const stagedBytes = await readFile(join(
        stagedRoot,
        "node_modules",
        ...capture.name.split("/"),
        ...file.relativeFile.split("/"),
      ));
      assert.equal(stagedBytes.toString("utf8"), file.sourceText);
      assert.equal(
        createHash("sha256").update(stagedBytes).digest("hex"),
        file.sha256,
      );
    }
    const corruptedRows = stagedRows.map((row, index) => index === 0
      ? { ...row, sha256: "0".repeat(64) }
      : row);
    assert.throws(
      () => assertLocalReviewIdentityCoreRuntimeInventory(
        corruptedRows,
        capture,
      ),
      /did not retain captured bytes/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-review identity-core capture rejects resolver mismatch and unsafe runtime files", async () => {
  const fixtureParent = join(REPOSITORY_ROOT, ".release-build");
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, "identity-core-guards-"));
  const sourceRoot = join(REPOSITORY_ROOT, "packages", "identity-core");
  const makeFixture = async (name) => {
    const packageRoot = join(root, name, "identity-core");
    for (const relativeFile of LOCAL_REVIEW_IDENTITY_CORE_RUNTIME_FILES) {
      const destination = join(packageRoot, ...relativeFile.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(sourceRoot, ...relativeFile.split("/")), destination);
    }
    return packageRoot;
  };
  try {
    const mismatchRoot = await makeFixture("mismatch");
    const mismatchEntrypoint = join(mismatchRoot, "other.js");
    await writeFile(mismatchEntrypoint, "export {};\n");
    await assert.rejects(
      captureLocalReviewIdentityCoreRuntime({
        packageRoot: mismatchRoot,
        resolvePackageEntrypoint: () => mismatchEntrypoint,
      }),
      /identity-core dependency resolved unexpectedly/u,
    );

    const missingRoot = await makeFixture("missing");
    await rm(join(missingRoot, "src", "pseudonym.js"));
    await assert.rejects(
      captureLocalReviewIdentityCoreRuntime({
        packageRoot: missingRoot,
        resolvePackageEntrypoint: () => join(missingRoot, "index.js"),
      }),
      /runtime source is not a stable regular UTF-8 file: src\/pseudonym\.js/u,
    );

    const symlinkRoot = await makeFixture("symlink");
    const symlinkPath = join(symlinkRoot, "src", "pseudonym.js");
    const target = join(root, "outside.js");
    await writeFile(target, "export {};\n");
    await rm(symlinkPath);
    await symlink(target, symlinkPath);
    await assert.rejects(
      captureLocalReviewIdentityCoreRuntime({
        packageRoot: symlinkRoot,
        resolvePackageEntrypoint: () => join(symlinkRoot, "index.js"),
      }),
      /runtime source is not a stable regular UTF-8 file: src\/pseudonym\.js/u,
    );

    const hardLinkedRoot = await makeFixture("hard-linked");
    await link(
      join(hardLinkedRoot, "src", "pseudonym.js"),
      join(root, "hard-link.js"),
    );
    await assert.rejects(
      captureLocalReviewIdentityCoreRuntime({
        packageRoot: hardLinkedRoot,
        resolvePackageEntrypoint: () => join(hardLinkedRoot, "index.js"),
      }),
      /runtime source is not a stable regular UTF-8 file: src\/pseudonym\.js/u,
    );

    const invalidUtf8Root = await makeFixture("invalid-utf8");
    await writeFile(
      join(invalidUtf8Root, "src", "pseudonym.js"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );
    await assert.rejects(
      captureLocalReviewIdentityCoreRuntime({
        packageRoot: invalidUtf8Root,
        resolvePackageEntrypoint: () => join(invalidUtf8Root, "index.js"),
      }),
      /runtime source is not a stable regular UTF-8 file: src\/pseudonym\.js/u,
    );

    const swapToSymlinkRoot = await makeFixture("swap-to-symlink");
    const swapToSymlinkPath = join(
      swapToSymlinkRoot,
      "src",
      "pseudonym.js",
    );
    const symlinkReplacement = join(root, "swap-symlink-replacement.js");
    await writeFile(symlinkReplacement, "export const swapped = true;\n");
    let symlinkFailpointCalls = 0;
    await assert.rejects(
      captureLocalReviewIdentityCoreRuntime({
        packageRoot: swapToSymlinkRoot,
        resolvePackageEntrypoint: () => join(
          swapToSymlinkRoot,
          "index.js",
        ),
        async postOpenPreReadFailpoint() {
          assert.equal(arguments.length, 0);
          symlinkFailpointCalls += 1;
          if (symlinkFailpointCalls !== 3) return;
          await rename(
            swapToSymlinkPath,
            join(root, "displaced-before-symlink.js"),
          );
          await symlink(symlinkReplacement, swapToSymlinkPath);
        },
      }),
      /runtime source is not a stable regular UTF-8 file: src\/pseudonym\.js/u,
    );
    assert.equal(symlinkFailpointCalls, 3);

    const swapToFileRoot = await makeFixture("swap-to-file");
    const swapToFilePath = join(swapToFileRoot, "src", "pseudonym.js");
    const fileReplacement = join(root, "swap-file-replacement.js");
    await writeFile(fileReplacement, "export const replaced = true;\n");
    let fileFailpointCalls = 0;
    await assert.rejects(
      captureLocalReviewIdentityCoreRuntime({
        packageRoot: swapToFileRoot,
        resolvePackageEntrypoint: () => join(swapToFileRoot, "index.js"),
        async postOpenPreReadFailpoint() {
          assert.equal(arguments.length, 0);
          fileFailpointCalls += 1;
          if (fileFailpointCalls !== 3) return;
          await rename(
            swapToFilePath,
            join(root, "displaced-before-file.js"),
          );
          await copyFile(fileReplacement, swapToFilePath);
        },
      }),
      /runtime source is not a stable regular UTF-8 file: src\/pseudonym\.js/u,
    );
    assert.equal(fileFailpointCalls, 3);

    const growAfterOpenRoot = await makeFixture("grow-after-open");
    const growAfterOpenPath = join(
      growAfterOpenRoot,
      "src",
      "pseudonym.js",
    );
    let growFailpointCalls = 0;
    await assert.rejects(
      captureLocalReviewIdentityCoreRuntime({
        packageRoot: growAfterOpenRoot,
        resolvePackageEntrypoint: () => join(growAfterOpenRoot, "index.js"),
        async postOpenPreReadFailpoint() {
          assert.equal(arguments.length, 0);
          growFailpointCalls += 1;
          if (growFailpointCalls === 3) {
            await appendFile(growAfterOpenPath, "// concurrent growth\n");
          }
        },
      }),
      /runtime source is not a stable regular UTF-8 file: src\/pseudonym\.js/u,
    );
    assert.equal(growFailpointCalls, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-review stages every admitted workspace package for isolated runtime imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-review-workspace-runtime-"));
  try {
    const graph = await collectStaticGraph(join(REPOSITORY_ROOT, "local-review", "cli.js"));
    const names = graph.external.filter((name) => name.startsWith("@app-usagemonitor/"));
    assert.deepEqual(names, Object.keys(LOCAL_REVIEW_WORKSPACE_RUNTIME_FILES));
    const captures = [];
    for (const name of names) {
      const capture = await captureLocalReviewWorkspaceRuntime({ name });
      captures.push(capture);
      const rows = await stageLocalReviewWorkspaceRuntime(root, capture);
      assert.deepEqual(capture.files.map(({ relativeFile }) => relativeFile),
        LOCAL_REVIEW_WORKSPACE_RUNTIME_FILES[name]);
      assert.equal(assertLocalReviewWorkspaceRuntimeInventory(rows, capture), true);
      assert.throws(() => assertLocalReviewWorkspaceRuntimeInventory(rows.slice(1), capture),
        /inventory is incomplete/u);
      assert.throws(() => assertLocalReviewWorkspaceRuntimeInventory(
        rows.map((row, index) => index === 0 ? { ...row, sha256: "0".repeat(64) } : row), capture),
      /did not retain captured bytes/u);
      await assert.rejects(stageLocalReviewWorkspaceRuntime(root, capture), { code: "EEXIST" });
      for (const file of capture.files) {
        assert.equal(await readFile(join(root, "node_modules", name, file.relativeFile), "utf8"),
          file.sourceText);
      }
    }
    // This cwd is outside the checkout: omitted dependencies cannot silently
    // resolve through the repository's node_modules in a source-only test.
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { deriveExportPseudonym } from "@app-usagemonitor/identity-core";
      import { isValidQuotaWindowDuration } from "@app-usagemonitor/quota-analysis";
      import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";
      if (typeof deriveExportPseudonym !== "function"
          || !isValidQuotaWindowDuration(300)
          || !Array.isArray(TELEMETRY_PLAN_TYPES)) throw new Error("runtime closure incomplete");
      process.stdout.write("runtime closure complete");
    `], { cwd: root, env: {}, encoding: "utf8" });
    assert.equal(output, "runtime closure complete");
    const digestOptions = {
      graph: { files: [] },
      identityCoreRuntime: captures[0],
      workspaceRuntimes: captures.slice(1),
    };
    const completeDigest = await calculateLocalReviewSourceInputDigest(digestOptions);
    assert.notEqual(completeDigest, await calculateLocalReviewSourceInputDigest({
      ...digestOptions, workspaceRuntimes: [],
    }));
    await assert.rejects(calculateLocalReviewSourceInputDigest({
      ...digestOptions, workspaceRuntimes: [captures[0]],
    }), /duplicate workspace packages/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-review workspace captures bind provenance to the bytes staged after source mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-review-workspace-capture-"));
  try {
    const identityCoreRuntime = await captureLocalReviewIdentityCoreRuntime();
    for (const name of ["@app-usagemonitor/quota-analysis", "@app-usagemonitor/telemetry-contract"]) {
      const packageDirectory = name.split("/")[1];
      const packageRoot = join(root, packageDirectory);
      for (const relativeFile of LOCAL_REVIEW_WORKSPACE_RUNTIME_FILES[name]) {
        const destination = join(packageRoot, relativeFile);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(join(REPOSITORY_ROOT, "packages", packageDirectory, relativeFile), destination);
      }
      const captureOptions = {
        name, packageRoot, resolvePackageEntrypoint: () => join(packageRoot, "index.js"),
      };
      const capture = await captureLocalReviewWorkspaceRuntime(captureOptions);
      const digestOptions = {
        graph: { files: [] }, identityCoreRuntime, workspaceRuntimes: [capture],
        readSource: async (path) => {
          assert.equal(path.startsWith(packageRoot), false);
          return readFile(path);
        },
      };
      const before = await calculateLocalReviewSourceInputDigest(digestOptions);
      await appendFile(join(packageRoot, "index.js"), "// changed after capture\n");
      assert.equal(await calculateLocalReviewSourceInputDigest(digestOptions), before);
      const fresh = await captureLocalReviewWorkspaceRuntime(captureOptions);
      assert.notEqual(await calculateLocalReviewSourceInputDigest({
        ...digestOptions, workspaceRuntimes: [fresh],
      }), before);
      const staged = join(root, `staged-${packageDirectory}`);
      await stageLocalReviewWorkspaceRuntime(staged, capture);
      assert.equal(await readFile(join(staged, "node_modules", name, "index.js"), "utf8"),
        capture.files[0].sourceText);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-review workspace capture rejects unknown identities and dependency-closure growth", async () => {
  await assert.rejects(captureLocalReviewWorkspaceRuntime({ name: "@unreviewed/package" }),
    /capture options are invalid/u);
  const root = await mkdtemp(join(tmpdir(), "local-review-workspace-guards-"));
  const name = "@app-usagemonitor/telemetry-contract";
  const packageRoot = join(root, "telemetry-contract");
  const options = { name, packageRoot, resolvePackageEntrypoint: () => join(packageRoot, "index.js") };
  try {
    for (const relativeFile of LOCAL_REVIEW_WORKSPACE_RUNTIME_FILES[name]) {
      const destination = join(packageRoot, relativeFile);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(REPOSITORY_ROOT, "packages", "telemetry-contract", relativeFile), destination);
    }
    const entry = join(packageRoot, "index.js");
    const original = await readFile(entry, "utf8");
    for (const dependency of [
      'import "node:https";\n',
      'import "./unstaged.js";\n',
      'import "@unreviewed/package";\n',
      'const specifier = "./src/constants.js"; import(specifier);\n',
    ]) {
      await writeFile(entry, `${original}\n${dependency}`);
      await assert.rejects(captureLocalReviewWorkspaceRuntime(options),
        /runtime closure contains an unreviewed dependency/u);
    }
    await writeFile(entry, original);
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const changed of [
      { ...manifest, version: "0.0.0" },
      { ...manifest, name: "@unreviewed/package" },
      { ...manifest, type: "commonjs" },
      { ...manifest, dependencies: { "unreviewed": "1.0.0" } },
    ]) {
      await writeFile(manifestPath, JSON.stringify(changed));
      await assert.rejects(captureLocalReviewWorkspaceRuntime(options), /Pinned package mismatch/u);
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    await rm(join(packageRoot, "src/constants.js"));
    await assert.rejects(captureLocalReviewWorkspaceRuntime(options),
      /runtime source is not a stable regular UTF-8 file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-review artifact package identity is derived from reviewed root metadata", () => {
  const packageMetadata = localReviewArtifactPackageMetadata({
    name: "app-usagemonitor",
    version: "1.2.3-beta.4",
    private: true,
    type: "module",
  });
  assert.deepEqual(packageMetadata, {
    name: "app-usagemonitor",
    version: "1.2.3-beta.4",
    private: true,
    type: "module",
    artifact: {
      name: "usage-monitor-local-review",
      version: "0.1.0-alpha.1",
      localOnly: true,
    },
  });
  assert.equal(Object.isFrozen(packageMetadata), true);
  assert.equal(Object.isFrozen(packageMetadata.artifact), true);

  for (const invalid of [
    null,
    [],
    {},
    {
      name: "../private",
      version: "1.2.3",
      private: true,
      type: "module",
    },
    {
      name: "app-usagemonitor",
      version: "latest",
      private: true,
      type: "module",
    },
    {
      name: "app-usagemonitor",
      version: "1.2.3",
      private: false,
      type: "module",
    },
    {
      name: "app-usagemonitor",
      version: "1.2.3",
      private: true,
      type: "commonjs",
    },
  ]) {
    assert.throws(
      () => localReviewArtifactPackageMetadata(invalid),
      { code: "LOCAL_REVIEW_BUILD_FAILED" },
    );
  }
});
