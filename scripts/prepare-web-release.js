#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPublicReleaseSite,
  parseArgs as parseReleaseSiteArgs,
} from "./build-public-release-site.js";
import {
  inspectWebReleaseScope,
  WEB_RELEASE_OUTPUT_DIRECTORY,
  writeWebReleaseReceipt,
} from "./web-release-lane.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-web-release.js --base <deployed-source-commit> \\",
    "    [--receipt /absolute/receipt.json] [--replace-receipt] -- \\",
    "    --output /absolute/repository/.release-build/public-release-site --replace \\",
    "    <product:release-site arguments>",
  ].join("\n");
}

export function parsePrepareWebReleaseArgs(argv) {
  const boundary = argv.indexOf("--");
  if (boundary < 0) {
    throw new TypeError(`Separate web-release and site-build arguments with --\n${usage()}`);
  }
  const control = argv.slice(0, boundary);
  const build = argv.slice(boundary + 1);
  const parsed = { receipt: null, replaceReceipt: false, baseCommit: null, build };
  for (let index = 0; index < control.length; index += 1) {
    const arg = control[index];
    if (arg === "--replace-receipt") {
      parsed.replaceReceipt = true;
      continue;
    }
    if (arg !== "--base" && arg !== "--receipt") {
      throw new TypeError(`Unknown web-release argument: ${arg}\n${usage()}`);
    }
    const value = control[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError(`Missing value for ${arg}\n${usage()}`);
    }
    index += 1;
    if (arg === "--base") parsed.baseCommit = value;
    else parsed.receipt = value;
  }
  if (!parsed.baseCommit || build.length === 0) {
    throw new TypeError(`A base commit and site-build arguments are required\n${usage()}`);
  }
  if (build.includes("--source") || build.includes("--source-commit")) {
    throw new TypeError(
      "Web-only release preparation selects the checked-out public source and source commit itself.",
    );
  }
  return parsed;
}

function assertPreparedBuildArguments(repositoryRoot, rawArgs) {
  const expectedOutput = resolve(repositoryRoot, WEB_RELEASE_OUTPUT_DIRECTORY);
  if (resolve(rawArgs.output ?? "") !== expectedOutput) {
    throw new TypeError(
      "Web-only release output must be .release-build/public-release-site in the candidate checkout.",
    );
  }
  if (!rawArgs.replace) {
    throw new TypeError(
      "Web-only release preparation requires --replace for its exact generated output directory.",
    );
  }
  const expectedSource = resolve(repositoryRoot, "apps", "web", "public");
  if (resolve(rawArgs.source) !== expectedSource) {
    throw new TypeError("Web-only release preparation must use apps/web/public.");
  }
}

/**
 * Build an auditable static-site bundle from a clean, committed candidate.
 * This intentionally does not create commits, push anything, or deploy.
 */
export async function prepareWebRelease({
  repositoryRoot = REPOSITORY_ROOT,
  baseCommit,
  rawBuildArgs,
  receiptPath = null,
  replaceReceipt = false,
  build = buildPublicReleaseSite,
  git,
}) {
  const repository = resolve(repositoryRoot);
  const scope = inspectWebReleaseScope({
    repositoryRoot: repository,
    baseCommit,
    git,
  });
  assertPreparedBuildArguments(repository, rawBuildArgs);
  const result = await build(rawBuildArgs);
  const receipt = await writeWebReleaseReceipt({
    repositoryRoot: repository,
    scope,
    ...(receiptPath ? { receiptPath: resolve(receiptPath) } : {}),
    replace: replaceReceipt,
  });
  return Object.freeze({ ...result, scope, receipt });
}

async function main() {
  try {
    const parsed = parsePrepareWebReleaseArgs(process.argv.slice(2));
    const rawBuildArgs = parseReleaseSiteArgs(parsed.build);
    const result = await prepareWebRelease({
      baseCommit: parsed.baseCommit,
      rawBuildArgs,
      ...(parsed.receipt ? { receiptPath: resolve(parsed.receipt) } : {}),
      replaceReceipt: parsed.replaceReceipt,
    });
    process.stdout.write(`${JSON.stringify({
      output: result.output,
      receipt: result.receipt.path,
      sourceCommit: result.scope.sourceCommit,
      baseCommit: result.scope.baseCommit,
      files: result.fileCount,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
