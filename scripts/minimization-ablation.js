#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateMinimizationAblation } from "../src/minimization-ablation.js";
import { writeJsonOwnerOnlyAtomic } from "../src/storage.js";

function usage() {
  return "Usage: node scripts/minimization-ablation.js --input <sanitized-transition.json> --output <local-receipt.json> [--prospective-after <ISO>] [--as-of <ISO>] [--fixture <sanitized-fixture> ...]";
}

function parseArgs(argv) {
  const result = { fixtures: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fixture") result.fixtures.push(argv[++index]);
    else if (value === "--input") result.input = argv[++index];
    else if (value === "--output") result.output = argv[++index];
    else if (value === "--prospective-after") result.prospectiveAfter = argv[++index];
    else if (value === "--as-of") result.asOf = argv[++index];
    else throw new TypeError(usage());
  }
  if (!result.input || !result.output) throw new TypeError(usage());
  return result;
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function runMinimizationAblation(argv) {
  const args = parseArgs(argv);
  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output);
  const inputContent = await readFile(inputPath, "utf8");
  const fixtureHashes = {};
  for (let index = 0; index < args.fixtures.length; index += 1) {
    const fixtureContent = await readFile(resolve(args.fixtures[index]), "utf8");
    fixtureHashes[`fixture_${index + 1}`] = digest(fixtureContent);
  }
  const receipt = evaluateMinimizationAblation(JSON.parse(inputContent), {
    prospectiveAfter: args.prospectiveAfter,
    asOf: args.asOf,
    fixtureHashes,
    inputSha256: digest(inputContent),
  });
  await writeJsonOwnerOnlyAtomic(outputPath, receipt);
  process.stdout.write(`${JSON.stringify({
    outputWritten: true,
    status: receipt.decision.status,
    prospectiveQualifyingResetCount: receipt.evidence.prospectiveQualifyingResetCount,
    blockerCount: receipt.evidence.blockers.length,
    receiptSha256: receipt.receiptSha256,
  })}\n`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runMinimizationAblation(process.argv.slice(2));
}
