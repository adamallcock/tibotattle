import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  assertI18nCatalogScope,
  assertModelCatalogScope,
  isAllowedWebReleasePath,
  verifyWebReleaseI18nProof,
  verifyWebReleaseModelCatalogProof,
  verifyWebReleaseReceipt,
  I18N_BROWSER_MIRROR_PATH,
  I18N_CANONICAL_PATH,
  MODEL_CATALOG_BROWSER_MIRROR_PATH,
  MODEL_CATALOG_CANONICAL_PATH,
  TELEMETRY_SHARED_MIRROR_PATH,
  WEB_RELEASE_OUTPUT_DIRECTORY,
  writeWebReleaseReceipt,
} from "../scripts/web-release-lane.js";
import { buildI18nBrowserMirror } from "../scripts/generate-i18n-browser-mirror.js";
import {
  buildPublicModelCatalogMirror,
  buildTelemetryBrowserMirror,
} from "../scripts/generate-telemetry-browser-mirror.js";

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
  assert.equal(isAllowedWebReleasePath("apps/web/public/community-refresh.js"), true);
  assert.equal(isAllowedWebReleasePath("apps/web/test/community-refresh.test.mjs"), true);
  assert.equal(isAllowedWebReleasePath("apps/web/test/public-allowance-views.test.mjs"), true);
  assert.equal(isAllowedWebReleasePath("apps/web/public/unreviewed.js"), false);
  assert.equal(isAllowedWebReleasePath("scripts/preview-public-release-site.js"), true);
  assert.equal(
    isAllowedWebReleasePath("docs/runbooks/2026-08-17-public-site-local-preview.md"),
    true,
  );
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
  const baseCommit = "b".repeat(40);
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
        scope: { sourceCommit, baseCommit },
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
    expectedPreviousSourceCommit: baseCommit,
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


test("web-only catalogue admission permits copy only and refuses runtime changes", () => {
  const before = 'export const CATALOG = Object.freeze({\n  "old.key": "old",\n});\nexport const runtime = 1;';
  const edited = before.replace('  "old.key"', '  "site.hero.title": "Know your usage",\n  "electron.site.download.linux": "Download Linux",\n  "old.key"');
  const check = after => assertI18nCatalogScope({ repositoryRoot: "/fixture", baseCommit: "before", sourceCommit: "after",
    git: (_root, args) => args[1].startsWith("before:") ? before : after });
  assert.doesNotThrow(() => check(edited));
  assert.doesNotThrow(() => check(edited.replace('"old"', '"changed"')));
  assert.throws(() => check(edited.replace('runtime = 1', 'runtime = 2')), /changed i18n runtime code/u);
  assert.throws(() => check(edited.replace('"Download Linux"', 'runCode()')), /changed i18n runtime code/u);
  assert.throws(() => check(`${edited}\nexport function weakenedValidator() {}`), /changed i18n runtime code/u);
  for (const path of ['scripts/lib/electron-public-site.mjs', 'test/electron-public-site.test.js',
    I18N_CANONICAL_PATH, I18N_BROWSER_MIRROR_PATH]) assert.equal(isAllowedWebReleasePath(path), true);
  for (const path of ['packages/i18n/other.js', 'packages/i18n/index.d.ts', 'packages/i18n/package.json',
    'packages/i18n/AGENTS.md', 'packages/accounting/index.js', 'packages/quota-analysis/index.js',
    'apps/worker/src/index.ts', 'config/electron-production-distribution.cjs']) assert.equal(isAllowedWebReleasePath(path), false);
});

test("web-only release receipt refuses an explicitly local Electron preview", async (t) => {
  const value = await candidateFixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(prepareWebRelease({
    repositoryRoot: value.root, baseCommit: value.baseCommit,
    rawBuildArgs: { output: value.output, replace: true, source: value.publicSource },
    build: async () => {
      const manifestPath = await writeBoundManifest(value);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.electronRelease = { publishedInstallersVerified: false };
      await writeFile(manifestPath, JSON.stringify(manifest));
      return { fileCount: 1, output: value.output, manifestPath };
    },
  }), /not bound/u);
});


test("web-only release admits exact public evidence controls, never general config or product runtime", () => {
  for (const path of ['config/release-evidence.js', 'schemas/release-evidence-v1/manifest.schema.json',
    'scripts/release-evidence-descriptor.js', 'scripts/release-evidence-policy.js',
    'scripts/release-evidence-output.js', 'test/release-evidence.test.js']) assert.equal(isAllowedWebReleasePath(path), true);
  for (const path of ['config/deployment-endpoints.js', 'config/release-manifest.js',
    'apps/worker/src/index.ts', 'apps/worker/wrangler.jsonc', 'apps/electron/main.js',
    'schemas/unrelated.json']) assert.equal(isAllowedWebReleasePath(path), false);
});


const CATALOG_MARKERS = ["EN_US_CATALOG", "ZH_HANS_CATALOG", "ES_CATALOG"];
const FIXTURE_KEY = "site.releaseLaneFixture";
const FIXTURE_COPY = ["Fixture copy", "Fixture copy zh", "Fixture copy es"];

/**
 * Insert one literal catalogue entry into the locale catalogs of the real
 * canonical source. A `null` value deliberately skips that locale so a test can
 * prove an incomplete locale is refused.
 */
function withCatalogKey(source, key, values) {
  let result = source;
  for (const [index, marker] of CATALOG_MARKERS.entries()) {
    if (values[index] === null) continue;
    const start = result.indexOf(`export const ${marker} = Object.freeze({\n`);
    assert.notEqual(start, -1, `${marker} is present in the canonical source`);
    const end = result.indexOf("\n});\n", start);
    assert.notEqual(end, -1, `${marker} is closed in the canonical source`);
    result = `${result.slice(0, end)}\n  "${key}": "${values[index]}",${result.slice(end)}`;
  }
  return result;
}

const addFixtureCopy = (values = FIXTURE_COPY) =>
  (source) => withCatalogKey(source, FIXTURE_KEY, values);

/**
 * A candidate carrying the real canonical catalogue and its real generated
 * mirror, so the lane's proof runs against reviewed code rather than a
 * simplified stand-in.
 */
async function i18nCandidateFixture({
  canonicalEdit = null,
  mirrorEdit = null,
  regenerateMirror = true,
  renameMirrorTo = null,
} = {}) {
  const baseCanonical = await readFile(
    fileURLToPath(new URL("../packages/i18n/index.js", import.meta.url)),
    "utf8",
  );
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-web-release-i18n-lane-"));
  const publicSource = join(root, "apps", "web", "public");
  const canonicalPath = join(root, I18N_CANONICAL_PATH);
  const mirrorPath = join(root, I18N_BROWSER_MIRROR_PATH);
  await mkdir(publicSource, { recursive: true });
  await mkdir(dirname(canonicalPath), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".release-build/\n");
  await writeFile(
    join(publicSource, "community.html"),
    '<!doctype html><script type="module" src="./community.js"></script>\n',
  );
  await writeFile(join(publicSource, "community.js"), "export const version = 1;\n");
  await writeFile(canonicalPath, baseCanonical);
  const baseMirror = await buildI18nBrowserMirror({ sourceFile: canonicalPath });
  await writeFile(mirrorPath, baseMirror);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Web release lane test"]);
  git(root, ["add", ".gitignore", "apps/web/public", "packages"]);
  git(root, ["commit", "--quiet", "-m", "deployed base"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);

  await writeFile(canonicalPath, canonicalEdit ? canonicalEdit(baseCanonical) : baseCanonical);
  let candidateMirror = regenerateMirror
    ? await buildI18nBrowserMirror({ sourceFile: canonicalPath })
    : baseMirror;
  if (mirrorEdit) candidateMirror = mirrorEdit(candidateMirror);
  await writeFile(mirrorPath, candidateMirror);
  if (renameMirrorTo) git(root, ["mv", I18N_BROWSER_MIRROR_PATH, renameMirrorTo]);
  git(root, ["add", "--all", "packages", "apps/web/public"]);
  git(root, ["commit", "--quiet", "-m", "candidate copy change"]);

  return {
    baseCommit,
    output: join(root, WEB_RELEASE_OUTPUT_DIRECTORY),
    publicSource,
    root,
    sourceCommit: git(root, ["rev-parse", "HEAD"]),
  };
}

test("web-only release admits a canonical copy change with its regenerated mirror", async (t) => {
  const value = await i18nCandidateFixture({ canonicalEdit: addFixtureCopy() });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  const scope = inspectWebReleaseScope({
    repositoryRoot: value.root,
    baseCommit: value.baseCommit,
  });
  assert.deepEqual(
    scope.changes.map((change) => change.path),
    [I18N_BROWSER_MIRROR_PATH, I18N_CANONICAL_PATH],
  );
  const proof = await verifyWebReleaseI18nProof({
    repositoryRoot: value.root,
    scope,
  });
  assert.deepEqual(proof.locales, ["en-US", "zh-Hans", "es"]);
  assert.equal(proof.keyCount > 0, true);
  assert.match(proof.canonicalSha256, /^[a-f0-9]{64}$/u);
  assert.match(proof.mirrorSha256, /^[a-f0-9]{64}$/u);
});

test("web-only release refuses a canonical copy change without its regenerated mirror", async (t) => {
  const value = await i18nCandidateFixture({
    canonicalEdit: addFixtureCopy(),
    regenerateMirror: false,
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed packages\/i18n\/index\.js without its regenerated apps\/web\/public\/i18n\.generated\.js/u,
  );
});

test("web-only release refuses a hand-edited mirror with no canonical change", async (t) => {
  const value = await i18nCandidateFixture({
    mirrorEdit: (mirror) => mirror.replace('"app.name": "TiboTattle"', '"app.name": "Hand edit"'),
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed apps\/web\/public\/i18n\.generated\.js without a matching packages\/i18n\/index\.js change/u,
  );
});

test("web-only release refuses a mirror renamed away from the public site", async (t) => {
  const value = await i18nCandidateFixture({ renameMirrorTo: "apps/web/public/ui-format.js" });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed apps\/web\/public\/i18n\.generated\.js without a matching packages\/i18n\/index\.js change/u,
  );
});

test("web-only release refuses a mirror that was not regenerated from its canonical source", async (t) => {
  const value = await i18nCandidateFixture({
    canonicalEdit: addFixtureCopy(),
    mirrorEdit: (mirror) => mirror.replace(
      `  "${FIXTURE_KEY}": "${FIXTURE_COPY[0]}",`,
      `  "${FIXTURE_KEY}": "Hand edited copy",`,
    ),
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  const scope = inspectWebReleaseScope({
    repositoryRoot: value.root,
    baseCommit: value.baseCommit,
  });
  await assert.rejects(
    verifyWebReleaseI18nProof({ repositoryRoot: value.root, scope }),
    /i18n\.generated\.js was not regenerated from packages\/i18n\/index\.js/u,
  );
  await writeBoundManifest({ root: value.root, publicSource: value.publicSource });
  await assert.rejects(
    writeWebReleaseReceipt({ repositoryRoot: value.root, scope, replace: true }),
    /was not regenerated from/u,
    "the receipt writer cannot be reached past the mirror proof",
  );
});

test("web-only release refuses copy that leaves a shipped locale incomplete", async (t) => {
  const value = await i18nCandidateFixture({
    canonicalEdit: addFixtureCopy([FIXTURE_COPY[0], FIXTURE_COPY[1], null]),
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  const scope = inspectWebReleaseScope({
    repositoryRoot: value.root,
    baseCommit: value.baseCommit,
  });
  await assert.rejects(
    verifyWebReleaseI18nProof({ repositoryRoot: value.root, scope }),
    /locales are incomplete: The es catalog is missing 1 canonical key\(s\): site\.releaseLaneFixture/u,
  );
});

test("web-only release refuses runtime code smuggled beside a catalogue copy change", async (t) => {
  const value = await i18nCandidateFixture({
    canonicalEdit: (source) =>
      `${addFixtureCopy()(source)}\nexport const smuggledRuntime = () => 1;\n`,
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed i18n runtime code, not only catalogue copy/u,
  );
});


const TELEMETRY_CANONICAL_SOURCE = "packages/telemetry-contract/src";
const FIXTURE_MODEL_ID = "gpt-4.1";
const FIXTURE_MODEL_LABEL = "GPT-4.1 Site Label";

/** Rename one reviewed identity's site-visible label in the real canonical module. */
const relabelModel = (id = FIXTURE_MODEL_ID, label = FIXTURE_MODEL_LABEL) => (source) => {
  const result = source.replace(
    new RegExp(`^ {2}\\["${id}", "[^"]*"\\],$`, "mu"),
    `  ["${id}", "${label}"],`,
  );
  assert.notEqual(result, source, `${id} is a reviewed identity row in the canonical module`);
  return result;
};

/**
 * A candidate carrying the real canonical model catalogue and both really
 * generated mirrors, so the lane's proof runs against the reviewed generator
 * rather than a simplified stand-in.
 */
async function modelCatalogCandidateFixture({
  canonicalEdit = null,
  browserMirrorEdit = null,
  sharedMirrorEdit = null,
  regenerateBrowserMirror = true,
  regenerateSharedMirror = true,
  renameBrowserMirrorTo = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-web-release-model-catalog-lane-"));
  const publicSource = join(root, "apps", "web", "public");
  const sourceDirectory = join(root, TELEMETRY_CANONICAL_SOURCE);
  const canonicalPath = join(root, MODEL_CATALOG_CANONICAL_PATH);
  const browserMirrorPath = join(root, MODEL_CATALOG_BROWSER_MIRROR_PATH);
  const sharedMirrorPath = join(root, TELEMETRY_SHARED_MIRROR_PATH);
  await mkdir(publicSource, { recursive: true });
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(join(root, ".gitignore"), ".release-build/\n");
  await writeFile(
    join(publicSource, "community.html"),
    '<!doctype html><script type="module" src="./community.js"></script>\n',
  );
  await writeFile(join(publicSource, "community.js"), "export const version = 1;\n");
  const reviewedSource = fileURLToPath(
    new URL(`../${TELEMETRY_CANONICAL_SOURCE}`, import.meta.url),
  );
  for (const basename of await readdir(reviewedSource)) {
    await copyFile(join(reviewedSource, basename), join(sourceDirectory, basename));
  }
  const baseCanonical = await readFile(canonicalPath, "utf8");
  const baseBrowserMirror = await buildPublicModelCatalogMirror({ sourceDirectory });
  const baseSharedMirror = await buildTelemetryBrowserMirror({ sourceDirectory });
  await writeFile(browserMirrorPath, baseBrowserMirror);
  await writeFile(sharedMirrorPath, baseSharedMirror);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Web release lane test"]);
  git(root, ["add", ".gitignore", "apps/web/public", "packages"]);
  git(root, ["commit", "--quiet", "-m", "deployed base"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);

  await writeFile(canonicalPath, canonicalEdit ? canonicalEdit(baseCanonical) : baseCanonical);
  let candidateBrowserMirror = regenerateBrowserMirror
    ? await buildPublicModelCatalogMirror({ sourceDirectory })
    : baseBrowserMirror;
  if (browserMirrorEdit) candidateBrowserMirror = browserMirrorEdit(candidateBrowserMirror);
  await writeFile(browserMirrorPath, candidateBrowserMirror);
  let candidateSharedMirror = regenerateSharedMirror
    ? await buildTelemetryBrowserMirror({ sourceDirectory })
    : baseSharedMirror;
  if (sharedMirrorEdit) candidateSharedMirror = sharedMirrorEdit(candidateSharedMirror);
  await writeFile(sharedMirrorPath, candidateSharedMirror);
  if (renameBrowserMirrorTo) {
    git(root, ["mv", MODEL_CATALOG_BROWSER_MIRROR_PATH, renameBrowserMirrorTo]);
  }
  git(root, ["add", "--all", "packages", "apps/web/public"]);
  git(root, ["commit", "--quiet", "-m", "candidate model vocabulary change"]);

  return {
    baseCommit,
    output: join(root, WEB_RELEASE_OUTPUT_DIRECTORY),
    publicSource,
    root,
    sourceCommit: git(root, ["rev-parse", "HEAD"]),
  };
}

test("web-only model catalogue admission permits reviewed rows only and refuses contract changes", () => {
  const before = [
    'export const REVIEWED_MODEL_CATALOG_VERSION = "reviewed-model-catalog-2026-09-03.1";',
    "const reviewedOpenAiModelRows = [",
    '  ["gpt-5.5", "GPT-5.5"],',
    "];",
    'export const track = (id) => id === "gpt-5.3-codex-spark" ? "spark" : "primary";',
  ].join("\n");
  const edited = before.replace(
    '  ["gpt-5.5", "GPT-5.5"],',
    '  ["gpt-5.5", "GPT-5.5"],\n  ["gpt-6-nova", "GPT-6 Nova", "unpriced", null],',
  );
  const check = (after) => assertModelCatalogScope({
    repositoryRoot: "/fixture",
    baseCommit: "before",
    sourceCommit: "after",
    git: (_root, args) => (args[1].startsWith("before:") ? before : after),
  });
  assert.doesNotThrow(() => check(edited));
  assert.doesNotThrow(() => check(before.replace('"GPT-5.5"]', '"GPT-5.5 Renamed"]')));
  assert.throws(
    () => check(edited.replace("2026-09-03.1", "2026-09-19.1")),
    /model catalogue contract code/u,
  );
  assert.throws(
    () => check(edited.replace('"spark" : "primary"', '"primary" : "primary"')),
    /model catalogue contract code/u,
  );
  assert.throws(
    () => check(edited.replace('"unpriced", null]', '"unpriced", null, runCode()]')),
    /model catalogue contract code/u,
  );
  assert.throws(
    () => check(`${edited}\nexport function weakenedIdentity() {}`),
    /model catalogue contract code/u,
  );
  for (const path of [MODEL_CATALOG_CANONICAL_PATH, MODEL_CATALOG_BROWSER_MIRROR_PATH,
    TELEMETRY_SHARED_MIRROR_PATH]) assert.equal(isAllowedWebReleasePath(path), true);
  for (const path of ["packages/telemetry-contract/src/constants.js",
    "packages/telemetry-contract/src/telemetry-v1.1.js", "packages/telemetry-contract/index.js",
    "packages/telemetry-contract/index.d.ts", "packages/telemetry-contract/package.json",
    "packages/telemetry-contract/AGENTS.md",
    "packages/telemetry-contract/schemas/v0.2/usage-event.schema.json",
  ]) assert.equal(isAllowedWebReleasePath(path), false);
});

test("web-only release admits a reviewed model relabel with both regenerated mirrors", async (t) => {
  const value = await modelCatalogCandidateFixture({ canonicalEdit: relabelModel() });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  const scope = inspectWebReleaseScope({
    repositoryRoot: value.root,
    baseCommit: value.baseCommit,
  });
  assert.deepEqual(
    scope.changes.map((change) => change.path),
    [
      MODEL_CATALOG_BROWSER_MIRROR_PATH,
      TELEMETRY_SHARED_MIRROR_PATH,
      MODEL_CATALOG_CANONICAL_PATH,
    ],
  );
  const proof = await verifyWebReleaseModelCatalogProof({
    repositoryRoot: value.root,
    scope,
  });
  for (const digest of [proof.canonicalSha256, proof.browserMirrorSha256,
    proof.sharedMirrorSha256]) assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(proof.browserMirrorBytes > 0, true);
  assert.equal(proof.sharedMirrorBytes > proof.browserMirrorBytes, true);

  await writeBoundManifest({ root: value.root, publicSource: value.publicSource });
  const written = await writeWebReleaseReceipt({
    repositoryRoot: value.root,
    scope,
    replace: true,
  });
  assert.equal(written.receipt.sourceCommit, value.sourceCommit);
  const verified = await verifyWebReleaseReceipt({ repositoryRoot: value.root });
  assert.equal(verified.scope.sha256, scope.sha256);
});

test("web-only release refuses a hand-edited app-only telemetry mirror", async (t) => {
  const value = await modelCatalogCandidateFixture({
    sharedMirrorEdit: (mirror) => mirror.replace('"GPT-4.1"]', '"Hand edited"]'),
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed apps\/web\/public\/telemetry-shared\.generated\.js without a matching packages\/telemetry-contract\/src\/model-catalog\.js change/u,
  );
});

test("web-only release refuses a catalogue change without its regenerated public mirror", async (t) => {
  const value = await modelCatalogCandidateFixture({
    canonicalEdit: relabelModel(),
    regenerateBrowserMirror: false,
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed packages\/telemetry-contract\/src\/model-catalog\.js without its regenerated apps\/web\/public\/model-catalog\.generated\.js/u,
  );
});

test("web-only release refuses a catalogue change that leaves the shared mirror stale", async (t) => {
  const value = await modelCatalogCandidateFixture({
    canonicalEdit: relabelModel(),
    regenerateSharedMirror: false,
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed packages\/telemetry-contract\/src\/model-catalog\.js without its regenerated apps\/web\/public\/telemetry-shared\.generated\.js/u,
  );
});

test("web-only release refuses a hand-edited model mirror with no canonical change", async (t) => {
  const value = await modelCatalogCandidateFixture({
    browserMirrorEdit: (mirror) => mirror.replace('"GPT-4.1"]', '"Hand edited"]'),
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed apps\/web\/public\/model-catalog\.generated\.js without a matching packages\/telemetry-contract\/src\/model-catalog\.js change/u,
  );
});

test("web-only release refuses a model mirror renamed away from the public site", async (t) => {
  const value = await modelCatalogCandidateFixture({
    renameBrowserMirrorTo: "apps/web/public/ui-format.js",
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed apps\/web\/public\/model-catalog\.generated\.js without a matching packages\/telemetry-contract\/src\/model-catalog\.js change/u,
  );
});

test("web-only release refuses a model mirror that was not regenerated from its canonical source", async (t) => {
  const value = await modelCatalogCandidateFixture({
    canonicalEdit: relabelModel(),
    browserMirrorEdit: (mirror) =>
      mirror.replace(`"${FIXTURE_MODEL_LABEL}"]`, '"Hand edited label"]'),
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  const scope = inspectWebReleaseScope({
    repositoryRoot: value.root,
    baseCommit: value.baseCommit,
  });
  await assert.rejects(
    verifyWebReleaseModelCatalogProof({ repositoryRoot: value.root, scope }),
    /model-catalog\.generated\.js was not regenerated from packages\/telemetry-contract\/src\/model-catalog\.js/u,
  );
  await writeBoundManifest({ root: value.root, publicSource: value.publicSource });
  await assert.rejects(
    writeWebReleaseReceipt({ repositoryRoot: value.root, scope, replace: true }),
    /was not regenerated from/u,
    "the receipt writer cannot be reached past the mirror proof",
  );
});

test("web-only release refuses contract code smuggled beside a reviewed model row", async (t) => {
  const value = await modelCatalogCandidateFixture({
    canonicalEdit: (source) =>
      `${relabelModel()(source)}\nexport const smuggledIdentity = () => 1;\n`,
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));

  assert.throws(
    () => inspectWebReleaseScope({
      repositoryRoot: value.root,
      baseCommit: value.baseCommit,
    }),
    /changed model catalogue contract code, not only reviewed identity rows/u,
  );
});
