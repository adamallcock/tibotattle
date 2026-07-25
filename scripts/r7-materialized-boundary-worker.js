#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runR7MaterializedBoundaryHarness } from "../src/r7-materialized-boundary-harness.js";
import { stableJson } from "../src/storage.js";

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2
      || typeof value.temporaryRoot !== "string"
      || value.temporaryRoot.length === 0
      || !value.fixturePaths || typeof value.fixturePaths !== "object") {
    throw new TypeError("Invalid R7 materialized boundary worker configuration");
  }
  return value;
}

export async function runR7MaterializedBoundaryWorker(config) {
  try {
    return {
      status: "completed",
      failureCode: "none",
      evidence: await runR7MaterializedBoundaryHarness({
        temporaryRoot: config.temporaryRoot,
        fixturePaths: config.fixturePaths,
      }),
    };
  } catch {
    return { status: "failed", failureCode: "harness_failed", evidence: null };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(stableJson(await runR7MaterializedBoundaryWorker(await readInput())));
}
