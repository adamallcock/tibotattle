import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  canonicalElectronBuilderPackageJsonBytes,
  transformElectronBuilderPackageJsonBytes,
} from "../scripts/lib/electron-builder-package-json.mjs";

const VERSION = "0.1.16";
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { createTransformer: createBuilderTransformer } =
  appBuilderRequire("app-builder-lib/out/fileTransformer.js");

function rootSource() {
  return Buffer.from(`${JSON.stringify({
    engines: { node: ">=22.13.0" },
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    private: true,
    type: "module",
    version: VERSION,
  }, null, 2)}\n`, "utf8");
}

test("canonicalizes the Electron root package with the selected fixed profile", () => {
  const development = canonicalElectronBuilderPackageJsonBytes(
    "package.json",
    rootSource(),
    { packageVersion: VERSION, profile: "development" },
  );
  const production = canonicalElectronBuilderPackageJsonBytes(
    "package.json",
    rootSource(),
    { packageVersion: VERSION, profile: "windows-production" },
  );

  assert.equal(JSON.parse(development).productName, "TiboTattle Dev");
  assert.equal(JSON.parse(development).desktopName, "com.adamallcock.tibotattle.electron.dev.desktop");
  assert.equal(JSON.parse(production).productName, "TiboTattle");
  assert.equal(JSON.parse(production).version, VERSION);
  assert.equal(development.toString("utf8").endsWith("\n"), false);
  assert.equal(production.toString("utf8").endsWith("\n"), false);
  assert.notEqual(development.toString("utf8"), production.toString("utf8"));
});

test("package-json canonicalization is idempotent and preserves dependency integrity", () => {
  const first = canonicalElectronBuilderPackageJsonBytes(
    "package.json",
    rootSource(),
    { packageVersion: VERSION, profile: "windows-production" },
  );
  const second = canonicalElectronBuilderPackageJsonBytes(
    "package.json",
    first,
    { packageVersion: VERSION, profile: "windows-production" },
  );
  assert.deepEqual(second, first);

  const dependencySource = Buffer.from(`${JSON.stringify({
    bugs: { url: "https://example.invalid" },
    name: "fixture",
    scripts: { test: "never" },
    version: "1.0.0",
  }, null, 2)}\n`, "utf8");
  const dependency = transformElectronBuilderPackageJsonBytes(
    "node_modules/fixture/package.json",
    dependencySource,
    { packageVersion: VERSION, profile: "windows-production" },
  );
  assert.equal(dependency.includes(Buffer.from('"scripts"')), false);
  assert.equal(dependency.includes(Buffer.from('"bugs"')), false);
  assert.equal(dependency.toString("utf8").endsWith("\n"), false);
  assert.equal(
    transformElectronBuilderPackageJsonBytes(
      "node_modules/unchanged/package.json",
      Buffer.from('{"name":"unchanged","version":"1.0.0"}\n', "utf8"),
      { packageVersion: VERSION, profile: "windows-production" },
    ),
    null,
  );
  assert.equal(
    transformElectronBuilderPackageJsonBytes(
      "node_modules/malformed/package.json",
      Buffer.from("not-json", "utf8"),
      { packageVersion: VERSION, profile: "windows-production" },
    ),
    null,
  );
  assert.equal(
    transformElectronBuilderPackageJsonBytes(
      "node_modules/non-object/package.json",
      Buffer.from("[]", "utf8"),
      { packageVersion: VERSION, profile: "windows-production" },
    ),
    null,
  );
  assert.equal(
    transformElectronBuilderPackageJsonBytes(
      "README.md",
      rootSource(),
      { packageVersion: VERSION, profile: "windows-production" },
    ),
    null,
  );
});

test("non-Electron runtime staging leaves package-json bytes unchanged", () => {
  const source = rootSource();
  assert.deepEqual(
    canonicalElectronBuilderPackageJsonBytes("package.json", source),
    source,
  );
});

test("matches pinned app-builder-lib 26.15.7 for the development profile", async () => {
  assert.equal(appBuilderRequire("app-builder-lib/package.json").version, "26.15.7");
  const root = await mkdtemp(join(tmpdir(), "tibotattle-package-transform-"));
  try {
    const dependencyPath = join(root, "node_modules", "fixture", "package.json");
    await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
    const packageBytes = Buffer.from(`${JSON.stringify({
      name: "source-name",
      version: "0.0.1",
      private: true,
      type: "module",
      description: "fixture",
      main: "source.js",
      scripts: { test: "never" },
      keywords: ["fixture"],
      bugs: { url: "https://example.invalid/fixture" },
      dist: { integrity: "sha512-fixture" },
      _fixture: true,
      babel: { presets: [] },
      dependencies: { fixture: "1.0.0" },
      devDependencies: { devFixture: "1.0.0" },
    })}\n`, "utf8");
    const dependencyBytes = Buffer.from(`${JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { test: "never" },
      bugs: { url: "https://example.invalid/dependency" },
      dependencies: { nested: "1.0.0" },
    })}\n`, "utf8");
    await writeFile(join(root, "package.json"), packageBytes);
    await writeFile(dependencyPath, dependencyBytes);

    const builderTransformer = createBuilderTransformer(
      root,
      {},
      {
        main: "apps/electron/main.js",
        name: "app-usagemonitor",
        productName: "TiboTattle Dev",
        desktopName: "com.adamallcock.tibotattle.electron.dev.desktop",
        version: VERSION,
      },
    );
    const builderRoot = await builderTransformer(join(root, "package.json"));
    const builderDependency = await builderTransformer(dependencyPath);
    const expectedRoot = transformElectronBuilderPackageJsonBytes(
      "package.json",
      packageBytes,
      { packageVersion: VERSION, profile: "development" },
    );
    const expectedDependency = transformElectronBuilderPackageJsonBytes(
      "node_modules/fixture/package.json",
      dependencyBytes,
      { packageVersion: VERSION, profile: "development" },
    );
    assert.equal(builderRoot, expectedRoot.toString("utf8"));
    assert.equal(builderDependency, expectedDependency.toString("utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
