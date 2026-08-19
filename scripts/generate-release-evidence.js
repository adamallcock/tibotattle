#!/usr/bin/env node

/**
 * Offline release-evidence CLI.
 *
 * Generate:
 *   node scripts/generate-release-evidence.js \
 *     --input staging/release-evidence.json \
 *     --output staging/release-manifest.json \
 *     [--sha256sums staging/SHA256SUMS]
 *
 * Validate an already generated manifest and, optionally, its local files:
 *   node scripts/generate-release-evidence.js --validate \
 *     --manifest staging/release-manifest.json \
 *     --artifacts-dir staging \
 *     [--sha256sums staging/SHA256SUMS]
 *
 * The CLI never signs, publishes, submits to a store, or performs network
 * requests.  It only reads supplied local bytes and writes local evidence.
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSha256Sums,
  generateReleaseEvidence,
  RELEASE_EVIDENCE_MANIFEST_FILE_NAME,
  ReleaseEvidenceError,
  stableStringify,
  validateReleaseEvidenceManifest,
  writeReleaseEvidenceFiles,
} from "./release-evidence.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function usage() {
  return [
    "Generate: node scripts/generate-release-evidence.js",
    "  --input <descriptor.json> --output <release-manifest.json>",
    "  [--base-dir <directory>] [--sha256sums <SHA256SUMS>] [--replace]",
    "Validate: node scripts/generate-release-evidence.js --validate",
    "  --manifest <release-manifest.json> [--artifacts-dir <directory>]",
    "  [--sha256sums <SHA256SUMS>]",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    validate: false,
    input: null,
    output: null,
    manifest: null,
    baseDir: null,
    artifactsDir: null,
    sums: null,
    replace: false,
  };
  const values = new Set([
    "--input",
    "--output",
    "--manifest",
    "--base-dir",
    "--artifacts-dir",
    "--sha256sums",
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--validate") {
      if (options.validate) throw new Error("--validate was repeated");
      options.validate = true;
      continue;
    }
    if (argument === "--replace") {
      if (options.replace) throw new Error("--replace was repeated");
      options.replace = true;
      continue;
    }
    if (!values.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`Argument was repeated: ${argument}`);
    seen.add(argument);
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    options[{
      "--input": "input",
      "--output": "output",
      "--manifest": "manifest",
      "--base-dir": "baseDir",
      "--artifacts-dir": "artifactsDir",
      "--sha256sums": "sums",
    }[argument]] = argv[++index];
  }
  if (options.validate) {
    if (!options.manifest || options.input || options.output || options.baseDir) {
      throw new Error("Validation requires --manifest only (plus optional file roots)");
    }
  } else if (!options.input || !options.output || options.manifest || options.artifactsDir) {
    throw new Error("Generation requires --input and --output");
  }
  return options;
}

async function readManifest(path) {
  let text;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch (error) {
    throw new ReleaseEvidenceError(
      "RELEASE_EVIDENCE_MANIFEST_UNAVAILABLE",
      `Could not read manifest: ${error.message}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseEvidenceError(
      "RELEASE_EVIDENCE_MANIFEST_INVALID",
      "Manifest is not valid JSON",
    );
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.validate) {
    const manifestPath = resolve(options.manifest);
    if (basename(manifestPath) !== RELEASE_EVIDENCE_MANIFEST_FILE_NAME) {
      throw new ReleaseEvidenceError(
        "RELEASE_EVIDENCE_MANIFEST_FILE_NAME_INVALID",
        `Manifest path must end in ${RELEASE_EVIDENCE_MANIFEST_FILE_NAME}`,
      );
    }
    const manifest = await readManifest(manifestPath);
    await validateReleaseEvidenceManifest(manifest, {
      artifactRoot: options.artifactsDir === null
        ? null
        : resolve(options.artifactsDir),
      manifestPath,
    });
    if (options.sums !== null) {
      const expected = buildSha256Sums(manifest);
      const actual = await readFile(resolve(options.sums), "utf8");
      if (actual !== expected) {
        throw new ReleaseEvidenceError(
          "RELEASE_EVIDENCE_SUMS_MISMATCH",
          "SHA256SUMS does not match the canonical manifest",
        );
      }
    }
    console.log("RELEASE_EVIDENCE_VALID");
    return manifest;
  }

  const inputPath = resolve(options.input);
  const inputText = await readFile(inputPath, "utf8");
  let descriptor;
  try {
    descriptor = JSON.parse(inputText);
  } catch {
    throw new ReleaseEvidenceError(
      "RELEASE_EVIDENCE_INPUT_INVALID",
      "Release descriptor is not valid JSON",
    );
  }
  const manifest = await generateReleaseEvidence({
    descriptor,
    baseDir: options.baseDir === null ? dirname(inputPath) : resolve(options.baseDir),
  });
  const sumsPath = options.sums === null
    ? join(dirname(resolve(options.output)), "SHA256SUMS")
    : resolve(options.sums);
  await writeReleaseEvidenceFiles({
    manifest,
    manifestPath: options.output,
    sumsPath,
    replace: options.replace,
  });
  console.log("RELEASE_EVIDENCE_GENERATED");
  console.log(`Manifest: ${resolve(options.output)}`);
  console.log(`SHA256SUMS: ${sumsPath}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    console.error(`${error?.code ?? "RELEASE_EVIDENCE_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  main,
  parseArguments,
  stableStringify,
  usage,
};
