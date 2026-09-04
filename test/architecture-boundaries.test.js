import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ARCHITECTURE_BOUNDARY_CATEGORIES,
  CURRENT_ARCHITECTURE_BOUNDARY_BASELINE,
  RETIRED_PRODUCTION_SOURCE_PATHS,
  RETIRED_PRODUCTION_TREE_PATHS,
  checkArchitectureBoundaries,
  formatArchitectureBoundaryReport,
} from "../scripts/check-architecture-boundaries.mjs";
import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function withFixtureTree(files, run) {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "usage-monitor-architecture-"),
  );
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = join(rootDirectory, relativePath);
      await mkdir(dirname(absolutePath), {
        recursive: true,
      });
      if (
        contents
        && typeof contents === "object"
        && Object.hasOwn(contents, "symlink")
      ) {
        await symlink(contents.symlink, absolutePath);
      } else {
        await writeFile(
          absolutePath,
          typeof contents === "function"
            ? contents(rootDirectory)
            : contents,
          "utf8",
        );
      }
    }
    return await run(rootDirectory);
  } finally {
    await rm(rootDirectory, {
      force: true,
      recursive: true,
    });
  }
}

test("the current repository satisfies the architecture boundary ratchet", async () => {
  const result = await checkArchitectureBoundaries({
    baseline: CURRENT_ARCHITECTURE_BOUNDARY_BASELINE,
    rootDirectory: REPOSITORY_ROOT,
  });

  assert.equal(
    result.ok,
    true,
    formatArchitectureBoundaryReport(result),
  );
  assert.ok(result.scannedFileCount > 100);
  assert.ok(result.importCount > 100);
  assert.equal(result.baselineIssues.length, 0);
  assert.equal(
    result.approvedViolations.length,
    CURRENT_ARCHITECTURE_BOUNDARY_BASELINE.length,
  );
  assert.deepEqual(CURRENT_ARCHITECTURE_BOUNDARY_BASELINE, []);
  assert.deepEqual(result.approvedViolations, []);
  assert.equal(result.unusedBaseline.length, 0);
});

test("reporting implementation requires its reviewed public index", async () => {
  await withFixtureTree(
    {
      "src/reporting/monitoring-quality.js":
        "export const analyzeMonitoringQuality = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "reporting_owner_public_entrypoint",
          importer: "src/reporting/index.js",
          target: "src/reporting/index.js",
        }],
      );
    },
  );
});

test("contribution implementation requires its sole reviewed public index", async () => {
  await withFixtureTree(
    {
      "src/contribution/telemetry-v01-projection.js":
        "export const buildTelemetryContributionsFromBundle = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "contribution_owner_public_entrypoint",
          importer: "src/contribution/index.js",
          target: "src/contribution/index.js",
        }],
      );
    },
  );
});

test("extracts static, dynamic, and export-from imports without reading prose as code", async () => {
  const imports = await extractEsmImports(`
    import value from "../apps/one/value.js";
    import "../apps/one/side-effect.js";
    export { other } from "../apps/two/other.js";
    export * as names from "../apps/two/names.js";
    const lazy = import("../apps/four/lazy.js");
    const computed = import(runtimePath);
    const metadata = import.meta.url;
    const prose = "import '../apps/not-code/string.js'";
    const template = \`require("../apps/not-code/template.js")\`;
    const expression = \`value: \${"import('../apps/not-code/expression.js')"}\`;
    const pattern = /import\\("\\.\\.\\/apps\\/not-code\\/regex\\.js"\\)/u;
    // import "../apps/not-code/comment.js";
    /* require("../apps/not-code/block.js"); */
  `);

  assert.deepEqual(
    imports.map(({ kind, specifier }) => [kind, specifier]),
    [
      ["import", "../apps/one/value.js"],
      ["import", "../apps/one/side-effect.js"],
      ["export-from", "../apps/two/other.js"],
      ["export-from", "../apps/two/names.js"],
      ["dynamic-import", "../apps/four/lazy.js"],
      ["dynamic-import", null],
    ],
  );
});

test("permits supported dependency directions and ignores tests and tooling", async () => {
  await withFixtureTree(
    {
      "apps/local/server.js": `
        import { shared } from "../../src/shared.js";
        import { contract } from "@usage-monitor/telemetry-contract";
      `,
      "apps/worker/scripts/check.mjs":
        'import "../../../src/forbidden-only-in-tooling.js";',
      "apps/worker/src/index.ts":
        'import { quota } from "../../../shared/quota.js";',
      "apps/worker/test/index.spec.ts":
        'import "../../../src/forbidden-only-in-tests.js";',
      "apps/worker/worker-configuration.d.ts":
        "type RuntimeModule = typeof import(runtimePath);",
      "packages/telemetry-contract/package.json": JSON.stringify({
        name: "@usage-monitor/telemetry-contract",
      }),
      "packages/telemetry-contract/src/index.js":
        'export { local } from "./local.js";',
      "packages/telemetry-contract/src/local.js":
        "export const local = true;",
      "src/shared.js":
        'export { quota } from "../shared/quota.js";',
      "test/root.test.js":
        'import "../apps/web/public/forbidden-only-in-tests.js";',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });
      assert.equal(
        result.ok,
        true,
        formatArchitectureBoundaryReport(result),
      );
      assert.equal(result.violations.length, 0);
    },
  );
});

test("rejects nonliteral dynamic imports in production source", async () => {
  await withFixtureTree(
    {
      "apps/local/server.js": `
        const runtimePath = process.env.RUNTIME_MODULE;
        export const module = import(runtimePath);
      `,
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, target }) => ({
          category,
          target,
        })),
        [{
          category: "nonliteral_dynamic_import",
          target: "<runtime-computed>",
        }],
      );
    },
  );
});

test("production cannot hide a forbidden edge behind an excluded module", async () => {
  await withFixtureTree(
    {
      "apps/local/bridge.test.js":
        'export { browser } from "../web/public/lib.js";',
      "apps/local/server.js":
        'import { browser } from "./bridge.test.js";',
      "apps/web/public/lib.js": "export const browser = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "excluded_source_dependency",
          importer: "apps/local/server.js",
          target: "apps/local/bridge.test.js",
        }],
      );
      assert.match(
        formatArchitectureBoundaryReport(result),
        /\[excluded_source_dependency\]/u,
      );
    },
  );
});

test("extensionless imports cannot hide an excluded production dependency", async () => {
  await withFixtureTree(
    {
      "apps/local/bridge.test.js":
        'export { browser } from "../web/public/lib.js";',
      "apps/local/server.js":
        'import { browser } from "./bridge.test";',
      "apps/web/public/lib.js": "export const browser = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "excluded_source_dependency",
          importer: "apps/local/server.js",
          target: "apps/local/bridge.test.js",
        }],
      );
    },
  );
});

test("absolute paths and file URLs cannot hide first-party tooling dependencies", async () => {
  await withFixtureTree(
    {
      "apps/local/server.js": (rootDirectory) => {
        const toolPath = join(rootDirectory, "tools", "build.js");
        return [
          `import ${JSON.stringify(toolPath)};`,
          `import ${JSON.stringify(pathToFileURL(toolPath).href)};`,
          "",
        ].join("\n");
      },
      "tools/build.js": "export const build = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, target }) => ({
          category,
          target,
        })),
        [
          {
            category: "product_tooling_independence",
            target: "tools/build.js",
          },
          {
            category: "product_tooling_independence",
            target: "tools/build.js",
          },
        ],
      );
    },
  );
});

test("a symlink cannot hide a first-party dependency from the production scan", async () => {
  await withFixtureTree(
    {
      "apps/local/server.js":
        'import "../../src/tool-link.js";',
      "src/tool-link.js": {
        symlink: "../tools/build.js",
      },
      "tools/build.js": "export const build = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, target }) => ({
          category,
          target,
        })),
        [{
          category: "excluded_source_dependency",
          target: "src/tool-link.js",
        }],
      );
    },
  );
});

test("rejects CommonJS production modules instead of missing literal, computed, or createRequire edges", async () => {
  await withFixtureTree(
    {
      "apps/local/literal-require.cjs":
        'module.exports = require("../web/public/lib.js");',
      "apps/local/computed-require.cts": [
        'const browserModule = "../web/public/lib.js";',
        "module.exports = require(browserModule);",
        "",
      ].join("\n"),
      "src/create-require.cjs": [
        'const { createRequire } = require("node:module");',
        "const requireFromSource = createRequire(__filename);",
        'module.exports = requireFromSource("../apps/web/public/lib.js");',
        "",
      ].join("\n"),
      "apps/web/public/lib.js": "export const browser = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer }) => ({
          category,
          importer,
        })),
        [{
          category: "commonjs_production_source",
          importer: "apps/local/computed-require.cts",
        }, {
          category: "commonjs_production_source",
          importer: "apps/local/literal-require.cjs",
        }, {
          category: "commonjs_production_source",
          importer: "src/create-require.cjs",
        }],
      );
    },
  );
});

test("allows only the exact sandboxed Electron preload shape", async () => {
  await withFixtureTree(
    {
      "apps/electron/preload.cjs": [
        'const { contextBridge, ipcRenderer } = require("electron");',
        "contextBridge.exposeInMainWorld('bounded', { invoke: () => ipcRenderer.invoke('fixed') });",
        "",
      ].join("\n"),
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });
      assert.equal(result.ok, true, formatArchitectureBoundaryReport(result));
    },
  );

  await withFixtureTree(
    {
      "apps/electron/not-a-preload.cjs":
        'const { contextBridge, ipcRenderer } = require("electron");',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });
      assert.deepEqual(
        result.violations.map(({ category, importer }) => ({ category, importer })),
        [{
          category: "commonjs_production_source",
          importer: "apps/electron/not-a-preload.cjs",
        }],
      );
    },
  );

  for (const unsafeSource of [
    [
      'const { contextBridge, ipcRenderer } = require("electron");',
      'import "./extra-static.js";',
    ].join("\n"),
    [
      'const { contextBridge, ipcRenderer } = require("electron");',
      'const extra = import("./extra-dynamic.js");',
    ].join("\n"),
    [
      'const { contextBridge, ipcRenderer } = require("electron");',
      "const extra = import(runtimePath);",
    ].join("\n"),
    [
      'const { contextBridge, ipcRenderer } = require("electron");',
      'const { createRequire } = require("node:module");',
    ].join("\n"),
    [
      'const { contextBridge, ipcRenderer } = require("electron");',
      'const fs = require("node:fs");',
    ].join("\n"),
    [
      'const { contextBridge, ipcRenderer } = require("electron");',
      'const target = "node:fs"; const fs = require(target);',
    ].join("\n"),
    [
      'const { contextBridge, ipcRenderer } = require("electron");',
      'const load = require; load("node:fs");',
    ].join("\n"),
  ]) {
    await withFixtureTree(
      { "apps/electron/preload.cjs": unsafeSource },
      async (rootDirectory) => {
        const result = await checkArchitectureBoundaries({
          baseline: [],
          rootDirectory,
        });
        assert.deepEqual(
          result.violations.map(({ category, importer }) => ({ category, importer })),
          [{
            category: "commonjs_production_source",
            importer: "apps/electron/preload.cjs",
          }],
        );
      },
    );
  }
});

test("rejects ESM CommonJS loaders before they can hide cross-app dependencies", async () => {
  await withFixtureTree(
    {
      "apps/local/aliased-create-require.mjs": [
        'import { createRequire as makeRequire } from "node:module";',
        "const load = makeRequire(import.meta.url);",
        'export const browser = load("../web/public/lib.js");',
        "",
      ].join("\n"),
      "apps/local/direct-require.ts": [
        'const browserModule = "../web/public/lib.js";',
        "export const browser = require(browserModule);",
        "",
      ].join("\n"),
      "apps/local/literal-create-require.js": [
        'import { createRequire } from "node:module";',
        "const require = createRequire(import.meta.url);",
        'export const browser = require("../web/public/lib.js");',
        "",
      ].join("\n"),
      "apps/local/member-create-require.js": [
        'import * as nodeModule from "node:module";',
        "const require = nodeModule.createRequire(import.meta.url);",
        'export const browser = require("../web/public/lib.js");',
        "",
      ].join("\n"),
      "apps/web/public/lib.js": "export const browser = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [
          {
            category: "esm_commonjs_loading",
            importer: "apps/local/aliased-create-require.mjs",
            target: "<runtime-commonjs-loader>",
          },
          {
            category: "esm_commonjs_loading",
            importer: "apps/local/direct-require.ts",
            target: "<runtime-commonjs-loader>",
          },
          {
            category: "esm_commonjs_loading",
            importer: "apps/local/literal-create-require.js",
            target: "<runtime-commonjs-loader>",
          },
          {
            category: "esm_commonjs_loading",
            importer: "apps/local/member-create-require.js",
            target: "<runtime-commonjs-loader>",
          },
        ],
      );
    },
  );
});

for (const fixture of [
  {
    category: "packages_dependency_direction",
    files: {
      "apps/web/public/lib.js": "export const value = true;",
      "packages/core/src/index.ts":
        'import { value } from "../../../apps/web/public/lib.js";',
    },
  },
  {
    category: "shared_dependency_direction",
    files: {
      "apps/web/public/lib.js": "export const value = true;",
      "shared/telemetry/index.js":
        'export { value } from "../../apps/web/public/lib.js";',
    },
  },
  {
    category: "src_application_independence",
    files: {
      "apps/local/server.js": "export const server = true;",
      "src/core.js":
        'export { server } from "../apps/local/server.js";',
    },
  },
  {
    category: "worker_root_source_independence",
    files: {
      "apps/worker/src/index.ts":
        'import core from "../../../src/core.js";',
      "src/core.js": "export const core = true;",
    },
  },
  {
    category: "application_isolation",
    files: {
      "apps/local/server.js": "export const server = true;",
      "apps/web/public/lib.js":
        'const server = import("../../local/server.js");',
    },
  },
  {
    category: "workspace_package_public_api",
    files: {
      "apps/local/server.js":
        'import { value } from "../../packages/core/src/index.js";',
      "packages/core/package.json": JSON.stringify({
        name: "@usage-monitor/core",
      }),
      "packages/core/src/index.js": "export const value = true;",
    },
  },
  {
    category: "workspace_package_public_api",
    files: {
      "packages/core/package.json": JSON.stringify({
        name: "@usage-monitor/core",
      }),
      "packages/core/src/index.js": "export const value = true;",
      "src/flat-client.js":
        'import { value } from "@usage-monitor/core/src/index.js";',
    },
  },
  {
    category: "product_tooling_independence",
    files: {
      "apps/local/server.js":
        'import { build } from "../../tools/build.js";',
      "tools/build.js": "export const build = true;",
    },
  },
]) {
  test(`rejects ${fixture.category} violations with actionable output`, async () => {
    await withFixtureTree(fixture.files, async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category }) => category),
        [fixture.category],
      );
      const report = formatArchitectureBoundaryReport(result);
      assert.match(report, new RegExp(`\\[${fixture.category}\\]`, "u"));
      assert.match(report, /Rule:/u);
      assert.match(report, /Fix:/u);
      assert.ok(
        ARCHITECTURE_BOUNDARY_CATEGORIES[fixture.category],
      );
    });
  });
}

test("resolves first-party workspace package names before applying boundaries", async () => {
  await withFixtureTree(
    {
      "apps/web/package.json": JSON.stringify({
        name: "@usage-monitor/web-internal",
      }),
      "apps/web/public/lib.js": "export const value = true;",
      "packages/core/package.json": JSON.stringify({
        name: "@usage-monitor/core",
      }),
      "packages/core/src/index.ts":
        'import { value } from "@usage-monitor/web-internal/public/lib.js";',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.violations[0]?.category,
        "packages_dependency_direction",
      );
      assert.equal(
        result.violations[0]?.target,
        "apps/web/public/lib.js",
      );
    },
  );
});

test("owned root source must consume an allowed workspace package through its public root", async () => {
  await withFixtureTree(
    {
      "packages/telemetry-contract/index.js":
        "export const publicValue = true;",
      "packages/telemetry-contract/package.json": JSON.stringify({
        name: "@fixture/telemetry-contract",
        exports: "./index.js",
      }),
      "packages/telemetry-contract/src/private.js":
        "export const privateValue = true;",
      "src/providers/codex/client.js":
        'import { privateValue } from "@fixture/telemetry-contract/src/private.js";',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(
          ({ category, importer, specifier, target }) => ({
            category,
            importer,
            specifier,
            target,
          }),
        ),
        [{
          category: "workspace_package_public_api",
          importer: "src/providers/codex/client.js",
          specifier: "@fixture/telemetry-contract/src/private.js",
          target: "packages/telemetry-contract/src/private.js",
        }],
      );
    },
  );
});

test("owned root source may consume an allowed workspace package through its bare public root", async () => {
  await withFixtureTree(
    {
      "packages/telemetry-contract/index.js":
        "export const publicValue = true;",
      "packages/telemetry-contract/package.json": JSON.stringify({
        name: "@fixture/telemetry-contract",
        exports: "./index.js",
      }),
      "src/providers/codex/client.js":
        'import { publicValue } from "@fixture/telemetry-contract";',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(
        result.ok,
        true,
        formatArchitectureBoundaryReport(result),
      );
    },
  );
});

test("retired production paths must stay absent", async () => {
  await withFixtureTree(
    {
      "shared/quota-rolling.js": "export const retired = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "retired_production_source_path",
          importer: "shared/quota-rolling.js",
          target: "shared/quota-rolling.js",
        }],
      );
    },
  );
});

test("imports into retired paths fail even after the target has been removed", async () => {
  await withFixtureTree(
    {
      "src/client.js":
        'import { retired } from "../shared/quota-rolling.js"; export { retired };',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "retired_production_source_path",
          importer: "src/client.js",
          target: "shared/quota-rolling.js",
        }],
      );
    },
  );
});

test("retired production trees reject every descendant path", async () => {
  await withFixtureTree(
    {
      "apps/cloud-run/src/reintroduced-under-a-new-name.js":
        "export const retired = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "retired_production_source_path",
          importer: "apps/cloud-run",
          target: "apps/cloud-run",
        }],
      );
    },
  );
});

test("imports into a retired production tree fail while it is absent", async () => {
  await withFixtureTree(
    {
      "src/client.js": [
        'import { retired } from "../apps/cloud-run/src/server.js";',
        "export { retired };",
      ].join("\n"),
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "retired_production_source_path",
          importer: "src/client.js",
          target: "apps/cloud-run",
        }],
      );
    },
  );
});

test("permits an acyclic production diamond", async () => {
  await withFixtureTree(
    {
      "src/diamond/a.js": [
        'import "./b.js";',
        'import "./c.js";',
        "",
      ].join("\n"),
      "src/diamond/b.js": 'import "./d.js";',
      "src/diamond/c.js": 'export { value } from "./d.js";',
      "src/diamond/d.js": "export const value = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(
        result.ok,
        true,
        formatArchitectureBoundaryReport(result),
      );
      assert.equal(
        result.violations.some(
          ({ category }) => category === "production_import_cycle",
        ),
        false,
      );
    },
  );
});

test("rejects static, export-from, and literal-dynamic production cycles deterministically", async () => {
  await withFixtureTree(
    {
      "src/cycle/a.js": 'import "./b.js";',
      "src/cycle/b.js": 'export { value } from "./c.js";',
      "src/cycle/c.js": [
        'export const value = import("./a.js");',
        "",
      ].join("\n"),
      "src/other-cycle/a.js": 'import "./b.js";',
      "src/other-cycle/b.js": 'import "./a.js";',
    },
    async (rootDirectory) => {
      const first = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });
      const second = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });
      const cycles = first.violations.filter(
        ({ category }) => category === "production_import_cycle",
      );

      assert.equal(first.ok, false);
      assert.deepEqual(first.violations, second.violations);
      assert.deepEqual(
        cycles.map(({ cycle, importer, target }) => ({
          cycle,
          importer,
          target,
        })),
        [
          {
            cycle: [
              "src/cycle/a.js",
              "src/cycle/b.js",
              "src/cycle/c.js",
              "src/cycle/a.js",
            ],
            importer: "src/cycle/a.js",
            target: "src/cycle/b.js",
          },
          {
            cycle: [
              "src/other-cycle/a.js",
              "src/other-cycle/b.js",
              "src/other-cycle/a.js",
            ],
            importer: "src/other-cycle/a.js",
            target: "src/other-cycle/b.js",
          },
        ],
      );
    },
  );
});

test("rejects a cycle crossing bare workspace package public roots", async () => {
  await withFixtureTree(
    {
      "packages/a/index.js": 'import "@fixture/b";',
      "packages/a/package.json": JSON.stringify({
        name: "@fixture/a",
        exports: "./index.js",
      }),
      "packages/b/index.js": 'import "@fixture/a";',
      "packages/b/package.json": JSON.stringify({
        name: "@fixture/b",
        exports: {
          ".": {
            import: "./index.js",
          },
        },
      }),
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations
          .filter(({ category }) => category === "production_import_cycle")
          .map(({ category, cycle }) => ({
            category,
            cycle,
          })),
        [{
          category: "production_import_cycle",
          cycle: [
            "packages/a/index.js",
            "packages/b/index.js",
            "packages/a/index.js",
          ],
        }],
      );
    },
  );
});

test("workspace packages cannot import sibling workspace packages", async () => {
  await withFixtureTree(
    {
      "packages/a/index.js": 'import "@fixture/b";',
      "packages/a/package.json": JSON.stringify({
        name: "@fixture/a",
        exports: "./index.js",
      }),
      "packages/b/index.js": "export const value = true;",
      "packages/b/package.json": JSON.stringify({
        name: "@fixture/b",
        exports: "./index.js",
      }),
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "packages_dependency_direction",
          importer: "packages/a/index.js",
          target: "packages/b/index.js",
        }],
      );
    },
  );
});

test("web cannot import root product source even through a reviewed facade", async () => {
  await withFixtureTree(
    {
      "apps/web/public/main.js":
        'import "../../../src/application/index.js";',
      "src/application/index.js":
        "export const application = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category }) => category),
        ["source_owner_dependency_direction"],
      );
    },
  );
});

test("local composition may import application and platform facades but not provider facades", async () => {
  await withFixtureTree(
    {
      "apps/local/server.js": [
        'import "../../src/application/index.js";',
        'import "../../src/platform/telemetry-envelope.js";',
        'import "../../src/providers/codex/account.js";',
        "",
      ].join("\n"),
      "src/application/index.js":
        "export const application = true;",
      "src/platform/telemetry-envelope.js":
        "export const envelope = true;",
      "src/providers/codex/account.js":
        "export const account = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, target }) => ({
          category,
          target,
        })),
        [{
          category: "source_owner_dependency_direction",
          target: "src/providers/codex/account.js",
        }],
      );
    },
  );
});

test("the distributable local-review root is scanned as production source", async () => {
  await withFixtureTree(
    {
      "local-review/arguments.js":
        "export const parsed = true;",
      "local-review/cli.js":
        'export { parsed } from "./arguments.js";',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(
        result.ok,
        true,
        formatArchitectureBoundaryReport(result),
      );
      assert.equal(result.scannedFileCount, 2);
      assert.equal(result.importCount, 1);
    },
  );
});

test("local-review production source cannot import build tools", async () => {
  await withFixtureTree(
    {
      "local-review/cli.js":
        'import "../tools/build.js";',
      "tools/build.js":
        "export const build = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "product_tooling_independence",
          importer: "local-review/cli.js",
          target: "tools/build.js",
        }],
      );
    },
  );
});

test("local-review remains isolated from every other application", async () => {
  await withFixtureTree(
    {
      "apps/local/server.js":
        "export const server = true;",
      "local-review/cli.js":
        'import { server } from "../apps/local/server.js";',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "application_isolation",
          importer: "local-review/cli.js",
          target: "apps/local/server.js",
        }],
      );
    },
  );
});

test("local-review must use reviewed source-owner facades rather than deep imports", async () => {
  await withFixtureTree(
    {
      "local-review/cli.js": [
        'import { publicOperation } from "../src/application/index.js";',
        'import { privateOperation } from "../src/application/private.js";',
        "export const operations = { privateOperation, publicOperation };",
        "",
      ].join("\n"),
      "src/application/index.js":
        "export const publicOperation = true;",
      "src/application/private.js":
        "export const privateOperation = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "source_owner_public_api",
          importer: "local-review/cli.js",
          target: "src/application/private.js",
        }],
      );
    },
  );
});

test("local-review legacy migration debt requires an exact documented edge", async () => {
  await withFixtureTree(
    {
      "local-review/cli.js": [
        'import { allowed } from "../src/allowed.js";',
        'import { unapproved } from "../src/unapproved.js";',
        "export const values = { allowed, unapproved };",
        "",
      ].join("\n"),
      "src/allowed.js":
        "export const allowed = true;",
      "src/unapproved.js":
        "export const unapproved = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [{
          category: "local_review_legacy_source_dependency",
          importer: "local-review/cli.js",
          rationale:
            "This exact fixture edge represents known local-review migration debt.",
          removeWhen:
            "The fixture dependency moves behind its reviewed source-owner facade.",
          target: "src/allowed.js",
        }],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.equal(result.approvedViolations.length, 1);
      assert.equal(result.approvedViolations[0].target, "src/allowed.js");
      assert.deepEqual(
        result.violations.map(({ category, importer, target }) => ({
          category,
          importer,
          target,
        })),
        [{
          category: "local_review_legacy_source_dependency",
          importer: "local-review/cli.js",
          target: "src/unapproved.js",
        }],
      );
    },
  );
});

test("cycles wholly inside local-review are structural failures", async () => {
  await withFixtureTree(
    {
      "local-review/a.js":
        'import { b } from "./b.js"; export const a = b;',
      "local-review/b.js":
        'import { a } from "./a.js"; export const b = a;',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category, cycle }) => ({
          category,
          cycle,
        })),
        [{
          category: "production_import_cycle",
          cycle: [
            "local-review/a.js",
            "local-review/b.js",
            "local-review/a.js",
          ],
        }],
      );
    },
  );
});

test("local and Worker apps may use only their reviewed package roots", async () => {
  await withFixtureTree(
    {
      "apps/local/server.js": [
        'import "@fixture/accounting";',
        'import "@fixture/quota-analysis";',
        'import "@fixture/telemetry-contract";',
        "",
      ].join("\n"),
      "apps/worker/src/index.ts": [
        'import "@fixture/accounting";',
        'import "@fixture/quota-analysis";',
        'import "@fixture/telemetry-contract";',
        "",
      ].join("\n"),
      "packages/accounting/index.js":
        "export const accounting = true;",
      "packages/accounting/package.json": JSON.stringify({
        name: "@fixture/accounting",
        exports: "./index.js",
      }),
      "packages/quota-analysis/index.js":
        "export const quota = true;",
      "packages/quota-analysis/package.json": JSON.stringify({
        name: "@fixture/quota-analysis",
        exports: "./index.js",
      }),
      "packages/identity-core/index.js":
        "export const identity = true;",
      "packages/identity-core/package.json": JSON.stringify({
        name: "@fixture/identity-core",
        exports: "./index.js",
      }),
      "packages/telemetry-contract/index.js":
        "export const telemetry = true;",
      "packages/telemetry-contract/package.json": JSON.stringify({
        name: "@fixture/telemetry-contract",
        exports: "./index.js",
      }),
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(
        result.ok,
        true,
        formatArchitectureBoundaryReport(result),
      );
    },
  );
});

for (const fixture of [
  {
    app: "macos",
    packageDirectory: "telemetry-contract",
    packageName: "@fixture/telemetry-contract",
  },
  {
    app: "web",
    packageDirectory: "accounting",
    packageName: "@fixture/accounting",
  },
  {
    app: "local-review",
    packageDirectory: "identity-core",
    packageName: "@fixture/identity-core",
    source: "local-review/cli.js",
  },
]) {
  test(`rejects an unapproved package root from the ${fixture.app} app`, async () => {
    await withFixtureTree(
      {
        [fixture.source ?? `apps/${fixture.app}/src/index.js`]:
          `import "${fixture.packageName}";`,
        [`packages/${fixture.packageDirectory}/index.js`]:
          "export const dependency = true;",
        [`packages/${fixture.packageDirectory}/package.json`]: JSON.stringify({
          name: fixture.packageName,
          exports: "./index.js",
        }),
      },
      async (rootDirectory) => {
        const result = await checkArchitectureBoundaries({
          baseline: [],
          rootDirectory,
        });

        assert.equal(result.ok, false);
        assert.deepEqual(
          result.violations.map(({ category }) => category),
          ["source_owner_dependency_direction"],
        );
      },
    );
  });
}

test("rejects macos imports into an owned root source area", async () => {
  await withFixtureTree(
    {
      "apps/macos/src/index.js":
        'import "../../../src/application/index.js";',
      "src/application/index.js":
        "export const application = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category }) => category),
        ["source_owner_dependency_direction"],
      );
    },
  );
});

test("permits every reviewed source-owner dependency row through exact public facades", async () => {
  await withFixtureTree(
    {
      "apps/local/server.js": [
        'import { application } from "../../src/application/index.js";',
        'import { envelope } from "../../src/platform/telemetry-envelope.js";',
        "export const composition = { application, envelope };",
        "",
      ].join("\n"),
      "packages/accounting/index.js":
        "export const accounting = true;",
      "packages/accounting/package.json": JSON.stringify({
        name: "@fixture/accounting",
        exports: "./index.js",
      }),
      "packages/quota-analysis/index.js":
        "export const quota = true;",
      "packages/quota-analysis/package.json": JSON.stringify({
        name: "@fixture/quota-analysis",
        exports: "./index.js",
      }),
      "packages/telemetry-contract/index.js":
        "export const telemetry = true;",
      "packages/telemetry-contract/package.json": JSON.stringify({
        name: "@fixture/telemetry-contract",
        exports: "./index.js",
      }),
      "src/application/index.js":
        'export { application } from "./run.js";',
      "src/application/run.js": [
        'import { account } from "../providers/codex/account.js";',
        'import { exported } from "../export/index.js";',
        'import { contribution } from "../contribution/index.js";',
        'import { report } from "../reporting/index.js";',
        'import { accounting } from "@fixture/accounting";',
        'import { quota } from "@fixture/quota-analysis";',
        'import { telemetry } from "@fixture/telemetry-contract";',
        "export const application = {",
        "  account, accounting, contribution, exported, quota, report, telemetry,",
        "};",
        "",
      ].join("\n"),
      "src/contribution/index.js": [
        'import { accounting } from "@fixture/accounting";',
        'import { exported } from "../export/index.js";',
        'import { identity } from "@fixture/identity-core";',
        'import { telemetry } from "@fixture/telemetry-contract";',
        "export const contribution = { accounting, exported, identity, telemetry };",
        "",
      ].join("\n"),
      "src/export/index.js": [
        'import { account } from "../providers/codex/account.js";',
        'import { telemetry } from "@fixture/telemetry-contract";',
        "export const exported = { account, telemetry };",
        "",
      ].join("\n"),
      "src/platform/telemetry-envelope.js": [
        'import { identity } from "@fixture/identity-core";',
        'import { telemetry } from "@fixture/telemetry-contract";',
        "export const envelope = { identity, telemetry };",
        "",
      ].join("\n"),
      "src/providers/codex/account-scope.js": [
        'import { telemetry } from "@fixture/telemetry-contract";',
        "export const account = telemetry;",
        "",
      ].join("\n"),
      "src/providers/codex/account.js":
        'export { account } from "./account-scope.js";',
      "src/reporting/index.js": [
        'import { accounting } from "@fixture/accounting";',
        'import { quota } from "@fixture/quota-analysis";',
        "export const report = { accounting, quota };",
        "",
      ].join("\n"),
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(
        result.ok,
        true,
        formatArchitectureBoundaryReport(result),
      );
    },
  );
});

for (const fixture of [
  {
    category: "source_owner_public_api",
    label: "external deep imports into an otherwise-allowed owner",
    files: {
      "apps/local/server.js":
        'import "../../src/application/private.js";',
      "src/application/private.js":
        "export const application = true;",
    },
  },
  {
    category: "source_owner_public_api",
    label: "otherwise-allowed owner crossings through private modules",
    files: {
      "src/export/index.js":
        'import { account } from "../providers/codex/account-scope.js";',
      "src/providers/codex/account-scope.js":
        "export const account = true;",
    },
  },
  {
    category: "source_owner_dependency_direction",
    label: "cross-provider dependencies even through a reviewed facade",
    files: {
      "src/providers/claude/statusline.js":
        "export const statusline = true;",
      "src/providers/codex/client.js":
        'import { statusline } from "../claude/statusline.js";',
    },
  },
  {
    category: "source_owner_dependency_direction",
    label: "provider-to-platform dependencies instead of injected adapters",
    files: {
      "src/platform/telemetry-envelope.js":
        "export const envelope = true;",
      "src/providers/codex/client.js":
        'import { envelope } from "../../platform/telemetry-envelope.js";',
    },
  },
  {
    category: "source_owner_dependency_direction",
    label: "reverse platform-to-provider dependencies",
    files: {
      "src/platform/telemetry-envelope.js":
        'import { account } from "../providers/codex/account.js";',
      "src/providers/codex/account.js":
        "export const account = true;",
    },
  },
  {
    category: "source_owner_dependency_direction",
    label: "provider dependencies on higher-level feature owners",
    files: {
      "src/contribution/ingest.js":
        "export const ingest = true;",
      "src/contribution/index.js":
        'export { ingest } from "./ingest.js";',
      "src/providers/codex/client.js":
        'import { ingest } from "../../contribution/index.js";',
    },
  },
  {
    category: "source_owner_dependency_direction",
    label: "provider dependencies on application-owned policy",
    files: {
      "src/application/index.js":
        "export const sensitivity = true;",
      "src/providers/codex/client.js":
        'import { sensitivity } from "../../application/index.js";',
    },
  },
  {
    category: "source_owner_dependency_direction",
    label: "export dependencies on contribution",
    files: {
      "src/contribution/index.js":
        "export const contribution = true;",
      "src/export/index.js":
        'import { contribution } from "../contribution/index.js";',
    },
  },
  {
    category: "source_owner_dependency_direction",
    label: "contribution dependencies on providers",
    files: {
      "src/contribution/index.js":
        'import { account } from "../providers/codex/account.js";',
      "src/providers/codex/account.js":
        "export const account = true;",
    },
  },
  {
    category: "source_owner_dependency_direction",
    label: "reporting dependencies on another source owner",
    files: {
      "src/export/index.js":
        "export const exported = true;",
      "src/reporting/index.js":
        'import { exported } from "../export/index.js";',
    },
  },
  {
    category: "source_owner_dependency_direction",
    label: "application dependencies on concrete platform modules",
    files: {
      "src/application/index.js":
        'import { envelope } from "../platform/telemetry-envelope.js";',
      "src/platform/telemetry-envelope.js":
        "export const envelope = true;",
    },
  },
  {
    category: "source_owner_dependency_direction",
    label: "owned source reaching back into flat legacy source",
    files: {
      "src/application/run.js":
        'import { legacy } from "../legacy.js";',
      "src/legacy.js": "export const legacy = true;",
    },
  },
]) {
  test(`rejects ${fixture.label}`, async () => {
    await withFixtureTree(fixture.files, async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(({ category }) => category),
        [fixture.category],
      );
    });
  });
}

for (const fixture of [
  {
    importer: "src/providers/codex/client.js",
    owner: "provider",
    packageDirectory: "accounting",
    packageName: "@fixture/accounting",
  },
  {
    importer: "src/platform/storage.js",
    owner: "platform",
    packageDirectory: "accounting",
    packageName: "@fixture/accounting",
  },
  {
    importer: "src/export/index.js",
    owner: "export",
    packageDirectory: "accounting",
    packageName: "@fixture/accounting",
  },
  {
    importer: "src/reporting/index.js",
    owner: "reporting",
    packageDirectory: "telemetry-contract",
    packageName: "@fixture/telemetry-contract",
  },
]) {
  test(`rejects an unapproved package dependency from the ${fixture.owner} owner`, async () => {
    await withFixtureTree(
      {
        [`packages/${fixture.packageDirectory}/index.js`]:
          "export const dependency = true;",
        [`packages/${fixture.packageDirectory}/package.json`]: JSON.stringify({
          name: fixture.packageName,
          exports: "./index.js",
        }),
        [fixture.importer]:
          `import { dependency } from "${fixture.packageName}";`,
      },
      async (rootDirectory) => {
        const result = await checkArchitectureBoundaries({
          baseline: [],
          rootDirectory,
        });

        assert.equal(result.ok, false);
        assert.deepEqual(
          result.violations.map(({ category }) => category),
          ["source_owner_dependency_direction"],
        );
      },
    );
  });
}

test("workspace-named tools cannot evade product tooling independence", async () => {
  await withFixtureTree(
    {
      "apps/local/server.js": [
        'import "@fixture/build-tool";',
        'import "../../scripts/app-build.js";',
        "",
      ].join("\n"),
      "packages/core/index.js": [
        'import "@fixture/build-tool";',
        'import "../../scripts/package-build.js";',
        "",
      ].join("\n"),
      "packages/core/package.json": JSON.stringify({
        name: "@fixture/core",
        exports: "./index.js",
      }),
      "scripts/app-build.js": "export const build = true;",
      "scripts/package-build.js": "export const build = true;",
      "scripts/provider-build.js": "export const build = true;",
      "src/providers/codex/client.js": [
        'import "@fixture/build-tool";',
        'import "../../../scripts/provider-build.js";',
        "",
      ].join("\n"),
      "tools/build-tool/index.js": "export const build = true;",
      "tools/build-tool/package.json": JSON.stringify({
        name: "@fixture/build-tool",
        exports: "./index.js",
      }),
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(
          ({ category, importer, target }) => ({
            category,
            importer,
            target,
          }),
        ),
        [
          {
            category: "product_tooling_independence",
            importer: "apps/local/server.js",
            target: "tools/build-tool/index.js",
          },
          {
            category: "product_tooling_independence",
            importer: "apps/local/server.js",
            target: "scripts/app-build.js",
          },
          {
            category: "product_tooling_independence",
            importer: "packages/core/index.js",
            target: "tools/build-tool/index.js",
          },
          {
            category: "product_tooling_independence",
            importer: "packages/core/index.js",
            target: "scripts/package-build.js",
          },
          {
            category: "product_tooling_independence",
            importer: "src/providers/codex/client.js",
            target: "tools/build-tool/index.js",
          },
          {
            category: "product_tooling_independence",
            importer: "src/providers/codex/client.js",
            target: "scripts/provider-build.js",
          },
        ],
      );
    },
  );
});

test("structural source-owner and cycle categories cannot be baselined", async () => {
  await withFixtureTree(
    {
      "src/clean.js": "export const clean = true;",
    },
    async (rootDirectory) => {
      const baseline = [
        "contribution_owner_public_entrypoint",
        "production_import_cycle",
        "retired_production_source_path",
        "source_owner_dependency_direction",
        "source_owner_public_api",
      ].map((category) => ({
        category,
        importer: "src/clean.js",
        rationale:
          "This structural violation is intentionally supplied as a negative fixture.",
        removeWhen:
          "The architecture checker proves that structural debt cannot be allowed.",
        target: "src/clean.js",
      }));
      const result = await checkArchitectureBoundaries({
        baseline,
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.equal(result.baselineIssues.length, 5);
      for (const category of [
        "contribution_owner_public_entrypoint",
        "production_import_cycle",
        "retired_production_source_path",
        "source_owner_dependency_direction",
        "source_owner_public_api",
      ]) {
        assert.match(
          result.baselineIssues.join("\n"),
          new RegExp(`non-baselinable structural category: ${category}`, "u"),
        );
      }
    },
  );
});

test("the retired source ledger remains exact and normalized", () => {
  assert.deepEqual(RETIRED_PRODUCTION_SOURCE_PATHS, [
    "shared/quota-calibration.js",
    "shared/quota-rolling.js",
    "shared/quota-tracks.js",
    "src/application/local-automatic-contribution.js",
    "src/automatic-contribution.js",
    "src/claude-desktop-quota-refresh.js",
    "src/claude-desktop-quota-state.js",
    "src/codex-log-scan.js",
    "src/contribution/recurrence-policy.js",
    "src/contribution-sync-queue.js",
    "src/cost-ledger.js",
    "src/export-checkpoint-state.js",
    "src/export-deletion-compatibility-internal.js",
    "src/export-deletion-schema.js",
    "src/export-registries.js",
    "src/export-safe-records.js",
    "src/export-set-materializer.js",
    "src/export-source-pipeline-compatibility-internal.js",
    "src/export-versions.js",
    "src/export-workspace-compatibility-internal.js",
    "src/export-workspace-discard-compatibility-internal.js",
    "src/export-workspace-lock-compatibility-internal.js",
    "src/export-workspace-lock.js",
    "src/export-workspace.js",
    "src/local-api-pricing.js",
    "src/metadata-exporter.js",
    "src/price-registry.js",
    "src/tier-semantics.js",
  ]);
  assert.deepEqual(RETIRED_PRODUCTION_TREE_PATHS, [
    "apps/cloud-run",
  ]);
});

test("an exact documented baseline permits only its named edge", async () => {
  await withFixtureTree(
    {
      "apps/web/public/lib.js": "export const value = true;",
      "src/allowed.js":
        'import { value } from "../apps/web/public/lib.js";',
      "src/new-debt.js":
        'import { value } from "../apps/web/public/lib.js";',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [
          {
            category: "src_application_independence",
            importer: "src/allowed.js",
            target: "apps/web/public/lib.js",
            rationale:
              "This exact compatibility edge predates the architecture ratchet.",
            removeWhen:
              "The compatibility implementation moves into a shared package.",
          },
        ],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.equal(result.approvedViolations.length, 1);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].importer, "src/new-debt.js");
    },
  );
});

test("code outside the Codex provider must use its reviewed log facade", async () => {
  await withFixtureTree(
    {
      "src/export/index.js": [
        'import { publicLogs } from "../providers/codex/logs.js";',
        'import { privateLogs } from "../providers/codex/log-ingestion.js";',
        "export const exported = { privateLogs, publicLogs };",
        "",
      ].join("\n"),
      "src/providers/codex/log-ingestion.js":
        "export const privateLogs = true;",
      "src/providers/codex/logs.js":
        'export { privateLogs as publicLogs } from "./log-ingestion.js";',
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.violations.map(
          ({ category, importer, target }) => ({
            category,
            importer,
            target,
          }),
        ),
        [{
          category: "source_owner_public_api",
          importer: "src/export/index.js",
          target: "src/providers/codex/log-ingestion.js",
        }],
      );
    },
  );
});

for (const fixture of [
  {
    dependencyFiles: {
      "src/legacy.js": "export const dependency = true;",
    },
    label: "flat legacy source",
    specifier: "../../legacy.js",
  },
  {
    dependencyFiles: {
      "packages/accounting/index.js":
        "export const dependency = true;",
      "packages/accounting/package.json": JSON.stringify({
        name: "@fixture/accounting",
        exports: "./index.js",
      }),
    },
    label: "the accounting package",
    specifier: "@fixture/accounting",
  },
  {
    dependencyFiles: {
      "src/platform/telemetry-envelope.js":
        "export const dependency = true;",
    },
    label: "the platform owner",
    specifier: "../../platform/telemetry-envelope.js",
  },
]) {
  test(`the Codex provider cannot import ${fixture.label}`, async () => {
    await withFixtureTree(
      {
        ...fixture.dependencyFiles,
        "src/providers/codex/log-ingestion.js":
          `import { dependency } from "${fixture.specifier}";`,
      },
      async (rootDirectory) => {
        const result = await checkArchitectureBoundaries({
          baseline: [],
          rootDirectory,
        });

        assert.equal(result.ok, false);
        assert.deepEqual(
          result.violations.map(({ category, importer }) => ({
            category,
            importer,
          })),
          [{
            category: "source_owner_dependency_direction",
            importer: "src/providers/codex/log-ingestion.js",
          }],
        );
      },
    );
  });
}

test("unused exact baseline allowances are diagnostic and do not make a concurrent cleanup fail", async () => {
  await withFixtureTree(
    {
      "src/clean.js": "export const clean = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [
          {
            category: "src_application_independence",
            importer: "src/removed-debt.js",
            target: "apps/web/public/lib.js",
            rationale:
              "This exact compatibility edge predates the architecture ratchet.",
            removeWhen:
              "The compatibility implementation moves into a shared package.",
          },
        ],
        rootDirectory,
      });

      assert.equal(result.ok, true);
      assert.equal(result.unusedBaseline.length, 1);
      assert.match(
        formatArchitectureBoundaryReport(result),
        /currently unused/u,
      );
    },
  );
});

test("rejects malformed or undocumented baseline entries", async () => {
  await withFixtureTree(
    {
      "src/clean.js": "export const clean = true;",
    },
    async (rootDirectory) => {
      const result = await checkArchitectureBoundaries({
        baseline: [
          {
            category: "not_a_category",
            importer: "src/clean.js",
            rationale: "too short",
            target: "apps/web/public/lib.js",
          },
        ],
        rootDirectory,
      });

      assert.equal(result.ok, false);
      assert.equal(result.baselineIssues.length, 1);
      assert.match(
        formatArchitectureBoundaryReport(result),
        /\[baseline_configuration\]/u,
      );
    },
  );
});
