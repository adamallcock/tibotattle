import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  MAX_PREPARED_CONTRIBUTION_BATCHES,
  PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA,
  PREPARED_CONTRIBUTION_SET_MANIFEST,
  PREPARED_CONTRIBUTION_SET_VERSION,
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
  buildTelemetryContributionsFromBundle,
  preparedContributionRecordCounts,
} from "./contribution/index.js";
import { stableJson } from "./export/index.js";
import {
  loadVerifiedLocalMetadataBundleFiles,
} from "./bundle-verifier.js";
import {
  preparedContributionContext,
} from "./prepared-contribution-compatibility-internal.js";

export {
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
  TELEMETRY_CONTRIBUTION_VERSION,
  buildTelemetryContributionsFromBundle,
} from "./contribution/index.js";

function fixedError(code) {
  const error = new Error(`Telemetry contribution build failed (${code})`);
  error.code = code;
  return error;
}

function capturePreparedContributionContext(context) {
  if (context === null
      || typeof context !== "object"
      || Array.isArray(context)) {
    throw fixedError("prepared_context_invalid");
  }
  const captured = {};
  for (const name of [
    "publishPreparedContributionFile",
    "publishPreparedContributionManifest",
    "verifyPreparedContributionFiles",
    "verifyPreparedContributionSet",
  ]) {
    let value;
    try {
      value = context[name];
    } catch {
      throw fixedError("prepared_context_invalid");
    }
    if (typeof value !== "function") {
      throw fixedError("prepared_context_invalid");
    }
    captured[name] = value;
  }
  if (context.ensureDirectory !== undefined
      && typeof context.ensureDirectory !== "function") {
    throw fixedError("prepared_context_invalid");
  }
  return Object.freeze({
    ...captured,
    ensureDirectory: context.ensureDirectory ?? null,
  });
}

export async function materializeTelemetryContributions({
  bundleFile,
  receiptFile,
  outputDirectory,
  failpoint = async () => {},
  signal = null,
  preparedContributionContext: configuredPreparedContributionContext =
    preparedContributionContext,
  isPreparedContributionContext = null,
  loadVerifiedSource = loadVerifiedLocalMetadataBundleFiles,
} = {}) {
  if (!outputDirectory) throw fixedError("output_required");
  if (typeof failpoint !== "function") throw fixedError("failpoint_invalid");
  if (signal !== null
      && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) {
    throw fixedError("signal_invalid");
  }
  signal?.throwIfAborted?.();
  const selectedContext = capturePreparedContributionContext(
    configuredPreparedContributionContext,
  );
  if (isPreparedContributionContext !== null
      && typeof isPreparedContributionContext !== "function") {
    throw fixedError("prepared_context_invalid");
  }
  let preparedContextValid = true;
  if (isPreparedContributionContext !== null) {
    try {
      preparedContextValid = isPreparedContributionContext(
        configuredPreparedContributionContext,
      ) === true;
    } catch {
      preparedContextValid = false;
    }
  }
  if (!preparedContextValid) {
    throw fixedError("prepared_context_invalid");
  }
  if (typeof loadVerifiedSource !== "function") {
    throw fixedError("source_verifier_invalid");
  }
  const verified = await loadVerifiedSource({
    bundleFile,
    receiptFile,
  });
  signal?.throwIfAborted?.();
  const contributions = buildTelemetryContributionsFromBundle(verified.bundle);
  if (contributions.length > MAX_PREPARED_CONTRIBUTION_BATCHES) {
    throw fixedError("batch_count_invalid");
  }
  const outputPath = selectedContext.ensureDirectory !== null
    ? outputDirectory
    : resolve(outputDirectory);
  const directory = selectedContext.ensureDirectory !== null
    ? await selectedContext.ensureDirectory(outputPath)
    : outputPath;
  if (selectedContext.ensureDirectory !== null) {
    if (directory === null || directory === undefined) {
      throw fixedError("prepared_context_invalid");
    }
  } else {
    await mkdir(outputPath, { recursive: true, mode: 0o700 });
  }
  signal?.throwIfAborted?.();
  const files = [];
  for (const [index, contribution] of contributions.entries()) {
    signal?.throwIfAborted?.();
    const content = stableJson(contribution);
    const file = join(
      outputPath,
      `telemetry-contribution-${String(index + 1).padStart(6, "0")}.json`,
    );
    const published = await selectedContext.publishPreparedContributionFile({
      directory,
      name: basename(file),
      content,
    });
    signal?.throwIfAborted?.();
    const counts = preparedContributionRecordCounts(contribution);
    files.push({
      file,
      basename: published.basename,
      sha256: published.sha256,
      bytes: published.bytes,
      counts,
    });
    await failpoint("after_contribution_file", {
      index: index + 1,
      batchCount: contributions.length,
    });
    signal?.throwIfAborted?.();
  }
  const manifestFiles = await selectedContext.verifyPreparedContributionFiles({
    directory,
    files: files.map((file) => ({
      basename: file.basename,
      sha256: file.sha256,
      bytes: file.bytes,
      recordCounts: file.counts,
    })),
  });
  signal?.throwIfAborted?.();
  const manifest = {
    schemaVersion: PREPARED_CONTRIBUTION_SET_VERSION,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    eligibleSchemaVersion: PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA,
    batchCount: manifestFiles.length,
    files: manifestFiles,
  };
  await failpoint("before_manifest", { batchCount: contributions.length });
  signal?.throwIfAborted?.();
  const publishedManifest = await selectedContext.publishPreparedContributionManifest({
    directory,
    manifest,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    failpoint: (name) => failpoint(name, {
      batchCount: contributions.length,
    }),
  });
  signal?.throwIfAborted?.();
  await failpoint("after_manifest", { batchCount: contributions.length });
  signal?.throwIfAborted?.();
  await selectedContext.verifyPreparedContributionSet({
    directory,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
  });
  signal?.throwIfAborted?.();
  return {
    schemaVersion: "telemetry-contribution-build-receipt-v0.1",
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    sourcePrivacyVerdict: verified.summary.verdict,
    sourceTransportReady: verified.summary.transportReady,
    outputDirectory: outputPath,
    batchCount: contributions.length,
    files,
    preparedSet: {
      schemaVersion: PREPARED_CONTRIBUTION_SET_VERSION,
      eligibleSchemaVersion: PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA,
      manifestBasename: PREPARED_CONTRIBUTION_SET_MANIFEST,
      manifestSha256: publishedManifest.sha256,
      manifestBytes: publishedManifest.bytes,
    },
  };
}
