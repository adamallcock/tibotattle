#!/usr/bin/env node
import { materializeTelemetryContributions } from "../src/telemetry-contribution-builder.js";

function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--bundle", "--receipt", "--output"].includes(key)) {
      throw new Error("Usage: build-telemetry-contributions --bundle FILE --receipt FILE --output DIRECTORY");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  if (!result.bundle || !result.receipt || !result.output) {
    throw new Error("Usage: build-telemetry-contributions --bundle FILE --receipt FILE --output DIRECTORY");
  }
  return result;
}

try {
  const options = argumentsFrom(process.argv.slice(2));
  const receipt = await materializeTelemetryContributions({
    bundleFile: options.bundle,
    receiptFile: options.receipt,
    outputDirectory: options.output,
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    sourcePrivacyVerdict: receipt.sourcePrivacyVerdict,
    sourceTransportReady: receipt.sourceTransportReady,
    batchCount: receipt.batchCount,
    files: receipt.files.map(({ basename, bytes, counts }) => ({ basename, bytes, counts })),
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.code ?? "telemetry_contribution_build_failed"}\n`);
  process.exitCode = 1;
}
