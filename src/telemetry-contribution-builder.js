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

const {
  publishPreparedContributionFile,
  publishPreparedContributionManifest,
  verifyPreparedContributionFiles,
  verifyPreparedContributionSet,
} = preparedContributionContext;

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

export async function materializeTelemetryContributions({
  bundleFile,
  receiptFile,
  outputDirectory,
  failpoint = async () => {},
  signal = null,
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
  const verified = await loadVerifiedLocalMetadataBundleFiles({
    bundleFile,
    receiptFile,
  });
  signal?.throwIfAborted?.();
  const contributions = buildTelemetryContributionsFromBundle(verified.bundle);
  if (contributions.length > MAX_PREPARED_CONTRIBUTION_BATCHES) {
    throw fixedError("batch_count_invalid");
  }
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted?.();
  const files = [];
  for (const [index, contribution] of contributions.entries()) {
    signal?.throwIfAborted?.();
    const content = stableJson(contribution);
    const file = join(
      directory,
      `telemetry-contribution-${String(index + 1).padStart(6, "0")}.json`,
    );
    const published = await publishPreparedContributionFile({
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
  const manifestFiles = await verifyPreparedContributionFiles({
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
  const publishedManifest = await publishPreparedContributionManifest({
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
  await verifyPreparedContributionSet({
    directory,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
  });
  signal?.throwIfAborted?.();
  return {
    schemaVersion: "telemetry-contribution-build-receipt-v0.1",
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    sourcePrivacyVerdict: verified.summary.verdict,
    sourceTransportReady: verified.summary.transportReady,
    outputDirectory: directory,
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
