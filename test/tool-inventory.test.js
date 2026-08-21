import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkToolInventory,
  formatToolInventoryReport,
} from "../tools/operations/check-tool-inventory.mjs";
import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REQUIRED_ROOT_EXECUTABLES = [
  "src/build-monitoring-quality-report.js",
  "src/build-multi-surface-report.js",
  "src/build-rolling-quota-history.js",
  "src/build-simple-quota-gradient-report.js",
  "src/build-weekly-calibration-audit.js",
  "src/build-weekly-calibration-report.js",
  "src/fix-portable-report-width.js",
  "src/verify-weekly-calibration.js",
];
const CONTRIBUTION_ENTRYPOINT =
  "scripts/build-telemetry-contributions.js";

function record(path, overrides = {}) {
  return {
    additionalAliases: [],
    callers: ["package.json"],
    canonicalPath: path,
    classification: "historical_research_report",
    decision: "retain",
    legacyPaths: [],
    owner: "fixture",
    provenance: null,
    provenanceReason: "Fixture record has no provenance artifact.",
    stableAlias: null,
    stableAliasReason: "Fixture record is not exposed through npm.",
    ...overrides,
  };
}

function fixtureInventory(extraRecords = []) {
  return {
    records: [
      ...REQUIRED_ROOT_EXECUTABLES.map((path) => record(path)),
      record(CONTRIBUTION_ENTRYPOINT, {
        classification: "shipped_product_operation",
      }),
      ...extraRecords,
    ],
    reviewedAt: "2026-07-30",
    schemaVersion: "tool-inventory-v0.1",
    scope: "Focused checker fixture.",
  };
}

async function writeFixtureFile(rootDirectory, path, contents = "") {
  const absolutePath = join(rootDirectory, path);
  await mkdir(dirname(absolutePath), {
    recursive: true,
  });
  await writeFile(absolutePath, contents, "utf8");
}

async function withInventoryFixture({
  extraFiles = {},
  inventory = fixtureInventory(),
  packageScripts = {},
  symlinks = [],
} = {}, run) {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "usage-monitor-tool-inventory-"),
  );
  try {
    await Promise.all([
      ...REQUIRED_ROOT_EXECUTABLES.map(
        (path) => writeFixtureFile(rootDirectory, path, "export {};\n"),
      ),
      writeFixtureFile(
        rootDirectory,
        CONTRIBUTION_ENTRYPOINT,
        "export {};\n",
      ),
      writeFixtureFile(
        rootDirectory,
        "package.json",
        `${JSON.stringify({
          scripts: packageScripts,
          type: "module",
        }, null, 2)}\n`,
      ),
      writeFixtureFile(
        rootDirectory,
        "tools/tool-inventory.json",
        `${JSON.stringify(inventory, null, 2)}\n`,
      ),
      ...Object.entries(extraFiles).map(
        ([path, contents]) =>
          writeFixtureFile(rootDirectory, path, contents),
      ),
    ]);
    for (const [path, target] of symlinks) {
      const absolutePath = join(rootDirectory, path);
      await mkdir(dirname(absolutePath), {
        recursive: true,
      });
      await symlink(target, absolutePath);
    }
    return await run(rootDirectory);
  } finally {
    await rm(rootDirectory, {
      force: true,
      recursive: true,
    });
  }
}

function issueCodes(result) {
  return new Set(result.issues.map(({ code }) => code));
}

function runNode(entrypoint, cwd, arguments_ = []) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [entrypoint, ...arguments_],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (status, signal) => {
      resolveRun({
        signal,
        status,
        stderr,
        stdout,
      });
    });
  });
}

async function sourceFiles(rootDirectory) {
  const files = [];
  const extensions = new Set([".js", ".mjs", ".ts", ".mts"]);
  const excludedDirectories = new Set([
    ".git",
    ".release-build",
    ".release-deps",
    ".wrangler",
    "dist",
    "generated",
    "node_modules",
  ]);
  async function walk(directory) {
    const entries = await readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (excludedDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (
        entry.isFile()
        && extensions.has(extname(entry.name))
      ) {
        files.push(path);
      }
    }
  }
  await walk(rootDirectory);
  return files.sort();
}

async function staticToolCallers(inventory) {
  const ownerByPath = new Map();
  for (const record of inventory.records) {
    for (const path of [
      record.canonicalPath,
      ...record.legacyPaths,
    ]) {
      ownerByPath.set(path, record);
    }
  }

  const callers = [];
  for (const absoluteImporter of await sourceFiles(REPOSITORY_ROOT)) {
    const importer = relative(
      REPOSITORY_ROOT,
      absoluteImporter,
    ).replaceAll("\\", "/");
    const imports = await extractEsmImports(
      await readFile(absoluteImporter, "utf8"),
      {
        sourceName: importer,
      },
    );
    for (const { specifier } of imports) {
      if (typeof specifier !== "string" || !specifier.startsWith(".")) {
        continue;
      }
      let target = relative(
        REPOSITORY_ROOT,
        resolve(dirname(absoluteImporter), specifier),
      ).replaceAll("\\", "/");
      if (!extname(target)) {
        const extension = [".js", ".mjs", ".ts", ".mts"].find(
          (candidate) => ownerByPath.has(`${target}${candidate}`),
        );
        if (extension) target = `${target}${extension}`;
      }
      const record = ownerByPath.get(target);
      if (record) {
        callers.push({
          importer,
          record,
          target,
        });
      }
    }
  }
  return callers;
}

async function createDocsLinkFixture(rootDirectory, {
  includeShim,
}) {
  const canonicalSource = await readFile(
    join(REPOSITORY_ROOT, "tools/operations/fix-doc-links.mjs"),
    "utf8",
  );
  await writeFixtureFile(
    rootDirectory,
    "tools/operations/fix-doc-links.mjs",
    canonicalSource,
  );
  if (includeShim) {
    const shimSource = await readFile(
      join(REPOSITORY_ROOT, "scripts/fix-doc-links.mjs"),
      "utf8",
    );
    await writeFixtureFile(
      rootDirectory,
      "scripts/fix-doc-links.mjs",
      shimSource,
    );
  }
  await writeFixtureFile(
    rootDirectory,
    "docs/reference/2026-07-30-target.md",
    "# Target\n",
  );
  await writeFixtureFile(
    rootDirectory,
    "README.md",
    [
      "[Target](./2026-07-30-target.md)" + ")",
      "\"../2026-07-30-target.md\"",
      "",
    ].join("\n"),
  );
}

test("the checked-in inventory classifies every retained tool entry point and npm alias", async () => {
  const result = await checkToolInventory({
    rootDirectory: REPOSITORY_ROOT,
  });
  assert.equal(
    result.ok,
    true,
    formatToolInventoryReport(result),
  );
  assert.equal(result.records, 89);
  assert.equal(result.candidates.length, 91);
  assert.equal(result.aliases, 63);
});

test("the inventory names every static ESM caller of a classified tool", async () => {
  const inventory = JSON.parse(
    await readFile(
      join(REPOSITORY_ROOT, "tools/tool-inventory.json"),
      "utf8",
    ),
  );
  const callers = await staticToolCallers(inventory);
  assert.ok(callers.length >= 30);
  for (const {
    importer,
    record,
    target,
  } of callers) {
    assert.equal(
      record.callers.includes(importer),
      true,
      `${record.canonicalPath} omits static caller ${importer} through ${target}`,
    );
  }
});

test("the inventory checker fails closed for every required ownership condition", async () => {
  const scenarios = [
    {
      code: "unclassified_executable",
      options: {
        extraFiles: {
          "scripts/unclassified.js": "export {};\n",
        },
      },
    },
    {
      code: "missing_canonical_path",
      options: {
        inventory: fixtureInventory([
          record("scripts/missing.js"),
        ]),
      },
    },
    {
      code: "untracked_alias",
      options: {
        packageScripts: {
          "fixture:report":
            "node ./src/build-monitoring-quality-report.js",
        },
      },
    },
    {
      code: "untracked_alias",
      options: {
        inventory: {
          ...fixtureInventory(),
          records: fixtureInventory().records.map((value, index) =>
            index === 0
              ? {
                ...value,
                stableAlias: "fixture:fake",
                stableAliasReason: null,
              }
              : value),
        },
        packageScripts: {
          "fixture:fake":
            "echo src/build-monitoring-quality-report.js",
        },
      },
    },
    {
      code: "duplicate_canonical_path",
      options: {
        inventory: fixtureInventory([
          record(REQUIRED_ROOT_EXECUTABLES[0]),
        ]),
      },
    },
    {
      code: "stale_legacy_path",
      options: {
        inventory: {
          ...fixtureInventory(),
          records: fixtureInventory().records.map((value, index) =>
            index === 0
              ? {
                ...value,
                legacyPaths: ["scripts/removed-compatibility.js"],
              }
              : value),
        },
      },
    },
    {
      code: "canonical_product_to_tooling_inversion",
      options: {
        extraFiles: {
          "tools/product-operation.js": "export {};\n",
        },
        inventory: fixtureInventory([
          record("tools/product-operation.js", {
            classification: "shipped_product_operation",
          }),
        ]),
      },
    },
    {
      code: "unclassified_executable",
      options: {
        extraFiles: {
          "outside-tool.js": "export {};\n",
        },
        symlinks: [
          ["tools/linked-tool", "../outside-tool.js"],
        ],
      },
    },
  ];

  for (const { code, options } of scenarios) {
    await withInventoryFixture(options, async (rootDirectory) => {
      const result = await checkToolInventory({
        rootDirectory,
      });
      assert.equal(result.ok, false, code);
      assert.equal(
        issueCodes(result).has(code),
        true,
        formatToolInventoryReport(result),
      );
    });
  }
});

test("docs-link aliases target the canonical tool and the legacy shim is behavior-identical", async () => {
  const packageManifest = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  assert.equal(
    packageManifest.scripts["docs:links:fix"],
    "node ./tools/operations/fix-doc-links.mjs",
  );
  assert.equal(
    packageManifest.scripts["docs:links:check"],
    "node ./tools/operations/fix-doc-links.mjs --check",
  );

  const canonicalRoot = await mkdtemp(
    join(tmpdir(), "usage-monitor-doc-links-canonical-"),
  );
  const legacyRoot = await mkdtemp(
    join(tmpdir(), "usage-monitor-doc-links-legacy-"),
  );
  try {
    await createDocsLinkFixture(canonicalRoot, {
      includeShim: false,
    });
    await createDocsLinkFixture(legacyRoot, {
      includeShim: true,
    });

    const canonicalCheck = await runNode(
      "tools/operations/fix-doc-links.mjs",
      canonicalRoot,
      ["--check"],
    );
    const legacyCheck = await runNode(
      "scripts/fix-doc-links.mjs",
      legacyRoot,
      ["--check"],
    );
    assert.deepEqual(legacyCheck, canonicalCheck);
    assert.equal(canonicalCheck.status, 1);
    assert.equal(canonicalCheck.stdout, "");
    assert.equal(
      canonicalCheck.stderr,
      "Documentation links need repair in 1 files.\n",
    );

    const canonicalMutation = await runNode(
      "tools/operations/fix-doc-links.mjs",
      canonicalRoot,
    );
    const legacyMutation = await runNode(
      "scripts/fix-doc-links.mjs",
      legacyRoot,
    );
    assert.deepEqual(legacyMutation, canonicalMutation);
    assert.equal(canonicalMutation.status, 0);
    assert.equal(canonicalMutation.stderr, "");
    assert.equal(canonicalMutation.stdout, "Fixed links in 1 files.\n");
    assert.equal(
      await readFile(join(legacyRoot, "README.md"), "utf8"),
      await readFile(join(canonicalRoot, "README.md"), "utf8"),
    );

    const canonicalCleanCheck = await runNode(
      "tools/operations/fix-doc-links.mjs",
      canonicalRoot,
      ["--check"],
    );
    const legacyCleanCheck = await runNode(
      "scripts/fix-doc-links.mjs",
      legacyRoot,
      ["--check"],
    );
    assert.deepEqual(legacyCleanCheck, canonicalCleanCheck);
    assert.deepEqual(canonicalCleanCheck, {
      signal: null,
      status: 0,
      stderr: "",
      stdout: "Documentation links are normalized.\n",
    });
  } finally {
    await Promise.all([
      rm(canonicalRoot, {
        force: true,
        recursive: true,
      }),
      rm(legacyRoot, {
        force: true,
        recursive: true,
      }),
    ]);
  }
});

test("docs-link maintenance refuses symlinks without mutating their targets", async () => {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "usage-monitor-doc-links-symlink-root-"),
  );
  const outsideRoot = await mkdtemp(
    join(tmpdir(), "usage-monitor-doc-links-symlink-target-"),
  );
  try {
    await createDocsLinkFixture(repositoryRoot, {
      includeShim: false,
    });
    const outsideFile = join(
      outsideRoot,
      "2026-07-30-outside.md",
    );
    const outsideContents =
      "[Target](./2026-07-30-target.md)\n";
    await writeFile(outsideFile, outsideContents, "utf8");
    await symlink(
      outsideFile,
      join(repositoryRoot, "docs", "2026-07-30-linked.md"),
    );

    const result = await runNode(
      "tools/operations/fix-doc-links.mjs",
      repositoryRoot,
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /refuses symbolic link: docs\/2026-07-30-linked\.md/u,
    );
    assert.equal(await readFile(outsideFile, "utf8"), outsideContents);
  } finally {
    await Promise.all([
      rm(repositoryRoot, {
        force: true,
        recursive: true,
      }),
      rm(outsideRoot, {
        force: true,
        recursive: true,
      }),
    ]);
  }
});
