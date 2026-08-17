import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPublicReleaseSourceProvenance,
  PUBLIC_RELEASE_MANIFEST_SCHEMA,
} from "../scripts/public-release-provenance.js";
import {
  parsePrepareWebReleaseArgs,
  prepareWebRelease,
} from "../scripts/prepare-web-release.js";
import {
  deployWebRelease,
  parseDeployWebReleaseArgs,
} from "../scripts/deploy-web-release.js";
import {
  inspectWebReleaseScope,
  isAllowedWebReleasePath,
  verifyWebReleaseReceipt,
  WEB_RELEASE_OUTPUT_DIRECTORY,
  writeWebReleaseReceipt,
} from "../scripts/web-release-lane.js";

function git(root, arguments_) {
  return execFileSync("/usr/bin/git", ["-C", root, ...arguments_], {
    encoding: "utf8",
  }).trim();
}

async function candidateFixture({
  includeUnsupportedChange = false,
  includeUnsupportedPackageChange = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-web-release-lane-"));
  const publicSource = join(root, "apps", "web", "public");
  await mkdir(publicSource, { recursive: true });
  await writeFile(join(root, ".gitignore"), ".release-build/\n");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "web-release-fixture",
    version: "1.0.0",
    scripts: { check: "node --check fixture.js" },
  }, null, 2)}\n`);
  await writeFile(
    join(publicSource, "community.html"),
    '<!doctype html><script type="module" src="./community.js"></script>\n',
  );
  await writeFile(join(publicSource, "community.js"), "export const version = 1;\n");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Web release lane test"]);
  git(root, ["add", ".gitignore", "apps/web/public", "package.json"]);
  git(root, ["commit", "--quiet", "-m", "deployed base"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);

  await writeFile(join(publicSource, "community.js"), "export const version = 2;\n");
  if (includeUnsupportedChange) {
    const clientPath = join(root, "apps", "macos", "Sources");
    await mkdir(clientPath, { recursive: true });
    await writeFile(join(clientPath, "UsageMonitorApp.swift"), "// client change\n");
    git(root, ["add", "apps/macos"]);
  }
  if (includeUnsupportedPackageChange) {
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "web-release-fixture",
      version: "2.0.0",
      scripts: { check: "node --check fixture.js" },
    }, null, 2)}\n`);
    git(root, ["add", "package.json"]);
  }
  git(root, ["add", "apps/web/public/community.js"]);
  git(root, ["commit", "--quiet", "-m", "candidate site change"]);

  return {
    baseCommit,
    output: join(root, WEB_RELEASE_OUTPUT_DIRECTORY),
    publicSource,
    root,
    sourceCommit: git(root, ["rev-parse", "HEAD"]),
  };
}

async function writeBoundManifest({ root, publicSource }) {
  const source = await createPublicReleaseSourceProvenance({
    repositoryRoot: root,
    sourceRoot: publicSource,
    sourceFiles: [
      join(publicSource, "community.html"),
      join(publicSource, "community.js"),
    ],
  });
  const output = join(root, WEB_RELEASE_OUTPUT_DIRECTORY);
  await mkdir(output, { recursive: true });
  const manifestPath = join(output, "release-site-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: PUBLIC_RELEASE_MANIFEST_SCHEMA,
    source,
    files: [],
  }, null, 2)}\n`);
  return manifestPath;
}

test("web-only scope accepts only committed public source and release controls", async (t) => {
  const value = await candidateFixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));

  const scope = inspectWebReleaseScope({
    repositoryRoot: value.root,
    baseCommit: value.baseCommit,
  });
  assert.equal(scope.baseCommit, value.baseCommit);
  assert.equal(scope.sourceCommit, value.sourceCommit);
  assert.deepEqual(scope.changes, [{
    path: "apps/web/public/community.js",
    status: "M",
  }]);
  assert.match(scope.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(isAllowedWebReleasePath("apps/web/public/community.js"), true);
  assert.equal(isAllowedWebReleasePath("apps/macos/Sources/UsageMonitorApp.swift"), false);
});

test("web-only scope rejects a client change even when a public site change is present", async (t) => {
  const value = await candidateFixture({ includeUnsupportedChange: true });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed an unsupported path: apps\/macos\/Sources\/UsageMonitorApp\.swift/u,
  );
});

test("web-only scope rejects a package version change", async (t) => {
  const value = await candidateFixture({ includeUnsupportedPackageChange: true });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed unsupported package metadata/u,
  );
});

test("web-only preparation records the committed source SHA in its receipt and catches changed output", async (t) => {
  const value = await candidateFixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const buildCalls = [];
  const result = await prepareWebRelease({
    repositoryRoot: value.root,
    baseCommit: value.baseCommit,
    rawBuildArgs: {
      output: value.output,
      replace: true,
      source: value.publicSource,
    },
    build: async (arguments_) => {
      buildCalls.push(arguments_);
      const manifestPath = await writeBoundManifest({
        root: value.root,
        publicSource: value.publicSource,
      });
      return { fileCount: 1, output: value.output, manifestPath };
    },
  });

  assert.equal(buildCalls.length, 1);
  assert.equal(Object.hasOwn(buildCalls[0], "sourceCommit"), false);
  assert.equal(result.scope.sourceCommit, value.sourceCommit);
  assert.equal(result.receipt.receipt.sourceCommit, value.sourceCommit);
  assert.equal(result.receipt.path, join(
    value.root,
    ".release-build",
    "web-release-receipt.json",
  ));
  const verification = await verifyWebReleaseReceipt({
    repositoryRoot: value.root,
    receiptPath: result.receipt.path,
  });
  assert.equal(verification.scope.sourceCommit, value.sourceCommit);

  const manifestPath = join(value.output, "release-site-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.source.repositoryCommit = "d".repeat(40);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    verifyWebReleaseReceipt({
      repositoryRoot: value.root,
      receiptPath: result.receipt.path,
    }),
    /not bound to the selected public source closure/u,
  );
});

test("web-only prepare parsing reserves source selection for the guarded command", () => {
  assert.deepEqual(
    parsePrepareWebReleaseArgs([
      "--base",
      "abc123",
      "--replace-receipt",
      "--",
      "--output",
      "/tmp/release-site",
      "--replace",
    ]),
    {
      baseCommit: "abc123",
      build: ["--output", "/tmp/release-site", "--replace"],
      receipt: null,
      replaceReceipt: true,
    },
  );
  assert.throws(
    () => parsePrepareWebReleaseArgs([
      "--base",
      "abc123",
      "--",
      "--source",
      "/tmp/other-site",
    ]),
    /selects the checked-out public source/u,
  );
});

test("web-only deployment delegates the receipt-pinned SHA to the production guard", async () => {
  const repositoryRoot = "/tmp/web-release-candidate";
  const sourceCommit = "a".repeat(40);
  const receiptPath = "/tmp/web-release-candidate/.release-build/web-release-receipt.json";
  const calls = [];
  const result = await deployWebRelease({
    repositoryRoot,
    receiptPath,
    confirmation: "DEPLOY_PRODUCTION",
    verifyReceipt: async (value) => {
      assert.deepEqual(value, { repositoryRoot, receiptPath });
      return {
        receipt: { sourceCommit },
        scope: { sourceCommit },
      };
    },
    runProduction: async (value) => {
      calls.push(value);
      return { ok: true, code: "PRODUCTION_DEPLOYED" };
    },
  });

  assert.equal(result.sourceCommit, sourceCommit);
  assert.deepEqual(calls, [{
    confirmation: "DEPLOY_PRODUCTION",
    confirmedMigrations: null,
    expectedSourceCommit: sourceCommit,
    workerDirectory: "/tmp/web-release-candidate/apps/worker",
    wrangler: "/tmp/web-release-candidate/apps/worker/node_modules/.bin/wrangler",
  }]);
  assert.deepEqual(
    parseDeployWebReleaseArgs([
      "--receipt",
      receiptPath,
      "--confirm",
      "DEPLOY_PRODUCTION",
    ]),
    {
      confirmation: "DEPLOY_PRODUCTION",
      confirmedMigrations: null,
      receiptPath,
    },
  );
  assert.throws(
    () => parseDeployWebReleaseArgs(["--receipt", receiptPath]),
    /receipt and explicit confirmation/u,
  );
});

test("web-only preparation refuses a receipt path redirected through a symlink", async (t) => {
  const value = await candidateFixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const scope = inspectWebReleaseScope({
    repositoryRoot: value.root,
    baseCommit: value.baseCommit,
  });
  await writeBoundManifest({ root: value.root, publicSource: value.publicSource });
  const receiptPath = join(value.root, ".release-build", "web-release-receipt.json");
  const redirectedPath = join(value.root, "redirected-receipt.json");
  await writeFile(redirectedPath, "do not replace\n");
  await symlink(redirectedPath, receiptPath);

  await assert.rejects(
    writeWebReleaseReceipt({
      repositoryRoot: value.root,
      scope,
      receiptPath,
      replace: true,
    }),
    /receipt path is not a safe regular file/u,
  );
  assert.equal(await readFile(redirectedPath, "utf8"), "do not replace\n");
});
