#!/usr/bin/env node

import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_SOURCE_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cjs",
  ".cts",
  ".js",
  ".mjs",
  ".mts",
  ".pl",
  ".py",
  ".rb",
  ".sh",
  ".ts",
  ".zsh",
]);
const ALLOWED_CLASSIFICATIONS = new Set([
  "build_release_operation",
  "historical_research_report",
  "obsolete",
  "reusable_benchmark",
  "shipped_product_operation",
]);
const REQUIRED_ROOT_EXECUTABLES = Object.freeze([
  "src/build-monitoring-quality-report.js",
  "src/build-multi-surface-report.js",
  "src/build-rolling-quota-history.js",
  "src/build-simple-quota-gradient-report.js",
  "src/build-weekly-calibration-audit.js",
  "src/build-weekly-calibration-report.js",
  "src/fix-portable-report-width.js",
  "src/verify-weekly-calibration.js",
]);
const REQUIRED_PRODUCT_CONTRIBUTION_ENTRYPOINT =
  "scripts/build-telemetry-contributions.js";
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..", "..");
const DEFAULT_INVENTORY_PATH = "tools/tool-inventory.json";

function repositoryPath(rootDirectory, absolutePath) {
  return relative(rootDirectory, absolutePath).split(sep).join("/");
}

function validRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value === value.replaceAll("\\", "/")
    && !value.startsWith("/")
    && !value.split("/").includes("..");
}

async function pathKind(absolutePath) {
  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function walkToolSources(rootDirectory, relativeDirectory, paths) {
  const absoluteDirectory = join(rootDirectory, relativeDirectory);
  if (await pathKind(absoluteDirectory) === "missing") return;
  const entries = await readdir(absoluteDirectory, {
    withFileTypes: true,
  });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = join(absoluteDirectory, entry.name);
    const path = repositoryPath(rootDirectory, absolutePath);
    if (entry.isSymbolicLink()) {
      // A symlink may resolve outside the repository or change classification
      // after review. Include it as an unowned candidate so the inventory fails
      // closed; canonical and compatibility paths must be regular files.
      paths.push(path);
    } else if (entry.isDirectory()) {
      await walkToolSources(rootDirectory, path, paths);
    } else if (entry.isFile()) {
      const stat = await lstat(absolutePath);
      if (
        TOOL_SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())
        || (stat.mode & 0o111) !== 0
      ) {
        paths.push(path);
      }
    }
  }
}

async function discoverInventoryCandidates(rootDirectory) {
  const paths = [];
  await walkToolSources(rootDirectory, "scripts", paths);
  await walkToolSources(rootDirectory, "tools", paths);

  const sourceDirectory = join(rootDirectory, "src");
  if (await pathKind(sourceDirectory) !== "missing") {
    const entries = await readdir(sourceDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (
        entry.isFile()
        && (
          /^build-.*\.js$/u.test(entry.name)
          || entry.name === "fix-portable-report-width.js"
          || entry.name === "verify-weekly-calibration.js"
        )
      ) {
        paths.push(`src/${entry.name}`);
      }
    }
  }

  return [...new Set(paths)].sort();
}

function issue(code, path, detail) {
  return {
    code,
    detail,
    path,
  };
}

function recordAliases(record) {
  return [
    ...(typeof record.stableAlias === "string"
      ? [record.stableAlias]
      : []),
    ...(Array.isArray(record.additionalAliases)
      ? record.additionalAliases
      : []),
  ];
}

function regexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function commandInvokesNodeEntrypoint(command, path) {
  if (typeof command !== "string" || !validRelativePath(path)) return false;
  const entrypoint = regexLiteral(path);
  return new RegExp(
    `(?:^|(?:&&|\\|\\||;)\\s*)node\\s+(?:\\./)?${entrypoint}(?=\\s|$)`,
    "u",
  ).test(command);
}

function callerPath(caller) {
  if (typeof caller !== "string" || caller.length === 0) return null;
  const [path] = caller.split("#", 1);
  return validRelativePath(path) ? path : null;
}

async function documentedLegacyReferences(rootDirectory, legacyPath) {
  const files = [];
  if (await pathKind(join(rootDirectory, "README.md")) === "file") {
    files.push("README.md");
  }

  async function walkDocs(relativeDirectory) {
    const absoluteDirectory = join(rootDirectory, relativeDirectory);
    if (await pathKind(absoluteDirectory) === "missing") return;
    const entries = await readdir(absoluteDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const path = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        await walkDocs(path);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path);
      }
    }
  }
  await walkDocs("docs");

  const references = [];
  for (const path of files) {
    const content = await readFile(join(rootDirectory, path), "utf8");
    if (content.includes(legacyPath)) references.push(path);
  }
  return references.sort();
}

export async function checkToolInventory({
  inventoryPath = DEFAULT_INVENTORY_PATH,
  rootDirectory = DEFAULT_REPOSITORY_ROOT,
} = {}) {
  const absoluteRoot = resolve(rootDirectory);
  const issues = [];
  let inventory;
  try {
    inventory = JSON.parse(
      await readFile(join(absoluteRoot, inventoryPath), "utf8"),
    );
  } catch (error) {
    return {
      aliases: 0,
      candidates: [],
      inventoryPath,
      issues: [
        issue(
          "inventory_unreadable",
          inventoryPath,
          error instanceof SyntaxError
            ? "Inventory is not valid JSON."
            : "Inventory file is missing or unreadable.",
        ),
      ],
      ok: false,
      records: 0,
    };
  }

  if (
    inventory?.schemaVersion !== "tool-inventory-v0.1"
    || !Array.isArray(inventory.records)
  ) {
    return {
      aliases: 0,
      candidates: [],
      inventoryPath,
      issues: [
        issue(
          "inventory_schema",
          inventoryPath,
          "Expected tool-inventory-v0.1 with a records array.",
        ),
      ],
      ok: false,
      records: 0,
    };
  }

  const packagePath = join(absoluteRoot, "package.json");
  let packageScripts = {};
  try {
    packageScripts = JSON.parse(await readFile(packagePath, "utf8")).scripts ?? {};
  } catch {
    issues.push(
      issue(
        "package_manifest_unreadable",
        "package.json",
        "Root npm aliases cannot be verified.",
      ),
    );
  }

  const candidates = await discoverInventoryCandidates(absoluteRoot);
  const canonicalOwners = new Map();
  const physicalOwners = new Map();
  let trackedAliasCount = 0;

  for (const [index, record] of inventory.records.entries()) {
    const recordPath = `records[${index}]`;
    if (!ALLOWED_CLASSIFICATIONS.has(record?.classification)) {
      issues.push(
        issue(
          "unclassified_executable",
          record?.canonicalPath ?? recordPath,
          "Classification is missing or not in the reviewed Phase 5 vocabulary.",
        ),
      );
    }
    if (typeof record?.owner !== "string" || record.owner.length === 0) {
      issues.push(
        issue(
          "missing_owner",
          record?.canonicalPath ?? recordPath,
          "Every tool record requires an explicit owner.",
        ),
      );
    }
    if (!validRelativePath(record?.canonicalPath)) {
      issues.push(
        issue(
          "invalid_canonical_path",
          recordPath,
          "Canonical paths must be normalized repository-relative paths.",
        ),
      );
      continue;
    }

    const canonicalPath = record.canonicalPath;
    const priorCanonicalOwner = canonicalOwners.get(canonicalPath);
    if (priorCanonicalOwner !== undefined) {
      issues.push(
        issue(
          "duplicate_canonical_path",
          canonicalPath,
          `Also declared by records[${priorCanonicalOwner}].`,
        ),
      );
    } else {
      canonicalOwners.set(canonicalPath, index);
    }
    const canonicalKind = await pathKind(join(absoluteRoot, canonicalPath));
    if (canonicalKind !== "file") {
      issues.push(
        issue(
          "missing_canonical_path",
          canonicalPath,
          `Expected a regular file; found ${canonicalKind}.`,
        ),
      );
    }

    if (
      record.classification === "shipped_product_operation"
      && canonicalPath.startsWith("tools/")
    ) {
      issues.push(
        issue(
          "canonical_product_to_tooling_inversion",
          canonicalPath,
          "Shipped product operations cannot have a tools/** canonical implementation.",
        ),
      );
    }

    const stableAliasIsNull = record.stableAlias === null;
    if (
      !stableAliasIsNull
      && (
        typeof record.stableAlias !== "string"
        || record.stableAlias.length === 0
      )
    ) {
      issues.push(
        issue(
          "invalid_stable_alias",
          canonicalPath,
          "stableAlias must be a non-empty npm alias or null.",
        ),
      );
    }
    if (
      stableAliasIsNull
      && (
        typeof record.stableAliasReason !== "string"
        || record.stableAliasReason.length === 0
      )
    ) {
      issues.push(
        issue(
          "missing_stable_alias_reason",
          canonicalPath,
          "A null stableAlias requires an explicit reason.",
        ),
      );
    }
    if (
      !Array.isArray(record.additionalAliases)
      || record.additionalAliases.some(
        (alias) => typeof alias !== "string" || alias.length === 0,
      )
    ) {
      issues.push(
        issue(
          "invalid_additional_aliases",
          canonicalPath,
          "additionalAliases must be an array of non-empty npm aliases.",
        ),
      );
    }

    const aliases = recordAliases(record);
    trackedAliasCount += aliases.length;
    if (new Set(aliases).size !== aliases.length) {
      issues.push(
        issue(
          "duplicate_record_alias",
          canonicalPath,
          "A record cannot declare the same npm alias more than once.",
        ),
      );
    }
    for (const alias of aliases) {
      const command = packageScripts[alias];
      if (typeof command !== "string") {
        issues.push(
          issue(
            "untracked_alias",
            `package.json#scripts.${alias}`,
            `Alias declared for ${canonicalPath} does not exist.`,
          ),
        );
      } else if (!commandInvokesNodeEntrypoint(command, canonicalPath)) {
        issues.push(
          issue(
            "untracked_alias",
            `package.json#scripts.${alias}`,
            `Alias does not invoke canonical Node entry point ${canonicalPath}.`,
          ),
        );
      }
    }

    if (!Array.isArray(record.callers)) {
      issues.push(
        issue(
          "invalid_callers",
          canonicalPath,
          "callers must be an array of repository paths.",
        ),
      );
    } else {
      for (const caller of record.callers) {
        const path = callerPath(caller);
        if (
          path === null
          || await pathKind(join(absoluteRoot, path)) === "missing"
        ) {
          issues.push(
            issue(
              "stale_caller",
              canonicalPath,
              "A declared caller path is invalid or missing.",
            ),
          );
        }
      }
    }

    if (typeof record.decision !== "string" || record.decision.length === 0) {
      issues.push(
        issue(
          "missing_decision",
          canonicalPath,
          "Every tool record requires a retention or removal decision.",
        ),
      );
    }

    if (record.provenance === null) {
      if (
        typeof record.provenanceReason !== "string"
        || record.provenanceReason.length === 0
      ) {
        issues.push(
          issue(
            "missing_provenance_reason",
            canonicalPath,
            "Null provenance requires an explicit reason.",
          ),
        );
      }
    } else if (
      !validRelativePath(record.provenance)
      || await pathKind(join(absoluteRoot, record.provenance)) !== "file"
    ) {
      issues.push(
        issue(
          "missing_provenance",
          canonicalPath,
          "The declared provenance artifact is invalid or missing.",
        ),
      );
    }

    if (
      !Array.isArray(record.legacyPaths)
      || record.legacyPaths.some((path) => !validRelativePath(path))
    ) {
      issues.push(
        issue(
          "invalid_legacy_paths",
          canonicalPath,
          "legacyPaths must contain normalized repository-relative paths.",
        ),
      );
    }

    const physicalPaths = [
      canonicalPath,
      ...(Array.isArray(record.legacyPaths) ? record.legacyPaths : []),
    ];
    for (const path of physicalPaths) {
      const priorPhysicalOwner = physicalOwners.get(path);
      if (priorPhysicalOwner !== undefined) {
        issues.push(
          issue(
            "duplicate_physical_path",
            path,
            `Also classified by records[${priorPhysicalOwner}].`,
          ),
        );
      } else {
        physicalOwners.set(path, index);
      }
    }

    for (const legacyPath of Array.isArray(record.legacyPaths)
      ? record.legacyPaths
      : []) {
      const legacyKind = await pathKind(join(absoluteRoot, legacyPath));
      if (legacyKind !== "file") {
        issues.push(
          issue(
            "stale_legacy_path",
            legacyPath,
            `Expected a retained compatibility file; found ${legacyKind}.`,
          ),
        );
      }
      for (const [alias, command] of Object.entries(packageScripts)) {
        if (
          typeof command === "string"
          && commandInvokesNodeEntrypoint(command, legacyPath)
        ) {
          issues.push(
            issue(
              "legacy_alias_target",
              `package.json#scripts.${alias}`,
              `Stable npm aliases must target ${canonicalPath}, not ${legacyPath}.`,
            ),
          );
        }
      }
      for (const path of await documentedLegacyReferences(
        absoluteRoot,
        legacyPath,
      )) {
        issues.push(
          issue(
            "stale_documented_legacy_path",
            path,
            `Documentation must use ${canonicalPath}, not ${legacyPath}.`,
          ),
        );
      }
    }
  }

  for (const path of candidates) {
    if (!physicalOwners.has(path)) {
      issues.push(
        issue(
          "unclassified_executable",
          path,
          "Executable tooling source is not present in the inventory.",
        ),
      );
    }
  }

  for (const path of REQUIRED_ROOT_EXECUTABLES) {
    if (!physicalOwners.has(path)) {
      issues.push(
        issue(
          "unclassified_required_root_entrypoint",
          path,
          "Required root report/verification entry point is not classified.",
        ),
      );
    }
  }
  const contributionOwner = physicalOwners.get(
    REQUIRED_PRODUCT_CONTRIBUTION_ENTRYPOINT,
  );
  if (contributionOwner === undefined) {
    issues.push(
      issue(
        "unclassified_product_contribution_entrypoint",
        REQUIRED_PRODUCT_CONTRIBUTION_ENTRYPOINT,
        "The product contribution preparation entry point must be classified.",
      ),
    );
  } else if (
    inventory.records[contributionOwner]?.classification
    !== "shipped_product_operation"
  ) {
    issues.push(
      issue(
        "misclassified_product_contribution_entrypoint",
        REQUIRED_PRODUCT_CONTRIBUTION_ENTRYPOINT,
        "Contribution preparation is shipped product behavior.",
      ),
    );
  }

  for (const [alias, command] of Object.entries(packageScripts)) {
    if (typeof command !== "string") continue;
    for (const path of candidates) {
      if (!commandInvokesNodeEntrypoint(command, path)) continue;
      const recordIndex = physicalOwners.get(path);
      if (recordIndex === undefined) continue;
      const record = inventory.records[recordIndex];
      if (!recordAliases(record).includes(alias)) {
        issues.push(
          issue(
            "untracked_alias",
            `package.json#scripts.${alias}`,
            `Alias invokes ${path} but its inventory record does not declare it.`,
          ),
        );
      }
    }
  }

  issues.sort(
    (left, right) =>
      left.code.localeCompare(right.code)
      || left.path.localeCompare(right.path)
      || left.detail.localeCompare(right.detail),
  );
  return {
    aliases: trackedAliasCount,
    candidates,
    inventoryPath,
    issues,
    ok: issues.length === 0,
    records: inventory.records.length,
  };
}

export function formatToolInventoryReport(result) {
  if (result.ok) {
    return [
      "Tool inventory is complete.",
      `Records: ${result.records}`,
      `Executable paths: ${result.candidates.length}`,
      `Tracked npm aliases: ${result.aliases}`,
    ].join("\n");
  }
  return [
    `Tool inventory check failed with ${result.issues.length} issue(s).`,
    ...result.issues.map(
      ({ code, detail, path }) => `- [${code}] ${path}: ${detail}`,
    ),
  ].join("\n");
}

async function runCli() {
  const result = await checkToolInventory();
  const output = formatToolInventoryReport(result);
  if (result.ok) {
    process.stdout.write(`${output}\n`);
  } else {
    process.stderr.write(`${output}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_FILE) {
  await runCli();
}
